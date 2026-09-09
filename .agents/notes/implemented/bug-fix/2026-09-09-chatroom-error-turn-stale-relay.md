# Agent Note: Chatroom error turns relay their own partial, never the stale last result

Status: implemented

English | [中文](2026-09-09-chatroom-error-turn-stale-relay.zh.md)

## Problem

2026-09-08 evening chatroom test run: a role turn was interrupted mid-generation by an API 1301 content-moderation error. An error-reasoned turn never overwrites `session.lastResult` (the engine's `!errored` guard on `setLastResult` — interim narration must not become the session's last clean result), but the turn-end waterfall unconditionally passed `lastResultOrReply` as the turn's response. With the stale value still holding the role's previous answer, the chatroom serial path matched its stamp and relayed that old answer verbatim to the moderator twice — once as the green 【Role】 relay card with a ledger row, once in the wake. The gather fan-in and the end barrier had the same blind spot: whatever `response` carried was absorbed as the round answer. The subtask auto-report hook in the same engine function already held the right discipline: on error, report this turn's own partial streamed text, "never a stale earlier reply".

## Decision

- **The turn-end payload carries the failure explicitly.** `response` becomes `joined.trim()` (this turn's partial) when the turn errored, and the payload gains `errored: boolean` + `errorText` — consumers no longer have to infer from text shape whether a response is a clean reply. The bridge-service event contract documents the three fields; the cordis catalog mirror is regenerated.
- **The channel-closed emission fills `errored` truthfully.** Only a genuine process crash (unexpected exit that is neither a user stop nor an engine reload) reads as errored, with the process-exited notice as `errorText`; deliberate cuts keep today's free-relay semantics.
- **A failed chatroom turn is never a reply.** `maybeAutoRelayRole` takes `errored`/`errorText`; a failed turn sends no 【Role】 relay card and writes no ledger row.
- **The serial wake generalizes the NO_REPLY branch**: `[聊天室·<role> 本轮发言失败（<errorText>）]` followed by the turn's own partial when any streamed, then the standing reminder — the moderator sees the failure and the partial, never the old answer. Entry completion, the answered-latch, and the in-flight flag behave exactly as for a normal answer; only the copy differs.
- **The gather and end barriers record an explicit failure note** (`（本轮发言失败：<errorText>）`) instead of the reply: the round still counts the role as answered (no barrier stall), but the wake summary says the turn failed rather than posing the partial as the round answer.
- **New copy goes through the chatroom i18n dictionary** (`chatroom_role_turn_failed_wake`, `chatroom_role_turn_failed_note`, zh+en); the wake and barrier strings stay verbatim-level pinned by the new tests.

## Alternatives considered

- **Overwriting `lastResult` on error**: lastResult is the durable "last clean result" other surfaces read (export keys, follow-up context); replacing it with failure text would poison every consumer to fix one relay.
- **Relaying the partial as a normal reply** (card + ledger + 发言 wake): a partial posing as a complete answer pollutes the ledger and the moderator's picture; the failure must be legible as a failure.
- **Recording `''` (NO_REPLY semantics) in the barriers**: zero new surface, but tells the moderator the role passed silently when its turn actually died; one i18n key keeps the distinction.
- **Suppressing the wake on error**: recreates the stall the wake-on-silent-NO_REPLY fix removed — the moderator would idle forever on a dead turn.

## Consequences

- Tests pin all three layers: the engine payload (response is the partial, never the stale lastResult, with `errored`/`errorText` set), the serial failure wake with unchanged entry semantics, and the gather absorption as a failure note.
- The serial wake includes the partial in full, unclipped — same shape as the subtask hook's failure report; the barrier note passes through the summary's existing 200-rune clip.
- Crash-cut channel-closed turns now read as errored on the chatroom side (a 发言失败 wake instead of a partial posing as a reply); user stops and engine reloads are unchanged.
- The errored response contract is additive on the event payload; the only listener is the chatroom relay, updated in the same change.
- Deployment: bridge rebuild + `/reload`; verification line: `chatroom: role turn failed; woke moderator with the failure (role=… error=…)`.
