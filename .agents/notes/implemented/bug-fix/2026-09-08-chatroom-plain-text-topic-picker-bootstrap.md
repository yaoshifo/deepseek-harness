# Agent Note: Plain-text chatroom topics must still reach the role picker — bootstrap over error

Status: implemented

English | [中文](2026-09-08-chatroom-plain-text-topic-picker-bootstrap.zh.md)

## Problem

The 2026-09-07 oc_94b41a incident (「飞书群测试」chatroom test): the user ran bare `/chatroom`, the moderator's #59 topic card proposed 5 candidates, and the user's actual topic was none of them — the card had no free-text field, so the user typed `题目：中国金融市场…` as a plain message. Plain messages bypass `cmdChatroom`, so `beginChatroomPick` never ran and the #43 role-picker state never armed. The moderator (woken by the plain message, following the #59 priming's advertised script) organized the opening poll itself, then called `pick-roles` and hit `chatroom: picker not active` — a hard error with no recovery path, since no tool action can arm the picker. The moderator degraded gracefully (picked the cast itself, started the room), but the user silently lost the role-selection card that the whole guided flow exists to provide.

Two gaps, one incident: the #59 card had no custom-topic escape, and `pick-roles` treated a missing picker state as terminal instead of repairable.

## Decision

- **`pick-roles` bootstraps a missing picker from its `topic` argument** (`bootstrapChatroomPick` in `packages/acp/feishu-bridge-chatroom/src/engine/chatroom-pick.ts`, wired in `src/tools/chatroom.ts`): when the armed state is absent and the call carries a non-empty `topic`, the engine arms the state (roles re-enumerated from the configured dir) and the existing render call pushes the card. Guarded by the hub's `chatroomModerator` flag — an already-started room refuses re-arming; a stateless call without `topic` returns a hint naming the argument so a model-driven moderator retries correctly. No wake, no picking watchdog: the moderator is already mid-turn and arrives with recommendations.
- **The #59 topic card carries a free-text field** (`renderChatroomTopicPickCard`): a Feishu form with a single-line input and a `form_submit` button. Form submits drop `action.value`, so the platform's name-recovery chain maps the button name `chatroom_topic_custom_submit` to `act:/chatroom-topic-pick custom`, and the typed value rides `form_value.chatroom_topic_custom` appended to the act payload (`packages/acp/feishu-bridge/src/feishu/platform.ts`). The picker state machine's new `custom` branch finalizes the typed topic through the same `finalizeChatroomTopicPick` handoff as a picked candidate; an empty submit keeps the card with the pick-one hint.

## Alternatives considered

- **Teach the moderator (priming) to tell the user to re-run `/chatroom <topic>`.** Adds a round-trip, depends on prompt compliance at exactly the moment the engine already lost the state, and leaves the root gap (no card escape for unlisted topics) in place.
- **Intent-detect plain-text topics and auto-arm the picker.** The engine cannot reliably distinguish a topic message from ordinary chat in a hub that also carries mid-run interjections; misfires would arm pickers mid-discussion.
- **Extend the picking watchdog instead.** The watchdog never fired here — the state was never created; lengthening windows addresses a different failure.

## Consequences

- Tests pin both legs: `pick-roles` with `topic` renders the card through a bootstrapped state (card body carries role and topic); stateless without `topic` errors with the hint; an already-started hub refuses (`already runs`); the bootstrapped state confirms into the mode card exactly like the command-armed one; a custom submit arms the role picker with the typed topic and swaps the transitional card; an empty custom submit keeps the card with the hint; the platform layer dispatches `act:/chatroom-topic-pick custom <topic>` with surrounding whitespace trimmed.
- The `topic` argument is inert when the picker is already armed — it exists solely for the bootstrap leg, so the tool schema documents it as such.
- The bootstrapped state stores empty `userID`/`'group'` `chatType`: the confirm chain's `afterChatroomStarted` consumes neither, and `renameHubToTopic` only skips on `'p2p'`.
- Deployment: both packages rebuild + `/reload`; no config or ledger change.
