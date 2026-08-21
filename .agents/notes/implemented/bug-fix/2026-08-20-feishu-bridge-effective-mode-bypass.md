# Agent Note: effectiveMode bypass for unattended feishu-bridge sessions

Status: implemented

English | [中文](2026-08-20-feishu-bridge-effective-mode-bypass.zh.md)

## Problem

Go's dsh backend computes an effective mode per session (`agent/dsh/dsh.go` effectiveMode): agent-delegated subtask children without a human in the group (`CC_SUBTASK=1`, no `CC_SUBTASK_ATTENDED`) and chatroom role / direct-role personas run as `bypassPermissions` — approval prompts there stall on nobody who can answer, so the first tool call would hang forever. The TS adapter ported only the plan-mode half of mode handling: every session, including delegated children, inherited the project's configured mode. On a `agent.mode: plan` profile the real-device smoke showed a subtask child pausing its whole turn on an ExitPlanMode approval card that only a human watching the child group could clear — behavior Go never had.

## Decision

`sessionBypassesPermissions(env)` (exported pure function in `src/agent-dsh/adapter.ts`) ports Go's effectiveMode predicate: unattended subtask, chatroom role, or direct-role flags → bypass; attended subtasks and moderators keep normal approval. `startSession` snapshots it into the `DshAgentSession` (`bypassPermissions`, the port of Go `permMode`/`autoApprove`) and overrides any configured or one-shot mode with `bypassPermissions`, which also forces plan mode off — a delegated child must not stall on an ExitPlanMode card. The adapter's `approval/request` answerer short-circuits bypass sessions to `allowed-once` before emitting any permission request toward the engine, mirroring Go's autoApprove branch. AskUserQuestion and plan-review rides stay on the separate userQuestions channel, so question and plan cards still surface in bypass sessions (Go #15 semantics: bypass auto-approves tools, never questions).

## Alternatives considered

**Set a per-session permission policy through dsh's approval service (`setPolicy`).** Rejected: the adapter already owns the single `approval/request` answerer that every tool ask funnels through, and the bypass is a property of the engine session env, not of the process-wide policy; a per-agent policy seam would need a second routing layer for what one flag at the existing choke point expresses.

**Bypass in the engine before the permission event is emitted.** Rejected: the engine's permission path is platform-agnostic and shared by other agent backends; Go put this decision in the dsh session where the env flags live, and the adapter is its TS counterpart.

**Include moderators in the bypass.** Rejected: Go excludes them — the moderator is the one chatroom session a human actively drives, and its plan approvals are meaningful.

## Consequences

Delegated subtask children now run straight through tool calls with no approval cards, matching Go: subtask smoke runs complete spawn → work → report with no human intervention (previously each child stalled on an ExitPlanMode card under a plan-default profile). Chatroom roles lose their approval cards too — a role with Bash could previously at least be stopped by a human declining a dangerous tool; that guard now rests entirely on the chatroom safety-floor prompt and the sandbox. Attended subtasks flip to normal approval the moment a human message marks `CC_SUBTASK_ATTENDED`, so joining a child group restores the guard.

## Testing

`tests/agent-dsh/adapter.spec.ts` pins the predicate table (Go session_test.go's four cases plus moderator and empty env), the answerer short-circuit for unattended subtask and chatroom-role sessions (settles `allowed-once` with no `respondPermission`), the attended-subtask path still waiting for the engine decision, and bypass overriding the plan default (`planMode.set(false)`). Real-device smoke: subtask child runs to report with no approval card in the child group.
