# Agent Note: feishu-bridge group @-gate admits replies to the bot's own messages

Status: implemented

English | [中文](2026-08-29-feishu-bridge-group-gate-reply-to-bot.zh.md)

## Problem

The group @-gate dropped any group message without an @bot mention, and Feishu replies never auto-mention the parent message's sender — so a user replying directly to one of the bot's messages was silently ignored: no dispatch, no log, no session event. Ask cards inviting a typed answer became text traps in gated groups, because the invited reply landed on the bot's card and was swallowed (2026-08-26 oc_0e48d3 incident; the only workaround was remembering to @ the bot).

## Decision

- The gate admits a group message whose `parent_id` names a message the bot itself sent: a reply to the bot addresses the bot, no @ required. Unrelated group messages without an @ still drop.
- The platform records every successful send's message id through a recording client wrapper installed once in `ensureApi`: send-path callers discard the SDK result, so the client is the only choke point that sees every `{ messageId }` (text, cards, preview sends alike); `withToken` derivatives re-wrap so the token-refresh retry path also records.
- The id set is a 2048-entry FIFO ring, so a long-running daemon's memory stays flat; ids are globally unique, so a tracked id can only be replied to in the chat it was sent to.

## Alternatives considered

- **Enable `groupReplyAll` for affected chats.** Rejected: the bot would answer every message in the chat; the gate exists to keep group noise out.
- **Reply with an in-chat hint when a message is dropped.** Rejected: it fixes the silence, not the dispatch — the user's answer still never reaches the agent.

## Consequences

- Only a reply whose immediate parent is the bot's message passes; a reply inside a bot-started thread whose parent is another human's message still needs an @ (deliberately narrow first cut).
- A reply to a bot message older than the ring window (more than 2048 sends ago) falls back to requiring an @.
- An empty `botOpenID` still disables the whole gate, as before.

## Testing

`tests/feishu/platform.spec.ts` (`group @-gate reply exception`): a group reply to the bot's own message without any mention is delivered to the handler; an unrelated group message without a mention is still dropped. Suites: feishu-bridge package green; repository typecheck clean; oxlint clean on the touched files.
