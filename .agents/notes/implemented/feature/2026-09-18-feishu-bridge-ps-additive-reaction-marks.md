# Agent Note: Additive /ps reaction marks; the pickup emoji is never retracted

Status: implemented

English | [中文](2026-09-18-feishu-bridge-ps-additive-reaction-marks.zh.md)

## Problem

The `/ps` pickup mark was a swap: `Get` when the text entered the agent's next-step inbox, retired as the claim landed and replaced by `DONE` — or by the configured stop emoji when the turn died first ([the three-state note](2026-09-17-feishu-bridge-ps-three-state-reaction.md)). One emoji per message therefore showed only the current state and erased what the message had already been through: a steer that completed and a steer that died on the way end up looking alike, and a message cannot show that its text was accepted at all once its outcome is known.

The swap also could not be made reliable. Retiring the pickup needs the reaction id of its add, so a claim arriving before that add resolves skipped the retraction (the pending record was already gone) and left a `Get` stranded beside the `DONE` forever; a retraction exhausting its retries left the same residue. Both were documented as accepted races rather than fixable under the swap.

The user ruled the other way after living with it: the pickup is a record of something that happened (the text was accepted into the inbox), the outcome is a separate fact, and both belong on the message.

## Decision

`/ps` leaves two additive marks on the triggering message.

**Pickup.** `cmdPs` adds `Get` through the plain fire-and-forget platform add: no reaction id is requested, none is kept. `PendingSteerReaction` holds only `{platform, replyCtx}` under the steer message id, and the pending map is a plain bounded map whose eviction retracts nothing.

**Outcome.** `settleSteerReaction` drops the pending record and adds the terminal emoji beside the pickup, never in place of it: `DONE` when the claim event reports the text reached a model request, `addCancelledReaction` (configured `cancelEmoji`, default `CrossMark`, `'none'` off) when the turn dies first. `settlePendingSteerReactions` keeps its job — teardown hands every still-pending pickup the stop emoji — and now removes nothing.

**One path for every platform.** The id-free pickup collapses the capability branch: a platform without id-based retraction adds the same `Get` and receives the same outcome mark. `ReactionManager` stays in the capability set — the monitor pickup still retracts a dropped triage — but the `/ps` path no longer touches it.

## Alternatives considered

- **Keep the swap and patch its two residue cases** (a settled flag so a late pickup add retracts itself; the outcome add chained behind the retraction). Rejected by the ruling behind this note: the swap hides history, and a message whose outcome is `DONE` should still show that its text was accepted.
- **Retract only on the death path** (keep `Get` when `DONE` lands, swap it for the stop emoji when the turn dies). Rejected: `Get` would then mean one thing or another depending on the outcome, and the retraction state — with its residue races — would stay for the rarer path.
- **Persist the pending map so a restart still delivers the outcome.** Rejected as before: reactions are ephemeral platform state, and the map is engine-lifetime bookkeeping only ([the three-state note](2026-09-17-feishu-bridge-ps-three-state-reaction.md) owns that reasoning).

## Consequences

- A steered message's marks only grow: `Get` always, then `DONE` or the stop emoji. A steer whose turn died shows `Get` plus the stop emoji, accepted because each mark names a different fact rather than a state to overwrite.
- The unsettled pickup stops being a defect: a pickup whose claim never arrives (a stall-retry channel swap draining the claim event, a daemon restart losing the record, an eviction at the map cap) keeps its `Get` with no outcome. Neither retraction residue documented in the three-state note can occur — nothing is retracted.
- `PendingSteerReaction` loses `reactionID`; the `/ps` path holds no retraction state and issues one fewer API call per settled steer.
- `tests/engine/misc-commands.spec.ts` pins the marks: `Get` at enqueue, `Get` + `DONE` after the claim, `Get` + stop emoji on the stop and cleanup paths, `Get` alone without the stop capability, and the same pair on a platform lacking id-based retraction; the recorder's id-based capabilities stay asserted-unused as the no-retraction guard.
- No model-visible, durable, or configuration change: the `steer_claimed` projection, the session log, and every `cancelEmoji` semantic are untouched.
