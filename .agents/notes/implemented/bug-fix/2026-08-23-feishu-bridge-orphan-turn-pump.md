# Agent Note: engine-woken turns run on an orphan-turn event pump

Status: implemented

English | [中文](2026-08-23-feishu-bridge-orphan-turn-pump.zh.md)

## Problem

`processInteractiveEvents` (the message-path event pump) lives only for a user message's turn: on `result` with no queued user message it returns. Turns the engine wakes without a user message — a background job completion notice, a background subagent report — still push channel events (the dsh adapter projects every durable event), but nothing consumes them: the reply never reaches the platform, `lastResult` stays stale, permission/plan-review requests are never bridged (`state.pending` never set), and the idle reaper's pending-exemption cannot fire. Fifteen minutes later the reaper disposes the whole interactive state and the parked turn ends `aborted/disposed`. The 2026-08-23 oc_9956 incident lost three turns this way and surfaced an `exit_plan_mode` review to nobody.

A second defect hid underneath: the pump re-arms its receive before processing each event, so on exit it leaves a pending waiter on the `EventChannel`. A JS promise cannot cancel its waiter (a Go receive goroutine just dies), so the dead waiter sat ahead of every later receiver and silently swallowed the next event — in production this ate the first streamed chunk after each user turn, and it would have starved any watch parked behind it.

## Decision

Two mechanisms in `packages/acp/feishu-bridge`:

1. `EventChannel.receiveArmed()` (`src/core/types.ts`) returns the receive promise plus a `cancel()` arm that removes the waiter. The pump holds its receive as an arm and cancels it in a `finally`, so an exited pump never steals the next event.
2. `armOrphanWatch` / `runOrphanTurnPump` (`src/engine/engine.ts`) park one receive after every pump exit. The first orphan event takes the session lock and runs a full `processInteractiveEvents` with the already-consumed event injected as `firstEvent` and `state.replyCtx` as the reply context — reusing the existing rendering, delivery, permission bridging, and stall machinery. If the lock is held (a message-path pump is alive), the watch pushes the event back onto the channel for that pump; FIFO single-consumer semantics keep delivery exactly once. The watch re-arms after each orphan pump, so cascading reports each get a pump.

## Alternatives considered

**Detecting `turn/start` on the adapter's `session/event` subscription.** Detection and consumption separate: the same `turn/start` must still reach the pump through the channel, and the adapter would need a new notification channel into the engine. The watch consumes and detects at the same point.

**Routing background notices through the bridge as virtual user messages.** Requires changing the harness-side subagent/jobs notification mechanism across packages; the watch fixes delivery inside the bridge alone.

**Go parity.** Go cc-connect has the same gap (its event select only runs for message turns); this fix is a deliberate deviation beyond Go, like the queued-turn takeover before it.

## Consequences

Engine-woken turns are fully delivered: reply, progress card, permission and plan-review cards, and the reaper's pending-exemption all work for them. The leftover-waiter fix also stops the first streamed chunk after each user turn from being swallowed. An orphan pump holds the session lock like a message turn, so user messages arriving mid-orphan-turn queue with the normal notice and drain afterward. The unsolicited-permission gate Go's background reader carries is still absent (unchanged scope).

## Testing

`tests/engine/engine-orphan-turn.spec.ts` — five behaviors: delivery after pump exit (`lastResult` updates), permission bridging plus reaper shielding, hand-back to a running message pump (no second pump), cascading orphan turns, and user-message queueing while an orphan pump owns the session. feishu-bridge suite: 2113 passing.
