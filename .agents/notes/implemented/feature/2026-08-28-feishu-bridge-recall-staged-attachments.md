# Agent Note: feishu-bridge recalls cancel staged attachments

Status: implemented

English | [中文](2026-08-28-feishu-bridge-recall-staged-attachments.zh.md)

## Problem

Recalling a message in Feishu (`im.message.recalled_v1`) only reached `cancelQueuedByMessageID`: it cancelled queued **text** messages (whose attachments ride inside the queued entry) and reported inflight ones. Pure-attachment messages never enter the queue — `stageAttachments` (#8) persists them to `.feishu-bridge/pending/<hash>/` and records them in `InteractiveState.pendingAttachments` keyed by message id. A recalled upload therefore stayed staged: the file remained on disk, and the next text prompt still spliced the recalled file's path into the model-visible bullet list. The port's own recall.ts header claimed "attachments ride inside the queued message", which is only true for text+attachment messages — the Go staged-attachment recall branch was a real gap, not an inapplicable one.

## Decision

`cancelStagedAttachmentsByMessageID` (src/engine/recall.ts) is the pure-attachment recall branch, wired in `Engine.start` next to the queue cancellation inside the single `setRecallHandler` callback. On a match it drops the `pendingAttachments` entries for that message id, deletes their cached files (`rm --force`, fire-and-forget with warn, same shape as `discardStagedAttachments`), removes the pending dir and clears `state.pendingDir` when no staged entry remains, and replies `attachments_cancelled_by_recall` listing the recalled file names and the remaining image/file counts. The two branches are disjoint by construction — pure-attachment messages stage, text messages queue — so the handler runs both unconditionally and order is irrelevant.

A path still referenced by a surviving staged entry is not deleted: same-name uploads from different messages share one file (`saveFilesToDir` writes `join(dir, fileName)` and overwrites), so deleting on recall would destroy the other message's attachment. The overwrite itself is the pre-existing collision defect, out of scope here.

The `attachments_staged` notice now ends with "send /new to discard, or recall the attachment message" so the affordance is discoverable.

## Alternatives considered

**Folding the branch into `cancelQueuedByMessageID`.** Rejected: `RecallResult` ('cancelled'/'inflight'/'not_found') drives the queued-message reply text (`cancel_queued_by_recall` says "queued message"); a staged hit needs a different reply and a different return contract (boolean). A sibling function keeps both honest.

**Replying "already processing" when the attachment was already drained.** Rejected: after `drainStagedAttachmentPaths` the message id is gone from state, and distinguishing "consumed" from "never staged here" needs a tombstone set for a moot case — the prompt is already sent. Silence matches the existing `not_found` semantics for unknown ids.

## Consequences

A recalled upload no longer reaches the model: staged entries and cached files disappear together, and the user sees what remains staged. If the follow-up text already started a turn (attachments drained), the recall is a silent no-op — the same inherent limit as the inflight queued message. Recalling the *text* message does not touch still-staged attachments; they keep waiting for the next text. Live verification of the whole `im.message.recalled_v1` path (both branches) was already listed as pending daily validation in MIGRATION.md — lark-cli cannot recall a user message, so the smoke needs a human recall.

## Testing

`tests/engine/recall.spec.ts`: staged entries for other message ids and their files survive a selective recall; the last staged entry's recall removes the pending dir and clears `state.pendingDir`; a shared path stays when another entry references it; an unmatched id is a no-op. A wiring test through `Engine.start` covers both branches behind the one recall handler: stage → recall drops the file and replies `attachments_cancelled_by_recall`, then a queued message recall still replies `cancel_queued_by_recall`.
