# Agent Note: feishu-bridge recalls cancel staged attachments

Status: implemented

English | [中文](2026-08-28-feishu-bridge-recall-staged-attachments.zh.md)

## Problem

Recalling a message in Feishu (`im.message.recalled_v1`) only reached `cancelQueuedByMessageID`: it cancelled queued **text** messages (whose attachments ride inside the queued entry) and reported inflight ones. Pure-attachment messages never enter the queue — `stageAttachments` (#8) persists them to `.feishu-bridge/pending/<hash>/` and records them in `InteractiveState.pendingAttachments` keyed by message id. A recalled upload therefore stayed staged: the file remained on disk, and the next text prompt still spliced the recalled file's path into the model-visible bullet list. The port's own recall.ts header claimed "attachments ride inside the queued message", which is only true for text+attachment messages — the Go staged-attachment recall branch was a real gap, not an inapplicable one.

## Decision

`cancelStagedAttachmentsByMessageID` (src/engine/recall.ts) is the pure-attachment recall branch, wired in `Engine.start` next to the queue cancellation inside the single `setRecallHandler` callback. On a match it drops the `pendingAttachments` entries for that message id, deletes their cached files (`rm --force`, fire-and-forget with warn, same shape as `discardStagedAttachments`), removes the pending dir and clears `state.pendingDir` when no staged entry remains, and replies `attachments_cancelled_by_recall` listing the recalled file names and the remaining image/file counts. The two branches are disjoint by construction — pure-attachment messages stage, text messages queue — so the handler runs both unconditionally and order is irrelevant.

A path still referenced by a surviving staged entry is not deleted — the delete stays guarded at this destructive boundary. The name collision that made path aliasing possible (same-name uploads from different messages overwriting each other's bytes in the shared pending dir) is fixed by `uniquePathIn` in src/engine/attachments.ts: `saveImagesToDir`/`saveFilesToDir` suffix `(n)` before the extension while the name is taken, so each staged upload keeps its own bytes.

The `attachments_staged` notice now ends with "send /new to discard, or recall the attachment message" so the affordance is discoverable.

## Alternatives considered

**Folding the branch into `cancelQueuedByMessageID`.** Rejected: `RecallResult` ('cancelled'/'inflight'/'not_found') drives the queued-message reply text (`cancel_queued_by_recall` says "queued message"); a staged hit needs a different reply and a different return contract (boolean). A sibling function keeps both honest.

**Replying "already processing" when the attachment was already drained.** Rejected: after `drainStagedAttachmentPaths` the message id is gone from state, and distinguishing "consumed" from "never staged here" needs a tombstone set for a moot case — the prompt is already sent. Silence matches the existing `not_found` semantics for unknown ids.

## Consequences

A recalled upload no longer reaches the model: staged entries and cached files disappear together, and the user sees what remains staged. If the follow-up text already started a turn (attachments drained), the recall is a silent no-op — the same inherent limit as the inflight queued message. Recalling the *text* message does not touch still-staged attachments; they keep waiting for the next text. Live verification of the whole `im.message.recalled_v1` path (both branches) was already listed as pending daily validation in MIGRATION.md — `lark-cli im messages delete --as user` (high-risk, needs user confirmation) can recall the user's own message, so the smoke can run without a human in the client.

## Testing

`tests/engine/recall.spec.ts`: staged entries for other message ids and their files survive a selective recall; the last staged entry's recall removes the pending dir and clears `state.pendingDir`; a shared path stays when another entry references it; an unmatched id is a no-op. A wiring test through `Engine.start` covers both branches behind the one recall handler: stage → recall drops the file and replies `attachments_cancelled_by_recall`, then a queued message recall still replies `cancel_queued_by_recall`. `tests/engine/attachment-staging.spec.ts` pins the dedup: a name already present in the dir gets a `(n)` suffix (both save helpers), and two same-named uploads from different messages stage to distinct paths with their own bytes.
