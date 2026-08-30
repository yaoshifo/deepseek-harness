# Agent Note: feishu-bridge /fork seeds a flying turn — balanced cut plus synthetic closure

Status: implemented

English | [中文](2026-08-30-feishu-bridge-flying-turn-fork-seed.zh.md)

## Problem

The 2026-08-30 incident (group `oc_5fd5cd` → forked group `oc_2b8c`): the parent session's only turn had been blocked on an `ask_user_question` card since minutes earlier, so it had **zero completed turns**. The fork seed trimmed everything through the last `turn/end` (Go `copyForkSession` parity) — an empty prefix. The child group was created, the readiness card said "context copied", and the child agent answered that it had received nothing. A turn parked on an interactive card is the canonical mid-flight state, so "fork works only after a turn completes" fails exactly when users branch away from a pending decision.

## Decision

`seedablePrefix` (pure module `agent-dsh/fork-seed.ts`, the `fork-at.ts` precedent) builds the seed for all three consumers — the live parent, `persistedForkSeed`, and `seedForLiveParent` (`/btw`, predict). With no flying turn it is byte-for-byte the old completed-turn prefix. With one, it cuts at the last balanced point by priority: through the last dangling `tool/call` when the open step's assistant message carries calls; through that message when it carries none; at the last `step/end` when the open step holds only streaming chunks; at the last `user/message` before the first step when the turn has no completed step; the whole turn is dropped when it holds nothing user-visible. The cut is closed by synthetic events: one settle per dangling call in the exact shape the runtime writes when `/stop` aborts a blocked tool (isError `AbortError` result with `surfaceOp: 'append'` and `sourceEventSeqs` citing the dangling call; provenance: production log `--home-hm-workspace-money--/cc-20260830-130031` seq 1533-1535), then `step/end`, then `turn/end` with the `interrupted` reason — the existing infrastructure-closure marker, so no vocabulary is extended. The seed contract (no open turn/step, no dangling call, contiguous seq) is preserved by construction, and the parent's own log and still-pending cards are never touched — fork stays non-destructive, Git-branch semantics.

## Alternatives considered

**Fail fast at `cmdFork` when nothing is seedable.** Lost: the requested outcome is that mid-turn forks work, not that they are refused; the refusal only relocates the disappointment.

**Abort the parent turn at fork time, then copy the settled prefix.** Lost: it reuses the abort machinery with zero synthesis, but it tears down the parent's pending ask card — the user may want to answer it in the parent group after exploring the branch. Fork must not make decisions for the parent.

**Drop the open step entirely (only close the turn).** Lost: the cut would always land on the newest, most decision-relevant content — the pending question summarizing the analysis. It also creates an information cliff between "stop then fork" (which keeps the settled step) and "fork mid-flight"; this note removes that asymmetry.

## Consequences

`/fk` mid-flight now inherits what "stop then fork" would: the flying turn's user input, completed steps, and the pending question settled as aborted (the child can re-ask it). Dangling calls of any kind — ask, long bash, gather — settle uniformly and honestly. The readiness card's "context copied" text is true whenever anything is seedable; the residual corner (a session with nothing user-visible) keeps the warn-only fresh degrade. Known follow-up, deliberately out of scope: rollback fork's `cutAfterTurn` returns `events.length` when the quoted message sits in the still-open turn, emitting an unbalanced seed that violates the same contract — fixing it needs quote-aware step semantics, not this prefix.

## Testing

`tests/agent-dsh/fork-seed.spec.ts` covers the five cut shapes, parallel dangling-call settlement, seq contiguity, and loads a fully-shaped synthesized seed through the real `Session.create` boundary; `tests/agent-dsh/adapter-fork.spec.ts` pins the live and persisted paths for the ask-blocked incident shape and the flying-user-message shape.
