# Agent Note: A settled card never re-opens as a second message

Status: implemented

English | [中文](2026-09-17-feishu-bridge-duplicate-completion-card.zh.md)

## Problem

Two groups saw the same「执行完成」card twice on 2026-09-17:

- oc_f7b306: the turn's card, created at 20:50:17 and settled at 21:10:03, appeared a second time at 21:11:07 as a new message at the chat tail. The copy was identical except for the four nodes only an in-place update injects — the `💡 1 个后台任务` body line, the 导出文件 / 查看完整回复 buttons, and the `✅ 已发送 26s` render status.
- oc_f85284: the turn's card settled at 14:38:00 and a second copy appeared at 15:09:09, headed 15:09:08 instead of the settlement time — the observation [the background-count reconcile note](2026-09-17-feishu-bridge-bg-count-leak-reconcile.md) first recorded. A hint clear and a card send land in the same second 23 times across the retained daemon logs (2026-09-01 through 2026-09-17), each pairing one second after a background-grace give-up or a reconcile tick.

The chain, identical in both:

1. A `run_in_background` call set the card's `💡 N` background hint.
2. The turn settled through the settle-and-freeze path: `markCompleted`/`markFailed` rendered the terminal card, then `detachPreview` cleared the handle while the `StreamPreview` stayed bound to the session state. That detach is deliberate — the card is the turn's history, and only in-place updates belonged to it.
3. Later, the unsolicited reader cleared the hint: the reconcile tick for a leaked count, or the grace-exhausted give-up. `setBackgroundHint` carries no `degraded` guard, `flushProgressLocked`'s inline path none either, and `flushLocked`'s no-handle branch opened a message unconditionally — so the detached preview re-sent the whole settled card.

The flush only decides "no handle → send a new card"; every path into it (hint clear, todo section, pending-subtask count, text append) inherits the same trap, so the defect class is "a terminal preview re-opens", not "the hint clear re-sends".

## Decision

`flushLocked` refuses to open a message for a terminal preview: entering the no-handle branch, `completed || failed || degraded` returns before any send. That is the same terminal set `reissueLocked` refuses for create-new-delete-old, applied to the create — a settled or frozen card is terminal in both directions. The in-place PATCH path is untouched, so a hint clear still reaches a card that holds a handle (2026-09-16 oc_3c16b semantics preserved).

The engine's two hint-cleanup comments (`engine.ts`, the reconcile tick and the grace-exhausted give-up) state the limit: the clear reaches only a card that still holds a handle.

A settled card the engine detached therefore keeps the hint its settlement render carried. That snapshot is what the card showed while the turn ran; the late clear could never have updated it — it could only add a second card.

## Alternatives considered

- **Guard each engine cleanup call site.** Four sites clear a hint or a count-derived title, and the same trap sits under the todo/subtask/text flushes the engine does not call through those sites; per-caller guards would leave the defect reproducible from the next caller. The decision belongs where the message is opened. Rejected.
- **Reconcile the count before the terminal render** so a leaked count never renders `💡` on a settled card. It removes this incident's hint but not the class: a genuinely pending job whose grace later expires still flushes after settlement. Worth doing for display honesty on its own, not as this fix. Rejected here.
- **Route the hint clear through the parked card's handle** (`settleParkedCard`'s argument). A settled card keeps no handle to route through — that is what detaching means — and the parked card's hint is equally a snapshot. Rejected.

## Consequences

- A settled or frozen card can no longer add a message to the chat: the only updates it accepts are in-place PATCHes, and a detached card accepts none.
- The frozen card's `💡 N` hint is a settlement-time snapshot. When the count was already stale at settlement the line reads wrong — fixed at the source by the [reconcile note](2026-09-17-feishu-bridge-bg-count-leak-reconcile.md)'s registry probe, not by re-rendering a dead card.
- Cost: a hint clear that used to produce a visible (duplicate) card now produces nothing. Recovery from a mistake here means re-deploying, not a card edit.
- Duplicate-card triage: a `feishu: preview card sent` line with no matching `preview card deleted` is a new message, not a reissue — the reissue path always deletes the card it replaces.

## Testing

- `tests/streaming.spec.ts`: a completed card and a failed card, each detached after settlement, take no further platform call when the hint clears; the settled parked card case now asserts the clear opens no message and the card keeps its outcome clock (it previously pinned the duplicate as expected behavior).
- `tests/feishu/preview-send.spec.ts`: the same scenario over the real platform — a settled, detached preview issues exactly one card create.
