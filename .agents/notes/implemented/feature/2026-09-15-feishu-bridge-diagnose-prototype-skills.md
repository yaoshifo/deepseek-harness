# Agent Note: diagnose and prototype skills — the bug-investigation mandate and grill's experiment escape hatch

Status: implemented

English | [中文](2026-09-15-feishu-bridge-diagnose-prototype-skills.zh.md)

## Problem

Two gaps, both ruled in after the grill landing:

1. **Bug investigations had no methodology.** The TDD default section explicitly exempted the investigation phase (「之前的调查阶段不受此约束」), so root-cause hunting ran on raw model judgment. Three documented misdiagnoses all fit the same failure shape — a conclusion asserted without a loop that could go red on the actual bug: the watchdog blind-killing live streams (total_ms far past the kill moment), the 09-10 "no thinking signature" misdiagnosis corrected 09-14 (the signature was looked up in the wrong place), and the FB-Eval status-read-as-reasonKind misread.
2. **grill's escape hatch had no floor under it.** The grill protocol routes ungrillable questions (feel, styling tradeoffs, performance, third-party behavior) to "a minimal experiment", but nothing defined how to build one, what discipline keeps it throwaway, or how the validated decision folds back.

## Decision

Same two-tier pattern as tdd and grill — but with a deliberate variation:

- **The diagnosis mandate joins the existing TDD-default section instead of a new section.** A reported breakage and its fix are one lifecycle; the section already registers for plain sessions and subtask children (bug-investigation briefs run in children), so the mandate inherits both branches with zero new registration. This also honors the 08-28 resident-restraint lesson: no fourth resident section. The added text (~150 chars) says: on a reported breakage, load `diagnose` and build a feedback loop that goes red on this exact bug before any root-cause conclusion; the loop usually is the failing test that follows. The now-false exemption sentence (「之前的调查阶段不受此约束」) is deleted — the investigation phase is now the constrained one.
- **`skills/diagnose/SKILL.md`** carries the six-phase loop adapted from aihero's `diagnosing-bugs`: build the loop (ten construction methods, in rough priority order, first one that works wins) → reproduce and minimise (one cut at a time, re-run, keep only load-bearing elements) → 3-5 falsifiable ranked hypotheses (posted, not blocking — async channel) → instrument (one variable at a time, `[DEBUG-` tagged logs, perf branch measures before bisecting) → fix plus regression test at a correct seam (no seam is itself a finding) → cleanup (loop re-run, tags grepped to zero, the confirmed hypothesis recorded in the commit message). Deployment-verified loop recipes are first-class: zstd session-log replay, the mify api.jsonl ts/ttft/total crosscheck, Feishu card mget server-state comparison, and stash-baseline before blind edits. aihero's hitl-loop template is not ported — a human step in the Feishu channel is a message asking the user to act and report back.
- **`skills/prototype/SKILL.md`** is on-demand only, no resident section: grill already routes to it. Six guardrails (marked throwaway from day one, one command to run, no persistence by default, skip the polish, surface full state after every action, fold the validated decision back and delete the prototype — prototype code never migrates, only conclusions), two branches (a logic prototype is a single shareable HTML driving the state machine, delivered through the html skill straight into the chat; a UI prototype is several radical variants on one route, web projects only). grill's protocol item 3 now names the skill.
- Boundary triangle, stated in all three skills: grill owns ambiguity, diagnose owns "why is it broken", prototype owns "what should it feel like"; handoffs are explicit (diagnose→grill when requirements turn out vague, diagnose→tdd once the cause is located, prototype→grill/tdd when the answer comes back).

## Alternatives considered

**A separate diagnose-default section (order 15/25).** Rejected: the lifecycle is continuous with the TDD default, and a fourth resident section spends attention on every plain session for a trigger the TDD section already sits on.

**Porting aihero verbatim (names included).** Rejected: their CONTEXT.md/ADR pointers, the hitl bash template, and terminal-interactive assumptions all need rewriting for this deployment; the deployment-verified recipes (session-log replay, api.jsonl crosscheck) are the local value the original lacks.

**Extending the triage runbook instead.** Rejected: feishu-session-log-triage is a Feishu-fault fingerprint runbook; diagnose is a general methodology for any reported breakage. They reference each other's recipes but own different layers.

## Consequences

Plain sessions and subtask children carry the TDD-default section at ~500 chars (was ~360). The catalog gains two entries; the three working-style skills now form a triangle with explicit handoffs. grill's batched-interview ruling is untouched.

Re-measurement (one week after the reload, same scan methodology as the grill note): reported-breakage sessions should show a loop built before the first root-cause conclusion (the three misdiagnosis shapes are the negative baseline); ungrillable-question sessions should route to a prototype rather than rephrasing; clear requests stay ungrilled. The 08-28 methodology applies (glob session dirs before `zstdcat`).
