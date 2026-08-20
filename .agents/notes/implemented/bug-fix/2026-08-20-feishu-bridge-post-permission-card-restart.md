# Agent Note: post-permission preview card restart in feishu-bridge

Status: implemented

English | [中文](2026-08-20-feishu-bridge-post-permission-card-restart.zh.md)

## Problem

Go's interactive event loop (core/engine_events.go, the block after `pending.Resolved`) treats every user interaction that resolves a pending permission as a phase boundary: it flushes the un-flushed text segment as plain messages, completes and detaches the pre-interaction streaming card, creates a fresh streamPreview and compactProgressWriter, re-binds the active preview, and pre-creates an execution-phase placeholder card — "subsequent execution info appears in a new message rather than being appended to the pre-interaction card". The TS port of the `permission_request` case (src/engine/engine.ts) kept only the `textParts`/`segmentStart`/`silentHold` reset: `sp`/`cp` kept their handles, so after the user approved an ExitPlanMode plan card, post-approval tool progress kept PATCHing the pre-plan tool-progress card instead of opening a fresh card.

## Decision

Port the Go block at the permission-resolution point in `processInteractiveEvents`: when the resolved preview has started, flush `textParts[segmentStart:]` as split platform messages, then `sp.completeAndDetach()`; afterwards reassign `sp`/`cp` (both now `let`), re-bind the active preview, mirror `state.preview`, and show a fresh placeholder when `display.toolProgress` is on. `toolCount` joins the reset. The block covers every permission resolution on this path — plan approvals, ordinary tool approvals, and AskUserQuestion answers alike, matching Go.

## Alternatives considered

**Swap only the compact writer (`cp`).** Rejected: in tool-progress mode the placeholder and the tool-progress entries live on `sp`'s card; both writers own the pre-interaction card, so swapping one leaves the other PATCHing the old message.

**`cp.finalize('completed')` instead of detaching.** Rejected: finalize PATCHes a terminal state but keeps the handle, so later appends would still target the pre-interaction card.

## Consequences

Every mid-turn permission interaction now splits the turn's cards at the interaction point: the pre-interaction card is finalized (green), and execution continues on a new card with a fresh placeholder. The un-flushed pre-interaction text segment is delivered as plain messages before the old card detaches, so intro text preceding a plan card is not lost. Go's plan-file archiving on approval (`pendingPlanArchive`, copy with timestamp suffix on approve) is not ported here — recorded as a separate migration gap.

## Testing

`tests/engine/engine-m3-permission.spec.ts` `PostPermissionCardRestart`: tool_use → write permission → resolve → tool_use → result against a preview-capable stub platform; asserts two preview starts (turn-entry placeholder plus post-approval placeholder) and that post-approval progress PATCHes land only on the new handle. Package suite 1844 green, oxlint/typecheck 0. Real-device verification: observe a plan-mode turn with tool progress before the plan card — after approval, execution must open a new progress card.
