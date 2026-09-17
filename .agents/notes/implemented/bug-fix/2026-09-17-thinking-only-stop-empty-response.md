# Agent Note: Treat a thinking-only stop as an EMPTY_RESPONSE error, not a silent completion

Status: implemented

English | [中文](2026-09-17-thinking-only-stop-empty-response.zh.md)

## Problem

Live evidence (2026-09-17, two occurrences): a Feishu group agent finished a 10-minute research turn (58 read-only tool calls) whose final model response contained **only a reasoning block** — the complete plan draft, cut off mid-sentence — while the wire reported a clean `end_turn`. The adapter guards only rejected a stop with **zero** content blocks; one thinking block passed, the loop saw no tool calls, and the turn ended `completed` with no user-visible output: a green「执行完成 · 15:26:15 · 58」card, a 🤫 silent-reply hint, zero daemon log lines. A second occurrence the same day (13:02, a mycontext subagent, also `deepseek/deepseek-flash`) confirms this is a recurring provider failure mode, not a one-off: the provider/gateway truncates mid-thinking yet reports a normal stop.

The silent path was real: `mapStopReason` (llm-pi-ai — the live mify-dsh route) and both llm-deepseek protocol translators each had the same guard shape (`content.length === 0` / `blocks.size === 0` / `order.length === 0`), and two tests explicitly codified the pass-through: llm-pi-ai `convert.spec` "keeps a thinking-only stop successful (any block counts as content)" and llm-deepseek `translate.spec` "keeps a reasoning-only stream a successful stop (any opened block counts)".

## Decision

Extend all three adapter guards from "no blocks at all" to "no text and no tool-call blocks" (thinking/reasoning blocks do not count as content), keeping the failure code `EMPTY_RESPONSE`:

- `llm-pi-ai/src/stream.ts` `mapStopReason` — the production path (mify-dsh serves both GLM and deepseek-flash through it).
- `llm-deepseek` messages protocol `translate` (throws) and chat-completions protocol `translate` (error finish).

`EMPTY_RESPONSE` is already in the default retryable code set, so the recovery chain is entirely existing machinery: error finish → `assistant/attempt` + `agent/request-error` → llm-retry (default 5; live mify-dsh profile 15) → on success the turn produces real content; on exhaustion the turn ends `error` and the bridge renders the existing red-card/❌/attention surface. Failure is now loud in both outcomes; no bridge, loop, SDK, or session-format change.

Both codified pass-through tests were reversed into EMPTY_RESPONSE assertions (behavior change with its tests); a new `reasoning_only_stop` mock-server behavior plus a transport-recovery case lock the composition: reasoning-only stop → one `llm/retry` (`EMPTY_RESPONSE`) → success → exactly one committed assistant message with text, turn `completed`.

## Alternatives considered

- **Loop-level detection at `agent.ts`'s no-tool-calls branch.** After all three adapters guard the shape, no real path can reach it; the check would be unreachable code, and a new `TurnEndReason` kind drags docs/architecture.md, both SDKs' expected outputs, and 10+ consumer surfaces. Rejected (revisit if a future adapter reintroduces the gap).
- **Steer-based continuation** (`agent/turn-stopping` + `steer`, the sanctioned same-turn continuation). Regeneration via retry already self-heals the flaky case; steer injects synthetic messages for no additional recovery. Rejected here — `max-tokens` continuation (the GLM burn-the-cap family) is a separate pending decision this note deliberately does not touch.
- **Fixing the provider.** The gateway reports mid-thinking truncation as a clean `end_turn`; wire-level it is indistinguishable from a genuine stop. Out of our control; the guard is the boundary that must hold.

## Consequences

- A thinking-only stop now costs up to `maxRetries` extra requests (output tokens; rare, bounded) instead of a silently dead turn.
- A provider that *deterministically* emits thinking-only stops surfaces as retries-then-red-card rather than silence — visible, slower than silence, strictly better for diagnosis.
- Message texts distinguish the shape (`"... no content (thinking only)"` / `"(reasoning only)"`) for log triage.
- redacted-thinking-only stops are equally rejected (both map to the thinking content type).
- Upstream candidate: this is a seam fix with no fork-local coupling; propose to upstream once it has soak time on the live profile.
