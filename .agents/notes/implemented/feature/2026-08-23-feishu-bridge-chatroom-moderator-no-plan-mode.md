# Agent Note: chatroom moderators never enter plan mode

Status: implemented

English | [中文](2026-08-23-feishu-bridge-chatroom-moderator-no-plan-mode.zh.md)

## Problem

`/chatroom` flows repeatedly posted ExitPlanMode approval cards into the group. Two layers caused it. First, the moderator (the hub session, `CC_CHATROOM_MODERATOR=1`) is the one chatroom persona not elevated by `sessionBypassesPermissions`, so its resolved mode is `modeOverride || defaultMode` — and every production project configures `agent.mode: plan`, which re-armed plan mode at every `startSession`, including resumes after agent recycling. Second, the moderator priming carried a "## plan mode" section instructing the model to call ExitPlanMode with a one-line plan before driving — but the bare persona replaces the whole system prompt (`complete: true` section), so the `plan:policy` section is invisible and the model cannot verify the "if you are in plan mode" condition; it erred toward obeying, producing a plan review card per chatroom start. Roles, direct roles, and research assistants already run bypass and never plan; the pick phases (role/topic) never showed a card because the engine auto-approves ExitPlanMode while `chatroomPickActive`.

## Decision

The adapter's session-start mode application downgrades any resolved `plan` mode to `default` when the session env carries `CC_CHATROOM_MODERATOR`, whatever the source (project default or one-shot override). The env flag holds for the moderator's whole lifetime, so every startSession — including recycled resumes — re-applies the downgrade; `endChatroom` clears the flag and the hub reverts to the project default. Tool approvals are untouched (Go effectiveMode parity holds there). The plan-dance section is removed from `buildChatroomModeratorPriming`, and the dead plan hint from the direct-role wake (a direct-role session is always bypass, never in plan mode). Both pick wakes (`beginChatroomPick`, `beginChatroomTopicPick`) carry a one-shot `modeOverride: 'default'` so the pick turn skips the plan dance too; when a live hub agent process bypasses the override, the engine's pick auto-approve remains the backstop.

## Alternatives considered

**Only remove the priming text, keep the mode.** Rejected: the plan state stays armed and re-arms from the project default at every recycled start; `exit_plan_mode` remains in the tool catalog and the plan file / planRender paths can still trigger on a stray exit call. The state is the root, the text only the trigger.

**Elevate moderators to bypass as well.** Rejected: that changes tool-approval semantics beyond plan mode; the moderator is attended and its tool approvals remain meaningful ([effectiveMode bypass](../bug-fix/2026-08-20-feishu-bridge-effective-mode-bypass.md)).

**Set the moderator flag at pick start instead of the one-shot override.** Rejected: early flagging swaps the pick-phase persona to the bare moderator prompt and adds flag hygiene to the cancel/expiry paths, for no behavioral gain — the pick phase never showed a card.

## Consequences

Chatroom flows post no plan review cards: the moderator drives gather/ask/note directly. A moderator session whose log had inherited plan gains a `plan/mode {active:false}` commit at its first session start. After `/chatroom end` the hub reverts to the project plan default, so coding chats keep their plan-first behavior. An explicit `/mode plan` typed into a hub while it is a moderator is downgraded at the next session start — the rule is absolute by design. This is a deliberate deviation from Go effectiveMode, plan mode only.

## Testing

`tests/agent-dsh/adapter.spec.ts`: a moderator session downgrades an inherited plan default and an explicit plan override (`planMode.set(false)` both ways). `tests/engine/engine-chatroom-gather.spec.ts`: the moderator priming contains no plan-mode dance text. `tests/engine/engine-chatroom.spec.ts`: the direct-role wake carries the bare topic; both pick wakes carry `modeOverride: 'default'`. Real-device: every `/chatroom` entry path (topic pick, role pick, explicit multi-role, direct 1:1) runs without a plan card, and after `/chatroom end` the hub still follows the project plan default.
