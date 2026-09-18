# Agent Note: a pending selection card turns moderator start into the mode card

Status: implemented

English | [中文](2026-09-09-chatroom-start-mode-card-guard.zh.md)

## Problem

2026-09-08 oc_9b99f (the DCA chatroom run): after `pick-roles` rendered the role multi-select card, the user answered in plain text («按照你推荐的角色推进») instead of clicking it. Plain messages reach the moderator session unfiltered, so the moderator treated the text as an instruction and called `feishu_bridge_chatroom` `start` directly — the chatroom launched in plain mode and the mode-selection card (plain / research-auto / research-manual) never reached the user. Structurally, the mode card existed only on the card-action path (`executeChatroomPickAction`'s confirm branch arms `chatroomModePick`), the text ingress had no interception for a pending picker, and the `start` action held no pending-card check of its own.

## Decision

The guard lives in the operation that makes the decision: the `start` action (`packages/acp/feishu-bridge-chatroom/src/tools/chatroom.ts`) consults `armChatroomModePickFromModeratorStart` (`src/engine/chatroom-pick.ts`) after the already-running guard and inherit resolution. When the role picker is pending, a multi-role start with the mode undecided consumes the role picker (the plain-text confirmation stands for the cast), arms the mode picker from the moderator's roles/topic/prior, and sends the mode card; the chatroom then launches through the existing `finalizeChatroomModePickStart` chain (research venv gating included). A repeat start while the mode card is with the user is idempotent. Pass-through mirrors the confirm path: an explicitly stashed `--research` and single-role casts start directly; an invalid cast (empty, over max, hallucinated role) falls through so `startChatroom` keeps failing loud on it.

## Alternatives considered

- **Intercept plain text at the message ingress while a picker is pending.** Either blocks all user text during picking or needs natural-language intent classification; and it covers only the text entry — the moderator can reach `start` from any wake (poll settle included). The start operation is the chokepoint every path shares.
- **Reject the start with an error.** Throws away the user's explicit confirmation and forces them back onto the old card, then the mode card — three steps for what the text already said.
- **Teach the moderator priming not to start while a card is pending.** Prompt text is not enforcement; poll-settle wakes reach the same code with different priming.

## Consequences

- Tests pin the behavior in `packages/acp/feishu-bridge-chatroom/tests/tools/chatroom-tool.spec.ts` (`start guards`): pending role picker → mode card armed, nothing starts, picker consumed; repeat start idempotent; research-stashed and single-role casts pass through; over-max casts keep the loud `too many roles` error with the role picker intact.
- The role card the user ignored is consumed by the swap — after the mode card, the cast is the moderator's confirmed list; the mode card's cancel returns the user to a fresh `/chatroom`.
- A `start` during the picker's `'picking'` phase (poll in flight) hits the same guard: the picker is consumed and the mode card goes out; a subsequent `pick-roles` from the poll settle bootstraps a fresh picker only when the chatroom never started.
- Deployment: bridge rebuild + `/reload`.
