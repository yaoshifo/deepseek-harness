# Agent Note: Chatroom low-risk guard batch

Status: implemented

English | [中文](2026-09-03-chatroom-lowrisk-guard-batch.zh.md)

## Problem

The 2026-09-03 audit left four low-severity guard and message gaps. (1) `askRole` lacked the pending-human guard its siblings carry: asking the role that holds a pending ask-human question injects a second in-flight question, and the one-shot relay gate then drops one of the two replies. (2) The tool's `start` action had neither the `/chatroom` command path's already-running guard (a repeat start spawns a second generation of role groups under the live hub) nor any member-session guard — and the command path's re-entry check only sees roles parented on the calling session, so `/chatroom` sent from a role group turned the role into a nested moderator (`chatroomModerator` alongside its outer `chatroomHubKey`). (3) `end` from a plain session outside any chatroom reported the moderator-only diagnosis (misleading, and it points at `/chatroom stop`, which answers not-in-room itself); `note` from a role session resolved the ledger dir from the role's own key and surfaced a raw ENOENT. (4) The research priming's replacement-steward guidance implied re-dispatching with the `assistant` alias, which the alias resolver rejects while the pre-provision key stays empty.

## Decision

- `askRole` now mirrors gather's pending-human guard and throws the new `chatroom_ask_pending_human_blocked`.
- Both start paths guard in order: member-session first (`chatroomHubKey !== '' || researchAssistant` → `chatroom_start_member_forbidden`), then already-running (`ChatroomAlreadyRunning`) on the tool path. The command path keeps its reply-style guard; the tool path throws.
- `end` distinguishes `''` (not in any chatroom → `chatroom_not_in_room`) from a resolved foreign hub (moderator-only, unchanged). `note` resolves the hub the same way and rejects non-moderators with `chatroom_note_moderator_only` before any ledger-directory resolution.
- The replacement-steward guidance now says to address the spawned child by its returned session key — the `assistant` alias cannot resolve it. The originally-feared session leak does not materialize: the tool's spawn produces a native child, and `finalizeChatroomEnd` drains the hub's native descendants (`drainNativeDescendants`) like every other subagent; only the group-spawned pre-provisioned stewards need the `researchAssistant` classification.

## Consequences

- Tests: ask rejects under a pending human question without arming the role; a repeat tool start and a role-session tool start both reject before `startChatroom`; `/chatroom` from a role session replies with the member-forbidden message and installs no nested moderator flag; end/note from plain sessions report not-in-room; note from a role session reports moderator-only instead of ENOENT. The routing-proof test's note assertion moved with the behavior (not-in-room now fires before the moderator-dir check).
- The chatroom i18n subtable grew by four keys (`chatroom_ask_pending_human_blocked`, `chatroom_start_member_forbidden`, `chatroom_not_in_room`, `chatroom_note_moderator_only`); the header count comment tracks the live total.
- Related: `2026-09-02-feishu-bridge-chatroom-followup-guards` (the earlier interlock batch this one completes), `2026-09-03-chatroom-research-in-turn-conclusion-relay`.
