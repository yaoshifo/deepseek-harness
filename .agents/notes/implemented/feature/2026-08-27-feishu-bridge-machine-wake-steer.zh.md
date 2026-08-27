# Agent Note: 机器唤醒直达忙碌中的父回合

Status: implemented

[English](2026-08-27-feishu-bridge-machine-wake-steer.md) | 中文

## 问题

2026-08-27 oc_56801302 事故：父群在一个随后运行了 40 多分钟、且没有调 `gather` 的回合里派发了 6 个 native 子任务——这正是设计内的逃生路径（"the escape is not calling gather, which keeps the per-report incremental wake"，见 [2026-08-27](2026-08-27-feishu-bridge-blocking-gather-and-failure-settlement.zh.md)）。该路径的「父回合忙碌」一腿从未实现：每份子任务汇报都以合成 `[子任务完成]` 消息重入 `receiveMessageSafe`，撞上会话锁，进入**人类**消息队列。用户看到 6 条来历不明的 📬 排队提示（每份汇报一条），第 6 份汇报在 `maxQueuedMessages=5` 上限处被静默丢弃，5 份排队副本只存内存。更糟的是其中一个子任务走了 runtime 原生 `report` 工具汇报——其投递直插 runtime 父收件箱，引擎观测不到该通道，于是 `subagent/end` 结算把同一内容又投了一遍。排查中还坐实两个相邻缺陷：live 卡的「N 个子任务后台运行中」提示只在 spawn 时写入、turn 结束才重算（父 agent 读着过期 footer 加上裸 `[ready]` 标签，叙述成「子任务都还在跑（ready/排队态）」——`ready` 的实际含义是已收档可复活）；`adapter.followupChild` 不传 `signal`，导致每一次 `send` 到已收档子任务都在 runtime 冷复活臂的 `options.signal.throwIfAborted()` 处崩溃——发往 W2 的两条环境坑提示就这样丢了。

## 决策

保留 B4 架构——external settlement、引擎投递、阻塞 gather 的 banking——补完设计内逃生路径而非推翻它：

- **`deliverMachineMessage` 缝**（engine）：机器消息（子任务汇报唤醒、gather 汇总唤醒、聊天室 moderator 唤醒、追问注入）到达**忙碌**父回合时改走 `AgentSession.steer`——在下一 step 边界被领取，多个唤醒合并为一步——而空闲父、启动窗口、忙但 agent session 已死三种情况回落到既有合成消息管线（空闲路径需要完整 turn 机器）。迁移全部合成注入点（engine、chatroom、chatroom-cmd）之后，平台消息队列在构造上只承载人消息。cron 有意留在管线上：它的 mode override、workDir 切换、每轮新会话语义需要完整消息路径。聊天室 `[主持]` 询问同样保留管线：其 `chatroomAskSeq` metadata 在 turn start 被消费用于 gather 回合配对，mid-turn steer 会跳过打点。
- **汇报单通道**：bundle patch 禁用 `tool-subagent-report`。其 `report` 工具直投 runtime 父收件箱——引擎观测不到的通道，即双投递来源；`feishu_bridge_subtask` action=report 成为唯一汇报面（子级 persona 本就这么写），`subagents` 服务的 `reportFrom` 路径保留给 native 父投递。`toolFilter.deny` 点名不到该工具：它按子级注册而非全局，`restrict` 按全局注册表校验——组合层才是强制点。
- **footer 实时化**：`refreshSubtaskFooter` 在子任务 `reported` 置位时（汇报、结算、interrupt）重算 `pendingNativeChildrenOf` 并 PATCH live 卡提示，对齐 turn 结束重算的 background-task 交互规则。
- **`followupChild` 补 signal**：传 `AbortSignal.timeout(startContinuableTimeoutMs)`，与 `reportChildToNativeParent` 一致；runtime 冷复活臂必需它。
- **`list_agents` 图例**：每个非空渲染追加一行状态图例，杜绝裸 `[ready]` 被误读为「排队执行中」。
- **重启恢复**（`recoverInterruptedNativeChildren`，挂在 platforms-ready）：子级 epoch 跑在 daemon 进程里，重启即静默死亡——`subagent/end` 永不发出，记录永远 `reported: false`，footer 数幻影，对着死子任务 arm 的 gather 会空等到超时。恢复是聊天室屏障恢复的子任务对等物：所有未汇报且无活 agent 的子级（经新增的可选 `ContinuableDelegator.childLive` 探测——HMR 重建但 runtime 存活时运行中的子级不受影响）被结算，其父群收到红色警示卡 + 经机器唤醒缝的通知——父 agent 得知这些子级可复活（`send` 会重新置 `reported: false`）或可忽略。无会话记录的父群静默结算，`/done` 仍能 drain 其记录。

