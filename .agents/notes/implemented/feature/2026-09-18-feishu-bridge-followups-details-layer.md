# Agent Note: Followups options carry a factual-detail layer into both the card and the dispatch

Status: implemented

English | [中文](2026-09-18-feishu-bridge-followups-details-layer.zh.md)

## Problem

Two defects met on the same closing followups option.

The [locator split](2026-09-17-feishu-bridge-followups-locator-split.md) moved the executing locator off the card face on the premise that the dispatched `[后续处理]` message would carry it — the executing agent's only locator source. It never did. The send-time read-back that rebuilds the question from the sent card (`askCardMeta`, `src/feishu/platform.ts`) maps a checker option as `{label, description}`; `locator` is not on the card model at all, so it was already gone when `cacheAskqMeta` wrote the in-memory cache and the persisted sidecar, and `followupsSelectionMessage` could never compose its `📍` line. Live evidence (chat `oc_2680b22abca4f04388504321e59f2984`, 2026-09-18): the registration carried `locator: apps/desktop/src-tauri/gen/schemas/acl-manifests.json:1`, the dispatched message carried no `📍` line, and a grep across the whole session log found zero occurrences. The egress has a second door too — `sendCard` hands a threaded reply to `replyCard`, which records the send-time cache again — so any fix passing the question as a call argument must thread it through both doors.

Separately, the user asked for the factual side of each finding on the card itself: the plan card's two-layer presentation (plain layer expanded, implementation details collapsed) had no counterpart on the followups card, and the card read as plain language only.

## Decision

One field replaces two: the option carries a factual `details` string, and the separate `locator` field is deleted.

- `UserQuestionOption.details` (replacing `locator`) holds the factual side — files, mechanism, evidence; whether it names an exact location (`path:line`) is the caller's call.
- Both cards fold it into one collapsed panel titled by the detail-bearing option count instead of showing it inline — the live card inside its form, the settled snapshot through `followupsDetailLines` (`src/engine/ask.ts`), whose marks carry the plain-language lines alone — see [followups card fold](2026-09-18-feishu-bridge-followups-card-fold.md).
- The dispatched selection message carries the same detail as plain text (face `dispatch`): a model input must not receive rendering tags.
- The send-time cache records the card's own source question (`Card.askQuestion`), so both egresses keep every option field and the sidecar survives restarts — the [source-question change](../bug-fix/2026-09-18-feishu-bridge-ask-meta-source-question.md) replaced the card-face reconstruction that had dropped the locator in the first place.

## Alternatives considered

- **Pass the source question as an extra `sendCard` argument.** Rejected: the threaded-reply egress re-records the cache inside `replyCard`, so the argument would have to thread through `CardSender.sendCard` and `CardSender.replyCard` both, and every future egress would have to remember it. Keeping the data on the card makes the guarantee structural.
- **Keep the separate `locator` field alongside `details`.** Superseded by the user's decision to merge: two fields meant two prompt contracts, two schema entries, and a "never on the card" rule that lost its reason once the card shows facts. The merged field also removes the only data the read-back could not see.
- **A collapsible details panel per option.** Not available: the Feishu checker option is a single text node, so a per-option fold cannot be built; a card-level `collapsible_panel` would put the detail away from the option it belongs to.

## Consequences

- The card no longer reads as plain language only: its factual detail rides both faces, one click away, matching the plan card's own collapsed-details pattern.
- Cards registered before this change dispatch without a detail line — a degradation to the old behavior, not a failure.
- `details` is optional in the tool schema; fill quality is watched on the first cards after reload, and the escalation path is making it required (mirroring the plan-details rollout).
- The fold's `**label** · detail` line is composed in two places — the Feishu renderer for the live card and `followupsDetailLines` for the settled snapshot — and both faces are pinned by the [followups card fold](2026-09-18-feishu-bridge-followups-card-fold.md) tests.
- Testing: `tests/feishu/card-action.spec.ts` (the send-time read-back through both the `sendCard` and `replyCard` egresses dispatches the detail), `tests/feishu/card.spec.ts` (the settled card's collapsed panel and its lines), `tests/engine/followups.spec.ts` (`followups details` describe), `tests/tools/followups-tool.spec.ts` (the schema exposes `details` and no `locator`; conversion keeps it), `tests/agent-dsh/adapter-persona.spec.ts` (conventions text updated).
