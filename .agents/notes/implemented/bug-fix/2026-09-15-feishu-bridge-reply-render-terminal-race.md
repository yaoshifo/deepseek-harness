# Agent Note: Sequence the reply render after the terminal card PATCH

Status: implemented

English | [中文](2026-09-15-feishu-bridge-reply-render-terminal-race.zh.md)

## Problem

The turn-end speculative reply render (#48) forked before the turn's terminal card PATCH landed. The render's status PATCHes (the initial 渲染中, the 30 s ticker, the terminal status) rebuild the card from `lastProgressCard` — the cache of the last `updateMessage` that landed. At fork time that cache still holds the pre-terminal streaming state (typically 思考中), because `patchReplyRenderStatus` goes directly through `updateRenderStatus` while the terminal rides the async-sender terminal queue; the two paths share only the per-message `patchRateWait` token bucket, which has no FIFO. Whenever the initial 渲染中 PATCH landed after the terminal, the settled card was repainted with its old running state — green → 思考中 (violet header + spinner GIF) → green when 渲染已发送 landed — for up to the render duration.

Incident (2026-09-15, group oc_1b7e133f4cdbca98229805023b9afe16): the group's last progress card read 思考中 on the user's client while the reply image (a separate message) rendered fine. The server-side card was already terminal — title 执行完成 · 08:30:45 · 36 with the 已发送 11s status line, unchanged since 08:30 — so the flip window had passed; the client had frozen on the thinking render, most plausibly tripped by the rapid template/icon transitions the race produces. Errored turns have the same shape against their red `markFailed` terminal.

## Decision

`handleResultEvent`'s export block still computes everything where it did — export-key extraction, the discard predicate (it reads pre-branch `sp` state), display text, `exportContent` caching — but no longer forks; it captures the invocation in a `startReplyRender` closure. The fork starts immediately after the terminal-card barrier (`await barrier()`), which drains the shared async sender the terminal PATCH was enqueued on, so the first 渲染中 status PATCH reads a cache that already holds the terminal card. The render fork's wall-clock start shifts by the terminal PATCH duration — sub-second on the non-degraded path; degraded turns never carry an export key (the discard predicate clears it).

## Alternatives considered

- **Fix `updateRenderStatus` to re-read the cache after acquiring the rate slot.** Insufficient: the token bucket is not a critical section, so the read can still precede the terminal's cache write while the PATCH lands after it.
- **Route the render-status PATCHes through the async sender for FIFO with terminals.** Fixes the whole class but re-plumbs the PATCH pipeline (drain semantics, coalescing) — out of proportion for the authorized fix.
- **Start the fork early and pass a "terminal landed" promise into it.** Preserves the early LLM fork start but adds plumbing across the engine/plan-render seam for a sub-second gain; moving the call site is one line.

## Consequences

- The card's header state moves one way — thinking → running → terminal → render-status line; the green/red terminal can no longer be transiently overwritten by a pre-terminal rebuild. Both completed and failed terminals are covered.
- The render fork starts one terminal PATCH later, shifting image delivery by the same sub-second. A turn whose completion branches throw before the barrier now skips the speculative render entirely (it previously started before the branches) — acceptable for a best-effort render, and the export button's cached content is unaffected.
- Residual, same class, not fixed: the pre-ask render path (`captureReplyForExport` → `renderAndDeliverReply`) runs while the card is parked, and its 30 s status ticker can read the cache before a parked-ask settle PATCH writes it and land after — a sub-second window that would repaint a settled parked card with its waiting state. Closing it needs per-message PATCH serialization (FIFO), not a call-site move.
- Tests: `tests/engine/engine-reply-render-order.spec.ts` drives the real event loop and asserts the first render-status PATCH records after the completed (and failed) terminal PATCH. The pre-fix code recorded it between the last thinking PATCH and the terminal — observed RED, then GREEN after the move. Regression: plan-render-fork, plan-render-image, engine-m3-plan, followups, engine-events (246 tests) and the repo typecheck stay green.
