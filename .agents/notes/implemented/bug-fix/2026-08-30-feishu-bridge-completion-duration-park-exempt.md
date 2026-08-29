# Agent Note: feishu-bridge completion-card duration excludes parked-ask time

Status: implemented

English | [中文](2026-08-30-feishu-bridge-completion-duration-park-exempt.zh.md)

## Problem

The ✅ completion card header renders `📁 dir · branch · <duration> · <rate>`, and the duration was pure wall clock: at turn end `engine.ts` computed `Date.now() − timing.agentStart` with no deductions. Time the engine spent parked on an ask — a permission approval, an AskUserQuestion card, or a plan review — therefore rendered as agent runtime. Group `oc_babc5d5f` (2026-08-29 session `cc-20260829-224852`): turn 1 spanned 514.7 minutes, of which 490.2 minutes sat between the `exit_plan_mode` call (seq 28772, evening) and its approval tool-result (seq 28773, next morning) — the card showed "514m" for ~24 minutes of actual work (95% wait).

The engine already owned the exact bookkeeping: an ask parks at `capParkStart` and `resumeCapPark` banks the elapsed wait into `capPausedMs`; the hard cap and the stall timeout both exempt that time (2026-08-28 oc_9d385 incident: the cap destroyed an overnight answer one second after it arrived). Only the completion durations ignored it.

## Decision

At the completion-card call site both duration arguments subtract `capPausedMs + parkedNow` (the in-flight park tail, same shape as the hard cap's own exemption check). `setCompletionDurations` itself is unchanged; the caller owns the exclusion, and its JSDoc now records that the values arrive with parked-ask time already removed.

## Alternatives considered

**Keep total wall clock somewhere (users may want elapsed time).** The Feishu message timestamp on the card already shows when the turn ended; the header line is the agent's throughput signal, matching the rate line next to it (which already excludes non-generation time via generationSpans, [2026-08-24](2026-08-24-feishu-bridge-token-rate-generation-spans.md)).

**Also deduct per-turn dispatch overhead (~7 s before `turn/start`).** Rejected for this change: an order of magnitude smaller than an overnight park, its root cause is unresolved in the agent runtime, and subtracting unexplained gaps invites the same wait-source enumeration fragility the generationSpans decision rejected.

**Re-own park accounting across queued-turn takeovers.** A takeover zeroes `capPausedMs` for the hard cap's per-turn budget, so a post-takeover completion card does not deduct the earlier turn's park time. The card's wall clock already spans both turns (Go parity on `turnStart`/`agentStart` being per-run); narrowing that is a separate decision.

## Consequences

A turn that parks overnight now renders its executing time (the oc_babc5d5f turn would have shown "24m" instead of "514m"). Only new cards change; already-delivered cards are not recomputed. Parked-ask time is the user deciding, not the agent working — the same principle the hard cap and the stall timeout already apply.

## Testing

`tests/engine/engine-events.spec.ts` — a turn parks on a permission ask for ~1.2 s, is answered, and completes; the assertion pins `agentDurationMsg` to "0s" (wall-clock math renders "1s"), with `capPausedMs ≥ 1100` as the bookkeeping precondition.
