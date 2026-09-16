# Agent Note: A configurable summarization effort for compaction

Status: implemented

English | [中文](2026-09-16-compaction-summarization-effort.zh.md)

## Problem

The one-shot summarization call inherited the conversation's reasoning effort: `GenerateOptions.reasoningEffort` was never set, and the pi-ai adapter falls back to the profile default (`options.reasoningEffort ?? profile.reasoning`) — `max` on both production bots. A reasoning model's thinking shares the summarization `maxTokens` cap with the checkpoint text, so the model first reasoned at length over the replayed context and only then wrote the summary. Live evidence (2026-09-16, oc_8b19, deepseek/deepseek-flash at ~840k tokens of context): four compaction attempts, three failed on `summarization truncated at the token cap` — first at the 8192 default, then twice at a raised 16384, each failed attempt burning ~76 s and retrying at every step boundary because pressure stayed above threshold. The summary that succeeded when effort happened to run short was ~15k characters; the thinking ran ~17k tokens.

## Decision

- `BasicCompactionConfig` gains `summarizationEffort?: string` (also per-target in `modelPolicies`), resolved alongside the summarization provider/model pair.
- `''` — the default — is a capability-aware auto-select: the summarizer resolves the summary target's declared `reasoning.efforts` and uses `low` when that rung exists, omitting the field otherwise. An unconditional `low` default would fail every compaction on models that declare no efforts or a different ladder (the runtime validates the effort against the declaration and fails loud); an omit-only default would replay the high-rung inheritance on every deployment that never reads this note.
- `summarizeWithLlm` passes the selected effort through `ReasoningEffortId()` into the one-shot request. An explicit configuration always wins over the auto-select.
- Deployments can still pin the field explicitly (the live profile pins `low` for deepseek-flash: a changed ladder then fails loud at the effort validation instead of silently degrading back to the inherited high rung).

## Alternatives considered

**Hardcode `low` as the default.** Fails every compaction on models that declare no efforts or a different ladder; the runtime's fail-loud validation makes an unconditional value a deployment breaker.

**Omit-only default (`''` never selects).** Preserves the high-rung inheritance on every deployment that never reads this note — the exact incident this change pays down; the auto-select closes it without the hardcode's failure mode.

**Raise `maxTokens` further.** Treats the symptom; the thinking has no upper bound, so any cap remains a lottery. Kept at 16384 as headroom for the checkpoint text itself (~15k characters observed).

## Consequences

- A selected effort applies to every summarization call through this backend (pressure, overflow recovery, and manual `/compact` all funnel through `summarize()`), on the model the summary is routed to.
- The auto-select adds one `resolveModelInfo` lookup per summarization — the same resolution the request dispatch itself performs, so it adds no new failure mode.
- Configuring an effort the summarization model does not declare fails the compaction attempt (then the step-boundary retry) with `UNSUPPORTED_REASONING_EFFORT` — visible in the daemon log since the logger-console exporter landed.
- The conversation's own effort is untouched; only the auxiliary call changes.
- Tests: config resolution/override/validation for the new key, wire-passing through `ReasoningEffortId`, auto-select on a low-declaring model, omission for no-low ladders and non-reasoning models (`compaction-basic.spec.ts`).
