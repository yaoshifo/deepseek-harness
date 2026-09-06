# Agent Note: chatroom moderator mid-round steering via ask delivery steer

Status: implemented

English | [中文](2026-09-03-feishu-bridge-chatroom-steer.zh.md)

## Problem

The moderator could not reach a running role: `askRole` injects the question through `receiveMessage`, so a busy role (mid-turn on the previous ask or the gather round) parks it in the platform human-message queue — queued-notice reply, in-memory storage, depth cap — exactly the semantics `deliverMachineMessage` was built to keep away from machine coordination (the 2026-08-27 oc_56801302 class). Meanwhile the opposite direction already steered: role replies wake a busy moderator mid-turn through `deliverMachineMessage`. The moderator watching a role go off-track mid-round had only `interrupt` (kills the turn) or waiting the round out, and the `ask` guard rejected every ask during an armed gather.

## Decision

`askRole` gains `delivery: 'queue' | 'steer'` (default queue, threading through `askRoleInternal`). Steer routes the injection through `e.deliverMachineMessage`: a busy role receives the question at its nearest step boundary (the same agent-session steer primitive as /ps), an idle role rides the machine-wake pipeline with the full turn machinery. The visible question card in the role group still posts before injection, and the one-shot relay re-arm runs unchanged — the steered round's reply still relays through the `chatroomAsked` gate, because a mid-turn steer folds into the running turn's answer.

The gather guard differentiates by mode: queue still rejects during `pendingGather` (the reply is lost either way — the gate was consumed by the gather question), steer is admitted, and the reply still counts as that role's gather reply since the barrier consumes by session, not by turn. `pendingHumanQuestionRole` and the end barrier keep rejecting both modes. The tool surface mirrors `feishu_bridge_subtask send`: an explicit `delivery` parameter with decision guidance plus a per-mode result message; `startChatroom` and `gatherRoles` keep queue defaults.

`SubtaskDelivery` is now exported through the bridge `exports` face — the chatroom package's supported import surface.

## Alternatives considered

**Auto-steer whenever the role is busy.** Rejected: an explicit mode keeps serial-ask semantics predictable and the choice with the moderator, matching the subtask `send` decision.

**Waiting for the subagent steer service.** Not applicable: chatroom roles are group sessions (attended), not native continuable children — the service's `deliverSubagentPrompt` never reaches them. The correct primitive was the engine's own machine-wake seam.

## Consequences

Mid-round course correction is now available exactly where it is most valuable: during an armed gather the moderator can correct a generating role without killing its turn or dropping the round. The research dispatch-flag reset (`researchDispatched = false`) on a mid-round steer has no effect on the running turn — the flag arms at turn start only. Model-visible ⟺ logged holds: steer goes through the agent-loop's persistent inbox, no new session events.

## Testing

`tests/engine/engine-chatroom.spec.ts` AskRole: steer into a busy role reaches `steerCalls` with the question, card posted, relay re-armed; steer on an idle role rides the pipeline (no steer primitive); steer admitted during an armed gather while queue still rejects; steer still rejects during an end barrier. `tests/tools/chatroom-tool.spec.ts`: the `delivery` parameter schema and guidance wording, and a full-engine routing proof (configured roles → started chatroom → busy role → tool ask with steer → `steerCalls`). Chatroom suite: 22 files, 326 passed.

## Related

Built the day after [subtask send steer](2026-09-03-feishu-bridge-subtask-steer.md) consumed the upstream steer service; this note records the sibling path — the same next-step inbox primitive reached through the engine's machine-wake seam for group-hosted roles. The earlier evaluation corrected a wrong first guess: roles are not `spawnSubtask`-hosted native children (only research assistants are `spawnSubtask` group children; roles spawn via the group spawner directly).
