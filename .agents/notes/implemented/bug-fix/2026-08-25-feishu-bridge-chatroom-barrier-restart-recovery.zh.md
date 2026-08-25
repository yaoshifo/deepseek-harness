# Agent Note: feishu-bridge 聊天室屏障跨重启收束而非停滞

Status: implemented

[English](2026-08-25-feishu-bridge-chatroom-barrier-restart-recovery.md) | 中文

## Problem

`pendingGather` 与 `pendingEndBarrier` 是带活 fallback timer 的内存对象；sessions.json 的序列化白名单不含它们。守护进程在 gather 进行中重启会静默丢失屏障：角色回复中继进一个不存在的屏障（串行路径噪音、每条回复各唤醒一次），moderator 永远收不到「全部回复完成」的唤醒；在收尾排空期重启则让 teardown 永久冻结——drain timer 已不存在。这与 subtask 汇报找回事故同属「重启丢调度」一类。

## Decision

三处协同改动：

1. **hub 会话上的快照。** 两个屏障新增 `snapshot()`，产出 JSON 安全记录（`question`/`seq`/`expected`/`collected`；timer、woken 标志、进度卡句柄留在内存），由 `serializeSession` 以 `pendingGatherData`/`pendingEndBarrierData` 落盘。已唤醒的屏障返回 `undefined`——每条唤醒路径都会在下一次 save 前清除屏障，唯一例外是异步 finalize 窗口，而该窗口内的重启绝不能复活一个唤醒已发出的屏障。快照走 sessions.json（沿用 B4 的 state.json durable side-channel 先例），不进原生 agent session log：它们是调度器状态、永不对模型可见，且 agent log 的删除/压缩生命周期不适合承载协议状态。
2. **恢复是收束而非重臂。** `recoverChatroomBarriers` 在 `Engine.start()` 平台就绪后运行。恢复出的屏障所等待的每条回复都属于随旧进程死去的角色轮次（expected ⟺ 在途轮次；`chatroomInFlight` 甚至不持久化），expected 集合永远无法凑齐：每个恢复出的 gather 立即以已收集回复加重启标注收束，恢复出的 end barrier 不等缺失的末轮回复直接 finalize，研究模式的 gather 补发一张终态进度卡（旧句柄随进程死去），过期的 `researchAwaitingAssistant` 标记被清除以免后续重新点名被误读为被推迟的结论轮。
3. **durable 文件校验。** 畸形快照丢弃并告警，恢复不崩溃（sessions.json 是文件边界）。

把 chatroom 角色完整迁移到原生 continuable children——2026-08-25 调研出的四阶段方案（双重身份：native child 承载身份/血缘/轮次驱动，bridge 持有的角色群承载可见面）——**延期而非否决**：其中唯一有用户可见价值的部分（重启耐久性）已由本 note 单独修复。启动迁移的触发条件：某个 chatroom bug 溯源到双重簿记或手写的 research defer 状态机；出现第二个需要圆桌编排的消费面（届时 chatroom capability seam 才是更好的终态）；或用户明确要原生血缘、弃群内流式预览（迁移正是用后者换前者）。

## Alternatives considered

**按剩余 deadline 重臂 timer。** 弃用：重启后没有任何 expected 回复可能到达，等待只会为已经丢失的回复停滞——带部分结果收束是在正确时刻应用的超时语义。

**持久化进原生 session log。** 弃用：屏障状态是调度器状态，不是模型可见内容（model-visible ⟺ logged 不变量并不要求它），且 agent session log 的删除与压缩生命周期不适合协议状态。

**同样修 `SubtaskGather`。** 超范围：`pendingSubtaskGather` 有同样的不持久化缺陷，但它的丢失是已知且有既有解法的 subtask 汇报找回场景（群历史恢复）；等该痛点再现时需要同样处理。

## Consequences

gather 进行中重启现在会以已收回复收束本轮，并明确告知 moderator 哪些角色丢失，由它决定重新点名或直接推进；收尾中重启以部分末轮回复完成 teardown。进程存活期间行为不变——快照只在 load 时读取，恢复在 start 时一次性消费。

## Testing

`tests/engine/engine-chatroom-recovery.spec.ts`（+6）：armed/woken 持久化往返、重启恢复带重启标注唤醒收束 gather、end barrier 恢复后 finalize 与角色清理、畸形快照丢弃不唤醒、恢复出的研究 gather 补发终态进度卡。既有 chatroom 套件（gather/end/session，116 个测试）与 session 序列化套件（50 个测试）不变通过。
