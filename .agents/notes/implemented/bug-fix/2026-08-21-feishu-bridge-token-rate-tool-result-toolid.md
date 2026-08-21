# Agent Note: feishu-bridge token rate inflated by tool-result events missing toolID

Status: implemented

English | [中文](2026-08-21-feishu-bridge-token-rate-tool-result-toolid.zh.md)

## Problem

The ✅ completion card showed `mem0 · test · 40s · 225 t/s` where the same workload on cc-connect showed tens of t/s. The affected turn (`cc-20260821-132814-1dcb6e318599`) ran 40.1s wall clock over 5 API steps with 6 tool calls and produced 2257 output tokens — a true rate of ~60 t/s over the 37.9s of model-generation time.

The engine computes the rate as `outputTokens / (agentWallClock − union(toolIntervals))`, and closes each tool interval by matching `tool_result.toolID` against the `tool_use` key (`engine.ts` `openToolIntervals`). The dsh adapter's main-path `tool/result` projection pushed no `toolID` at all (Go `agent/dsh/session.go` sets `ToolID: callID` on EventToolResult). Every interval therefore stayed open until the `result` event closed them all at turn end, so the subtracted union covered "first tool call → turn end" (33.4s of the 40.1s turn). The thinking time collapsed to the 6.6s before the first tool call and the last request's 1569 output tokens divided by that residue: ≈236 t/s on the card (225 rendered; the engine stamps at processing time, not log time).

Two sibling divergences surfaced in the same code path: the subagent projection read the callId from a nonexistent `message.callId` field (the durable event carries `message.source.callId`, repeated on the `tool-result` block's `toolCallId`), and the result event carried only the **last** assistant message's usage where Go's `accumulateUsage` folds the whole turn's usage (input, cache, output, step count). The engine's ctx/hit footer lines consume the turn sum, so multi-step turns also underreported input deltas and always rendered "0 api".

## Decision

`toolResultCallIdOf(message)` extracts the call id from `message.source.callId` with the `tool-result` block's `toolCallId` as fallback; both the main path and `projectSubagentEvent` project it as `toolID` (subagent ids keep their `<childSessionId>:` namespace). Usage accounting switches to Go's accumulate semantics: `turn/start` zeroes the counters, each `assistant/message` folds its request's usage and increments the step count, and `turn/end` carries the sums plus `numTurns` on the result event.

## Alternatives considered

**Making the engine close ID-less tool_results against the most recent open interval.** Rejected: Go never needed the fallback because its adapter always set ToolID, and a "most recent" heuristic mispairs parallel tools. The projection is the divergence; fix it there.

**Leaving the numerator as the last request's usage.** Rejected: the rate divides turn-wide generation time, and Go's dsh adapter accumulates — keeping the last-call numerator would underreport multi-step turns by exactly the earlier steps' tokens.

## Consequences

Tool-time intervals close on their own tool_result, so the rate denominator is the model's actual generation span; the numerator and the ctx/hit lines now carry turn sums (multi-step turns no longer underreport, "N api" shows the real step count). ID-less tool_results still project without `toolID` and the engine still closes stragglers at `result` — the pre-existing fallback pairing is untouched. Not fixed here (same-root omissions, deliberately deferred): tool_result still carries no `toolName` (Go rebuilds it from a pending callId→name map; the engine's Write plan-file promotion and result labels read it), and real `tool/call` events still project no `toolInputRaw` (the engine's `file_path` plan-path tracking reads it).

## Testing

`tests/agent-dsh/adapter.spec.ts`: the durable tool/result shape projects `toolID` (red before, green after); the result event carries the turn-wide usage sums and step count, and a following turn starts from zero. `tests/agent-dsh/adapter-subagent.spec.ts`: the real durable shape (callId on `message.source` and the tool-result block) projects the namespaced id — the old test encoded a flat `message.callId` fiction that production never delivers, which is how the bug stayed hidden. `tests/engine/engine-events.spec.ts`: a contract test locks the engine side — a tool_use/tool_result pair with matching ids closes mid-turn, so post-tool generation time stays in the thinking time (green before and after; it pins the pairing the adapter now feeds). Full package suite green (2008 tests).
