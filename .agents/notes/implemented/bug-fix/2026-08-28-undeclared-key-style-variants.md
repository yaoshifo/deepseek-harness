# Agent Note: Undeclared keys naming declared properties in the opposite style fail loud

Status: implemented

English | [中文](2026-08-28-undeclared-key-style-variants.zh.md)

**Partial supersession (same day, evening):** the did-you-mean violation lost its bet — the model failed to self-correct across three identical `ask_user_question` failures and abandoned the card. Model-input variant keys are now **normalized at the input boundary** instead; the violation remains for output validation and direct validator callers. See [key-style-variant normalization](2026-08-28-key-style-variant-normalization.md).

## Problem

A Feishu follow-up card rendered single-select where the agent had asked for multi-select. The session log showed the model calling `ask_user_question` with `"multiSelect": true` — camelCase where the tool schema declares `multi_select`. Two layers let that pass silently: the question item's `additionalProperties: true` made the validator skip unknown keys entirely, and the tool's `execute` picks declared keys only, so the misspelled value evaporated before the bridge defaulted `multiSelect` to false. A full sweep of that session's 282 tool calls against all 34 exposed schemas found this one key the only collision: the camelCase prior is word-position-specific (OpenAI-style function calling plus `multiSelect` type names in context), not a misread of the repository's snake_case-dominant tool-argument style (34 snake keys vs 6 camel keys, all other keys written correctly).

## Decision

`validateJsonSchemaValue` object nodes compare every undeclared key against the declared property names, ignoring underscores and case: a key whose normalized form equals a declared property's (`multiSelect` against `multi_select`, either direction) is a violation with a did-you-mean hint, on open and closed objects alike. Non-variant unknown keys keep the existing semantics — open objects accept them (the workflow `args` passthrough stays legal), closed objects reject them. The `ask_user_question` question and option items additionally declare `additionalProperties: false`, so invented fields are also rejected.

## Alternatives considered

**Rename `multi_select` to `multiSelect`.** Rejected: snake_case is the dominant tool-argument style here, so the rename moves one key into the 6-key minority; and the model's prior varies per word position, so appeasing it one key at a time cannot generalize.

**Unify all tool-argument key style repository-wide.** Rejected: the migration touches every model-visible schema and snapshot, while only one key ever collided and the six camelCase keys never did — no evidence the churn buys anything.

**Accept the variant key in `execute` (lenient dual-read).** Rejected: it hides the model's error, leaves the uncorrected call in the transcript, and makes replay depend on implicit key mapping.

**Prompt guidance emphasizing snake_case.** Rejected: a violation naming the intended key is a stronger, replayable signal than prose advice.

## Consequences

- ~~A misspelled key now costs the model one self-correction round trip — the same failure path that already worked for missing required properties in the incident session (the model fixed a missing `id` immediately after its `INVALID_ARGS` result).~~ Falsified the same evening: across three identical `ask_user_question` failures the model never applied the hinted fix and abandoned the card — see the supersession pointer above.
- Objects that legitimately accept arbitrary keys are unaffected: no declared properties means no collision to report.
- `tool-workflow` keeps its three open schemas; `meta`/`phases` style variants now fail at the tool layer with a did-you-mean instead of the engine's `META_INVALID` — same error-result path, earlier and more specific.
- The did-you-mean text is model-visible: the `subagent-child-question-rejection` tool-schema snapshot records the closed `ask_user_question` schema.

## Testing

Validator cases in `packages/core/tools/tests/json-schema.spec.ts` cover both collision directions on open and closed objects plus the non-variant unknown-key split; `packages/interaction/tool-ask-user/tests/tool-ask-user.spec.ts` proves the end-to-end camelCase call returns `INVALID_ARGS` with the hint and never reaches the provider.
