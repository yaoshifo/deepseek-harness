# Agent Note: plan-review rejection opens a discussion round

Status: implemented

English | [中文](2026-09-02-plan-rejection-discussion-round.zh.md)

## Problem

When a Feishu bridge plan review was rejected with feedback, the model followed its guidance ("If review rejects it, incorporate the feedback and present again") and re-called exit_plan_mode in the same turn: the reply text answering the feedback stayed inside the turn's progress card (its live-narration section), and the new plan card plus the approval card were sent immediately after — the answer was buried above cards the user had to scroll past, and the only recovery was the settled card's undiscoverable 「查看完整回复」 button. The root cause was the interaction contract itself: the answer and the re-presentation shared one turn, so the turn's final-reply delivery never carried the answer.

## Decision

A rejection now opens a discussion round: the model answers the feedback in its reply text and ends the turn — the answer rides the turn's final reply card at the chat tail, where nothing buries it — and re-presents only after the user asks for the updated plan (an explicit re-present request inside the rejection note counts as asking; otherwise a closing followups option offering the update is the natural close, reusing the engine's existing non-blocking followups card). Empty feedback asks what to change instead of guessing.

The contract lives where plan-mode policy already lives: the deployment-owned `section` config. Both patch layers carry the identical sentence — `packages/bundle/base/cordis.patch.yml` and `packages/acp/feishu-bridge/cordis.patch.yml` (the bridge profile composes the two in order, so live sessions read the bridge override) — keeping the bundle-patch lockstep spec green (the delta stays exactly the one delegation sentence). The exit_plan_mode tool description is neutralized to mechanism-only ("their feedback comes back in the tool result", `packages/plan/plan-mode/src/index.ts`), so no instruction fights the section and the policy stays per-deployment: the three presets (standard/cordis/ptc) keep the Claude-Code-classic "incorporate and present again" through their own sections. The 37 snapshot expected files plus docs/tool-catalog.md that pinned the old description sentence were updated mechanically (replay reconstructs tool schemas from live source, so hand-editing expected fixtures is the correct keyless update).

## Alternatives considered

**A bridge-side flush delivering the post-rejection reply segment as its own card before the new plan card.** Rejected by the user: still a card wedged mid-stream, more machinery, and the rhythm (immediate re-presentation) stays wrong.

**A hard gate auto-denying same-turn re-presents** (the engine's `feishuBridge/ask-approval` waterfall already exists for the role-pick auto-approve). Deferred, not rejected: deterministic, but it would deny the legitimate case where the rejection note explicitly asks for an immediate re-presentation ("改完直接给我看"). Design recorded here; mount it only if live observation shows the guidance being ignored.

**A section sentence declaring precedence over the tool description** ("these rules override the description's revise-and-present-again clause"). Rejected by the user as inelegant; the cleaner fix removes the policy from the description (mechanism/policy split), which is what shipped.

## Consequences

The answer rides the existing turn-end delivery and the followups option the existing closing-card conversion; the one engine change the contract forced is session-scoping the plan revision counter (`processInteractiveEvents` used to zero it per turn — under the discussion-round contract a re-presentation lands in a later turn, and its (vN) card title / `plan:{N}` export keys must keep counting, else every revision re-titles as the first plan and overwrites the `plan:1` export entry). The presets keep a rhythm different from base/bridge until the contract is proposed upstream along the fork sync cadence. A live-profile deployment needs `@deepseek-ai/dsh-plan-mode` added as a `link:` dependency (the profile resolves it today through the registry-pinned dsh-base) before `/reload` picks up the neutralized description. The snapshot suite carries known pre-existing golden drift (fs tool `sandbox_permissions` schema fields; [the 09-07 audit note](../process/2026-09-07-full-suite-audit-fork-drift.md)) — this change adds no new failures over that baseline, verified by main-checkout parity.
