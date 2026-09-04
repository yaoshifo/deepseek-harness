# Agent Note: ask_user_question single-select cards highlight the recommended option

Status: implemented

English | [中文](2026-09-04-askq-single-select-recommended-highlight.zh.md)

## Problem

The `recommended` option flag reaches the Feishu bridge on every ask — the `ask_user_question` schema tells the model to set it — but only the multi-select checker form consumed it (pre-checking via `checked: true`). On single-select cards (list rows with number buttons) the flag had no presentation at all, so the model's recommendation was invisible on the most common ask shape.

## Decision

A single-select list row renders its button as `btnType: 'primary'` when `opt.recommended === true`, `'default'` otherwise. Nothing else changes: label, description, and the index-based `askq:{q}:{n}` answer encoding stay untouched, and the settled snapshot does not mark recommendations — matching the multi-select snapshot, which also drops the pre-checked state and shows only the chosen options.

## Alternatives considered

**Emoji prefix on the label.** Rejected: the display text would diverge from the answer-facing label, the settled snapshot would need the same decoration to stay symmetric, and it can stack with a model-written `(Recommended)` suffix into a double mark.

**A "recommended" prefix on the description.** Rejected: it splices UI copy into a model-authored sentence.

## Consequences

The `AskUserQuestionOption.recommended` contract wording (user-questions types JSDoc and both READMEs) now names both presentations: multi-select UIs pre-check the option, single-select UIs highlight it. Multiple recommended options render multiple primary buttons as-is — the schema permits it and no defense is added. The Feishu listItem `primary` style is cross-client available; `session-card.ts` already used it.

## Testing

`tests/engine/engine-m3-askq.spec.ts` gains `single-select renders the recommended option button as primary` beside its multi-select pre-check twin (25 passing); `tests/feishu/card-action.spec.ts` stays green (57).
