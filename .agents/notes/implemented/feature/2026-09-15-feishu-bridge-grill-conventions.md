# Agent Note: grill interview mandate — resident section plus on-demand skill for ambiguous requests

Status: implemented

English | [中文](2026-09-15-feishu-bridge-grill-conventions.zh.md)

## Problem

The structured-interview convention (「需求模糊或设计空间较大时，先做结构化访谈再动手」— one question at a time, each with a recommended answer, look up before asking) has lived in the machine-local global instructions (`~/.claude/CLAUDE.md`, commit `9e1753a` "add grill", 2026-06-22) since June and underexecuted in bridge sessions. Three stacked causes:

1. **Delivery**: global user instructions ride as user-message `<system-reminder>`s and are the first segment dropped under instruction-budget overflow (the known render-order defect, deferred to upstream by user ruling).
2. **Decision-moment recall**: the bridge's own resident conventions carried a weaker inline version of the same rule — "ask one focused question, otherwise proceed with a reasonable interpretation" — which crowded out the full protocol at the moment a session started work. This is the same visibility-does-not-equal-adherence failure the [2026-08-28 TDD mandate regression](../process/2026-08-28-tdd-mandate-tier-regression.md) measured (66%→14%): resident text dominates non-resident text.
3. **Perception**: the trigger「需求模糊」is a meta-judgment — the model must first admit the request is ambiguous, which is exactly the judgment that fails.

## Decision

Replicate the TDD two-tier pattern — a resident imperative section carries the mandate, an on-demand skill carries the protocol:

- `### 需求模糊先访谈（grill）` joins `agentConventionsPrompt()` (plain sessions only, order 10; subtask children keep arriving with pre-decided briefs, chatroom personas replace the prompt wholesale). The section states concrete, pattern-matchable trigger signals instead of the abstract meta-rule — a one-line ask for a deliverable (a feature, proposal, report, plan, or selection), several materially different readings of one request, the user weighing approaches — plus the inline degradation discipline (look up what the repo answers first; one ask card per round carrying every currently-askable independent question with recommended answers; ungrillable questions diverted to a minimal experiment) and the non-trigger boundary (non-material ambiguity → proceed with a stated interpretation). The async-autonomy first bullet now routes to the section, so the material-ambiguity rule has one home. The section deliberately never names `ask_user_question`: `followups.spec.ts` pins the conventions prompt free of the generic ask tool name so the closing card keeps routing through `feishu_bridge_followups`.
- `skills/grill/SKILL.md` carries the full protocol on demand and doubles as the user-invocable handle (「grill」「烤一下这个想法」): look up before asking; one `ask_user_question` per round carrying all currently-askable independent questions (soft cap 5 per card — beyond that, split the task or ask the branch-cutting question first); dependent questions wait for the next round; ungrillable questions (feel, styling tradeoffs, performance, third-party behavior) divert to a minimal prototype/experiment instead of rephrasing; attack the weakest assumption rather than enumerate low-risk ones; terminate when the design tree is traversed with no implicit assumption left — summarize each decision in one line plus why, folding decisions into the plan's plain layer in plan-mode sessions.
- The CLAUDE.md line is deleted from the dotfiles repo, following the `12ceaa3` precedent; the 08-28 note already rejected machine-local mandates (new-machine deployment gap).

**Protocol ruling (user, 2026-09-15): batched rounds replace the 2026-06-22 one-question-at-a-time calibration.** The June rule was calibrated for interactive terminal use (「多问会让人懵」); in the async Feishu channel each round-trip costs hours, and ask cards natively render multiple questions with per-question options and recommended marks — one card per frontier round compresses an interview from days to a round or two. Dependency ordering (never ask a question whose prerequisites are unsettled) replaces raw sequencing as the anti-confusion guard.

## Alternatives considered

**Resident section only (no skill).** Rejected: no user-invocable handle, no home for protocol depth and the anti-pattern list; the section must stay lean.

**Skill only (no section).** Rejected: the exact 2026-08-24 mistake — catalog descriptions do not reliably trigger at decision moment (measured 66%→14% collapse for TDD).

**Strengthen or restore the CLAUDE.md line.** Rejected per the 08-28 note: instruction-budget drop order plus the machine-local deployment gap.

**Mechanized trigger (monitor-style lightweight side query classifying inbound requests, injecting the mandate on detected ambiguity).** Deferred: the only architecture that structurally fixes the perception layer, but unwarranted before the resident section's effect is measured; the escalation path if re-measurement misses.

**Adopting aihero's grill-me skill verbatim.** Rejected: the June CLAUDE.md line was already a hand-internalization of the same methodology; the missing concepts (frontier dependency ordering, ungrillable/prototype boundary, termination criterion) were folded into the bridge skill instead.

## Consequences

Plain sessions carry the conventions section (~1450 chars) plus the TDD default (~360) plus the grill section (~370). Subtask children and chatroom personas get neither — same tier as the skillify offer; dsh web sessions are outside the coverage, the same accepted trade the TDD mandate made.

Unlike TDD's unconditional trigger (implementing → loop), grill fires on a perception; the concrete trigger signals are the mitigation, and the residual discount is acknowledged. Multi-question interview cards are a new runtime path: the ask tool takes a question array natively and the followups ask-delegate special case only claims single-question「后续处理」signatures, so interview cards park normally — smoke-verify the rendering on first live use.

Re-measurement criterion (one week after the reload): sample one-line ask sessions (a feature or a non-code deliverable) for grill skill loads and an ask card before implementation (both should appear where the baseline showed silent dives), and clearly-specified task sessions for spurious interviews (should be ≈0). The 08-28 scan methodology applies (glob session dirs before `zstdcat`; pre-reload sessions are all baseline).
