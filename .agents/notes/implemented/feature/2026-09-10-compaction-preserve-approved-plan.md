# Agent Note: Preserve approved plans verbatim across compaction checkpoints

Status: implemented

English | [中文](2026-09-10-compaction-preserve-approved-plan.zh.md)

## Problem

When compaction summarizes a long execution, the approved plan (the plan the user approved through the exit_plan_mode review) gets diluted away. The compacted region is head-anchored (`selectCompactableRange` in `region.ts`): everything from the first surface node to the retention cut is replaced by one summary, and plan approval typically happens early in execution, so the exit_plan_mode call almost always falls inside that region. The summarization directive (`COMPACTION_INSTRUCTION` in `summarizer.ts`) had no plan-preservation clause — the plan could only survive as bullets under Pending Jobs / Current Work / Next Step / Critical Context — and the prior-checkpoint "do not copy it forward verbatim" rule actively merged it away. Under repeated compaction the model's view of the approved plan degrades monotonically while the executing agent loses the global picture (scope, groups, acceptance criteria). The todo list suffers the same loss (the `todos` projection is client-only; the model's only view is its own call arguments).

## Decision

Add a rule to the summarization directive (smallest change: no state, no region selection, no checkpoint-structure change):

- When the conversation contains an approved plan (an exit_plan_mode tool call the user approved; with several, the latest), copy its full markdown verbatim into Critical Context as a fenced code block, and keep it there while any of its work remains unexecuted; condense it like other completed history once it is fully executed.
- The prior-checkpoint merge rule ("do not copy it forward verbatim") exempts exactly that one copy: carry it forward unchanged while any of its work remains unexecuted.

The first compaction picks the verbatim copy up while the exit_plan_mode call is still visible; later compactions carry it forward from the prior checkpoint. Once the plan is fully executed it condenses like any other history, so the budget cost is self-limiting. No behavior change for plan-less sessions; the checkpoint structure (eight sections) is unchanged.

## Alternatives considered

**The plan as durable state re-injected per request (a system-prompt section, like the agent-instructions baseline's surface-presence resend).** Deferred: this is the fully reliable path (a section re-rendered per request is outside compaction's reach), but it is a new feature — a new event type plus section in plan-mode, touching two upstream-owned packages. The minimal clause lands first; escalate if measured fidelity falls short.

**Exempting the plan node from region selection.** Rejected: region selection is token-priced and tool-pairing-balanced; a message-identity exemption breaks the invariant that the region is a balanced head range and could make compaction unable to shrink at all.

**Preserving the todo list in the directive too.** Deferred: same mechanism, but the todo stance is a client-only projection; changing the model's view of todos is a separate decision (the tool-todo README records the current stance).

## Consequences

- Fidelity is probabilistic: the summarizer model follows guidance, not enforcement; the verbatim copy rides with the same compliance probability as the rest of the directive.
- The preserved plan counts against `maxTokens` (default 8192): a plan that does not fit fails the checkpoint closed (truncation error, full history retained) instead of silently losing plan content — raise `maxTokens` when that repeats (recorded in the README limitations).
- A summary dominated by a large verbatim plan can also fail shrink validation; the outcome is the same warning with full history.
- The directive text in `summarizer.ts` is upstream-owned; per fork principles, propose the clause upstream once it proves stable.

## Testing

`packages/compaction/compaction-basic/tests/compaction-basic.spec.ts` (describe "default one-shot summarizer"): two new assertions pin the instruction's exact wording on the dispatched call envelope — the `an exit_plan_mode tool call the user approved` / `copy its full markdown verbatim into Critical Context as a fenced code block` rule, and the prior-checkpoint exception sentence.
