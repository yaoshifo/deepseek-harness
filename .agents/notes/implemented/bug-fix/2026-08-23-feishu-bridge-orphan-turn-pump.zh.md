# Agent Note: 引擎唤醒的 turn 运行在孤儿 turn 事件泵上

Status: implemented

[English](2026-08-23-feishu-bridge-orphan-turn-pump.md) | 中文

## 问题

`processInteractiveEvents`（消息路径的事件泵）只为用户消息的 turn 存活：`result` 事件后若无排队的用户消息即返回。引擎在没有用户消息时唤醒的 turn——后台 job 完成通知、后台 subagent 报告——仍会向 channel 推送事件（dsh adapter 投影每一个 durable 事件），但没有任何消费者：回复到不了平台、`lastResult` 停留旧值、权限/计划审批请求不被桥接（`state.pending` 从不设置）、idle reaper 的 pending 豁免无法生效。十五分钟后 reaper 回收整个交互状态，挂起的 turn 以 `aborted/disposed` 结束。2026-08-23 oc_9956 事故以此方式丢了三个 turn，`exit_plan_mode` 的审批请求呈给了空气。

其下还藏着第二个缺陷：泵在处理每个事件前重挂 receive，退出时在 `EventChannel` 上遗留一个 pending waiter。JS 的 promise 无法取消它的 waiter（Go 的 receive goroutine 退出即消失），死 waiter 排在每个后来接收者前面，静默吞掉下一个事件——生产环境里这吃掉了每个用户 turn 之后的第一个流式 chunk，也会饿死排在它后面的任何哨兵。

## 决策

`packages/acp/feishu-bridge` 里的两个机制：

1. `EventChannel.receiveArmed()`（`src/core/types.ts`）返回 receive promise 外加一个能移除 waiter 的 `cancel()` 臂。泵以臂持有 receive，并在 `finally` 里 cancel，退出的泵不再偷走下一个事件。
2. `armOrphanWatch` / `runOrphanTurnPump`（`src/engine/engine.ts`）在每次泵退出后停放一个 receive。第一个孤儿事件取得 session 锁，以已消费的事件作为 `firstEvent`、以 `state.replyCtx` 作为回复上下文跑一个完整的 `processInteractiveEvents`——复用现有的渲染、投递、权限桥接与 stall 机制。若锁被占（消息路径的泵活着），哨兵把事件推回 channel 交给该泵；FIFO 单消费者语义保证投递恰好一次。孤儿泵退出后哨兵重新武装，级联报告各得一个泵。

## 备选方案

**在 adapter 的 `session/event` 订阅上检测 `turn/start`。** 检测与消费分离：同一个 `turn/start` 仍须经 channel 到达泵，且 adapter 需要一条通向 engine 的新通知通道。哨兵在同一个点上同时消费与检测。

**把后台通知作为虚拟用户消息经 bridge 路由。** 需要改动 harness 侧 subagent/jobs 的通知机制、跨多个包；哨兵只在 bridge 内修复投递。

**Go parity。** Go cc-connect 有同样的缺口（其事件 select 只为消息 turn 运行）；本修复是对 Go 行为的有意超越，与更早的 queued-turn takeover 一致。

## 影响

引擎唤醒的 turn 获得完整投递：回复、进度卡、权限与计划审批卡，以及 reaper 的 pending 豁免全部对它们生效。遗留 waiter 的修复也止住了每个用户 turn 后第一个流式 chunk 被吞的问题。孤儿泵像消息 turn 一样持有 session 锁，孤儿 turn 期间到达的用户消息按正常语义排队并在其后 drain。Go 后台读取器携带的 unsolicited-permission 门控仍然缺席（范围未变）。

## 测试

`tests/engine/engine-orphan-turn.spec.ts`——五个行为：泵退出后的投递（`lastResult` 更新）、权限桥接加 reaper 豁免、交还给运行中的消息泵（不出现第二个泵）、级联孤儿 turn、孤儿泵占用 session 时的用户消息排队。feishu-bridge 套件：2113 通过。
