# Agent Note: Revert the reply direct-render length tier

Status: implemented

English | [中文](2026-09-14-reply-render-tier-revert.zh.md)

## Problem

4956ae127e length-tiered the speculative reply→HTML render as the 2026-09-13 chatroom postmortem's cost fix (see [the batch note](2026-09-14-chatroom-session-postmortem-fixes.md)): replies at or below `planRenderDirectLen` (default 2000 runes) skipped the render-session fork — the engine wrote the `markdownToSimpleHTML` fragment itself and assembled the reply template in place. Review before deployment found the direct tier produced a defective, redundant artifact:

1. **Template-contract violation.** The reply template's only page padding lives on the fragment-provided `.wrap` container and the document title is extracted from a fragment `<h1>` — both are the render skill's fragment contract. The direct fragment carries neither: the rendered text starts at pixel (0,0), flush against the image edge, and `<title>` is empty, so the delivered PNG falls back to a `render.png` filename and the image card carries no title. Headings degrade to same-size `<b>`, lists to plain-text bullets, tables to ASCII inside `<pre>`. Verified by assembling the direct fragment through the real pipeline (`markdownToSimpleHTML` + `assembleHTMLInPlace` + the production rasterizer parameters) and measuring the first text node's bounding rect at (0,0).
2. **Verbatim duplication.** The reply render's input prefers the trailing 实时播报 segment — the exact text remaining on the completion card — so the delivered image duplicated content the user had just read, for a Chromium rasterize plus an image upload per mid-length reply. The render skill's own contract is a one-screen distilled overview ("完整回复已在对话里，不进片段").

## Decision

- The length tier is reverted before any deployment: `renderReplyToHTML` forks a render session for every reply again, the `planRenderDirectLen`/`directLen` config surface is gone, and `plan-render-fork.spec.ts` runs its original short fixtures. The batch's other fixes — machine-message ask exemption, poll one-shots, report dedup, one-shot lineage, ledger hygiene, save debounce, supervision config, gather wake — are untouched.
- The mid-reply render-fork cost finding (43 of the run's 81 sessions) is reopened as a known open cost, not re-solved here.

## Alternatives considered

- **Fix the direct tier's fragment (wrap it, synthesize an `<h1>`).** Rejected: repairs the visuals but keeps delivering a verbatim duplicate of the completion card — zero information gain for a rasterize + upload per mid-length reply.
- **Skip the render entirely below the threshold (deliver no image).** Declined by the product owner in favor of the fork-rendered card for every ≥500-rune reply; the cost item stays recorded as open instead.
- **Keep the tier as shipped.** Rejected: the output defect and the duplication are user-visible on every mid-length reply of every plan_render-enabled bot.

## Consequences

- Every pre-render-eligible (≥500-rune) reply burns a render-session fork again; the 2026-09-13 cost profile returns by decision. Chatroom runs remain the pressure point — revisit when it bites.
- The revert landed before deployment: the live built artifact never contained the tier, so no user-visible behavior changed on either side.
- Tests: the reply-fork contract and the render parent-lineage cases live in `plan-render-fork.spec.ts`; `plan-render-direct.spec.ts` is deleted.
