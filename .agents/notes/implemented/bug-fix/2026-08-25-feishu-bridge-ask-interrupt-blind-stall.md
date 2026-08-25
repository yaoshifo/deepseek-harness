# Agent Note: Ask interruption settles mid card delivery; the stall watchdog cross-checks the agent's own stream

Status: implemented

English | [中文](2026-08-25-feishu-bridge-ask-interrupt-blind-stall.zh.md)

## Problem

The 2026-08-25 oc_29bb incident (chat "mem0 MCP迁移到DSH") surfaced a three-link failure chain that ended with the user seeing `💀 Agent 长时间无响应（200 无输出，已重试 3 次均失败）` — while the session log proved the agent streamed continuously through every kill window:

1. **The parked ask could not be interrupted while its cards were being delivered.** `Engine.askUser` armed its stop/abort race only *after* the pre-card flush, the plan-card send, and the permission/ask card send all completed. A plugin reload (or any engine stop) that landed in that window stopped the platform mid-send; the hanging send parked the ask forever, the exit_plan_mode tool call never returned, and `AgentHandle.dispose()` — which awaits `machine.whenIdle()` — never completed. The session therefore never left `ctx.sessions`: a live-registry leak.
2. **The leak degraded the chat on the next wake.** The subtask gather timeout woke the parent, the resume hit the coordinator's live guard (`cannot prepare session ... while it is live`), the retry budget exhausted, and the chat fell back to a fresh session — losing the entire conversation context (this is the same leak as the 2026-08-21 stall-retry incident, with reload interruption as a second trigger).
3. **The stall watchdog killed the turn it could not see.** On the degraded fresh session the dispatch pump lost the event feed while the agent streamed 16 steps; `stallConfirmed` read only `state.lastEventAt` (the pump's view), so the idle fire killed a healthy stream at an exact 200 s cadence three times — each kill also aborting the turn's in-flight exit_plan_mode ask (the model's "submitted seven times, all futile") — before the terminal 💀.

`Engine.stop()` also never fired the state stop signal (`markStopped`); parked waiters relied on the channel-close drain, which itself depends on the close chain that the parked ask was blocking.

## Decision

- **`Engine.askUser` arms its stop/abort race before any delivery await.** The pre-card flush, the park, and the card sends run inside one `deliverCards` closure raced against `Promise.race([stopP, abortP])`; an interruption settles the ask as `{ outcome: 'cancelled' }` immediately, clears the park if it landed, and returns. Late card sends from an interrupted delivery land harmlessly (the ask is already unsettled; stray answers route nowhere). The abort listener is removed only on the two exit paths — removing it after the delivery race alone would disarm the subsequent decision wait (caught by the existing aborted-ask spec).
- **`Engine.stop()` fires `state.markStopped()`** for states with active turns, so pumps and parked asks settle deterministically instead of depending on the channel-close drain; the pump's stop arm renders the ⏹ stopped card for engine stops (it already distinguished user stops).
- **`stallConfirmed` cross-checks the agent session's own stream.** `AgentSession.lastStreamActivity()` (new optional capability, implemented by the dsh adapter as its projected-event timestamp) arbitrates: when the agent projected events more recently than the pump's last receive, the idle fire logs a `blind pump` warning and refuses the kill. A genuinely blind pump still terminates via the hard turn cap — bounded, diagnosable, and no longer destroying healthy work.

## Alternatives considered

**Registry-level forced retirement of leaked sessions.** Rejected: `AgentHandle.dispose()` is a capability held only by the consumer owner; a `ctx.agents` backdoor that force-detaches a session whose agent still runs risks a zombie appending to a log a resumed session also appends to (seq conflicts). Fixing the interruption path removes the leak at its source instead.

**Bounded `machine.whenIdle()` in the dispose chain.** Deferred: racing the quiescence wait and detaching anyway leaves the same zombie window; the ask-interrupt fix removes the observed hang, and any *other* never-settling tool already violates the documented `exec.signal` contract.

**Self-healing resume (force-close stale wrappers before degrading).** Not needed once the leak's source is fixed; the existing poll-then-degrade remains as the last-resort path.

## Consequences

- An ask interrupted mid delivery settles cancelled; the agent sees the cancelled review and continues per its own handling (plan-mode treats a cancelled review as keep-planning).
- The 2026-08-21 stall-retry leak trigger is covered too: `restartAgentForStallRetry`'s close cancels the turn, the abort signal now reaches the ask through the whole delivery phase, and dispose completes.
- The blind-pump guard trades an unbounded hung card for a bounded one (hard turn cap); the `blind pump` warning is the diagnosis hook for the still-open question of *which* consumer steals the channel under the reload+degrade sequence.

## Testing

`tests/engine/engine-ask-interrupt.spec.ts` (new, five specs): an ask whose platform send hangs settles cancelled when the stop signal fires mid delivery, when the abort signal fires mid delivery, and via `engine.stop()`; `stallConfirmed` refuses the kill while the agent session's stream is newer than the pump receive (asserting the `blind pump` warning) and confirms it when both are stale. The existing aborted/stopped-ask specs in `engine-ask.spec.ts` pin the decision-wait semantics (and caught the listener-removal regression during development). Full feishu-bridge suite: 2334 tests across 134 files pass; repository typecheck passes.