## 已考虑的替代方案

- **父忙时跳过合成唤醒**（「runtime splice 已送达」）：否决——只有调了原生 `report` 工具的子任务才有 runtime splice；bridge 工具汇报和结算没有其他投递载体，跳过即丢汇报。steer 改为 mid-turn 直达。
- **投递归还 runtime（`settlementNotice: 'inbox'`）**：红队后否决。它翻转 B4 的通道切分，并在四处撞上刚落地的阻塞 gather 设计：runtime 无法在 gather waiter armed 时抑制 notice（「汇总即工具结果」性质——spawn → gather → synthesize 一个模型请求完成——依赖 banking）；2026-08-27 note 已明确否决重启用原生 `subagent` 工具、以及把 native 子任务计入 unsolicited-reader keep-alive（计数漂移对不上 gather 的 N-to-1 banking）；`subtaskQuiet` 的 wake-only 语义会重排；刚钉死的 gather/结算测试面全部重写。且 runtime 唤起的空闲回合依赖 unsolicited reader——其预算是按事故调出来的。引擎保留投递保住了上述每一个决策。
- **用 `toolFilter` deny 原生 `report` 工具**：机械性否决——该工具是子级作用域，`tools.restrict` 点名不到；bundle patch 才是可行的强制点。

## 后果

- 机器唤醒到达忙碌回合改为 mid-turn（快于排队后 drain）、在 step 边界成批消费、是持久 session 事件（steer 的 splice 落 log），从此不可能撞队列上限、不可能因 daemon 重启丢失。队列的 📬 提示、5 条上限、内存存储只约束人消息（README Known Limitations 记录了重启丢失边界与 cron 例外）。
- 并发子任务数量处处无上限（runtime、gather 期望集、steer 批量）；事故里的「5」是人消息队列泄漏到机器流量，不是子任务上限。`maxDepth`（默认 3）只管嵌套深度。
- 改动前已持久化的子任务的 descriptor 里可能仍带原生 `report` 工具；存量子任务若调用它会像从前一样双投递，直到被 drain。新子任务看不到该工具。
- 带在途子任务的重启现在会结算其记录并唤醒各父群一次；本改动之前这些记录永远停留在 `reported: false`（footer 幻影计数、gather 对永不可能汇报的子任务空等超时）。
- 卡片上两个子任务计数器改为自解释标签——统计行 `🤖 累计派发：N`（累计）、footer 提示 `⏳ N 个子任务在途`（在途，键 `subtasks_running_hint`）及同词汇的结算卡标题后缀——「累计 vs 在途」的区分不再依赖位置，裸 `Sub Agent：N` 不再诱发误读。
- 测试：`engine-subtask.spec.ts` 的 `deliverMachineMessage` 三态 + footer 刷新 + 重启恢复用例；`tests/agent-dsh/adapter-followup-signal.spec.ts` 的 followup-signal 回归；tool-subagent-control 的 list-agents 图例。阻塞 gather 三态、结算词汇、REAL-composition 用例原样通过——它们是「本改动补全而非反转 2026-08-27 设计」的回归证明。
