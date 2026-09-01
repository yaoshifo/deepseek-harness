# Agent Note: feishu-bridge gather abort settles the parked turn; stop-path close is bounded

Status: implemented

English | [中文](2026-08-26-feishu-bridge-gather-abort-settles.zh.md)

## Problem

The 2026-08-26 oc_b46da chatroom-hub incident had a third layer beyond the [frozen-clock pump](2026-08-26-feishu-bridge-frozen-stream-clock-stall.md) and the [polluted gather expected set](2026-08-26-feishu-bridge-gather-expected-set.md): after the user stopped the gather-blocked turn at 20:59, the durable session log of `cc-…074844` ended at the 20:42 `tool/call feishu_bridge_subtask` — no `tool/result`, no `turn/end`, ever. `gatherSubtasksBlocking`'s abort listener cleared the gather waiter but never settled the tool promise, so the runtime-side turn stayed parked on the tool call forever. The stop path's `cancelTurn()` could not finalize the turn, and its fire-and-forget `agentSession.close()` — the one close site without `closeAgentSessionWithTimeout`'s bound — hung forever inside `handle.dispose()` waiting for a quiescence the parked turn made unreachable, with no timeout to even log a warning. The session stayed live in the runtime registry (`ctx.sessions`), so the 21:30 resume hit `cannot prepare session while it is live`, retried for two minutes, and degraded to a fresh session: the moderator lost its conversational context for nothing. The 21:02 gather-timeout wake also landed nowhere (the interactive state was already cleaned), silently dropping the partial summary.

## Decision

- `gatherSubtasksBlocking` settles on abort: the abort listener clears the waiter (unchanged — later reports must take the async wake, not a dead waiter) and resolves the promise with the new `subtask_gather_aborted` message ("Gather wait aborted by a stop; reports already banked still arrive via the timeout wake."). The parked runtime turn gets its tool result and can end, `aborted/user` becomes reachable, quiescence returns, and dispose can deregister the session. The armed barrier is untouched: the timeout wake still delivers banked reports — except under teardown, where [chatroom interrupt disarms member barriers](2026-09-01-feishu-bridge-chatroom-interrupt-disarms-gathers.md) so the fallback timer cannot wake a torn-down room.
- `stopInteractiveSession`'s close now goes through `closeAgentSessionWithTimeout` like every other close site: a dispose parked on a non-quiescing turn surfaces the `close timed out` warn and is abandoned instead of hanging silently.

## Alternatives considered

- **Resolve with the partial summary on abort.** Rejected: at abort time the barrier is deliberately incomplete; resolving with a partial summary would read as a completed gather to a turn that is being discarded anyway. The async timeout wake owns partial delivery.
- **Force-deregister the runtime session from the stop path.** Rejected: bypassing dispose re-creates the zombie-append hazard the oc_29bb fix removed; the leak's source is the unsettled tool promise, not the registry.
- **Unbounded close with a completion log.** Rejected: observability without a bound still leaks the bridge-side `state.closing` forever and gives the operator no failure to alert on.

## Consequences

- A stopped gather-blocked turn now ends durably (`tool/result` with the abort notice + `turn/end`), the agent session disposes cleanly, and a same-id resume works instead of degrading to a fresh session.
- The abort notice is a tool result the model may see in non-stop abort shapes (plugin reload); it names the fallback path so the model does not re-gather immediately.
- Residual: any other blocking tool that registers an abort listener without settling its promise has the same parked-turn hazard; `gatherSubtasksBlocking` was the only such shape found (askUser settles cancelled since oc_29bb).
- Covered by `tests/engine/engine-subtask.spec.ts` (abort settles with the notice, barrier stays armed; the async-wake fallback spec now settles too) and `tests/engine/engine-resume-race.spec.ts` (a hung stop-path close warns past the bounded timeout).
