# Agent Note: chatroom barrier settlement moves to the failure point, not the timeout

Status: implemented

English | [中文](2026-08-31-feishu-bridge-chatroom-barrier-failure-settlement.zh.md)

## Problem

The chatroom barrier machinery was correct on the happy path but its failure branches left state that only timeouts cleaned up, and two guards were one-directional. A gather broadcast that failed for one role left that role in `expected`, so the barrier waited the full gather timeout (20 min, 60 min for research rounds) with a frozen progress card and no moderator feedback. A mid-spawn failure orphaned the already-spawned role groups: the hub had no `chatroomModerator` marker yet, so `resolveChatroomHubKey` could not resolve the hub itself and `/chatroom stop` answered "not in a room". An ask whose card send failed left `chatroomInFlight` armed, so `endChatroom`'s Phase A installed a drain barrier for a reply that could never arrive and burned the whole drain timeout. The end barrier posted its relay card fire-and-forget, so the closing wake could land above the role's final relay card, breaking the "relay card lands before the placeholder card" contract the gather path already enforced. `askHuman` refused while a gather was armed, but `gatherRoles` did not refuse while a human question was pending — the interleave injected a second in-flight ask whose turn-end consumed the one-shot relay gate, and the role's follow-up to the human answer was dropped wholesale at the silent `:1004` return. The `end`/`force` tool actions passed the caller's session key straight through as the hub key, so a role persona could end the chatroom from its own group (killing its subtree, abandoning its research assistants, leaving the real hub's gather to time out). Re-opening a chatroom over live role groups stacked generations with mixed persona markers, and the gather summary inlined full replies with no cap, sending arbitrarily large wake text into the moderator's context.

## Decision

Settlement now happens where the failure happens; timeouts are backstops again. `gatherRoles` rejects while `pendingHumanQuestionRole` is set, mirroring `askHuman`'s gather guard, and `routePendingHumanReply` falls back to the hub's normal agent path when a gather is armed — the user did answer, so the stale ask flag is cleared rather than left routing later unrelated messages into a dead ask (symmetric with the existing stale-flag fallthrough). A failed gather broadcast calls `forgetFailed` to remove the role from `expected`; an empty expected completes the barrier immediately — removal, not an empty-reply accumulate, because the role never received the question and NO_REPLY (a deliberate abstention) would misreport it. `startChatroom` sets `chatroomModerator` before the spawn loop, so a mid-spawn failure leaves the hub stoppable from every entry point. `askRoleInternal` clears the in-flight flag when its send throws, so `end` never arms a drain barrier for a dead reply. The end barrier awaits the relay card before waking, matching the gather path. `end`/`force` resolve the caller's owning hub with `resolveChatroomHubKey` and reject callers that are not the moderator hub (`chatroom_end_moderator_only`) — a role persona can no longer impersonate the hub. Starting a chatroom while live role groups exist is rejected (`chatroom_already_running`). Gather summaries cap each reply at 200 runes through the same `clipRunes` the end barrier uses.

## Alternatives considered

**Accumulating a failed broadcast as an empty reply.** Rejected: the role never saw the question; NO_REPLY semantics belong to a role that chose silence.

**Reclaiming half-spawned groups in a catch block.** Rejected: per-role cleanup plus state reset is a larger diff than setting the moderator marker before spawning, and the marker leaves every entry point able to stop the room, not just the failure path.

**A larger research-specific summary cap (600 runes).** Rejected: the research flag would have to thread through the barrier constructor and its persisted snapshot; the full replies already live in the ledger and on the relay cards.

## Consequences

The interleave guards are symmetric (human-question-pending blocks gather, gather-pending routes the human reply through the hub); `end` is moderator-only, including the once-silent pseudo-success of a second `end` after teardown, which now errors; wake summaries are model-visible truncations. Known limitation: a moderator whose reply arrives during a gather gets it relayed after the gather rather than mid-flight — the price of never having two in-flight asks on one role.

## Testing

`tests/engine/engine-chatroom-gather.spec.ts`: gather rejected while a human question is pending; the pending-reply fallthrough; a single-role broadcast failure wakes on the remaining replies and an all-failed broadcast completes immediately; overlong replies trim to 200 runes. `tests/engine/engine-chatroom-end.spec.ts`: the closing wake lands only after the final relay card; a second open is rejected while live role groups exist. `tests/engine/engine-chatroom.spec.ts`: a mid-spawn failure leaves the hub stoppable and the orphan group reclaimable; a failed ask send clears the in-flight flag so `end` settles immediately. `tests/tools/chatroom-tool.spec.ts`: role sessions cannot call `end`/`force`; the moderator path still works.
