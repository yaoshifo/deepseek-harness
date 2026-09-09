# Agent Note: the approval exemption narrowed by render family — plan-card renders cancel on approval

Status: implemented

English | [中文](2026-09-09-feishu-bridge-plan-render-approval-cancel.zh.md)

## Problem

2026-09-09 user report: while the plan card's image still showed 🖼 Rendering…, the user clicked approve to execute the plan — and the render fork still delivered its PNG into the group once done, a late plan image landing amid the executing turn's process messages. Root cause: the 2026-09-04 exemption (see [approving a permission no longer kills the in-flight render](2026-09-04-feishu-bridge-approval-render-cancel.md)) spared every in-flight render based on 「the response is an approval」, without asking which render: what oc_3b2fa actually needed protecting was the speculative reply render — approval decisions take seconds while render forks take ~12s, so an unconditional cancel was an almost-certain kill, and the rendered content is this turn's valid deliverable. A plan-card render after its plan was approved is stale — the plan is already executing, the late image is pure noise, and the plan content stays reachable through the card's markdown and export button. That day's 33 surviving plan deliveries were luck: users typically read the plan card longer than the render takes, so anyone approving faster than the render hit the exemption branch.

## Decision

`routeAskResponse`'s approval branch narrowed from 「cancel nothing」 to 「cancel by family」: `RenderCancelHandle` carries `kind: 'plan' | 'reply'` (same shape as `RenderStatusEntry.kind`), `registerRenderCancel` takes the family as a third parameter (`launchPlanRender` → plan, `renderAndDeliverReply` → reply); an approving verdict (permission and plan-review alike, card buttons and free text equivalent) now calls the new `cancelPlanRenders(state)` — it detaches and cancels only plan-kind handles, leaving reply handles registered and delivering. Deny, questions answers, and expired buttons keep the unconditional `cancelRenders`, and the other call sites (new-turn entry, interactive-state cleanup, session stop, card-nav buttons) are unchanged.

## Alternatives considered

- **Switching the approved plan render to silent delivery (no group message, card status-line PATCH only).** Keeps the delivery but keeps most of the annoyance (render tokens still burn, the status line still flips), and forks one `deliverRenderedImage` into two delivery shapes — a wider change than the payoff.
- **Keeping the 09-04 exemption as-is.** The user reported the noise explicitly; a late image after the plan is approved is questionable value, and the export button already covers reachability.

## Consequences

- Testing: the `engine-ask.spec.ts` render-cancel describe flipped the plan-review approval case (the plan handle gets cancelled), gained a plan-review-approval-keeps-reply case (the oc_3b2fa regression guard), and the three permission-approval shapes now register with `'reply'`; the `plan-render.spec.ts` RenderCancels describe adapted to the three-parameter signature and gained direct `cancelPlanRenders` cases.
- A user approving faster than the render (~12s) no longer receives the plan image; the plan content stays reachable through the plan card's markdown and export button.
- Known flaw left alone: a plan render cancelled between completion and delivery lands in the catch branch marked `failed` instead of `cancelled`.
- Deployment: the user manually `/reload`s after the build; the live verification signal: clicking approve while the plan card shows Rendering… flips the status line to ✘ Cancelled with no late image in the group, and the log shows `plan-render: cancelled` instead of `delivering image`.
- Go parity: one step further from `handlePendingPermission` beyond the 09-04 deviation; this package's test suite arbitrates any upstream-absorption collision.
