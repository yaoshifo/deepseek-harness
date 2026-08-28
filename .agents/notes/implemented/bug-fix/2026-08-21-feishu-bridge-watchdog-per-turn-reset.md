# Agent Note: feishu-bridge watchdog hard cap counts per turn, not per run

Status: implemented

English | [中文](2026-08-21-feishu-bridge-watchdog-per-turn-reset.zh.md)

## Problem

On 2026-08-21 the Dev-migration group chat (session `cc-20260821-210214-1595171d8f87`) was force-reset mid-investigation by the hard turn cap. Turn 1 (the Dev-server cutover task) legitimately ran 86 minutes and completed normally at 22:28. The follow-up message arrived two seconds later, took over the same engine run as a queued turn (the in-loop drain), and was killed 4 minutes in: `turnStart` is captured once at run start, the queued takeover never reset it, and the run crossed `softCap × 3` (90 minutes with `absoluteTurnTimeoutSecs: 1800`) at 22:32. The watchdog disposed the agent session mid-turn (`turn/end reason: aborted/disposed`), sent the `watchdog_reset` message, and the session auto-reset — the user lost the in-flight investigation and had to resend.

The user-visible contract already promised per-turn semantics: the config key documents "Per-turn wall-clock cap seconds" and the `watchdog_reset` message says "this turn exceeded the maximum turn duration". Go's watchdog measures the same way (per prompt-processing run), so this is a faithful-port bug in the ported shape, not a Go bug fix — Go sessions have the same follow-up-killed-after-long-turn failure mode.

## Decision

`processInteractiveEvents` resets `turnStart` in the `result`-event branch when a queued message takes over the loop as a fresh turn (`finished.kind === 'queued'`), alongside the other per-turn state resets. Arrival-time enforcement, the 3× multiplier, and the research exemption are unchanged. The stall-retry path deliberately does **not** reset: its `继续` injection serves the same logical turn, and resetting there would let an infinitely stalling-and-retrying session dodge the cap forever. This is a deliberate deviation from Go's per-run clock, recorded in MIGRATION.md 补充 24.

## Alternatives considered

**Keep Go's per-run clock and reword the message to say "session run".** Rejected: the damage is real regardless of wording — after any near-cap long turn, the next queued message inherits a nearly exhausted budget and is killed within minutes. The config JSDoc, the i18n message, and user expectation all say per-turn; the clock is the divergence.

**Renew the clock on any inbound user activity.** Rejected: the queued drain is the only in-run user takeover; mid-turn splices and steer injections belong to the running turn and must not refresh its budget.

**Reset on stall retry as well.** Rejected: stall retry restarts the agent for the same logical turn. A reset would make the hard cap — the only backstop for a turn whose events trickle in forever while stall retries loop — unreachable.

## Consequences

Every turn now gets a full hard-cap budget, so a follow-up instruction after a long turn survives. In exchange, a run that keeps queueing follow-ups can span many multiples of the cap in aggregate; each individual turn remains bounded, and the trickle-forever protection (the cap's original purpose) is intact because it has always been per turn in effect. A turn that ends exactly at the cap boundary no longer poisons the next one. Research sessions keep the exemption. Since 2026-08-28 the clock additionally excludes parked-ask wall time (banked per park) — the user deciding is not runaway activity, and for a parked ask the first arriving event is the answer itself; see [the parked-ask cap-exemption note](2026-08-28-feishu-bridge-parked-ask-cap-exemption-waiting-card.md).

## Testing

`tests/engine/engine-events.spec.ts` "queued takeover resets the hard-cap clock (per-turn, not per-run)": turn 1 completes after 500 ms, a queued message takes over, and the run must survive past the old run-level deadline (3.6 s) while still being force-cleaned after the takeover's own deadline — red before the fix (turn 2 killed at the run-level deadline), green after. Full package suite green (2042 tests).
