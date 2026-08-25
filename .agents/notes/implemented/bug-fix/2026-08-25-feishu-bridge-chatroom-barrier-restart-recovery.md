# Agent Note: feishu-bridge chatroom barriers close across restarts instead of stalling

Status: implemented

English | [中文](2026-08-25-feishu-bridge-chatroom-barrier-restart-recovery.zh.md)

## Problem

`pendingGather` and `pendingEndBarrier` were in-memory objects with live fallback timers; the sessions.json serialization whitelist omitted them. A daemon restart mid-gather silently lost the barrier: role replies relayed into no barrier (serial-path noise, one wake per reply), the moderator never received the all-replies wake, and a restart mid-end-drain froze the teardown forever — the drain timer no longer existed. This is the same restart-loses-scheduling class as the subtask-report recovery incidents.

## Decision

Three coordinated changes:

1. **Snapshots on the hub session.** Both barriers gain a `snapshot()` producing a JSON-safe record (`question`/`seq`/`expected`/`collected`; timer, woken flag, and progress-card handle stay in memory) that `serializeSession` embeds as `pendingGatherData`/`pendingEndBarrierData`. A woken barrier returns `undefined` — every wake path clears the barrier before the next save except the async finalize window, and a restart there must not resurrect a barrier whose wake already fired. Snapshots ride sessions.json (the B4 state.json durable-side-channel precedent), not the native agent session log: they are scheduler state, never model-visible, and the agent log's deletion/compaction lifecycle must not carry protocol state.
2. **Recovery closes instead of re-arming.** `recoverChatroomBarriers` runs from `Engine.start()` once platforms can deliver. Every reply a restored barrier awaits belonged to a role turn that died with the old process (expected ⟺ in-flight turn; `chatroomInFlight` is not even persisted), so the expected set can never complete: each restored gather closes immediately with the collected replies plus a restart annotation, a restored end barrier finalizes without its missing final replies, a research gather posts a fresh terminal progress card (the old handle died with the process), and a stale `researchAwaitingAssistant` marker is cleared so a later re-ask is not misread as a deferred conclusion.
3. **Durable-file validation.** Malformed snapshots drop with a warning instead of crashing recovery (sessions.json is a file boundary).

The full migration of chatroom roles onto native continuable children — the four-phase plan researched on 2026-08-25 (dual identity: native child for identity/lineage/turn-driving, bridge-owned role groups for the visible surface) — is **deferred, not rejected**: restart durability, the part with user-visible value, is now fixed by this note alone. Triggers to start it: a chatroom bug traced to the dual bookkeeping or the hand-rolled research defer state machine; a second consumer for round-table orchestration (at which point a chatroom capability seam is the better end-state); or an explicit preference for native lineage over in-group streaming previews (the migration trades the latter away).

## Alternatives considered

**Re-arm the timer with the remaining deadline.** Rejected: no expected reply can ever arrive after a restart, so waiting would only stall for replies that are already lost — closing with partial results is the timeout semantics applied at the correct time.

**Persist into the native session log.** Rejected: barrier state is scheduler state, not model-visible content (the model-visible ⟺ logged invariant does not require it), and the agent session log's deletion and compaction lifecycle is wrong for protocol state.

**Fix `SubtaskGather` the same way.** Out of scope: `pendingSubtaskGather` has the same non-persistence flaw, but its loss is the already-known subtask-report recovery scenario with its own workaround (group-history recovery); it needs the same treatment only when that pain returns.

## Consequences

A restart mid-gather now closes the round with the replies received and tells the moderator exactly which roles were lost, so it can re-ask them or proceed; a restart mid-end finalizes the teardown with partial final replies. Round-trip behavior is unchanged while the process lives — snapshots are read only at load, and recovery consumes them at start.

## Testing

`tests/engine/engine-chatroom-recovery.spec.ts` (+6): armed/woken persistence round-trips, restart recovery closing a gather with a restart-annotated wake, end-barrier finalization with role cleanup, malformed-snapshot dropping without waking, and the fresh terminal progress card for a restored research gather. Existing chatroom suites (gather/end/session, 116 tests) and the session serialization suite (50 tests) pass unchanged.
