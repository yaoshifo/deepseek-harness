# Agent Note: Followups card registrations survive daemon restarts

Status: implemented

English | [中文](2026-09-09-feishu-bridge-followups-meta-persistence.zh.md)

## Problem

The followups suggestion card's option texts lived only in the platform's in-memory `askqMetaCache`, written at card send and consumed at submit. Any daemon restart between the two wiped the mapping, so the submission degraded to the index-only `followups_stale` notice — the agent then had to reconstruct the options from its own context and burn a confirmation round (2026-09-09 oc_8451188a: card sent 09-08 18:43, five restarts inside the 18.4-hour window, the 13:09 submit hit a generation with an empty cache; journal signature `followups card callback without cached meta`). The wire payload cannot carry the texts: a form_submit callback drops `action.value` and returns only the checked checker indices.

## Decision

Followups registrations persist in a per-project sidecar (`<dataDir>/sessions/<project>_followups_meta.json`, `FollowupsMetaStore` in `feishu/followups-meta.ts`) and seed `askqMetaCache` at platform init. Only `followups: true` entries are stored: after a restart no engine ask state survives to resolve an askq card, so a followups submit is the only post-restart consumer. The store mirrors the cache's single-slot semantics — a followups card's send writes its entry, any other question card owning the same session key deletes it, and a submission consumes it — so a restart cannot resurrect an entry a newer card retired or a submit already answered. Mutations serialize on an internal tail queue before their atomic rename: two card sends queueing a set and a delete back-to-back would otherwise race independent `atomicWriteFile` renames and could persist the retired entry (the overwrite test caught exactly this ordering). A seven-day retention sweep on write bounds the file across spawned chats.

## Alternatives considered

**Persist all askq metas, not just followups.** Rejected: no post-restart consumer exists for ask cards — the engine's ask state is memory-only and gone with the process — so the extra entries buy nothing.

**Recover the texts from the Feishu-side card on a stale callback.** Rejected: an extra message fetch plus card-JSON parse on a rare path, when the send path already holds everything the store needs at write time.

**Persist through the engine's `pendingFollowups` instead of the platform.** Rejected: that registration owns card emission, while the texts' consumer is the platform's callback path; coupling them adds a cross-layer lookup for no gain.

## Consequences

A submit on a card sent before any number of restarts now dispatches the full readable selection message and freezes the card, indistinguishable from the always-fresh case. Costs: one small JSON sidecar per project, bounded by the retention sweep — a card older than a week still degrades to the stale notice — and a fire-and-forget write that can lose the newest registration to a crash mid-send (same stale degradation, never worse than before). The stale path itself remains for overwritten keys, pre-window cards, and lost writes. Pinned by `tests/feishu/card-action.spec.ts` (post-restart dispatch with full labels and freeze, consumed registration not resurrected, askq overwrite drops the entry) and `tests/feishu/followups-meta.spec.ts` (retention sweep, same-key replacement). Extends the [followups selection message](../architecture/2026-09-07-feishu-bridge-followups-selection-message.md) and the [closing-card conversion](../architecture/2026-09-02-feishu-bridge-closing-card-followups-conversion.md).
