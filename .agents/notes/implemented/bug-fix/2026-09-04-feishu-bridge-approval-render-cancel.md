# Agent Note: approving a permission no longer kills the in-flight render

Status: implemented

English | [中文](2026-09-04-feishu-bridge-approval-render-cancel.zh.md)

## Problem

The 2026-09-04 oc_3b2fa group incident chain: after `/provider` switched to glm-5.3-flash, the first bash escalation popped a card (approve-all memory is per Agent instance, so the fresh session started clean), and the speculative reply render triggered while the approval sat parked (an over-threshold pre-ask text segment, `engine.ts` deliverCards → `renderAndDeliverReply`) was killed eight seconds later by the approve button's `cancelRenders`; the turn-end fallback render did not fire because the final reply stayed under the `defaultReplyPreRenderLen` threshold — so that segment (the model's full plan text, externally visible) permanently lost its rendered delivery and lived only on the process card. Structural cause: the scale mismatch between permission-approval decision latency (seconds) and render fork latency (~12s) makes the Go `handlePendingPermission` legacy 「any user response cancels unconditionally」 an almost-certain kill for speculative renders; that day's 33 plan-render deliveries all survived only because users typically read the plan card longer than the render takes. `cancelRenders`' own stated cancel motive is saving tokens (a stale render is not worth burning), but on approval the rendered content is this turn's valid deliverable — not stale.

## Decision

`routeAskResponse`'s `cancelRenders` became conditional: when a pending ask exists, `kind !== 'questions'`, and `parsePermissionVerdict(content)` is allow or allow-all (card buttons and free text are equivalent), the cancel is skipped — approval settles the ask and resumes the turn, and the pre-ask segment's / plan's in-flight render remains a valid delivery. Every other response (deny, any answer to questions, an expired button with nothing pending) keeps the Go cancel semantics; the other four `cancelRenders` call sites (new-turn entry, interactive-state cleanup, session stop, card-nav buttons) are unchanged.

## Alternatives considered

- **Marking the cancelled segment for a turn-end retry.** The single-flight guard (`preRenderRunning`) and the `exportContent` export button already provide the fallback, and turn-end's `displayReplyText` only carries trailing segments — retry semantics would need newly introduced segment-ownership state, a wide change.
- **Removing the routeAskResponse cancel entirely (exempting every response).** After a partial questions answer the ask stays parked, and a completed render landing in the group would push the parked card off the group tail — a new UX surface; the genuinely stale scenarios (new turn, session stop) are already covered by their own entry-point cancels, but edge cases like expired buttons would drift along.

## Consequences

- Testing: `engine-ask.spec.ts` gained the `routeAskResponse render-cancel semantics` describe, pinning through the public interface (`askUser` + `registerRenderCancel` + `routeAskResponse`) that four approval shapes skip the cancel (`perm:allow`, `perm:allow_all`, free-text 「允许」, plan-review approval) and three preserved shapes still cancel (deny, questions answers, expired buttons with nothing pending).
- Known boundary: questions answers still cancel renders (the isomorphic case stays unfixed), covered by the turn-end fallback and the export button; when a render completes after approval the turn has already resumed, and the image landing in the group triggers a fresh process-card `bumpToEnd` — both existing mechanisms; when the render is still incomplete, turn-end's `renderAndDeliverReply` remains skipped by the single-flight guard (unchanged).
- Deployment: the user manually `/reload`s after the build; the live verification signal: a `reply-html` fork started during a permission-approval wait shows `render session completed` (not `cancelled`) in the log after approval.
- Go parity: a deliberate deviation from `handlePendingPermission`'s unconditional cancel; `engine.ts` comments record the case and rationale — if upstream later absorbs a colliding change, this package's test suite arbitrates.
