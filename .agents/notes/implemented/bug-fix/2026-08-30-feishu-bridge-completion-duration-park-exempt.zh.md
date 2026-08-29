# Agent Note: feishu-bridge 完成卡时长刨除 parked-ask 等待时间

Status: implemented

[English](2026-08-30-feishu-bridge-completion-duration-park-exempt.md) | 中文

## Problem

✅ 完成通知卡 header 渲染 `📁 目录 · 分支 · <时长> · <速率>`，其中时长是纯墙钟：turn 结束时 `engine.ts` 用 `Date.now() − timing.agentStart` 计算，零扣除。引擎 parked 在 ask 上等待的时间——权限审批、AskUserQuestion 追问卡、计划审批——因此被渲染成 agent 运行时间。群 `oc_babc5d5f`（2026-08-29 会话 `cc-20260829-224852`）：turn 1 跨 514.7 分钟，其中 490.2 分钟耗在 `exit_plan_mode` 调用（seq 28772，当晚）与其审批 tool-result（seq 28773，次日上午）之间——卡片对 ~24 分钟的实际工作显示 "514m"（等待占 95%）。

引擎本就持有精确记账：ask parked 时记 `capParkStart`，`resumeCapPark` 把流逝的等待存入 `capPausedMs`；hard cap 与 stall timeout 都豁免这段时间（2026-08-28 oc_9d385 事故：cap 在隔夜回答到达 1 秒后把它销毁）。唯独完成卡时长无视了它。

## Decision

完成卡调用点的两个时长实参都减去 `capPausedMs + parkedNow`（在途 park 尾巴，与 hard cap 自己的豁免检查同形态）。`setCompletionDurations` 本身不变；豁免归调用方所有，其 JSDoc 现在记明传入值已扣除 parked-ask 时间。

## Alternatives considered

**在别处保留总墙钟（用户可能想知道流逝时间）。** 拒绝：卡片上的飞书消息时间戳已经显示 turn 何时结束；header 行是 agent 的吞吐信号，与旁边的速率行口径一致（后者经 generationSpans 已经排除非生成时间，[2026-08-24](2026-08-24-feishu-bridge-token-rate-generation-spans.zh.md)）。

**顺带扣除每 turn 的派发开销（`turn/start` 前的 ~7s）。** 本次不做：比隔夜 park 小一个数量级，根因在 agent 运行时侧未定位，且扣除未解释的空档会重蹈 generationSpans 决策否决过的「等待来源枚举脆弱性」。

**重排 queued-turn 接管处的 park 记账。** 接管时 `capPausedMs` 清零以满足 hard cap 的 per-turn 预算，因此接管后的完成卡不扣前一 turn 的 park 时间。卡片的墙钟本就跨两个 turn（Go 对 `turnStart`/`agentStart` 为 per-run 的保形）；收窄它是另一个独立决策。

## Consequences

隔夜 parked 的 turn 现在显示实际执行时间（oc_babc5d5f 那个 turn 会显示 "24m" 而非 "514m"）。只有新发的卡片变化；已送达的卡片不追溯重算。Parked-ask 时间是用户在决策、不是 agent 在工作——与 hard cap 和 stall timeout 已采用的同一原则。

## Testing

`tests/engine/engine-events.spec.ts` —— 一个 turn 在 permission ask 上 park 约 1.2 s、被回答后完成；断言把 `agentDurationMsg` 钉在 "0s"（墙钟口径渲染 "1s"），`capPausedMs ≥ 1100` 作为记账前提。
