# Agent Note: wiring the todo-list tool into feishu-bridge progress cards

Status: implemented

English | [中文](2026-08-20-feishu-bridge-todo-write-progress-section.zh.md)

## Problem

dsh agents call `todo_write` (packages/todo/tool-todo), but the feishu-bridge tool-progress card never showed the pinned todo section. Three gaps stacked: (1) `StreamPreview.updateTodoSection` and `CompactProgressWriter.setTodos` shipped in the M2 Go port with no production caller (only tests called them directly), so nothing parsed a todo tool call into card todo items; (2) the per-entry fallback `isTodoWriteToolName` matched only the Claude-style name `TodoWrite`, not dsh's `todo_write`; (3) a real-device smoke exposed two queued-follow-up-turn defects — a turn whose message was queued behind a running turn rendered no tool progress at all (not just todos). A scratchpad reproduction against the source Engine confirmed both: the previous turn's completion degrades the reused `StreamPreview` (`canPreview()` false, so every append is skipped), and the queued arm's channel re-arm orphans the receive waiter armed earlier in the same iteration, which then steals the queued turn's first event (in the smoke run: the `todo_write` tool_use itself).

## Decision

The engine's `tool_use` case (src/engine/engine.ts) detects the todo tool by name, parses the tool input, and feeds both writers: `sp.updateTodoSection(items)` (flushes the streaming card's pinned section) and `cp.setTodos(items)` (rebuilds with the next payload PATCH, which the tool result always triggers). Shared helpers live in src/progress.ts next to `TodoItem`: `isTodoToolName` normalizes underscores and case so `todo_write`/`TodoWrite`/`todowrite` all match, and `parseTodoItems` returns `undefined` for a non-todo-shaped input (engine keeps the last list) versus `[]` for an empty list (engine clears the section). `formatTodoWriteInput` in src/feishu/progress.ts now parses through `parseTodoItems`, so the V2 card's per-entry rendering shows a status-icon checklist for both tool names.

The queued-turn fix has two halves in the engine's in-loop queued arm. It recreates `sp`/`cp` and rebinds the active preview with a fresh placeholder, mirroring the post-permission restart: the previous turn's completion already terminated its card in every result branch, and a degraded preview silently drops the follow-up turn's tool progress while patching its final reply onto the old card. It no longer re-arms `recvP`: the loop arms one receive per received event at the top of the iteration, so a second receive orphans that waiter — and because `EventChannel.push` resolves waiters FIFO, the orphan steals the queued turn's first pushed event. The receive armed before the switch is the correct one to keep.

## Alternatives considered

**Project the durable `todo/write` session event from the dsh adapter as a new engine Event type.** Rejected: it reads authoritative session state instead of call arguments, but requires extending the engine Event union and rippling through stubs and tests. The engine already special-cases tool names (the `Write` plan-file tracking in the same `tool_use` case), so name-based detection is the established extension point.

**Parse in the adapter and push pre-built items.** Rejected: the adapter projects the wire protocol only; presentation concerns belong to the progress/rendering layer it feeds.

**Un-degrade the existing `sp` in the queued arm instead of recreating it.** Rejected: the terminal card would resume receiving PATCHes, resurrecting a completed (green) card for the follow-up turn; a fresh card per queued turn matches how a message arriving between turns renders.

**Drain-plus-rearm harder in the queued arm.** Rejected: any re-arm after the per-event arm leaves two waiters registered; removing the redundant receive is the only state with exactly one waiter.

## Consequences

A dsh agent's `todo_write` calls now render the pinned todo section on the live card (streaming text path) and the `📋 Task List` section on V2 payload cards, replacing the list on each call and clearing it on an empty list. Malformed input keeps the last list rather than silently clearing it. Queued follow-up turns open their own progress card: tool entries, the todo section, and the tool counter describe only that turn, and the first event of the turn is no longer dropped. The completed card of the finished turn stays untouched. The section title stays the existing hardcoded `📋 Task List` (V2) and untitled code block (streaming path); localization was out of scope.

## Testing

`tests/engine/engine-events.spec.ts` `todo_write progress section`: drives `todo_write` tool_use events through `processInteractiveEvents` against a preview-capturing stub platform; asserts the last card update contains the status-icon lines and that an empty-list call clears them. The queued follow-up test queues a message through `queueMessageForBusySession`, drives turn 1 (bash) to completion, then pushes turn 2's events asynchronously from the session's send hook (the queued arm drains before send; real adapters push asynchronously) — asserting a second preview card, the todo lines on it, the final reply, and that turn 1's entry does not leak. `tests/progress-compact.spec.ts` covers `isTodoToolName`/`parseTodoItems` (match set, empty-list vs undefined); `tests/feishu/progress.spec.ts` covers the per-entry checklist for both tool names and the code-block fallback for other tools. Package suite 1865 green, typecheck clean.
