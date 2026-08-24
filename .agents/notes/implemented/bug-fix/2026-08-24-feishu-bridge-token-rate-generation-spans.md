# Agent Note: feishu-bridge token rate derives from streamed generation spans

Status: implemented

English | [中文](2026-08-24-feishu-bridge-token-rate-generation-spans.zh.md)

## Problem

The ✅ completion notification card showed `deepseek-harness · dev · 9s · 5.0 t/s` for turns that follow a subagent report in group `oc_325f5652…` — an order of magnitude below the expected tens of t/s. Replaying the bound session log (`cc-20260824-124410`) turn by turn pinned the defect to the denominator of the rate formula `outputTokens / (agent wall clock − union(tool/permission intervals))` (the formula the toolID fix of 2026-08-21 already corrected once):

1. **First-token latency counted as generation.** Each model step's prefill/queue wait before its first streamed delta measured 1.0–6.3 s and entered the thinking time in full. Short turns are dominated by it: the worst turn decoded 51 tokens in 0.5 s after a 6.3 s wait, rendering ~7.5 t/s against a measured decode rate of 93.6 t/s.
2. **Dispatch overhead before the agent's turn.** The bridge sets `agentStart` when its event pump starts; the agent's `turn/start` followed up to ~7 s later (`followup()` returns immediately — the delay sits in the agent runtime between inbox delivery and turn claim, root cause not yet located). A 1.5 s agent turn rendered as "9s".
3. **Subagent model time charged to the parent.** Inside a turn with a synchronous delegated subagent, the child's model-generation time is neither a parent tool interval (child tool calls are, but the child's thinking between them is not) nor parent output tokens, so it inflates the parent denominator wholesale.

The numerator is correct: the adapter folds each request's `usage.outputTokens` (DeepSeek `completion_tokens` includes reasoning tokens — reasoning-block character counts in the log correlate with it). Across the six report-acknowledgment turns, true decode rates measured 90–130 t/s while the card showed 5–9 t/s; long replies self-dilute the error, which is why only short turns looked broken.

## Decision

`TurnTiming.intervals` is replaced by `generationSpans` (`engine.ts`): a span opens at the first `text_delta`/`thinking_delta` after a quiet period and closes at the parent's own `tool_use` or the `result` event; `fromSubagent` tool calls do not close it (the parent may keep generating while the child runs). The rate becomes `outputTokens ÷ union(generationSpans)`, which excludes all three pollutions by construction. The `openToolIntervals`/`toolIntervalSeq` bookkeeping and the permission-wait interval push existed only to feed the old formula and were removed. Known imprecision, accepted: a span closes at the `tool_use` projection instant, truncating the generation time of the tool-call arguments themselves (small share of a reasoning-heavy step).

## Alternatives considered

**Subtract measured TTFT from the wall-clock formula.** Equivalent in effect but keeps the fragile subtraction chain (every new wait source must be remembered as an interval); the span union needs no enumeration of wait kinds.

**Compute decode time in the adapter from `assistant/chunk` event timestamps.** More precise timestamps, but deltas already reach the engine live (the streaming preview rides them), and the adapter would need a new result-event field plus per-step accumulation for no user-visible gain.

**Go parity.** Go's `thinkingTime` has the same structure; this is a deliberate divergence because the wall-clock formula is structurally wrong for short turns — the same class of decision as the per-turn watchdog clock.

## Consequences

Short turns now render their true decode throughput; providers that stream no deltas produce no spans and the rate line is omitted (dsh providers stream, so this only guards foreign adapters). The duration line (`agentDurationMsg`) still measures pump wall time and therefore still over-reports (~7 s of dispatch overhead); fixing it is a separate decision, as is locating that overhead's root cause in the agent runtime. A queued-turn takeover keeps accumulating spans on the same timing object, mirroring the old formula's cross-turn mixing rather than fixing it.

## Testing

`tests/engine/engine-events.spec.ts` — the rate describe covers four behaviors: pre-first-delta wait excluded from the denominator, the parent's own tool call closing the span (post-tool quiet time excluded), a `fromSubagent` tool call not closing the parent's span, and no-delta turns omitting the rate line.
