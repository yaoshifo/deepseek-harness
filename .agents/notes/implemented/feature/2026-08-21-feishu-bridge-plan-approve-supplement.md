# Agent Note: Plan-review approval supplement via steer

Status: implemented

English | [中文](2026-08-21-feishu-bridge-plan-approve-supplement.zh.md)

## Problem

The ExitPlanMode permission card carried one free-text input, but only the deny button read it: an allow (or allow-all) click discarded whatever the user had typed, so the only way to say "approve this plan, and also do X" was to reject with a reason and re-review a second plan. The supplement needs to reach the model in the same turn as the approval — after the fact it reads as a new task, not a rider on the approved plan.

The obvious encoding is forbidden by the seam: `exit_plan_mode` treats any `custom` on the review answer as keep-planning feedback (`plan-mode/src/index.ts`), and the user-questions contract makes `custom` override `selected` on a single-select question anyway. The approval answer must stay `selected`-only.

## Decision

The supplement rides as a steered user message, reusing the `/ps` channel ([ps steer](2026-08-21-feishu-bridge-ps-steer.md)):

- The card form field is renamed `deny_reason` → `perm_note` and becomes dual-purpose. On plan-review cards (toolName `ExitPlanMode`) the placeholder advertises both semantics; ordinary tool cards keep the deny-only wording.
- `onCardAction` reads `form_value.perm_note` for allow and allow-all too, encoding `allow\x00<note>` / `allow all\x00<note>` the way deny already encoded its reason; the resolved in-place card quotes the note under the body for either verdict.
- `handlePendingPermission` forwards the note as `message` on allow/allow-all (raw — only the deny path wraps it with the native rejection preamble).
- `answerPlanReview` steers a non-empty allow-side note as a verbatim user message (`AgentSession.steer`) and returns the approval answer `selected`-only. The `exit_plan_mode` tool call is still awaiting the ask when the decision settles, so the agent is running and the inbox message is claimed at the next step boundary — the model sees the approval tool result and the supplement in the same request.

## Alternatives considered

**Extend the user-questions/plan-mode contract to allow `selected` + `custom` on a review answer (multi-select semantics).** Rejected as the wrong blast radius: single-select `custom`-overrides-`selected` is the seam's documented contract, and changing it ripples through plan-mode, user-questions, the apiproxy schema, the Web UI, and cc-connect-bridge for one bridge's UX. Worth revisiting only if the product wants the gesture on every surface.

**Prefix the steered text (e.g. "approval supplement: …").** Rejected: verbatim text preserves exactly what the user typed, the placeholder already frames it, and `/ps` steers verbatim — a wrapper adds translation risk, not clarity. Upgrade path if real-machine smoke shows misreading as a new task.

## Consequences

Approving a plan with a supplement works on the Feishu card flow only; plain-text verdicts (`allow <text>`) stay keyword-exact, and cc-connect-bridge / Web UI keep their current behavior. Ordinary tool permissions forward the allow-side message up to the approval answerer, which drops it — the approval seam carries outcomes only, so an allow-side note has no ordinary-tool consumer (the deny side gained one: [deny reasons are steered](2026-08-21-feishu-bridge-deny-reason-steer.md) next to the rejection). If the user stops the turn in the settle-to-steer window, the steer is claimed by the next turn instead of lost.

## Testing

`tests/feishu/card-action.spec.ts` pins the `perm_note` encoding on allow/allow-all, the bare-allow passthrough, and the quoted note on the resolved card; `tests/engine/engine-m3-permission.spec.ts` pins the note→message forwarding on all three verdicts and the bare-allow absence; `tests/agent-dsh/adapter.spec.ts` pins the selected-only answer plus exactly one verbatim steer, no steer without a note or with whitespace only, and the deny path unchanged.
