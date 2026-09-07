# Agent Note: feishu-bridge auto-compress reads the session-projection occupancy

Status: implemented

English | [中文](2026-09-06-feishu-bridge-auto-compress-projection-source.zh.md)

## Problem

Two token figures coexisted in one bridge process. The auto-compress trigger (M7-c, ported from Go `estimateTokensWithPendingAssistant`) estimated context size as chars/4 over the full `recentTurnsOf` window plus a pending-assistant term, while the `/context` card and the upstream token-meter already served provider-anchored figures through `adapter.contextSnapshot` (`sessionProjections.snapshot` over the live session's log). The two drift independently — the chars/4 heuristic systematically underprices CJK text and tool-result JSON, and it never sees system-prompt or tool-schema weight at all — so the configured `autoCompress.maxTokens` cap meant different things to the trigger than to every other token surface in the process.

## Decision

- **The trigger reads `contextPressure.projectedTokens`** — the token-meter projection value the `/context` headline anchors on first: the newest usage sample's prompt-side pressure plus the heuristic repricing of surface movement since that sample. It steps with every settled request, reacts the moment a compaction shadows a span, and is provider-anchored rather than rune-counted.
- **`tokenUsage` was investigated and rejected**: it is cumulative billed usage over the complete durable log. It never drops after a compression, so gating on it would re-trigger every `minGapMins` forever after the first crossing, and it counts all historical output tokens — not context occupancy.
- **No fallback estimator survives.** At the trigger point (the turn-end tail of `handleResultEvent`) the turn's usage events are already committed, and `sessionProjections.snapshot` is synchronous: missing cells fold lazily over the full in-memory log, and a resumed session folds its restored log the same way (the persisted projection cache is a shortcut, never a prerequisite). The base bundle always mounts token-meter, and the bridge's production providers (llm-pi-ai, anthropic-messages API) report usage on every settled request. The one absence case — zero requests ever settled — has no provider-anchored context to compress; keeping a second estimator alive for it is exactly the drift this change removes.
- **`projectedContextTokens(e, sessionKey, session)`** (session-misc.ts) owns the read: `asContextSnapshotReader(e.agent)?.contextSnapshot(e.activeAgentSessionID(...))?.pressure?.projectedTokens`, with a caught registry failure degrading to "below the cap" plus a warn (the `/context` card degrades the same way; a throw would otherwise break the turn-end path).
- **Trigger semantics are unchanged**: absolute `occupancy >= autoCompressMaxTokens`, min-gap between auto compressions, the `(~Nk tokens)` notice figure — only the source of the number changed.

## Alternatives considered

- **Gate on `tokenUsage`**: rejected — cumulative, monotonic, wrong semantics (see above).
- **Gate on the ratio against `contextWindow`**: would change the configured cap's meaning (an absolute token figure today); the config contract stays as-is.
- **Projection-first with a chars/4 fallback**: rejected — every real trigger scenario has the projection available, so the fallback would be dead code that reintroduces the second estimator.
- **Read the projection inline in engine.ts**: the read belongs to the auto-compress domain module (session-misc.ts), where the retired estimator lived.

## Consequences

- `estimateTokensWithPendingAssistant` and its describe block are deleted; the trigger's full-window `recentTurnsOf` fold goes with it (`recentTurnsOf` itself keeps its other callers: predict-next, commands, reset-on-idle, lastResultOrReply).
- Tests pin the source switch both ways: a below-cap projection with a fat (200-char, 50-token-at-chars/4) recent-turn window does not trigger, and an agent without the `contextSnapshot` capability does not trigger either.
- A deployment whose host somehow lacks token-meter loses auto-compress triggering entirely (it previously fired on the heuristic); the base bundle makes this unreachable in practice.
- Verification: `packages/acp/feishu-bridge` engine spec suite; real-machine check is a long session crossing `maxTokens` showing the 🗜 notice whose token figure matches the `/context` headline.
