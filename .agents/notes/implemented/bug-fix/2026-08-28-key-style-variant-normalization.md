# Agent Note: Opposite-key-style argument keys normalize at the model-input boundary

Status: implemented

English | [中文](2026-08-28-key-style-variant-normalization.zh.md)

Supersedes the input-path half of [style-variant rejection](2026-08-28-undeclared-key-style-variants.md), which stays authoritative for output validation and direct validator callers.

## Problem

Hours after the style-variant rejection landed, the same camelCase habit produced a worse failure in a different session: the closing follow-up card (`ask_user_question`) failed argument validation three consecutive turns-in-a-row, each error result — did-you-mean hint included — fully present in the model's context, and the model still re-emitted byte-identical arguments (session log seqs 72508/72785/73089). At the second attempt the reasoning explicitly stated the fix ("The tool schema uses `multi_select` (snake_case). I wrote `multiSelect`. Retry with correct property name.") yet the third call was unchanged; after the third failure the model constructed a false theory (harness mis-serialization) and abandoned the card, so the user received no card at all. The repeat-tool-reminder guard nudged at ×3 and the model complied by giving up. The two policies now bracket the dilemma: silent acceptance (the morning incident — card rendered single-select) corrupts semantics, loud rejection (this incident — card never sent) loses the feature, and both depend on the model reading a hint and editing its own emitted JSON, which the harness cannot rely on.

## Decision

Undeclared keys that name a declared property in the opposite key style (`multiSelect` against `multi_select`, underscore- and case-insensitive in both directions) are **normalized to the declared key before validation**:

- `normalizeKeyStyleVariants(schema, value)` (dsh-tools `json-schema.ts`) rewrites such keys recursively through `properties`/`items`, returns the same reference when nothing renamed, lets the declared key win when both spellings are present, and is total for arbitrary inputs (non-node schemas, hostile getters, cycles → unchanged). `oneOf` interiors are not normalized — branch matching there is not keyed by property name alone — so variant keys inside a union still reject.
- The registry applies it in `createExecution` between the lossless snapshot and the deep freeze, so every tool kind — defineTool, raw, MCP — sees model-intended keys, and pre-execute policies (permission, approval) see the canonical form. The `tool/call` event keeps the raw arguments for audit.
- `defineTool` canonicalizes in its validate/execute/present/isConcurrencySafe closures too (display runs on raw replayed args outside the registry), and `execute` receives the normalized value.
- The subagent structured-output capture normalizes before validating, so the parent receives declared keys.
- feishu-bridge's tolerant raw-argument readers (background sniff, skill-input parse, monitor triage verdict) normalize with literal mini-schemas; the chatroom picks parser does the same for its embedded pick arrays.

Everything else is unchanged: non-variant unknown keys keep the accept/reject split, invented fields on the closed `ask_user_question` items still reject, tool **output** validation still reports variant keys (an output-side variant is a code bug, not model output), and missing required properties still fail loud — probing shows that class cannot be repaired.

## Forward positioning: constrained decoding

Probing (mify relay, the official Anthropic-compatible endpoint, and the coding-plan OpenAI endpoint) showed GLM accepts `strict: true` and `response_format: json_schema` without error but does not constrain: prompts demanding a required field's omission succeed on every endpoint with the flag on. The harness-side capability path is wired anyway per deployment decision — pi-ai compat `supportsStrictTools`/`supportsStrictMode` is enabled for the GLM providers, and dsh tags closed-root tools with `constrainedSampling: {type: "json_schema", strict: "prefer"}` — so the day upstream enforces, strict flows without another change. `prefer` semantics keep the request legal meanwhile, and normalization stays the model-independent layer for every provider without constraints. Open-root tools stay untagged: enforcing engines require closed schemas, so extending coverage is a root-closedness decision, not a flag flip.

## Alternatives considered

**Rename `multi_select` to `multiSelect`.** Rejected: snake_case is the dominant tool-argument style here, so the rename moves one key into the 6-key minority; and the model's prior varies per word position, so appeasing it one key at a time cannot generalize. Normalization makes the declared convention irrelevant to call success, which is the general form of this idea.

**Unify all tool-argument key style repository-wide.** Rejected: the migration touches every model-visible schema and snapshot, while only one key ever collided and the six camelCase keys never did — no evidence the churn buys anything.

**Keep the loud rejection with a stronger hint.** Rejected on evidence: the hint named the correct key three times and the model re-emitted the identical payload twice; a stronger hint still routes success through model compliance.

**Prompt guidance emphasizing snake_case.** Rejected: an adversarial-prompt probe showed the schema beats prompt pressure 5/5 — the emission failure is a long-context habit, not a comprehension problem.

**Enable the strict flags only, skip normalization.** Rejected: probing proved the upstream ignores `strict` today, so flags alone are dead configuration; they are enabled anyway as forward positioning, with normalization as the model-independent layer.

## Consequences

- A variant-key call now succeeds on the first attempt with zero round trips and zero model dependence; the failed-card failure mode (three rejections, guard nudge, feature abandonment) is closed for this class.
- The raw arguments remain in `tool/call` events, so audit and replay are unchanged; the normalization is reconstructable from the log.
- Objects that legitimately accept arbitrary keys are unaffected: no declared properties means no variant to rename. Open passthrough (`tool-workflow`) keeps its semantics.
- Normalization is idempotent and reference-preserving on conformant arguments — a future constrained model that only emits declared keys hits the fast path, so the two layers compose instead of conflicting.
- The did-you-mean branch in the pure validator stays (output validation and direct callers still use it) but is no longer reachable from the model input path.

## Testing

`packages/core/tools/tests/json-schema.spec.ts` covers the walker: recursive rename through array items, declared-key-wins precedence, open-object normalization, same-reference fast path, union/non-plain/garbage-schema/cyclic/hostile totality, and the existing validator violations for both collision directions. `packages/core/tools/tests/tools.spec.ts` proves the registry boundary for defineTool and raw tools (canonical args at the body, canonical args at pre-execute, open passthrough untouched). `packages/interaction/tool-ask-user/tests/tool-ask-user.spec.ts` proves the end-to-end camelCase call now asks the multi-select question. `packages/subagent/subagent-in-process-driver/tests/structured.spec.ts` covers the capture path, `packages/llm/llm-pi-ai/tests/context.spec.ts` the strict-sampling tagging, and the feishu-bridge specs the sniff sites.
