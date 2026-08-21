# Agent Note: feishu-bridge stall retry re-armed the event loop on the dead pre-retry channel

Status: implemented

English | [中文](2026-08-21-feishu-bridge-stall-retry-dead-channel.zh.md)

## Problem

Production incident 2026-08-21 07:34 (chat oc_07627): a model stream hung mid-reasoning for 200 s, the idle watchdog fired the designed stall retry (「⚠️ Agent 无响应超时（200），正在重试（1/3）」), and 2.4 s later the retried turn died with the spurious 「⚠️ Agent 进程意外退出」 — the restart was killed by its own bookkeeping three seconds after it began. The session recovered only because the user resent 「继续」.

`processInteractiveEvents` captured the agent session's event channel as a loop-local `const channel` and re-armed its receive promise from that constant after every received event. `restartAgentForStallRetry` swapped `recvP` to the resumed session's channel but never swapped `channel`, so the retried turn's **first** event re-armed `recvP` on the old, already-closed channel; the next loop iteration read that close as the `closed` select case and ran the agent-exit path (`handleChannelClosed` → exit notification + `cleanupInteractiveState`, which disposed the healthy resumed agent). The 28 ms gap between the retried turn's first reasoning delta and the turn's `aborted/disposed` end in the session log is exactly one loop iteration.

The investigation first suspected the dsh runtime (the disposal genuinely ran `machine.cancel({kind:'disposed'})` via factory dispose), because every engine-initiated close marks the state stopped first and cannot produce the exit notification. A core-level bisect test — mid-turn dispose of a hung agent, immediate same-id resume, assert the resumed turn completes — passed, proving the factory/registry lifecycle clean and localizing the bug to the engine loop.

## Decision

Track the live channel in a `let events` alongside `recvP`: initialize both from the loop-entry session's channel, swap both in the stall-retry branch (`events = retry.events()`), and re-arm `recvP = events.receive()` after each received event. The old `channel` constant remains only as the drain target handed to `restartAgentForStallRetry`.

## Alternatives considered

**Re-arming from `state.agentSession?.events()` on each event.** Couples the loop's arm step to interactive-state mutation timing; a queued-turn transition swaps the session between events, and reading state there reintroduces a different stale-read class.

**Swapping only `recvP` in the retry (the pre-fix shape).** Any event received after the swap resets the arm to the dead channel — the bug.

## Consequences

A stall retry now survives its own first event; the retry-exhaustion path (N retries, then 「💀 Session terminated」 + state cleanup) is reachable again — before the fix the first retried event always short-circuited the loop into the exit path, so exhaustion could never occur. The real trigger (a provider stream that stops emitting while the connection stays open) still surfaces as the stall notification, which is the designed behavior.

## Testing

`tests/engine/engine-stall-retry.spec.ts` is a REAL-composition suite: the full Engine + DshAgentAdapter over a real Cordis runtime (agent-loop, registry, jsonl persistence) with a scripted LLM adapter whose first request hangs mid-stream and whose retry response delays its first chunk — the incident shape at test speed (idle timeout 400 ms). Red run reproduced both chat messages verbatim and showed two `agent/disposed` events for one session id; green run completes the retried turn and, in a second case, exhausts three retries to the terminal kill without any exit notification. `packages/core/agent-loop/tests/stall-retry-resume.spec.ts` keeps the bisect as a factory lifecycle guard. Full feishu-bridge + agent-loop suites: 2262 green.

An application-transcript snapshot of the stall-retry flow is not covered: the snapshot harness replays recorded model responses and has no timed wire-fault injection, which a stall scenario requires. Deferred rather than expanding the harness in this change; the real-composition suite is the coverage stand-in.
