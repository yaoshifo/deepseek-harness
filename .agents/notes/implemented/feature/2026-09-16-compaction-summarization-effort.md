# Agent Note: A configurable summarization effort for compaction

Status: implemented

English | [中文](2026-09-16-compaction-summarization-effort.zh.md)

## Problem

The one-shot summarization call inherited the conversation's reasoning effort: `GenerateOptions.reasoningEffort` was never set, and the pi-ai adapter falls back to the profile default (`options.reasoningEffort ?? profile.reasoning`) — `max` on both production bots. A reasoning model's thinking shares the summarization `maxTokens` cap with the checkpoint text, so the model first reasoned at length over the replayed context and only then wrote the summary. Live evidence (2026-09-16, oc_8b19, deepseek/deepseek-flash at ~840k tokens of context): four compaction attempts, three failed on `summarization truncated at the token cap` — first at the 8192 default, then twice at a raised 16384, each failed attempt burning ~76 s and retrying at every step boundary because pressure stayed above threshold. The summary that succeeded when effort happened to run short was ~15k characters; the thinking ran ~17k tokens.

## Decision

- `BasicCompactionConfig` gains `summarizationEffort?: string` (also per-target in `modelPolicies`), resolved alongside the summarization provider/model pair; `''` — the default — omits the field so the provider default applies, preserving today's behavior.
- `summarizeWithLlm` passes the configured effort through `ReasoningEffortId()` into the one-shot request. The llm runtime already validates the effort against the resolved model's declared `reasoning.efforts` and fails loud on an unsupported level — which is exactly why the default is `''` rather than a hardcoded `low`: a non-reasoning model, or one without that level, would otherwise fail every compaction.
- Deployments running a reasoning model at a high effort should set it explicitly (the live profile pins `low` for deepseek-flash, which declares low/high/max).

## Alternatives considered

**Hardcode `low`.** Fails every compaction on models that declare no efforts or a different ladder; the runtime's fail-loud validation makes an unconditional value a deployment breaker.

**Raise `maxTokens` further.** Treats the symptom; the thinking has no upper bound, so any cap remains a lottery. Kept at 16384 as headroom for the checkpoint text itself (~15k characters observed).

## Consequences

- A configured effort applies to every summarization call through this backend (pressure, overflow recovery, and manual `/compact` all funnel through `summarize()`), on the model the summary is routed to.
- Configuring an effort the summarization model does not declare fails the compaction attempt (then the step-boundary retry) with `UNSUPPORTED_REASONING_EFFORT` — visible in the daemon log since the logger-console exporter landed.
- The conversation's own effort is untouched; only the auxiliary call changes.
- Tests: config resolution/override/validation for the new key, wire-passing through `ReasoningEffortId`, and omission when unset (`compaction-basic.spec.ts`).
