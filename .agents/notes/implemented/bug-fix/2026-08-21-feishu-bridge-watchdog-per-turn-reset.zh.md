# Agent Note: feishu-bridge 看门狗硬上限按轮计量而非按 run 计量

Status: implemented

[English](2026-08-21-feishu-bridge-watchdog-per-turn-reset.md) | 中文

## Problem

2026-08-21，Dev 迁移群（会话 `cc-20260821-210214-1595171d8f87`）的排查回合被硬回合上限强制中断。Turn 1（Dev 服务器切流任务）合法地跑了 86 分钟并于 22:28 正常完成；两秒后到达的追加消息作为排队回合接管同一个引擎 run（in-loop drain），4 分钟后被杀：`turnStart` 只在 run 开始时取值一次，排队接管从不重置它，run 在 22:32 跨过 `softCap × 3`（`absoluteTurnTimeoutSecs: 1800` 时即 90 分钟）。看门狗在回合中途 dispose 了 agent 会话（`turn/end reason: aborted/disposed`）、发出 `watchdog_reset` 消息并自动重置会话——用户丢失了在途排查，只能重发。

用户可见的契约本来就承诺按轮语义：配置键文档写的是 "Per-turn wall-clock cap seconds"，`watchdog_reset` 消息说的是「本轮执行超出时长上限」。Go 的看门狗同样按 prompt 处理 run 计量，所以这是移植保形带来的缺陷，不是 Go 侧的修复——Go 会话同样存在「长 turn 之后追加消息被杀」的失败模式。

## Decision

`processInteractiveEvents` 在 `result` 事件分支里，当排队消息接管循环成为新回合时（`finished.kind === 'queued'`）重置 `turnStart`，与其他 per-turn 状态重置并列。事件到达时强制执行、3× 乘数、research 豁免均不变。stall-retry 路径刻意**不**重置：它注入的 `继续` 服务的是同一逻辑回合，在那里重置会让无限 stall-重试的会话永远绕开上限。这是对 Go per-run 时钟的有意偏离，记录于 MIGRATION.md 补充 24。

## Alternatives considered

**保留 Go 的 per-run 时钟，把文案改成「会话 run」。** 否决：无论文案怎么写，损害都是真实的——任何接近上限的长 turn 之后，下一条排队消息只剩残余预算，几分钟内必被杀。配置 JSDoc、i18n 消息与用户预期都说的是按轮；时钟才是偏离方。

**任何入站用户活动都续期时钟。** 否决：排队接管是 run 内唯一的用户接管路径；回合中段的 splice 与 steer 注入属于正在运行的回合，不得刷新其预算。

**stall 重试时也重置。** 否决：stall 重试为同一逻辑回合重启 agent。重置会让硬上限——事件慢滴流且 stall 重试循环时的唯一兜底——永远不可达。

## Consequences

每个回合现在获得完整的硬上限预算，长任务后的追加指令得以存活。代价是：持续排队追加消息的 run 在总量上可以超过上限的许多倍；每个回合本身仍有界，且慢滴流防护（上限的本意）不受影响——它在效果上从来就是按回合的。恰好在上限边界结束的回合不再毒害下一个。research 会话保留豁免。

## Testing

`tests/engine/engine-events.spec.ts` "queued takeover resets the hard-cap clock (per-turn, not per-run)"：turn 1 在 500 ms 后完成，排队消息接管，run 必须活过旧的 run 级死线（3.6 s），同时在接管点自身的死线之后仍被强制清理——修复前红（turn 2 在 run 级死线被杀），修复后绿。包全量套件绿（2042 项测试）。
