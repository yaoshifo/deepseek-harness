# Agent Note: /chatroom stop — interrupting a chatroom from any protocol state

Status: implemented

English | [中文](2026-08-25-feishu-bridge-chatroom-interrupt.zh.md)

## Problem

`endChatroom` refuses while a gather is armed — and a gather whose reply sources died can never complete. The 2026-08-25 oc_65f8918e incident walked into exactly that deadlock: the user manually stopped two research assistants (user-stop suppresses auto-report by design), the two roles' conclusion turns never fired, the hub went idle-reaped, and the chatroom became a zombie — the armed barrier's 60-minute timeout would wake the abandoned moderator to keep orchestrating, `/done` was blocked by the barrier, ten groups were left uncleaned, and a hung native descendant (marks' spawn fallback, open tool call for 28+ minutes) could only be drained by an end that could not run. Go has no counterpart: there was never a hard-stop path that does not depend on protocol state.

## Decision

**`interruptChatroom(e, hubKey)`** — one kernel, three entries:

- Consumes both barriers (gather + end) without waking: their timers stop, the missing role names go only into the interrupt card.
- Stops the moderator turn first (a mid-orchestration turn would issue asks into groups being deleted), then every in-flight role/assistant turn via `stopInteractiveSession` — interrupt waits for nothing, unlike end's drain semantics.
- Reuses `finalizeChatroomEnd`'s teardown unchanged (role/assistant group cleanup, flag reset, native-descendant drain — the hung fallback child dies here).
- Sends one system card to the hub (⏹ 聊天室已中断: roles removed, unreceived replies, ledger retained). **No moderator turn**: the user is aborting; the card is the only terminal record, and an armed gather's progress card is not separately updated (the interrupt card is the terminal record).

Entries: `/chatroom stop` (or 中断) — valid from the hub, any role group, or any assistant group (`resolveChatroomHubKey` walks the moderator flag, chatroomHubKey, then the parent chain); the chatroom tool's `end` action gains `force: true` routing to interrupt (its refusal message now names the force path); `/done` keeps graceful semantics with no implicit downgrade.

## Alternatives considered

**Make end auto-interrupt when blocked.** Rejected: end's drain semantics are correct when replies CAN still arrive; the choice between waiting and aborting belongs to the caller, so the blocked error now points at force instead of silently changing meaning.

**Wake the moderator with a "you were interrupted" note.** Rejected by user decision: aborting means no further model turns; the system card carries the accounting.

**A stop-assistant notification chain (wake the parent role when its assistant is user-stopped).** Deferred as a separate refinement: interrupt is the escape hatch that unblocks the stall; the notification chain only improves the moment-to-moment UX around it.

## Consequences

A gather armed over dead reply sources is no longer a deadlock: the user breaks it from any member group, the moderator breaks it via `end force`, and a daemon restart closes it through the barrier-recovery path (which does wake the moderator — that path's contract differs because nobody asked for the restart). The oc_65f8918e zombie itself still needs the one-time cleanup (reload + `/done`, or `/chatroom stop` once the new code is live).

## Testing

`tests/engine/engine-chatroom-interrupt.spec.ts` (+6): armed-gather interrupt (barrier consumed, no wake, moderator + member turns stopped, teardown, card with missing roles), end-barrier interrupt, no-op on an ended chatroom, hub resolution from hub/role/assistant/unrelated chats, and both command paths. Full engine + adapter + assembly suites and repo typecheck pass.
