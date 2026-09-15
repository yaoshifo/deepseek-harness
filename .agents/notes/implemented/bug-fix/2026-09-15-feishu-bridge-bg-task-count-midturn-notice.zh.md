# Agent Note: 后台任务计数消费回合内送达的 tool-jobs 通知

Status: implemented

[English](2026-09-15-feishu-bridge-bg-task-count-midturn-notice.md) | 中文

## 问题

进度卡的「💡 N 个后台任务」计数在真实会话里只涨不跌。活体证据（2026-09-15，oc_1b7e133f）：一个用户发起的长回合启动了 7 个 `run_in_background` bash 任务，全部完成且都在回合内被 `job_output` 收走——卡片仍显示 💡 7，且只有等回合结束 30 分钟后由 unsolicited reader 的后台宽限期强制归零。

递减只有一条路径：引擎唤醒的后台回合结算（回合结算处理里的 `background && !turnStartedBg`），建立在 Go 时代的假设上——「完成会作为稍后唤醒的回合到来」。dsh 的 tool-jobs 控制器按 owner 状态投递，只有一支符合该假设：

- 空闲 owner → `Agent.followup`（next-turn splice + 唤醒）——唤醒的回合结算时递减生效；
- 忙碌 owner → `Agent.inject`（next-step splice，不唤醒）——通知进入运行中回合的下一步，而桥的 adapter 把 `agent/inbox/spliced` durable 事件整个丢弃，引擎无从得知任务已结束。

忙碌路径不是边角案例：它是工具描述教学的用法（「任务跑着时继续干独立的活」），任何 agent 在长回合里这么用，每个任务漏一格，直到宽限期重置。

## 决策

投影回合内投递、在通知送达点递减：

- `EventKind` 新增 `bg_task_notice`，携带 `bgNoticeIDs`（拼接通知的消息 id）。
- adapter 仅在 `target === 'next-step'` 且插入消息的 source 为 `{kind: 'plugin', plugin: 'tool-jobs', form: 'notice'}` 时投影 `agent/inbox/spliced`。next-turn splice 不投影：空闲路径的结算递减已覆盖它，两边都投影会双重递减。外来 source（steer 文本、skill 正文）与纯删除 splice 从不占格；无 id 的通知无法去重，保持不投影。
- `Engine.consumeBackgroundNotices` 消费 `min(新 id 数, pending)` 格（下限零），归零时重置 `bgWaitStartedAt` 并刷新卡片提示。通知 id 在 `consumedNoticeIDs` 里 FIFO 封顶（64），镜像 `consumedToolIDs`，同一 splice 的迟到重投影不再消费。
- 三个消费点：回合泵的事件分支（忙碌 owner 修复本体）、unsolicited reader 在实质事件判定**之前**（唤醒预算耗尽时通知以 next-step 投给空闲 owner——格子照样结算，不开回合）、spillover relay 自己的拉取（绕过 reader 前置检查；id 去重让重复目击无害）。跨项目 relay 的 switch 忽略该类型：它的通知属于 relay 会话自己的 agent，在本引擎没有交互计数。

## 考虑过的替代方案

- **回合领走通知时递减**（真正的可观测点）。否：桥看到的是 durable splice 事件，不是领走动作；没有领走投影可挂。
- **`job_output` 读到已结束任务时递减。** 否：解析工具结果里的任务状态把计数耦合到一个 agent 可能永不调用的工具上；通知才是权威的投递信号。
- **所有通知都在插入时递减（两种 target）并删掉结算路径递减。** 否：空闲路径的计数会在唤醒回合开始前掉光，丢失「🔄 后台任务完成，正在处理...」header（它依赖回合开始时的 `background && pending > 0`）。

## 后果

- 计数回到存活语义：后台调用 +1，通知送达 −1。回合中的卡片刷盘随 agent 收任务实时下降。
- 30 分钟后台宽限期回到本职：只兜真正悬挂的任务（永远等不到完成通知），这正是它的原始用途。
- 残余窗口：未被回合领走的 next-step 通知存留到后续引擎唤醒回合结算时，会多消费一格——结算路径按「后台回合数」递减本就松散，`> 0` 下限兜底。
- 漂移警报：投影锚定 dsh core 的投递形状——`Agent.send/inject/followup` 的 target（`agent-loop/src/agent.ts`）与 tool-jobs `onJobDone` 的 source `{kind: 'plugin', plugin: 'tool-jobs', form: 'notice'}`。core 若改忙碌路径的 target 或通知 source 形状，adapter spec 的负向用例会大声失败；若新增没有 splice 事件的忙碌路径形状，计数将重新泄漏，宽限重置是唯一恢复。
- 测试：`adapter-projection.spec.ts` 覆盖投影契约（正向、id 批量、next-turn/外来 source/纯删除/无 id 负向）；`engine-unsolicited.spec.ts` 覆盖回合内递减、重复 id 单次消费、零下限、空闲消费不开回合；既有空闲路径闭环用例保持绿色。
