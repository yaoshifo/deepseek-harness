# Agent Note: The closing followups card moves to a dedicated feishu_bridge_followups tool

Status: implemented

English | [中文](2026-09-10-feishu-bridge-followups-dedicated-tool.zh.md)

## Problem

The [closing-card conversion](2026-09-02-feishu-bridge-closing-card-followups-conversion.md) kept the model hand-writing the closing card as an `ask_user_question` call with a prompt-mandated signature — five fields of which four are engine constants (question text, question id, reserved header, multi-select flag); only the options list varies. That hand-copying failed tool-args validation across the bridge fleet on ~3 attempts/day: 44 rejections 2026-08-27..09-10 over 8 project workspaces, 38 carrying the closing-card header, every failure dropping exactly a boilerplate field — `question` (33) or `id` (8, mostly glm-5.3-flash) — while options were never malformed. Each rejection self-healed on the next call (the error text names the missing property), costing a raw validation error in the chat plus one extra round trip. The conventions checklist named the optional fields and omitted the required ones, and GLM follows the prose template literally.

## Decision

A dedicated `feishu_bridge_followups` tool (`src/tools/followups.ts`) narrows the model's contract to the one varying input: `options: [{label, description, recommended?}]`, at least one. The tool synthesizes the four constants onto a questions ask — header from the imported `FOLLOWUPS_ASK_HEADER` (single source), fixed question 「以上发现后续如何处理？」, stable id `followups`, `multiSelect: true` — and delegates to `Engine.askUser`, whose `isFollowupsAsk` conversion branch stays the single registration implementation; no second engine path exists. The agent-conventions section now names the tool and drops the field checklist. The hand-written signature path stays as the compatibility layer: sessions on the pre-tool prompt convert through `isFollowupsAsk` exactly as before — which is also every tool miss's fallback, so this partially supersedes the 2026-09-02 note's tool rejection in amended form: a missed instruction now degrades to that conversion, not to the parked turn that motivated the original rejection.

## Alternatives considered

**Prompt checklist repair (required-field sentence plus a complete example payload).** Rejected as the fix: the required fields were already in the generic tool's schema when every failure happened; prose examples lower the probability but cannot delete the class. Stays as the fallback tier if the tool's call rate disappoints after fleet rotation.

**Packaging the card requirements as a skill.** Rejected: models never load skills on their own (the tdd-default prompt exists for exactly that documented reason), a per-closing skill load costs a round trip on every closing (vs ~3 failures/day fleet-wide), and skills deploy per-project while the conventions section covers every bridge project from one place.

**Engine-side defaulting (fill `question`/`id` when the reserved header is present, instead of rejecting).** Rejected: it silently repairs model output at the tool-args boundary (against fail-loud), and the generic ask tool's validation is core-harness owned — the bridge would have to intercept before the executor.

## Consequences

For sessions on the new prompt the missing-field rejection class is structurally deleted — the schema exposes no boilerplate field to drop. The conventions text is shorter (no field checklist, no reserved-word explanation). Costs: the tool catalog grows one tool (~150 tokens per plain session), and two live paths coexist until sessions rotate — the ask-header conversion serves legacy prompts and tool misses; retire it only after fleet rotation completes (not in this change, monitor via the followups registration log line). The non-closing ask failures (6 of 44; glm-5.3-flash dropping `id` on ordinary asks) are untouched — the generic tool's schema still owns them. Pinned by `tests/tools/followups-tool.spec.ts` (registration/HMR disposal, synthesized ask + deferred-sentence passthrough, unrouted caller, empty options, real-conversion integration through the actual `askUser` branch), the rewritten prompt contract in `tests/engine/followups.spec.ts` (mandates the tool, forbids the generic-tool mention), and the verbatim persona pin in `tests/agent-dsh/adapter-persona.spec.ts`.
