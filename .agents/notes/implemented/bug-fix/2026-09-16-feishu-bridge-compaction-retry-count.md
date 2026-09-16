# Agent Note: Count only landed compactions; surface failed retries

Status: implemented

English | [中文](2026-09-16-feishu-bridge-compaction-retry-count.zh.md)

## Problem

The adapter projected only `compaction/start` into the engine event stream, so the bridge never learned whether an attempt landed a checkpoint. Both counters charged every attempt: `state.compactionCount` (status footer's "N zip") and the card's `compactCount` ("🗜上下文压缩：N次") each incremented on start. Live evidence (2026-09-16, oc_8b19): one summarization hit the token cap (fail-closed, no checkpoint) and the next step's retry landed — the card displayed "压缩2次", which reads as two independent compactions and misled the operator into a triage.

Two adjacent lies rode the same gap: the no-preview-card path sent the "auto-compacted" chat message on start, announcing a checkpoint before it existed; and a failed attempt had no card-visible trace at all.

## Decision

- The adapter projects `compaction/end` too, carrying failure identity in `errorText` (absent on a landed checkpoint). `Event.done` splits the compaction lifecycle on the wire: false is the start, true is the end.
- The engine counts `state.compactionCount` only on a successful end; a failed end becomes a `isCompactRetry` progress entry instead. The start drives a "compacting…" progress entry only (new `context_compacting` key) — no count, no chat message.
- The card summary line separates the two tallies: "🗜上下文压缩：N次（含M次重试）" when both are nonzero, "🗜上下文压缩重试：M次" when every attempt in the turn failed. The no-preview path sends one message per end — `context_compacted` on success, the new `context_compaction_retried` on failure.
- Evolves the [native signal projection note](../simplification/2026-08-23-feishu-bridge-native-signal-projection.md) (which introduced start-only counting) and the [compress-path removal note](../simplification/2026-09-16-remove-bridge-compress-path.md) (which kept `compactionCount` as the footer's writer); neither is superseded — the writer's semantics are.

## Alternatives considered

**Guess in the engine without the end event.** The bridge has no other source for attempt outcome; anything derived there is fabrication.

**Count only successes and hide failures entirely.** A turn that fails every attempt would show nothing — the exact observability gap that made the original incident worth a triage. The retry line stays.

## Consequences

- "N zip" and the card count now mean landed checkpoints; a retry storm is visible as （含M次重试） instead of inflating the count.
- The retry tallies are per-card (one StreamProjection per turn), matching the existing count's lifecycle; a failure in turn N and the landing in turn N+1 render on their own cards.
- Compaction-in-progress is now visible on the progress ring for the summarization window (~25–35 s) where the card previously showed nothing.
- The compaction wire contract lives on `Event.done`/`errorText`; a future third lifecycle frame would need a distinct field rather than overloading `done` further.
- Tests: `engine-events.spec.ts` — landed counting, failed-retry display, all-failed retry line, both no-preview chat messages.
