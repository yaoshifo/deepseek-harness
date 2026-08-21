# Agent Note: feishu-bridge quiet mode suppressed the streaming 思考中 header

Status: implemented

English | [中文](2026-08-21-feishu-bridge-quiet-thinking-header.zh.md)

## Problem

On the live profile (project `开发虾`, `features.quiet: true`), the tool-progress card never showed the 思考中 header state while the dsh agent reasoned between tool calls — it stayed on 执行中 (yellow) for the whole turn. Go cc-connect, on the same quiet config (`thinking_messages = false` + `tool_progress = true`), showed it. The migration gate was one condition too wide: `engine.ts` `case 'thinking_delta'` guarded `sp.appendThinking(...)` behind `this.display.thinkingMessages`, so `thinkingText` stayed empty and `streaming.ts` `buildProgressDisplayLocked` never emitted `__cc_state__:thinking`. cc-connect's `EventThinkingDelta` (`core/engine_events.go:4022`) has no such guard — its quiet mode suppresses thinking *messages* only, never the streaming 💭 section and header state. Two adjacent safety nets were dropped in the same port: `EventThinking` calls `clearThinking` before its `!ThinkingMessages` branch (`engine_events.go:3696`), and `EventToolUse` clears streaming thinking when a tool starts (`engine_events.go:3781`).

## Decision

Quiet mode keeps suppressing thinking messages but no longer the streaming preview, matching Go: `thinking_delta` appends to the 💭 section whenever `sp.canPreview()`; `case 'thinking'` hoists the `clearThinking` call above the quiet early break (whose skip of `completeAndDetach` and segment flush stays — that part fixed a real duplicate-reply regression and matches Go's `tool_progress` behavior of keeping the card alive); `case 'tool_use'` gains the Go safety net — clear thinking and reset `thinkingAccum` when a tool starts — so the header cannot linger on 思考中 for delta-only agents that never emit a full thinking block. The `cp.appendEvent('thinking', ...)` message path keeps its `thinkingMessages` gate; that one is correct Go parity.

## Alternatives considered

**Setting the header from the full `thinking` block instead.** Agents that never stream deltas would then show 思考中 with no body; Go derives the state exclusively from the delta-driven `thinkingText`, and the dsh harness streams `reasoning-delta` chunks (`agent-dsh/adapter.ts` maps them), so delta-driven is both the parity shape and the live shape. The Go one-line "Thinking" progress entry for delta-less agents stays unported — see below.

## Consequences

The card header flips 执行中 → 思考中 → 执行中 with the model's reasoning/executing phases in quiet mode, as in cc-connect. Known deferred gap (deliberate): cc-connect's quiet mode also appends a one-line `Thinking` progress entry when a thinking block arrives without prior deltas (`engine_events.go:3704`, `formatThinkingProgressLine`); the TS port has no equivalent, which only matters for agents that emit full thinking blocks without deltas — not the dsh path.

## Testing

`tests/engine/engine-events.spec.ts` `quiet-mode thinking preview (cc-connect parity)`: three tests over `thinkingMessages: false` + `toolProgress: true` — deltas set `__cc_state__:thinking`, the full block clears it (no lingering 💭, no thinking message sent), and a new tool call clears it. The driver paces event batches one `progressFlushInterval` (300ms) apart so throttled header PATCHes land mid-turn, as they do over real multi-second thinking. Full package suite 1977 tests green.
