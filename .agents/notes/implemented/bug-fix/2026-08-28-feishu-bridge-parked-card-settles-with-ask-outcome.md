# Agent Note: feishu-bridge parked cards settle to the ask outcome when the decision lands

Status: implemented

English | [中文](2026-08-28-feishu-bridge-parked-card-settles-with-ask-outcome.zh.md)

## Problem

2026-08-28, the oc_b20512 group (dsh-memory rename): turn 4 ran 12 tool calls, called `exit_plan_mode` at 14:50:10, and the live progress card parked blue「等待中 · 14:50:11 · 12」. The user clicked 允许 at 14:55:10: the permission card swapped to ✅ 已允许, the chat-phase avatar went green, and the post-decision restart opened a fresh card that carried the rest of the turn — every functional path worked. But the parked card stayed 等待中 forever: `completeAndDetach(park)` drops the preview handle (`previewMsgID = undefined`), and every terminal render (`markCompleted`/`markFailed`/`markStopped`) bails on the missing handle, so no settlement path could ever touch the card again. A card whose ask the user already answered keeps claiming the turn is waiting — reading the chat history later, the approval looks like it never took effect. Extends [the parked-ask cap-exemption / waiting-card note](2026-08-28-feishu-bridge-parked-ask-cap-exemption-waiting-card.md), which defined the waiting header but not its settlement. At merge time the same-day waiting-card export-buttons change (buttons on blue) collided with this fix: the settle re-render would strip the buttons the user just gained the moment they answered, so the merge also made button eligibility state-keyed.

## Decision

- Park keeps the card's handle reachable for settlement: `completeAndDetach` now returns the detached handle; the ask flow captures it next to the preview writer it parked.
- When the ask settles — decided, stopped, and aborted outcomes alike, plus best-effort on the delivery-interruption race — the engine PATCHes the parked card's header to the ask outcome before restarting surfaces: approved「已批准」(turquoise), rejected「已拒绝」(red), answered「已回答」(turquoise), cancelled「已取消」(grey), mapped from the `AskDecision` by `parkedOutcomeOf`. The settle PATCH is best-effort: a failure logs and leaves the waiting header.
- Settled headers never use green — green claims 执行完成, which the pre-ask segment is not. They keep the export/reply buttons their waiting render carried: `injectReplyButtons` gained state-keyed eligibility (`buttonState` from the PATCH content; completed, waiting, and the settled states all carry registered export content, while running yellow/violet stay bare so a click cannot fall back to the previous turn's reply — state keying also splits settled rejected from failed on the same red template). The ⏹ stop button leaves settled cards: its target is the post-decision turn's fresh card.
- The post-permission card restart is untouched: post-decision execution still opens a fresh card ([the card-restart note](2026-08-20-feishu-bridge-post-permission-card-restart.md) is load-bearing), and the parked card keeps the pre-ask segment's tool history as the visible record.
- Settled headers carry no spinner icon: `spinnerKeyForState` treats the four settled states as terminal (like completed/failed), so the settle re-render rebuilds the card without `header.icon` — the executing spinner beside 已批准 misreads as still running. Waiting keeps the executing indicator: the turn is still in flight while parked on the user's answer.

## Alternatives considered

- **Resume PATCHing the same card instead of restarting surfaces.** Rejected: the restart resets per-phase state (`textParts`, `toolCount`) so post-decision execution starts clean; resuming would drag the pre-ask card — and its displacement reissue carrying every old entry — through the plan, permission, and image cards.
- **Delete the parked card on settle.** Rejected: the card is the visible record of the pre-ask segment; deleting it loses the research history the plan was built on.
- **Settle only plan reviews.** Rejected: permissions and AskUserQuestion park the same way and strand the same frozen 等待中 card; the settle point is shared, so all ask kinds settle.

## Consequences

- No card in a chat keeps claiming 等待中 after its ask resolved; scrolling back reads 已批准/已拒绝/已回答/已取消 with the settle timestamp and the pre-ask tool count, and without the running spinner.
- A settled card keeps its export/reply buttons (the registered pre-ask reply stays retrievable) and carries no stop button.
- A stop during a parked ask now leaves a terminal grey 已取消 card instead of an orphaned blue waiting card (the stop render itself still no-ops on the detached handle).
- The delivery-interruption race (a stop landing while the cards are still being sent) can miss the settle — the handle is captured inside `deliverCards`, which keeps running in the background after the interruption; that rare path keeps the pre-fix waiting header.
- Engine tests on stub platforms without `updateMessage` see the settle as a no-op; only preview-capable recorders observe the PATCH.

## Testing

`tests/engine/engine-m3-plan.spec.ts` `PlanReviewParkedCardSettle` (approve → the parked card PATCHes running→waiting→approved and the restart placeholder still opens; deny → rejected); `tests/streaming.spec.ts` `settleParkedCard` (outcome PATCH keeps the tool-entry body; no-op when never parked; idempotent on double settle) and the `completeAndDetach(park)` handle return; `tests/feishu/card.spec.ts` settled headers render turquoise/red/turquoise/grey and never green; `tests/feishu/spinner.spec.ts` the settled states render no header icon while waiting keeps the executing indicator; `tests/feishu/progress.spec.ts` state-keyed button eligibility (settled states keep both buttons, failed red stays bare) and settled templates hide the stop button. Package suite green; `tsc -b` on the package graph clean.
