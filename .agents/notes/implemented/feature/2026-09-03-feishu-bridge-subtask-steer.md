# Agent Note: subtask send gains a steer delivery mode

Status: implemented

English | [中文](2026-09-03-feishu-bridge-subtask-steer.zh.md)

## Problem

`feishu_bridge_subtask send` could only queue: a follow-up waited for the child's current turn to finish before the child saw it. Upstream 0.1.2-rc.1 (merged into dev the same day) shipped the steer service — `[deliverSubagentPrompt]` grew a `queue | steer` delivery argument, where steer admits a message at a running child's nearest step boundary, wakes an idle child, and cold-resumes a settled one. The bridge already consumed the queue half (`followupChild`, after the 2026-08-27 AbortSignal cold-resume fix); the steer half went unused, so a parent wanting to correct a long-running child mid-flight had only `interrupt` (kills the whole turn) or waiting the turn out.

## Decision

`send` accepts `delivery: 'queue' | 'steer'`, default `queue`. The mode threads through `engine.sendToSubtask` → `ContinuableDelegator.followupChild` → `[deliverSubagentPrompt](..., delivery)`; the adapter passes the existing `AbortSignal.timeout` on both arms (the cold-resume path dereferences it on either mode). All steer semantics stay owned by the subagent runtime — running/idle/settled admission, the turn-closing race degrading to next-turn delivery, and cold resume are service behavior the bridge does not re-implement. An attended group child asked for steer fails loudly (`subtask: steer delivery is only supported for native subtasks`): it has no runtime inbox to admit a mid-turn message, and silently degrading to queue would hide the miss behind a success message.

Discovery is model-facing by design: the `delivery` parameter description carries decision guidance ("prefer steer to correct course or add key context while a long-running subtask is still working"), and the spawn result now states the intervention channel ("send with delivery steer reaches it mid-turn") so the parent learns it at dispatch time rather than re-deriving it from the schema later.

## Alternatives considered

**Steer automatically whenever the child is running.** Rejected: fire-and-forget batch follow-ups get unpredictable mid-turn direction changes; an explicit mode keeps queue semantics the default and the choice where the information is.

**Support steer for attended group children via `AgentSession.steer`.** Deferred: the group path posts a visible card and re-arms the one-shot auto-report around a platform queue, a different delivery machinery; recorded here as the follow-up if the need appears.

## Consequences

The tool schema is model-visible on every request (description plus the new parameter); no new session events — the runtime's persistent inbox already owns model-visible ⟺ logged. The default path is byte-identical to before: the settlement-fallback hint sends (`monitor.ts`) keep queue semantics without changes.

## Testing

`tests/agent-dsh/adapter-followup-signal.spec.ts`: the fake subagents recorder now captures the delivery argument; default asserts `queue`, explicit asserts `steer`. `tests/engine/engine-subtask.spec.ts`: `sendToSubtask` threads the mode to the delegator and re-arms; steer on an attended group child rejects with no follow-up card; the default assertion documents `queue`. `tests/tools/subtask-tool.spec.ts`: schema enum plus guidance wording, spawn result mention, and per-mode result messages. Full bridge suite: 180 files, 3161 passed.

Separately, the new tests' scheduling shift deterministically exposed a pre-existing race in `tests/engine/engine-stall-retry.spec.ts`: the "Session terminated" notification is sent before the state removal, which trails inside `closeAgentSessionWithTimeout().finally()` (bounded by `closeTimeoutMs`, 200 ms in that suite); the exhausted-retries test asserted removal synchronously. Fixed by wrapping that one assertion in `vi.waitFor`, the pattern its sibling test in the same file already used for the identical condition.

## Related

Upstream steer service: PR #3250 (`feat/3220-steer-service`) and the agent-team mailbox consumer (PR #3333). The in-process sibling is the [/ps note](2026-08-21-feishu-bridge-ps-steer.md) — same next-step inbox primitive reached through a direct handle, no service indirection. The queue-mode deviation from Go's busy-reject recorded in the B4 note stands unchanged as the default.
