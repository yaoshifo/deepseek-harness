# Agent Note: post-permission preview card restart in feishu-bridge

Status: implemented

English | [中文](2026-08-20-feishu-bridge-post-permission-card-restart.zh.md)

## Problem

Go's interactive event loop treats a pending permission as a two-step phase boundary. At permission-card time (core/engine_events.go ~4192-4225) it strips the streamed plan text off the live card, flushes the accumulated text segment as plain messages only when the preview is degraded (advancing `segmentStart` either way), then completes and detaches the live card BEFORE the user answers. After resolution (the block after `pending.Resolved`) it flushes whatever segment remains, detaches any still-started preview, creates a fresh streamPreview and compactProgressWriter, re-binds the active preview, and pre-creates an execution-phase placeholder — "subsequent execution info appears in a new message rather than being appended to the pre-interaction card". The TS port of the `permission_request` case (src/engine/engine.ts) had neither half: only the `textParts`/`segmentStart`/`silentHold` reset survived. Symptom: after the user approved an ExitPlanMode plan card, post-approval tool progress kept PATCHing the pre-plan tool-progress card instead of opening a fresh card.

## Decision

Port both halves of Go's permission handling. **At permission-card time** (Go engine_events.go ~4192-4225): strip the streamed plan text from the live card (`sp.removeText`), flush the accumulated text segment as plain messages only when the preview is degraded (advance `segmentStart` either way), then `barrier()` + `sp.completeAndDetach()` — the live card is finalized BEFORE the user answers, with the speculative reply render captured before the detach (`!session.shouldSuppressAutoRender()` joins the trigger condition). **After resolution** (the block after `pending.Resolved`): flush any remaining segment, detach if a preview is somehow still started, reassign `sp`/`cp` (both now `let`), re-bind the active preview, mirror `state.preview`, and show a fresh placeholder when `display.toolProgress` is on; `toolCount` joins the reset. The post-resolution detach is a safety net in the normal flow — the pre-card detach already found and finalized the live card — and the block covers every permission resolution on this path: plan approvals, ordinary tool approvals, and AskUserQuestion answers alike, matching Go. Since 2026-08-25 the restart runs only when the ask settled by a user decision: stopped/aborted outcomes (session teardown or recycling) skip it, because the restart's placeholder would strand a running card nobody finalizes ([stray-card note](2026-08-25-feishu-bridge-done-during-parked-ask-stray-card.md)).

## Alternatives considered

**Swap only the compact writer (`cp`).** Rejected: in tool-progress mode the placeholder and the tool-progress entries live on `sp`'s card; both writers own the pre-interaction card, so swapping one leaves the other PATCHing the old message.

**`cp.finalize('completed')` instead of detaching.** Rejected: finalize PATCHes a terminal state but keeps the handle, so later appends would still target the pre-interaction card.

**Detach only after resolution.** The first cut of this fix did exactly that; the real-device smoke showed the accumulated pre-interaction text then flushes as a separate plain card between the approval and the new progress card, duplicating text the completed card already shows. Go detaches at permission-card time and advances `segmentStart` there, so the post-resolution flush is normally empty — that ordering is the actual load-bearing half.

## Consequences

When a permission card (or AskUserQuestion card) goes out, the live progress card is finalized on the spot (green, export buttons live from the captured snapshot); post-approval execution opens a fresh placeholder card. With an active preview the pre-interaction text stays on the completed card — it is re-sent as plain messages only when the preview is degraded, matching Go. Go's plan-file archiving on approval (`pendingPlanArchive`, copy with timestamp suffix on approve) is not ported here — recorded as a separate migration gap.

## Testing

`tests/engine/engine-m3-permission.spec.ts` `PostPermissionCardRestart`: text → tool_use → write permission → resolve → tool_use → result against a preview-capable stub platform; asserts two preview starts (turn-entry placeholder plus post-approval placeholder), that post-approval progress PATCHes land only on the new handle, that the old card receives no updates after the permission card goes out (pre-card detach), and that the pre-interaction text is not re-sent as a plain message while the preview is active. Package suite 1844 green, oxlint/typecheck 0. Real-device smoke (2026-08-20, dev-shrimp group): tool-progress card finalized the moment the plan card appeared; after approval, execution opened a new progress card directly with no interim plain-text card; plan executed correctly on disk.
