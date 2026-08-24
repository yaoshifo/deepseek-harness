# Agent Note: feishu-bridge 带四个可配置预算的 unsolicited reader

Status: implemented

[English](2026-08-24-feishu-bridge-unsolicited-reader.md) | 中文

## Problem

桥只在回合的事件泵内消费 agent 事件。用户回合之间，通道只有一次性的 orphan watch（commit 1b45a770ed）在看守，而它没有时间概念：一个永远挂死的后台工具、一个完成回合永远不来的 `run_in_background` 任务、以及模型在用户回合 ✅ 卡之后紧接着发的重复 result 帧，与真正的引擎唤醒回合无法区分——最后这种会给用户已经看过的内容再弹一张流式+完成卡（Go 的 spillover 事故类别）。`streaming.ts` 里移植来的 `setBackgroundHint` 机制与 `bg_task_*` i18n 键零调用，Go 的 `runUnsolicitedReader`——带 idle、tool-in-flight、background-grace、spillover 四个预算的常驻消费者——没有移植。路线图还裁定过（FEATURE-PARITY.md）：后台任务计数必须与 unsolicited reader 同批接线，因为递减锚定在 reader 消费的完成回合上。

## Decision

orphan watch 升级为 unsolicited reader（`packages/acp/feishu-bridge/src/engine/engine.ts` 的 `startUnsolicitedReader` / `stopUnsolicitedReader` / `runUnsolicitedReader`），后台任务计数端到端接线：

- **Reader 循环**：每次泵退出后，reader 在活通道上停一个可取消的 receive（`EventChannel.receiveArmed`）加一个 idle sleep。实质性事件（Go `isSubstantiveUnsolicitedEvent`：非静默文本、工具调用、result、error——delta、thinking、compaction、todo 快照丢弃）在会话锁下跑完整 orphan 泵，与旧 watch 一致；之后循环重新布防。消息路径回合入口先解除 reader（取消其停泊的 receive，使其不会偷走新回合的第一个事件），`stopInteractiveSession` / `cleanupInteractiveState` 在拆除时解除。
- **四个预算**，全部是插件 `Config` 字段 `projects[].unsolicited`（`idleSec`、`toolInFlightSec`、`backgroundGraceSec`、`spilloverSec`；引擎默认 60s / 30min / 30min / 0，assembly 层把 spillover 默认接成 30s，对齐 Go 的 wire.go）：idle 解除 reader（并标记 `eventsNeedResync`，让下一个前台回合排空之后缓冲的事件）；停泊的 ask、安静的工具调用、pending 的后台任务各自在自己的预算内保活，预算耗尽即 finalize——background grace 还会把永不完成的任务计数清零。reader 唤醒的回合里，工具在飞时泵的 idle 改用 tool-in-flight 预算布防，挂死的后台工具不能再永远钉住处理中卡（用户驱动的回合保持既有「工具在飞时解除 idle」行为；Go 那边靠 watchdog 兜底）。
- **Spillover 中继**：前台回合完成（每个用户驱动的 result 打 `lastForegroundCompletionAt`）后宽限窗内的事件以纯文本中继——累积文本、最终 result 以消息发出、记 history、更新 `setLastResult`，无卡、无完成卡、不递减后台计数。error 中继其消息并结束 reader。
- **后台任务计数**：dsh adapter 解析 `tool/call` 的 arguments，把 `run_in_background: true` 标记为 `Event.toolBackground`；泵在这类工具调用时递增 `state.backgroundTasksPending` 并在回合卡上显示 `bg_task_running`（Go 的前台与 reader 两个分支合并进唯一的泵）。完成锚点是 reader 消费的回合的 `result` 事件——本 harness 中后台任务的完成以 runtime notice 唤醒新回合、其持久化事件投影到同一通道的形式到达，orphan 泵消费它并在那里递减（Go 的 reader EventResult，`!turnStartedBg`）。计数归零清 hint——修掉 Go 的 hint 只增不减缺口。idle reaper 跳过有 pending 后台任务的 state，grace 不被提前掐断；reader 在宽限耗尽时清零计数也重新放行 reaping。

## Alternatives considered

**按 Go 原样把 reader 移植成所有引擎唤醒回合的轻量中继。** 桥的 orphan 泵已经把引擎唤醒回合送进完整回合机制（进度卡、ask-delegate 审批桥接、insights），严格富于 Go 的 reader 中继；在第二个消费者里复制那套逻辑会与泵竞争并翻倍表面积。reader 保留 Go 的**时间**语义，把**回合渲染**委托给既有泵。

**在前台回合的 result 上递减计数。** Go 只在 reader 消费的 result 上递减：发起任务的回合不是它的完成。锚在任何别处都会重复计数或永不递减。

**用 adapter 的专用通知检测后台完成。** 完成本来就以普通引擎唤醒回合的形式到达既有通道（orphan 泵为之而生的机制）；第二条通知通路是重复。

## Consequences

引擎唤醒回合有了时间边界：挂死的后台工具或永不完成的任务不会再把处理中卡或 reader 钉过预算，完成后的重复帧以安静的纯文本到达而非第二张 ✅ 卡。后台任务提示终于闭环——工具调用时计数上涨，完成回合落地时计数下降并清除——reaper 的护盾也被 grace 约束。代价：spillover 窗口内（默认用户回合后 30s）引擎唤醒回合失去卡片、只交付纯文本（对齐 Go，但桥更丰富的 orphan 泵处理在该窗口被绕过）；后台回合里安静运行超过 tool-in-flight 预算的合法工具会被当作挂死并 stall-retry（可配置，默认 30min）；reader 丢弃的事件（回合间的 thinking、compaction、todo 快照）永远到不了泵——Go 同样丢弃。

## Testing

`tests/engine/engine-unsolicited.spec.ts` —— fake-timer 覆盖四个预算（idle 解除与零禁用、ask 保活、tool-in-flight 保活后 finalize、background grace 保活后计数清零）、窗口内纯文本中继与窗口外完整泵、非实质性噪声丢弃、新回合解除，以及跨真实「前台+完成」回合对的 hint 增减闭环。`tests/agent-dsh/adapter-projection.spec.ts` —— `run_in_background` 参数检测。既有的 orphan-turn、stall-retry、engine-events 套件（154 个测试）不变通过。feishu-bridge 套件：2207 通过（9 个与本次改动无关的既有环境失败：reload-script 的 launchctl/systemd 用例与一个 fork-at 用例，在基线提交上同样失败）。
