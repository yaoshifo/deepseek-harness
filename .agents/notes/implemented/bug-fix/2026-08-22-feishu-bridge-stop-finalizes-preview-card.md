# Agent Note: feishu-bridge user stop now finalizes the preview card itself

Status: implemented

English | [中文](2026-08-22-feishu-bridge-stop-finalizes-preview-card.zh.md)

## Problem

Production incident 2026-08-22 (chat oc_74a7): a `/done` sent while a vision MCP tool call was in flight left the progress card frozen at 「执行中 · 17:01:02 · 6」 forever — a Running header, a tool count, and no terminal state, while the engine had actually torn the session down within a second (session log: `turn/end reason aborted(disposed)` at 17:00:55.079; a later ⏹ click on the frozen card replied "没有正在执行的任务").

The stopped-card render lived in exactly one place: the event loop's 'stop' race arm, which calls `sp.markStopped()` after a sender barrier. `stopInteractiveSession` resolves the stop signal and closes the event channel in the same synchronous block, so a loop that is mid-event-handler when the stop lands reaches its next race with both arms already settled — `Promise.race` order (`recvOutcome` first) hands the win to the 'closed' exit, and the early `isStopped()` event-return path skips the render too. In the incident the loop was parked that way for ~5 s: a throttled `sendPreviewStart` (the global PATCH limiter backs up under multi-chat load) held the preview mutex inside the placeholder flush while the loop waited in `appendProgress`. After the loop exited, the preview's delayed flush timers were still armed with `degraded` unset, so they kept PATCHing Running-state content after the stop — the 17:01:02 title — and nothing ever rendered a terminal card. The [stop-is-silent note](../feature/2026-08-21-feishu-bridge-stop-silent.md) made the ⏹ card the only success feedback for a stop, so the skipped render also meant zero stop feedback.

## Decision

`stopInteractiveSession` finalizes the active preview itself, right after `state.markStopped()`: it fire-and-forgets `state.preview.markStoppedSync()` (previously dead code — Go's `stopInteractiveSession` calls `sp.markStoppedSync()` at this exact site with a comment describing the same overwrite symptom; the port had dropped it) with a warning on failure. `markStoppedSync` sets `degraded` first — late throttled flushes and appends become no-ops — then barriers the per-state async sender so already-queued Running PATCHes land first, then PATCHes the ⏹ card inline. It queues on the preview mutex behind any in-flight flush, so ordering with queued Running content is preserved without coordination.

`Engine.stop()` renders the same ⏹ finalize for in-flight turns before platforms stop (2026-08-22 oc_610e reload incident: the loop never resumed before process exit, so nothing else could render), shipped by the parallel reload fix as `e7a3233fc6`, which also latches `flushLocked` on `stoppedCardRendered` so a throttled flush cannot overwrite the ⏹ card. Until 2026-08-23 this finalize never ran on the SIGTERM path: the per-engine effect disposer was `void engine.stop()`, and `profile-boot.ts` exits once the `fiber.dispose()` chain drains — with nobody awaiting the stop, its in-flight stop-notice and ⏹ PATCH died with the process when an unrelated env-fix timer ran `systemctl restart` mid-chatroom, freezing the running card at 「思考中 · 09:39:26 · 19」. The disposer now returns `engine.stop()`'s promise; Cordis unloading awaits async disposers, bounded by profile-boot's 5 s shutdown timeout.

`StreamPreview` gains a `stoppedCardRendered` guard set under the preview lock: the event loop's stop arm and the synchronous finalize race to render the terminal card, and the loser returns without PATCHing again. `resumeFromFreeze` resets the guard alongside `degraded`, keeping "the card is live again" one invariant.

## Alternatives considered

**Reordering the race array or checking `isStopped()` before the 'closed' branch.** Only covers the parked-race window; the mid-handler exit and the `isStopped()` event early-return still skip the render. A user stop must not depend on where the event loop happens to be scheduled — hence finalizing at the call site that owns the stop.

**Rendering the stopped card in `handleChannelClosed`.** Wrong owner: channel-close means agent-exit (its notice logic keys off `unexpectedExit`), and the loop can also exit through the event early-return without reaching it.

**Reusing `cancelRenders` for the preview.** It aborts plan/reply-HTML render forks, a different writer with different lifecycle; the preview needs a terminal render, not an abort.

## Consequences

A user stop (`/stop`, `/done`, `/new`, `/switch`, the ⏹ button) deterministically renders the ⏹ terminal card once the preview lock turns over and the sender queue drains, even under PATCH backpressure — the multi-second delay of the incident becomes a late-but-correct render instead of a frozen Running card. A SIGTERM or daemon restart follows the same contract: the stop notice and ⏹ card land before process exit; a stop that exceeds profile-boot's 5 s budget still force-exits, falling back to the frozen-card outcome. The MCP server behind an aborted tool call may still finish computing server-side (it did, at 17:01:05, ten seconds after the abort) — client-side cancellation cannot stop a remote server, and the correct ⏹ state is what stops misleading the user about it.

## Testing

`tests/engine/engine-events.spec.ts` ("user stop mid-handler") reproduces the incident deterministically: a deferred `sendPreviewStart` holds the preview lock, the loop parks in `appendProgress`, the stop lands, the gate opens — the card must show a `stopped:` render and no `update:`/`start:` after it. `tests/streaming.spec.ts` pins the render-once guard across `markStoppedSync` + `markStopped` and its re-arm by `resumeFromFreeze`. `tests/shutdown-assembly.spec.ts` pins the awaited-disposer contract: `fiber.dispose()` stays pending while `engine.stop()` is unsettled. feishu-bridge suite: 2103 passing.
