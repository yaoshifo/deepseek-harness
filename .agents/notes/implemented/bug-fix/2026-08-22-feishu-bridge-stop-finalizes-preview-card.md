# Agent Note: feishu-bridge user stop now finalizes the preview card itself

Status: implemented

English | [中文](2026-08-22-feishu-bridge-stop-finalizes-preview-card.zh.md)

## Problem

Production incident 2026-08-22 (chat oc_74a7): a `/done` sent while a vision MCP tool call was in flight left the progress card frozen at 「执行中 · 17:01:02 · 6」 forever — a Running header, a tool count, and no terminal state, while the engine had actually torn the session down within a second (session log: `turn/end reason aborted(disposed)` at 17:00:55.079; a later ⏹ click on the frozen card replied "没有正在执行的任务").

The stopped-card render lived in exactly one place: the event loop's 'stop' race arm, which calls `sp.markStopped()` after a sender barrier. `stopInteractiveSession` resolves the stop signal and closes the event channel in the same synchronous block, so a loop that is mid-event-handler when the stop lands reaches its next race with both arms already settled — `Promise.race` order (`recvOutcome` first) hands the win to the 'closed' exit, and the early `isStopped()` event-return path skips the render too. In the incident the loop was parked that way for ~5 s: a throttled `sendPreviewStart` (the global PATCH limiter backs up under multi-chat load) held the preview mutex inside the placeholder flush while the loop waited in `appendProgress`. After the loop exited, the preview's delayed flush timers were still armed with `degraded` unset, so they kept PATCHing Running-state content after the stop — the 17:01:02 title — and nothing ever rendered a terminal card. The [stop-is-silent note](../feature/2026-08-21-feishu-bridge-stop-silent.md) made the ⏹ card the only success feedback for a stop, so the skipped render also meant zero stop feedback.

## Decision

`stopInteractiveSession` finalizes the active preview itself, right after `state.markStopped()`: it fire-and-forgets `state.preview.markStoppedSync()` (written for exactly this synchronous-stop shape but previously dead code) with a warning on failure. `markStoppedSync` sets `degraded` first — late throttled flushes and appends become no-ops — then barriers the per-state async sender so already-queued Running PATCHes land first, then PATCHes the ⏹ card inline. It queues on the preview mutex behind any in-flight flush, so ordering with queued Running content is preserved without coordination.

`StreamPreview` gains a `stoppedCardRendered` guard set under the preview lock: the event loop's stop arm and the synchronous finalize race to render the terminal card, and the loser returns without PATCHing again. `resumeFromFreeze` resets the guard alongside `degraded`, keeping "the card is live again" one invariant.

## Alternatives considered

**Reordering the race array or checking `isStopped()` before the 'closed' branch.** Only covers the parked-race window; the mid-handler exit and the `isStopped()` event early-return still skip the render. A user stop must not depend on where the event loop happens to be scheduled — hence finalizing at the call site that owns the stop.

**Rendering the stopped card in `handleChannelClosed`.** Wrong owner: channel-close means agent-exit (its notice logic keys off `unexpectedExit`), and the loop can also exit through the event early-return without reaching it.

**Reusing `cancelRenders` for the preview.** It aborts plan/reply-HTML render forks, a different writer with different lifecycle; the preview needs a terminal render, not an abort.

## Consequences

A user stop (`/stop`, `/done`, `/new`, `/switch`, the ⏹ button) deterministically renders the ⏹ terminal card once the preview lock turns over and the sender queue drains, even under PATCH backpressure — the multi-second delay of the incident becomes a late-but-correct render instead of a frozen Running card. The MCP server behind an aborted tool call may still finish computing server-side (it did, at 17:01:05, ten seconds after the abort) — client-side cancellation cannot stop a remote server, and the correct ⏹ state is what stops misleading the user about it.

## Testing

`tests/engine/engine-events.spec.ts` ("user stop mid-handler") reproduces the incident deterministically: a deferred `sendPreviewStart` holds the preview lock, the loop parks in `appendProgress`, the stop lands, the gate opens — the card must show a `stopped:` render and no `update:`/`start:` after it. `tests/streaming.spec.ts` pins the render-once guard across `markStoppedSync` + `markStopped` and its re-arm by `resumeFromFreeze`. feishu-bridge suite: 2077 passing.
