# Agent Note: Post-approval parallel execution guidance

Status: implemented

English | [中文](2026-09-02-post-approval-parallel-execution-guidance.zh.md)

## Problem

The 2026-08-31 guidance made exploration fan out by default, but post-approval implementation still ran serial unless the user said 「并行」. The gap is structural, verified in code: the `plan:policy` section unmounts the moment plan mode exits (the mode switch swaps only the prompt section), the approval result text carries no dispatch semantics ("Plan approved — plan mode exited; carry out the plan starting with your next step."), and the plan template's parallel-group marking had no consumer — no surface told the agent to honor the marking at execution time. Nothing durable carries the execution order either: the plan markdown is surface content that compaction summarizes away, and the todo list has no re-injection channel (the model sees todos only through its own past tool calls on the surface).

## Decision

- Three surfaces state one boundary — independent work defaults to parallel, lightweight single-focus work stays serial:
  1. Global instructions (`~/.claude/CLAUDE.md`, the `~/.dsh/AGENTS.md` symlink target) gain a 并行推进 rule: approved-plan independent groups dispatch together when execution begins, serially dependent groups self-execute in order, other obviously independent multi-block work parallelizes too. This reverses the 2026-08-31 note's "accepted as small" call on the AGENTS.md nudge — the non-plan surface is now covered deliberately.
  2. The plan template's marking became an imperative execution-order statement in the two gated copies (bundle base patch + bridge patch): "state the execution order — independent groups dispatched together as parallel subtask spawns when execution begins, serially dependent groups executed in order". The execution strategy is user-reviewed plan content; `bundle-patch.spec` pins the sentence and keeps the base≡bridge lockstep.
  3. The delegation surfaces state the same boundary: the `feishu_bridge_subtask` tool description gained the approved-plan execution sentence (pinned in `subtask-tool.spec`), and the `feishu-bridge-subtask` skill's frontmatter description and plan-mode section carry the same trigger.
- Layering principle: principle layers (global instructions, skill, plan template) carry only the decision boundary. Mechanism — worktree defaults and the read-only exception, dispatch cadence, gather barrier — stays in the tool description, which the model reads at the spawn decision point. The 2–5 band is the exploration-shape guard and stays only in the plan-mode exploration sentence; execution-phase fan-out breadth is bounded by the plan's own user-reviewed grouping, not a number.
- Presets stay untouched: the three preset copies are not in the fork's live assembly chain (web-app surface) and already drift one revision; the base↔bridge lockstep gate covers the live pair.

## Alternatives considered

- **An execution-phase prompt section with durable state** (new session event + folded projection + a `plan:execution` section unmounted on the next `/plan`). Mechanically clean — `plan:policy` already swaps by state — but end-of-execution has no clean log signal (turn/end is too early since execution spans turns, todo completion is optional, agent self-report needs a new event), and the state churn (SessionEventMap → SDK dual projection, stateVersion, invariants) serves a text problem. Escalation trigger: if acceptance replay still shows serial post-approval execution, this becomes the second phase.
- **Extending the approval result text** (plan-mode's tool render). One-shot surface text that compaction summarizes away, upstream product text pinned by snapshots, and the wrong seam — the behavior belongs to delegation, not plan-mode.
- **Unconditional global push (「尽量并行」).** Over-fires on lightweight work; every spawn is a full agent session. The conditional wording with the single-focus exception is the safety valve.
- **Global instructions only.** Covers breadth but cannot deliver the user-reviewed execution contract or the spawn-decision surface; standing global text is also the weakest attention position — the tool prompt and skill already said "parallel" and execution still ran serial.

## Consequences

- Deployment: global instructions hot-reload on both ends (dsh and Claude Code) with no build; the dev server's global file needs a manual sync. The bridge patch and tool description ride the linked package's pull + `/reload` (user-triggered only); the skill markdown is live without reload.
- Acceptance: replay four shapes without 「并行」 — a plan-approval flow with ≥2 independent groups (fan out in the first execution turn), a small or single-group plan (no dispatch), and a non-plan direct-execution task with two independent slices (fan out), plus an explicit 「并行」 regression. The 8-31 sampling bar applies: a single replay is not evidence. Spawn breadth should match the plan's marked groups.
- Known residual: execution orders live on the surface (the plan text inside tool-call arguments) and do not survive compaction verbatim; the durable fix (logged plan event or runtime-context re-injection) is deferred until the text layer is falsified by replay. The todo list shares the same re-injection gap and the same deferral.
