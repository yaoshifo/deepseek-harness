# Agent Note: cost-and-side-effect disclosure — the non-absorbable core of the conclusion gate

Status: implemented

English | [中文](2026-09-15-feishu-bridge-cost-disclosure.zh.md)

## Problem

Conclusion-grade output (plans, technology choices, root-cause conclusions, performance recommendations) shipped without definite cost statements, and the machine-local four-step critical self-review that was meant to gate it never reliably reached the decision moment — the same droppable reminder channel the grill and TDD mandates escaped, with a misdiagnosis-correction history standing while the rule was present.

## Decision

A compact resident section `### 代价说清楚` in `agentConventionsPrompt()` (plain sessions only): conclusion-grade recommendations carry a paragraph of **costs and side effects** — definite harms that will occur and tradeoffs forgone — and unverified unknowns become **verification actions** (an experiment, a feedback loop), never hedged risk sentences. Challenging a likely-wrong user premise rides along as the second line. The plan details layer's slot word changes from 风险 to 代价与副作用 (one home per fact), and the pre-plan check reverts to the readability pass alone.

The vocabulary split is the substance, not cosmetics: 风险 conflates three epistemic classes — definite harms, definite forgone tradeoffs, and unverified unknowns. Only the first two belong in prose, and being definite they are checkable statements, which resists ritual compliance (unverifiable hedged sentences are how risk paragraphs degrade into boilerplate). Unknowns belong to verification — the same 把「想」换成「查」bloodline as diagnose's loop and tdd's red-green — and the best live output already used this shape organically (a shipped plan's strongest section was titled 「代价说清楚」).

**No skill** — the content is two lines; resident-only is proportionate.

The CLAUDE.md four-step section is deleted from the dotfiles repo (grill / `12ceaa3` precedent). Subtask children stay ungated: their reports surface through the parent session, whose synthesis carries the disclosure; the escalation path if child-side underexecution is observed is the subtask preamble.

## Alternatives considered

**The four-step critical self-review (self-critique, steelman, red team, pre-mortem), resident.** Considered and cut the same day, before any reload shipped it: the reflection step is the capability-absorbable form — models improve at native self-critique, and intrinsic self-correction without external signal is the weak form — while pre-mortem's human mechanism (psychological safety unlocking dissent) does not exist for a model, and its content largely overlaps cost enumeration. The one residual (the temporal decay lens) is re-addable into the cost slot with evidence if decay-failure blindness shows up in re-measurement.

**A Chain-of-Verification restructure (claims → verification questions → independent answers → synthesis).** Deferred: the strongest evidence-backed form, but a meaningful share of its value is also capability-absorbable, and its cost (independent re-answering per conclusion) does not fit a resident default. The verification routing for unknowns keeps the CoVe spirit at one line.

**Deleting the gate entirely.** Rejected: the disclosure contract (definite costs attached to conclusions) and the premise challenge are deployment preferences about output shape, not capability gaps — model iterations do not restore user-owned output conventions by themselves.

## Consequences

The conventions section carries seven sections at roughly the pre-critical-review size plus two lines. Re-measurement (one week, same scan methodology): recommendation-bearing replies should show definite cost statements (checkable, not hedged); watch items are hedged-risk boilerplate regression and decay-failure blindness (the pre-mortem cut's observable).
