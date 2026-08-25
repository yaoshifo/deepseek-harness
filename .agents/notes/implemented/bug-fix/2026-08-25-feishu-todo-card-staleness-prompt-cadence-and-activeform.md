# Agent Note: Feishu todo card staleness was model batching; prompt cadence rule plus activeForm acceptance

Status: implemented

English | [中文](2026-08-25-feishu-todo-card-staleness-prompt-cadence-and-activeform.zh.md)

## Problem

Live Feishu progress cards showed todo items as pending long after the underlying work finished. The render path is not the delay: the engine parses a `todo_write` call at `tool_use` time (before the tool even validates), the native `todo/write` session event updates the same pinned section, and `updateTodoSection` flushes through a 300 ms throttle with a delayed catch-up flush and transient-PATCH retry — the card shows the latest snapshot within about a second of the session event.

The session logs hold the cause. Across 67 daemon sessions carrying todo lists (228 successful `todo_write` calls), the model writes the list once at the start and once at the end, marking everything completed in the final write; between the two sit up to 378 tool calls and 53 minutes (`cc-20260824-130227-aa3b8e71d0ec`). The card renders the last snapshot faithfully, so mid-turn statuses go stale. Claude Code's timeliness comes from the model following TodoWrite discipline reinforced twice — system prompt and tool description; dsh carried the identical tool-description sentence ("Mark a todo `completed` the moment it is done (do not batch completions)") but nothing in the agent-conventions prompt section.

Secondary friction: models trained on Claude Code's TodoWrite send `activeForm` (4 of 233 observed calls) or a hallucinated extra field (1 of 233); `additionalProperties: false` rejected the whole call, and one such failure left the list unmaintained for ~30 minutes.

## Decision

- **A cadence rule in the agent-conventions prompt section** (`agentConventionsPrompt`, registered for plain sessions by the dsh adapter): update the todo list the moment an item completes — mark it `completed`, mark the next one `in_progress` — never batch updates to the end, because the Feishu card renders the list live. This is the missing second emphasis Claude Code gets from its system prompt.
- **`todo_write` accepts an optional `activeForm`**: trimmed on acceptance, dropped when empty, logged with the snapshot (the logged snapshot stays equal to what the model believes it wrote), echoed in the tool output, carried by the `todos` projection wire schema and the feishu-bridge adapter's `todo_update` mapping. The pinned card section already renders it for `in_progress` items. Item keys beyond `content`/`status`/`activeForm` still fail loud; the durable invariant validates `activeForm` (string, non-empty, trimmed) when present and stays silent on its absence, so historical logs replay unchanged. The `todos` projection keeps `stateVersion: 2`: the fold is unchanged and old rows remain valid.

## Alternatives considered

**Loop-level stale-todo reminders.** Deferred: injecting a mid-turn reminder when the list is stale would live in agent-loop, against the plugins-not-loop-changes rule. Try the prompt-level fix first and measure whether the model follows it.

**Card-side completion inference.** Rejected: the card must render the durable snapshot, not guess state from tool traffic.

## Consequences

Model adherence to the new bullet is the open risk — the prompt rule is enforceable only by observation. If batching persists after deployment, the escalation path is a reminder mechanism on a documented extension point. The ACP snapshot pins (tool-schema and system-prompt type projections) now carry `activeForm`; they are refreshed by the keyless refresh mode, not re-recorded.

## Testing

`tool-todo.spec.ts`: schema-shape pin includes `activeForm`; accept/trim/drop round-trip asserts the logged snapshot and tool output. `invariant.spec.ts`: accepts a trimmed `activeForm`, rejects non-string, empty, and untrimmed. `chatroom-persona.spec.ts`: verbatim pin of the conventions text with the new bullet. `adapter-projection.spec.ts`: `activeForm` passes through `todo_update`, empty ones drop. Full suites: feishu-bridge 2303, session + token-meter 336, tools + client 3929; repo typecheck and keyless snapshot replay pass — the five residual snapshot failures on this host (Node 24 SQLite stderr warning, `mkdtemp` EPERM under the agent sandbox, landlock Napi crash) reproduce on a clean dev checkout and predate this change.
