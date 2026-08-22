# Agent Note: feishu-bridge 异常退出失败化预览卡；用户停止以 user 原因取消

Status: implemented

[English](2026-08-22-feishu-bridge-abnormal-exit-fails-preview-card.md) | 中文

## Problem

复核 [stop-finalizes-preview note](2026-08-22-feishu-bridge-stop-finalizes-preview-card.zh.md) 的后续时发现两处端口缺失：

Go cc-connect 在每种异常 turn 退出上都渲染终态预览卡——stall 重试退役旧卡并换新卡（`engine_events.go:2730`）、重试耗尽失败化（`:3628`）、意外 channel 关闭失败化（`:5121`，注释引用 Go 自己 2026-08-17 卡片冻结至用户重发的事故）、停止后事件到达渲染停止或失败（`:3649`）。TS 端口只保留了事件循环的 stop 分支：agent 崩溃、stall 耗尽、带缓冲事件的外部停止，都会让卡片冻结在 Running 态、旁边只有一条文本通知——与 oc_74a7 事故同形的冻结，只是触发源不同。

另外，`DshAgentSession.cancelTurn()`——Go `AgentInterrupter.Interrupt` 的端口，Go 的 `stopInteractiveSession` 对用户停止优先于 `Close` 走它——生产代码无调用方，导致每次用户停止在持久化会话日志里记录的是 `turn/end reason aborted/disposed` 而非 `aborted/user`。

## Decision

引擎现在在异常退出上失败化或终态化预览卡，镜像 Go：stall 重试分支用 `markFailed()` 退役卡并重建 `sp`/`cp`（与 queued-takeover 重启同形），续跑的「继续」turn PATCH 新卡；重试耗尽与停止后事件到达在 cleanup 前渲染终态卡（`userStopped`/`engineStopped` → `markStopped()`，其它停止 → `markFailed()`）；`handleChannelClosed` 在意外退出上失败化 `state.preview`。与 Go 无条件 `unexpectedExit` 门控的一处有意偏离：`Engine.stop()` 有意不置 `stopped`（区分 reload 与崩溃）且已自行渲染 ⏹ 卡，因此 channel-closed 的失败渲染豁免 `engineStopped`——否则红卡会覆盖 reload 的 ⏹。

`stopInteractiveSession` 现在在 `close()` 之前调用 `asAgentInterrupter(agentSession)?.cancelTurn()`：进行中的 turn 以 user 原因中止，持久化日志记录 `aborted/user`。与 Go 的二选一不同——Go 的 `Interrupt` 直接杀子进程——dsh 的 cancel 不释放 agent handle，teardown 仍归 `close()`；是 cancel 后 close，不是 cancel 代 close。

## Alternatives considered

**只修用户停止的事故路径。** 留下崩溃/stall 冻结——Go 2026-08-17 事故正是它们会在生产咬人的先例。

**channel 关闭时无条件失败化（严格 Go 镜像）。** 会覆盖 `Engine.stop()` 渲染的 reload ⏹，用一种不一致换另一种；`engineStopped` 豁免让每种停止的卡都正确。

**用 `cancelTurn()` 替代 `close()`（严格 Go 二选一）。** 泄漏 agent handle——dsh 的 cancel 不注销不 dispose；teardown 仍归 `close()`。

**像 Go 一样在 stop 时关闭 `state.sender`。** TS 的终结是 fire-and-forget、在 preview 锁上排队；其 barrier 需要 sender 开放才能在 ⏹ 卡之前排空在途 Running PATCH。提前关闭会让在途 Running PATCH 落在停止卡之后。`degraded` 已阻止新入队，新状态会拿新 sender。

## Consequences

agent 崩溃或 stall 耗尽的会话现在以红色「执行失败」卡收尾，而非冻结的 Running 卡；stall 重试可见地退役旧卡。用户停止在会话日志记录 `aborted/user`（回放时模型可见）。watchdog 硬上限退出在 Go 与 TS 中都仍不终结卡片——双方共有的缺口，有意不单方面偏离。

## Testing

`tests/engine/engine-events.spec.ts`（"abnormal-exit preview finalization"）：意外 channel 关闭渲染 `__cc_state__:failed`；停止后事件到达对非用户停止渲染失败卡、对用户停止恰好一次 `stopped:`。"Interrupt preference"：`cancelTurn` 先于 `close` 触发，无该能力的会话照常停止。`tests/engine/engine-stall-retry.spec.ts`：重试以失败渲染退役旧卡并换新卡；耗尽失败化卡片。feishu-bridge 套件：2085 通过。
