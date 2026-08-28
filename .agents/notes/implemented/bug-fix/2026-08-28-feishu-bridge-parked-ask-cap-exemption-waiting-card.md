# Agent Note: feishu-bridge parked-ask wall time is exempt from the hard turn cap; a parked card reads 等待中

Status: implemented

English | [中文](2026-08-28-feishu-bridge-parked-ask-cap-exemption-waiting-card.zh.md)

## Problem

2026-08-28, the oc_9d385 spawned group (推送项目分支): turn 1 started 21:15, ran 184 tool calls, and at 23:04:14 called `ask_user_question` (the「后续处理」follow-up card) and parked. The idle timer is deliberately disarmed while an ask is parked — the user deciding is not a stall — so the turn waited silently overnight. At 07:15:55 the user typed "push"; the engine correctly routed it as the ask's custom answer (tool/result `{"answers":[{"id":"followup-remaining","selected":[],"custom":"push"}]}`) and the agent resumed — and one second later the hard-cap check, which evaluates only on event arrival, measured `now - turnStart` (≈10 h) > `softCap × 3` (3 h with `absoluteTurnTimeoutSecs: 3600`) and force-disposed the turn. The user's answer was destroyed by the very event that delivered it, and the reset notice demanded a resend the user had to re-issue through a full plan-approval round trip. The structural flaw: for a parked ask the only event that can arrive *is* the user's answer, so any ask left open past the cap guarantees its own answer gets eaten.

Second defect from the same incident: the ask-park `completeAndDetach` renders the green 执行完成 card before the permission card even lands — the group showed「执行完成 · 07:38:57 · 2」directly above the ‼️ 权限请求 card it was waiting on — so a turn parked on the user looks finished while nothing has happened.

## Decision

- **Cap clock:** bank parked-ask wall time (`capParkStart`/`capPausedMs` on `InteractiveState`, banked by `resumeCapPark` at every `pendingAsk` clear site) and evaluate `now - turnStart - capPausedMs - capParkedNow > hardCapMs`, exempting both banked and in-flight park time. The user deciding is not the runaway activity the cap exists to kill — the idle disarm's own principle, extended to the arrival-time check. Extends the per-turn clock reset owned by [the watchdog per-turn-reset note](2026-08-21-feishu-bridge-watchdog-per-turn-reset.md).
- **Waiting card:** the ask-park detach renders a new blue `waiting` terminal state (「等待中」) instead of green 执行完成 — the pre-ask segment is delivered, the turn itself still waits. Turn end and the thinking-boundary segment splits keep 执行完成.
- **Hard-cap cleanup parity:** the force cleanup now fails the running card before the kill (`markFailed`, no-op on an already-terminal card — parity with the stall path), and the reset notice states the turn was terminated, context is preserved, and parked question/approval cards are invalid. Same family as [the abnormal-exit fails-preview-card note](2026-08-22-feishu-bridge-abnormal-exit-fails-preview-card.md).

## Alternatives considered

- **Reset `turnStart` when the ask resolves.** Rejected: work→ask→answer cycles each inherit a fresh budget, so a turn that keeps asking never hits the cap; banking park time bounds total active pumping time instead.
- **Evaluate the cap on a wall-clock timer so the kill fires at cap crossing.** Rejected: it would kill parked asks proactively — destroying the pending question — the exact failure class being fixed; arrival-time evaluation plus the exemption keeps the kill for genuinely active turns.
- **Patch the orphaned ask card to a disabled terminal on force cleanup.** Deferred: `sendPermissionPrompt`/`sendAskQuestionsCard` return void, so handle plumbing (sendCardWithHandle + card-JSON cache + disabled-button rebuild) is its own change; after the exemption a kill with a parked ask needs active time alone to exceed the cap, and the notice now names the invalidation.

## Consequences

- An ask left open longer than the cap — overnight included — can be answered normally; the answer is delivered and processed.
- A turn can now span unbounded wall time through repeated asks (every park is exempt); active pumping time stays bounded, so the trickle-forever protection is intact.
- Parked cards read「等待中 · <last tool ts> · <count>」; the post-permission restart still opens a fresh running card, per [the post-permission card-restart note](2026-08-20-feishu-bridge-post-permission-card-restart.md) (its pre-card finalize now lands blue instead of green).
- Diagnostic logging (preview-card send/delete, tail-guard bump) landed to chase the separate 2026-08-28 anomaly: 19 recall tombstones at exactly 3.0 s intervals during one plan-mode turn (07:37:59–07:38:53), not reproduced by the parallel group or the previous night's 2-hour turn — mechanism not yet pinned.

## Testing

`tests/engine/engine-events.spec.ts` "parked-ask wall time is exempt: answering past the hard cap keeps the turn alive" (verified red against the pre-fix check by locally reverting the subtraction); `tests/engine/engine-ask.spec.ts` park bookkeeping (park start set, banked on settle); `tests/streaming.spec.ts` `completeAndDetach(park)` renders the waiting status; `tests/feishu/card.spec.ts` waiting header renders blue「等待中 · ts · n」.
