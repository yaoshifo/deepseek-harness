# Agent Note: Background-subtask live panel

Status: implemented

English | [中文](2026-08-27-feishu-bridge-background-subtask-panel.zh.md)

## Problem

When a parent turn settles with native subtasks still running (the no-gather escape path — spawn, hand off, end the turn, wake per report), the chat went silent: child events project into the parent channel only while a bridge session is live, and the turn's `completeAndDetach` removes it, so `resolveSubagentAncestor` drops every child event afterward. The user watched a frozen "N 个子任务运行中" footer with no way to tell whether the children were alive (2026-08-27 oc_a7ab0de6: two implementation children ran eight-plus minutes on the settled card alone). The 2026-08-26 visibility note had already deferred a per-child panel, blocked on the post-detach PATCH channel for the settled progress card.

## Decision

A standalone panel card — its own message handle, never the progress-card machinery — sidesteps that blocker entirely:

- **Lifecycle**: posted when a turn settles with unreported native children (`ensureSubtaskPanel` at the turn-end recount site), PATCHed in place on a timer (`features.subtaskLivePanelIntervalMs`, default 15s) and on every reported-flag flip, finalized to a done card when the set settles (a dead card PATCH failure finalizes silently — a recalled or deleted chat must not tick forever). `/done` drains close it with a drained card; engine `stop()` clears the timers. Gather turns never post one — their live card already streams child activity, and a gather-held turn never settles mid-wait.
- **Rows**: per pending child — label, tool-call count, last-activity clock plus relative age ("上次活跃 HH:MM:SS（刚刚/N 分钟前）"), a ⚠️ stall flag after `features.subtaskLivePanelStallMs` (default 120s) of silence, and "尚未产生事件" before the first event. A Stop-all button (`act:/subtask-panel stop`) interrupts every pending child through `interruptNativeChild`; the interrupts flip the reported flags and the next refresh finalizes the panel. The header and row wording were later reworked into the tool-progress running composition; [the header-refresh note](2026-08-28-feishu-bridge-subtask-panel-header-refresh.md) owns that decision.
- **Data source**: the adapter's subagent activity recorder — `session/event` feeds `childId → {lastEventAt, toolCalls}` for every session with a `parentSession` header, before (and independent of) the ancestor projection, so recording survives the parent turn's detach. Exposed to the engine through the `SubagentActivitySource` structural probe; the panel finalization forgets settled children's entries so the map does not grow with the daemon's lifetime.

## Alternatives considered

- **PATCH the settled progress card's footer with per-child rows.** Rejected: the footer is one line, the 2026-08-26 note deliberately keeps the settled header terminal, and it needs exactly the post-detach progress PATCH channel that motivated the deferral.
- **Keep the projection alive past detach and stream rows from it.** Rejected: the detached session's channel has no consumer, keeping one is new lifecycle machinery, and events (not liveness) is the wrong granularity — the panel wants counters, not a stream.
- **Poll child session logs.** Rejected: the recorder already sees every durable event at zero I/O; polling re-reads zstd logs on every tick for the same numbers.

## Consequences

- Mode B (parent suspended, children in background) now shows continuous liveness; a hung child is distinguishable from a working one within one stall window.
- Panels are in-memory: a daemon restart or HMR rebuild drops them (the restart-recovery notice accounts for the records; the stale panel card simply stops updating — the Agent Note on machine-wake steer covers the restart path).
- A parent woken by a report renders a new turn's own card while the panel keeps PATCHing the remainder — PATCH-in-place never fights the tail guard, which owns reissue for progress cards only.
- Pinned by `tests/engine/subtask-panel.spec.ts` (renderer layout, post/refresh/finalize, config-off, drain, stop-all) and the activity-recorder cases in `tests/agent-dsh/adapter-subagent.spec.ts` (detach-immune recording, non-child sessions ignored). Successor to the deferred item in [2026-08-26](2026-08-26-feishu-bridge-pending-subtasks-card-visibility.md); the gather-mode counterpart lives in [2026-08-27](2026-08-27-feishu-bridge-blocking-gather-and-failure-settlement.md).
