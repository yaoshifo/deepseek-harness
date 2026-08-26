# Agent Note: Every engine-owned agent-session close is bounded

Status: implemented

English | [中文](2026-08-26-feishu-bridge-bounded-agent-close.zh.md)

## Problem

Three engine-owned waits called `AgentSession.close()` with no bound: `restartAgentForStallRetry` (the stall-retry restart), `Engine.stop()` (per-state teardown), and `DshAgentAdapter.stop()` (the close-all at engine shutdown). A close whose underlying dispose never settles — any tool call ignoring its `exec.signal` contract — parked the event pump inside the stall retry forever (the idle timer had already fired, so no watchdog could rescue it) and wedged daemon shutdown. The 2026-08-25 ask-interrupt fix removed the known trigger for a hanging dispose, but the waits themselves stayed unbounded ([incident family](2026-08-25-feishu-bridge-ask-interrupt-blind-stall.md)).

## Decision

All three waits race the close against `agentCloseTimeout` (default 130 s, Go's value) and abandon it on expiry with a warning:

- The stall retry proceeds. The adapter's engine-key session cache (`sessionsByEngineKey`) then reattaches to the still-live session instead of failing the resume, so the turn continues on the reattached session; the blind-pump guard and the hard turn cap own the resulting loop when that session never produces pump events.
- `Engine.stop()` and `DshAgentAdapter.stop()` complete shutdown; an abandoned agent fiber is left to process exit.

The bound is one knob: the per-project `agentCloseSec` cordis field feeds the engine (`setAgentCloseTimeout`, an instance field replacing the module constant) and the adapter (`DshAdapterConfig.closeTimeoutMs`).

## Alternatives considered

**Bounding `machine.whenIdle()` inside the dispose chain.** Still rejected for the same reason as 2026-08-25: detaching mid-quiescence leaves a zombie appending to a log a resumed session also appends to. The engine stops waiting instead; the agent side keeps its orderly teardown.

**Bounded close only in the stall retry.** Rejected after the regression test: the wedge simply moved to `Engine.stop()` → `DshAgentAdapter.stop()`. All three sites are the same wait on the same operation.

## Consequences

- A hung close now costs at most `agentCloseTimeout` per wait site, then fails loud (warn log) with the engine still responsive; the session stays live in the registry until process exit and later resumes go through the live-guard retry/degrade chain.
- The live-guard resume budget keeps its 130 s default (previously the same constant); it is set independently via `setLiveGuardRetryBudgetMs`.

## Testing

`tests/engine/engine-stall-retry.spec.ts` gains a REAL-composition spec whose first session's `close()` never settles: it asserts the close-timeout warning, the stall-retry notification, a subsequent blind-pump warning (the pump is still cycling, not parked), and that `engine.stop()` settles. Full feishu-bridge suite: 2377 tests across 136 files pass.
