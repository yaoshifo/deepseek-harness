# Agent Note: feishu-bridge abnormal exits fail the preview card; user stops cancel with the user cause

Status: implemented

English | [中文](2026-08-22-feishu-bridge-abnormal-exit-fails-preview-card.zh.md)

## Problem

Two port gaps surfaced while re-verifying the follow-ups to the [stop-finalizes-preview note](2026-08-22-feishu-bridge-stop-finalizes-preview-card.md):

Go cc-connect renders a terminal preview card on every abnormal turn exit — stall retry retires the card and starts a fresh one (`engine_events.go:2730`), stall-retry exhaustion fails it (`:3628`), an unexpected channel close fails it (`:5121`, with a comment citing Go's own 2026-08-17 incident where the card froze mid-state until the user resent), and the post-stop event arrival renders stopped-or-failed (`:3649`). The TS port kept only the event loop's stop arm: a crashed agent, a stalled-out session, or an externally stopped state with buffered events each left the card frozen in its Running state next to a text notice — the same freeze shape as the oc_74a7 incident, minus the user-stop trigger.

Separately, `DshAgentSession.cancelTurn()` — the port of Go's `AgentInterrupter.Interrupt`, which Go's `stopInteractiveSession` prefers over `Close` for user stops — had no production caller, so every user stop recorded `turn/end reason aborted/disposed` in the durable session log instead of `aborted/user`.

## Decision

The engine now fails or terminalizes the preview card on the abnormal exits, mirroring Go: the stall-retry branch retires the stalled card with `markFailed()` and rebuilds `sp`/`cp` (same shape as the queued-takeover restart) so the resumed 「继续」 turn PATCHes a fresh card; stall-retry exhaustion and the post-stop event arrival render the terminal card before cleanup (`userStopped`/`engineStopped` → `markStopped()`, any other stop → `markFailed()`); `handleChannelClosed` fails `state.preview` on an unexpected exit. One deliberate divergence from Go's unconditional `unexpectedExit` gate there: `Engine.stop()` leaves `stopped` unset by design (it distinguishes reload from crash) and already rendered its own ⏹ card, so the channel-closed failure render exempts `engineStopped` — otherwise the red card would clobber the reload ⏹.

`stopInteractiveSession` now calls `asAgentInterrupter(agentSession)?.cancelTurn()` before `close()`: the in-flight turn aborts with the user cause and the durable log records `aborted/user`. Unlike Go's either-or — where `Interrupt` kills the subprocess outright — the dsh cancel keeps the agent handle alive, so `close()` still owns teardown; cancel-then-close, not cancel-instead-of-close.

## Alternatives considered

**Fixing only the user-stop incident path.** Leaves the crash/stall freezes — Go's 2026-08-17 incident is the exact precedent that they bite in production.

**Failing the card unconditionally on channel close (strict Go mirror).** Would overwrite the reload ⏹ rendered by `Engine.stop()`, trading one inconsistency for another; the `engineStopped` exemption keeps each stop kind's card correct.

**Replacing `close()` with `cancelTurn()` (strict Go either-or).** Leaks the agent handle — dsh's cancel does not unregister or dispose; teardown stays with `close()`.

**Closing `state.sender` at stop, as Go does.** The TS finalize is fire-and-forget and queues on the preview lock; its barrier needs the sender open to drain in-flight Running PATCHes before the ⏹ card. Closing early would let an in-flight Running PATCH land after the stopped card. `degraded` already stops new enqueues and a fresh state gets a fresh sender.

## Consequences

A crashed agent or stalled-out session now ends with a red 执行失败 card instead of a frozen Running one; a stall retry visibly retires the old card. User stops record `aborted/user` in the session log (model-visible on replay). The watchdog hard-cap exit still leaves the card unfinalized in both Go and TS — a shared gap deliberately not diverged from.

## Testing

`tests/engine/engine-events.spec.ts` ("abnormal-exit preview finalization"): unexpected channel close renders `__cc_state__:failed`; post-stop event arrival renders failed for non-user stops and exactly one `stopped:` for user stops. "Interrupt preference": `cancelTurn` fires before `close`, and sessions without it stop unchanged. `tests/engine/engine-stall-retry.spec.ts`: the retry retires the card with a failed render and starts a fresh one; exhaustion fails the card. feishu-bridge suite: 2085 passing.
