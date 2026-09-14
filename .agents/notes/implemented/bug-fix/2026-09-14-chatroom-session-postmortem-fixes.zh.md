# Agent Note: 2026-09-13 chatroom 场次的八项复盘修复

Status: implemented

[English](2026-09-14-chatroom-session-postmortem-fixes.md) | 中文

## 问题

2026-09-13「闲钱定投」chatroom 场次（账本 `f64eb48bd04b26b0`）干净收官——81 个会话、零报错、全流程闭环——但复盘发现一个引擎 bug 与一条成本/健壮性尾巴：

1. 第一张收尾 ask 卡（02:13:09）发出 3 秒后被 HTML 渲染子任务的正式回执当「自由文本答案」吃掉（hub 日志 seq 287/288）：ask 挂起期间 `routeAskResponse` 接受任何入站文本，包括机器注入的子任务回执。卡变死卡，只有监督网 60 分钟后的重发唤醒救回房间。
2. 每条达到预渲染门槛的回复都 fork 一个 LLM 渲染会话——本场 81 个会话中的 43 个（53%）只为提炼本可直接投递的回复而存在（每场约 0.83M 输入 + 1M 缓存）。
3. 闪电轮 poll 为整个人设库铸造一次性会话且开着 LLM 标题生成（每场约 23 次浪费的标题调用），poll 工作池把 9 席收尾轮串行拖到约 10 分钟，而普通模式房间没有监督覆盖：gather 唤醒丢失即静默冻结（barrier 在唤醒前就被清掉，`reconstructReplyCtx` 失败只 warn）。
4. 子任务结果逐字双投递（运行时 send_message + 正式汇报）、一次性会话无父链（复盘靠时间戳考古归因）、账本段标题重复、`SYNTHESIS.md` 覆盖不存档、预热 poll 行落进下一场账本、`SessionManager.save()` 每次状态变化全量重写注册表（chatroom 每轮多次）、监督 tick 是硬编码常量、熔断后每个窗口无限发群通知。

## 决策

- **机器消息永不回答挂起的 ask**（`routeAskResponse` 对 `machine: true` 返回 `false`）；豁免次序排在追问卡豁免之后。全部内部注入路径已审计确带机标——`spawnSubtask` 的合成首消息是唯一绕过点，现已补上。`/spawn` 的同形首消息保持不带：它注入的是全新 session key，不可能有挂起的 ask。
- **reply 渲染按长度分档**（`planRenderDirectLen`，默认 2000 rune，0 = 关闭）：阈值及以下 engine 直接写 SimpleHTML 片段并原地组装模板——不 fork；超过阈值保留 LLM 提炼 fork，因为渲染 skill 的契约是一屏概览而非复制。中短回复的卡片现在显示原文。
- **poll 一次性会话保 memory、去 title**：`pollQuery` 以 `origin: 'oneshot'` 运行（无 LLM 标题、/list 隐藏），并在会话自身 agent scope 重注入角色目录的 memory 索引——dsh-memory 插件对任何非 undefined origin 硬关注入。工作池上限维持配置值（`pollMaxConcurrent`）。
- **汇报去重观察运行时 relay**：adapter 把活跃会话上的 `agent-message` relay user 事件转发给引擎注册的 notifier（`AgentDirectMessageSource` 能力 → `noteAgentDirectMessage`）；与子会话最近一条直发消息逐字相同的正式汇报注入一行短状态，父面向用户的卡片保留全文。
- **收齐的 gather 在消费前是 durable 的**：一轮收齐（或超时、广播失败、重启恢复）时 hub 记录 `completedGather {seq, wakeContent, completedAt}`；moderator 下一个 turn-start 消费清除，监督网新 sweep 分支在普通房间同样补醒——3 次唤醒后按通知上限走熔断通知。
- **一次性会话血缘走 native header**：`pollQuery` 与 `renderQuery` 把发起聊天方的 native session id 作为 `parentSession` 传入；桥注册表经 hub 的 `agentSessionID` 对上。
- **账本卫生**：与段名同义的首行标题从 `SUBPROBLEMS` 正文剥除；被替换的 `SYNTHESIS` 正文在同一序列化写链内归档进 `SYNTHESIS-HISTORY.md`。预热 poll 行仍会落进下一场账本（记为 Known Limitation——picker 取消点分散、无共享清理钩子）。
- **热路径与噪音纪律**：`SessionManager.save()` 改为每秒一次 trailing 合并写，dispose 与 beforeExit 时 `flushNow()`（内部 mutator 保持同步）；监督 tick（`superviseTickSec`，默认 60）与熔断通知上限（`supervisorBreakerNoticeCap`，默认 2）成为配置字段；超上限后熔断只记日志，直到有机活动重新武装。

## 考虑过的替代方案

- **ask 挂起期间把机器回执排队、解决后再投。** 作为主修复被否：挂起轮的队列属于人类会话流且有长度上限——一条永不该答题的机器消息也不该静默死在上限处。机标豁免保留既有队列/steer 语义。
- **渲染 fork 全砍（所有回复直接落盘）。** 否：长回复确实需要提炼卡；单一阈值既保住那部分又删掉洪水。
- **在 gather 对象本身上标完成态。** 否：七处以上的 `pendingGather` guard 都读「存在 = 进行中」；hub state 上独立的 durable `completedGather` 字段不碰这套语义。
- **引擎侧删除泄漏的预热 poll 行。** 降级为 Known Limitation：需要 durable 逐 hub 台账行加四个 picker 取消路径的钩子，且仍漏「结算后经重启放弃」的窗口。

## 后果

- 测试：`engine-ask-machine.spec.ts`（机标豁免 + 真人/卡片回归）、`plan-render-direct.spec.ts`（分档、可注入阈值、render 父血缘）、`adapter-agent-message.spec.ts`（relay 观察）、`subtask-report-dedup.spec.ts`（去重 + 引擎接线）、`session-save-debounce.spec.ts`、`adapter-oneshot.spec.ts`（poll origin + memory 重注入 + 父链接）、`chatroom-ledger.spec.ts`（标题剥除、综合归档）、`engine-chatroom-supervise.spec.ts`（tick 配置、熔断上限、completed-gather 补醒）、`engine-chatroom-gather.spec.ts`。合并树套件：198 文件、3444 通过。
- 部署：host build + `/reload`；生产在 profile patch 把 `pollMaxConcurrent` 提到 14（角色库规模）。上线信号：poll 无标题生成调用、中短回复无渲染 fork、`chatroom: supervisor` 行只在真停滞出现。
- 已知边界：去重记录仅在内存（直发与汇报间重启则重新全文投递——无害）；直写档卡片显示原文而非提炼概览；serial-ask 熔断通知计数随 entry 生命周期、无有机重置（entry 消亡即重置）；预热 poll 行仍会落进被放弃的下一场账本。
- 下一场 chatroom 应复查：poll 快答仍吃到人设 memory、收尾 ask 在并发子任务回执下存活、故意制造的唤醒丢失在一个停滞窗口内恢复。
