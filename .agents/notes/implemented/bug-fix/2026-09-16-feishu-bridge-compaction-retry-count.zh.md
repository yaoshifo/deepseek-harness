# Agent Note: 只统计落盘的压缩；失败重试单独显示

Status: implemented

[English](2026-09-16-feishu-bridge-compaction-retry-count.md) | 中文

## 问题

adapter 只把 `compaction/start` 投影进 engine 事件流，bridge 因此永远不知道一次尝试是否落了 checkpoint。两个计数器都在为每次尝试记账：`state.compactionCount`（状态 footer 的「N zip」）和卡片的 `compactCount`（「🗜上下文压缩：N次」）都在 start 时 +1。活体证据（2026-09-16，oc_8b19）：一次摘要生成撞了 token 帽（fail-closed，无 checkpoint），下一步的重试落盘——卡片显示「压缩2次」，读起来像两次独立压缩，把运营者误导进了一场排查。

同一缺口上还骑着两个小谎：无预览卡通路在 start 时就发「已自动压缩」聊天消息，checkpoint 还没生成就宣布完成；失败的尝试在卡片上则完全没有痕迹。

## 决策

- adapter 补投影 `compaction/end`，失败身份放 `errorText`（落盘成功时缺席）。`Event.done` 在 wire 上拆分压缩生命周期：false 是 start，true 是 end。
- engine 只在成功的 end 上计 `state.compactionCount`；失败的 end 变成一条 `isCompactRetry` 进度条目。start 只驱动一条「压缩中…」进度条目（新词条 `context_compacting`）——不计数、不发聊天消息。
- 卡片摘要行分开两个计数：两个都非零时「🗜上下文压缩：N次（含M次重试）」，本轮全部尝试失败时「🗜上下文压缩重试：M次」。无预览通路每个 end 发一条消息——成功发 `context_compacted`，失败发新词条 `context_compaction_retried`。
- 演进 [native 信号投影 note](../simplification/2026-08-23-feishu-bridge-native-signal-projection.zh.md)（它引入了 start-only 计数）与 [compress 路径移除 note](../simplification/2026-09-16-remove-bridge-compress-path.zh.md)（它保留了 `compactionCount` 作为 footer 的写入者）；两者都不被取代——被改的是写入者的语义。

## 考虑过的替代方案

**在 engine 里不发 end 事件硬猜。** bridge 没有别的尝试结果来源；在那里推导出的任何东西都是编造。

**只计成功、完全隐藏失败。** 一轮内全部尝试失败的 turn 会什么都不显示——这正是让原始事故值得排查的可观测性缺口。重试行保留。

## 后果

- 「N zip」和卡片计数现在指落盘的 checkpoint；重试风暴显示为（含M次重试）而不是抬高计数。
- 重试计数是每卡生命周期（每 turn 一个 StreamProjection），与既有计数的生命周期一致；turn N 内失败、turn N+1 落盘时各自渲染在自己的卡上。
- 压缩进行中现在在进度环上可见（摘要生成的 ~25–35 秒窗口，此前卡片什么都不显示）。
- 压缩 wire 契约落在 `Event.done`/`errorText` 上；将来若出现第三个生命周期帧，需要独立字段而不是继续加重 `done` 的语义。
- 测试：`engine-events.spec.ts`——落盘计数、失败重试显示、全失败重试行、无预览两条聊天消息。
