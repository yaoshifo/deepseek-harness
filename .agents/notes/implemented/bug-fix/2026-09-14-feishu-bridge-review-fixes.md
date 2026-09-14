# Agent Note: Post-review fixes across the bridge delivery, render, and session paths

Status: implemented

English | [中文](2026-09-14-feishu-bridge-review-fixes.zh.md)

## Problem

A same-day review of the 2026-09-14 audit-fix batches found nine defects on four surfaces:

- The answer-delivery warning read `sp.answerDelivery` before `await barrier()`, but the streaming card's terminal PATCH (and its fallback classification) only runs inside the barrier — the worst case that batch targeted, a failed terminal PATCH plus a failed fallback re-delivery, still ended the turn as pure success with no warning and no saved copy.
- A killed turn's partial delivery wrote `state.answerDelivery` that nothing consumed (the kill path cleaned up and returned before the warning block), and its plain-text re-delivery lacked the turn-end `inProgressMode` guard, re-sending a segment the failed card still carried live.
- The gather summary banked each child's full report text before the report-dedup check, so a gathered child that had already sent the same text directly was still read twice.
- SIGTERM — the `/reload` restart path — bypassed the debounced session-store save entirely (a signal death never runs `beforeExit`), losing whatever sat in the debounce window.
- The post-start reload settlement accessed `ctx.tools` after an `await captureBuildInfo()`, and an HMR-disposed fiber turned that access into seven unhandled rejections that fail the whole vitest run.
- The initial 'rendering' PATCH was fire-and-forget, outside `progressInflight`, so a late-landing initial PATCH could flip a settled card's status line back to rendering.
- A deliver-stage abort whose PNG render also failed settled the render as `failed` instead of `cancelled` — the user's own cancellation read as a render failure.
- `classifyDeliveryFailure` treated any HTTP status — including 502/503/504 — as `'failed'`, whose wording invites a re-send even though a gateway 5xx does not prove the server skipped the create.
- The five interactive-card send paths carried no intent uuid and kept deadline retries, so a post-delivery timeout could double-send a card with live buttons.
- The inter-segment text flush sent through the error-swallowing plain send and advanced `segmentStart` unconditionally: a failed segment was lost forever while the turn still read as pure success.
- The degraded branch deleted the frozen card before re-delivering its answer — the discard-then-deliver shape u5 removed from `fallbackSend`.
- A killed turn whose answer lived only on the in-progress card's live-narration segment lost that segment when the terminal PATCH and the fallback both failed: the text re-delivery guard suppressed it and nothing warned or saved.

## Decision

**Warning after the barrier.** The sp→state answer-delivery sync and the warning/save decision run after `await barrier()` and before the ✅ completion card. Card-less platforms, whose `deliverAnswerText` writes the state synchronously, behave as before. The regression test drives a real macro-task delay on the terminal PATCH — a micro-task ordering would pass vacuously.

**Kill-path settlement.** The kill path records `lastBaseResponse` before delivering the partial, settles a failed partial through the same warning-and-save block as turn end, and the segment re-delivery respects `inProgressMode`: a card still carrying the streamed segment live is not re-sent as plain text.

**Gather dedup.** A gathered child whose report repeats its prior direct `send_message` text verbatim is banked into the summary as the shared one-line status (the card still carries the full text), the same wording the single-report path uses.

**SIGTERM flush.** `hookSigtermFlush()` is a reference-counted, idempotent disposer the Engine registers on construction and drops in `stop()`. The listener flushes pending saves synchronously, then re-raises `SIGTERM` (`process.kill(process.pid, 'SIGTERM')`) — the once-listener is already removed, so the process dies by the same signal it would have died by before the flush; it never converts a signal death into a clean exit. The daemon's long-lived sockets keep the event loop alive, so without the re-raise the process would survive its own termination signal.

**Fail-soft reload settlement.** The post-start callback is wrapped: a fiber that died mid-await logs and abandons the settlement (the replacement fiber re-runs it; the marker TTL bounds the retry), instead of resurrecting `ctx.tools` from a disposed context.

**Initial PATCH drains.** The initial 'rendering' PATCH's promise joins `progressInflight`, so all four exits of `drainProgress` cover it and a late initial PATCH cannot land after the terminal state.

**Abort settles cancelled.** The two deliver-stage catches classify by `parentCtl.signal.aborted ? 'cancelled' : 'failed'`; an abort whose delivery still succeeds keeps `delivered`.

**5xx is unknown.** `status >= 500` classifies as `'unknown'`; only a status below 500 or a Feishu business code proves rejection (`'failed'`).

**Cards are idempotent.** Each card send path (reply card, send card, send card with handle, send preview) mints one intent uuid per send intent — shared across the path's internal create/reply fallbacks — and passes `retryOnDeadline: false`, matching the text path's u6 contract.

**Segment flush settles by verdict.** The inter-segment flush records its delivery outcome and branches on it: a definite `'failed'` holds `segmentStart` (the segment stays unsent; the next flush or the turn-end/kill settlement re-delivers a superset, and a later success clears the record), while `'unknown'` advances the boundary — a retry could duplicate an already-landed segment — and stays sticky across later merges. The turn-end gate widens to include `answerDelivery === 'failed'` so a first-segment failure with `segmentStart === 0` still reaches the remainder path, and the state/sp outcome merge takes the worse of the two.

**Degraded delivers, then discards.** The degraded branch re-delivers the answer before deleting the frozen card, so a failed re-delivery leaves the card as the answer's remaining carrier (and records the failure for the warning block).

**Killed cards settle by terminal outcome.** The kill path awaits the sender barrier, then reads the final `sp.answerDelivery`: `'sent'` keeps the text re-delivery excluded; `'unknown'` records without re-sending (the fallback may have landed); a definite `'failed'` — terminal PATCH and fallback both provably never landed — re-delivers the segment as plain text, warns, and saves the copy. The re-delivery is mutually exclusive with the in-card fallback by construction: it runs only after that fallback itself definitely failed.

## Consequences

A turn whose answer could not provably land now warns and saves a recoverable copy on every path — card terminal failure, kill-path partial failure included — instead of only the synchronous text path. A killed turn no longer re-sends a segment its failed card still carries. Gather summaries never repeat a child's already-delivered text. A `/reload` restart loses at most writes newer than the last synchronous save instead of the whole debounce window. `pnpm run test` is green again (the unhandled rejections are gone). Card statuses settle consistently under abort. A gateway 5xx no longer invites a re-send that could duplicate an answer, and interactive cards cannot double-deliver on a deadline retry.

## Alternatives considered

Capturing `ctx.tools` before the `captureBuildInfo()` await was rejected for the reload settlement: the reference stays usable after disposal, letting a dead fiber's continuation send notices from a stopped platform and consume the completion marker ahead of the replacement fiber. `process.exit(0)` after the SIGTERM flush was rejected because it would disguise a signal death as a clean exit and change what launchd/systemd observe; the re-raise preserves the pre-fix death semantics. Keeping 5xx as `'failed'` was rejected: only a sub-500 status or a Feishu business code proves the server rejected the create. Server-side card idempotency beyond the uuid contract was out of scope — the client-side uuid plus no-deadline-retry already bounds the double-send window to one attempt.
