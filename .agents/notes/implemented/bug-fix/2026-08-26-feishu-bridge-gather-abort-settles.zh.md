# Agent Note: feishu-bridge gather 中止结算挂起回合；stop 路径关闭有界化

Status: implemented

[English](2026-08-26-feishu-bridge-gather-abort-settles.md) | 中文

## Problem

2026-08-26 oc_b46da 聊天室 hub 事故在[冻结时钟泵](2026-08-26-feishu-bridge-frozen-stream-clock-stall.zh.md)与[gather 等待集污染](2026-08-26-feishu-bridge-gather-expected-set.zh.md)之外还有第三层：用户 20:59 停掉被 gather 阻塞的回合后，`cc-…074844` 的持久会话日志终止在 20:42 的 `tool/call feishu_bridge_subtask`——再无 `tool/result`、再无 `turn/end`。`gatherSubtasksBlocking` 的 abort 监听器只清 gather waiter、从不结算工具 promise，runtime 侧的回合因此永远挂在工具调用上。stop 路径的 `cancelTurn()` 无法终结回合，而它 fire-and-forget 的 `agentSession.close()`——全仓库唯一没走 `closeAgentSessionWithTimeout` 有界等待的关闭点——在 `handle.dispose()` 里等一个挂起回合使其不可达的静息，永远挂住，连超时告警都不会打。会话于是一直 live 在 runtime 注册表（`ctx.sessions`）里：21:30 的恢复撞上 `cannot prepare session while it is live`，重试两分钟后降级新会话——主持人的对话上下文白白丢失。21:02 的 gather 超时唤醒也无处落地（interactive state 已被清理），部分汇总被静默丢弃。

## Decision

- `gatherSubtasksBlocking` 中止即结算：abort 监听器清 waiter（不变——后续回报必须走异步唤醒而非死 waiter）并以新增的 `subtask_gather_aborted` 消息结算 promise（「gather 等待被停止中止；已收集的回报仍会经超时唤醒送达。」）。挂起的 runtime 回合拿到工具结果得以终结、`aborted/user` 可达、静息恢复、dispose 能注销会话。武装中的屏障不动：超时唤醒照常投递已收集的回报。
- `stopInteractiveSession` 的关闭改走 `closeAgentSessionWithTimeout`，与其他关闭点对齐：挂在永不静息回合上的 dispose 会打出 `close timed out` 警告并被放弃，而不是静默悬挂。

## Alternatives considered

- **中止时以部分汇总结算。** 否决：中止时刻屏障刻意不完整；对正被丢弃的回合用部分汇总结算会被读作 gather 已完成。部分投递归异步超时唤醒。
- **从 stop 路径强制注销 runtime 会话。** 否决：绕过 dispose 重新制造 oc_29bb 修复移除的僵尸追加风险；泄漏源是未结算的工具 promise，不是注册表。
- **无界关闭 + 完成日志。** 否决：只有可观测性没有上界，桥接侧 `state.closing` 仍永久泄漏，操作者也没有可告警的失败。

## Consequences

- 被停止的 gather 阻塞回合现在能持久终结（带中止提示的 `tool/result` + `turn/end`），agent 会话干净注销，同 id 恢复可用，不再降级新会话。
- 中止提示是工具结果，非停止形态的中止（插件 reload）下模型可能看到；它点名了回退路径，模型不会立刻重新 gather。
- 遗留：其他「注册 abort 监听器但不结算 promise」的阻塞工具有同款挂起回合风险；排查仅发现 `gatherSubtasksBlocking` 一处（askUser 自 oc_29bb 起结算 cancelled）。
- 覆盖：`tests/engine/engine-subtask.spec.ts`（中止以提示结算、屏障保持武装；异步唤醒回退用例改为同样结算）与 `tests/engine/engine-resume-race.spec.ts`（挂死的 stop 关闭在有界超时后告警）。
