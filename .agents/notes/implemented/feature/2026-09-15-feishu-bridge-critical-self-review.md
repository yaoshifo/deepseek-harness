# Agent Note: pre-conclusion critical self-review as a resident gate

Status: implemented

English | [中文](2026-09-15-feishu-bridge-critical-self-review.zh.md)

## Problem

Conclusion-grade output (plans, technology choices, root-cause conclusions, performance recommendations) shipped with unearned certainty. The four-step critical self-review rule lived in the machine-local global instructions — the same user-message reminder channel the grill and TDD mandates escaped: dropped first under instruction-budget overflow, and crowded out at the decision moment. Evidence: the 09-10 "no thinking signature" misdiagnosis stood four days before the 09-14 correction; the FB-Eval status-read-as-reasonKind misread; and a live same-day case — the first prototype-trigger fix proposed in this deployment's landing conversation was over-broad (it would have captured pure demo requests) and was caught by the user's steelman, not by the model's own review.

## Decision

A seventh resident section `### 结论前自检` in `agentConventionsPrompt()` (plain sessions only), placed after the grill section to complete the decision-quality triangle: grill attacks the question before the decision, diagnose's Phase 3 (ranked falsifiable hypotheses) is the bug-side instance, and this section attacks the answer before delivery. The four steps — self-critique (unverified assumptions, hidden dependencies, weakest link), steelman (strongest opposing argument, not a strawman), red team (which assumption failure collapses the most; pre-mortem: why would this fail in six months), conclusion (deliver with identified risks, or switch / flag uncertainty) — carry a proportionality rule (simple cases: one risk paragraph after the recommendation; important decisions: the four steps written out) and a skip list (fact queries, code explanation, mechanical operations). 「默认怀疑第一个方案」 and the challenge-the-user's-premise rule fold in.

The 白话直讲 section's pre-plan check now references the four steps instead of duplicating them (one home per fact): readability pass, then the self-review pass, risks into the plan.

**No skill** — deliberately. The tdd/grill/diagnose migrations needed on-demand bodies because their procedural depth (the loop, the interview protocol, the six phases) exceeds a resident line; the four steps fit resident in ~240 chars. Proportionality is the 08-28 restraint lesson applied in reverse: resident-only is right when the content is compact.

The CLAUDE.md section is deleted from the dotfiles repo (grill / `12ceaa3` precedent).

Plain-only scoping: subtask children do not carry the section — their reports surface through the parent session, whose synthesis is where conclusion-grade output forms and where the gate applies. The accepted gap: an individual child's wrong intermediate conclusion relies on the parent's review and the subtask brief conventions, not on a per-child gate; extending into the subtask preamble is the escalation path if child-side underexecution is observed.

## Alternatives considered

**A separate self-review skill.** Rejected: the content is compact; a skill would spend a catalog entry to carry what a resident paragraph holds, and skill-only deployments lose decision-moment recall (the 08-24 collapse).

**Riding the TDD-default section (registered for subtask children too).** Rejected: the four steps are off-topic in an implementation-discipline section, and gating every child's intermediate output doubles review cost for findings the parent already synthesizes.

**Extending the bundle-patch plan-mode guidance.** Rejected: that text is lockstep with dsh-base; fork-local edits there fight upstream sync.

## Consequences

The conventions section grows to ~2100 chars; plain sessions carry seven sections plus the TDD default. Plans should now reach approval having passed both the readability and the four-step pass (risks visible in the details layer); recommendation-bearing replies should carry a risk paragraph or an explicit four-step trace. Re-measurement (one week, same scan methodology): recommendation-bearing replies and submitted plans should show risk paragraphs / self-review traces where the baseline showed bare conclusions.
