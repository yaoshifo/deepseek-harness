# Agent Note: Parallel exploration default guidance

Status: implemented

English | [中文](2026-08-31-parallel-exploration-default-guidance.zh.md)

## Problem

Feishu-bridge session logs (344 sessions, 2026-08-19 through 08-31) show parallel delegation fires only on explicit instruction: 14 of 14 sessions where the user wrote 「并行」 or 「充分利用并行」 fanned out subtask spawns, while un-instructed investigations stayed serial whenever the model had to split the work itself — a three-direction research request planned with zero spawns (session `cc-20260821-122708`), a multi-angle verification audit at 58 serial tool calls, and a history-log analysis at 594 calls over 324 minutes with zero background jobs. Un-instructed fan-out happened only when the request itself was pre-partitioned (one book per child, several numbered query points, two servers to compare).

Three causes, each verified in logs:

1. The plan-mode section (injected only into plan-mode sessions — the deployment's default mode for these chats; the tool catalog stays the same across modes for request-cache stability) phrased delegation conditionally: "Exploration also parallelizes: when the investigation spans independent areas, …". Whether an abstract request ("scan comprehensively", "verify from multiple angles") *has* independent areas was left to on-the-spot model judgment, which wavers.
2. The skill text contradicted it: "同一个项目内的只读调研 / 勘察不开子任务" (2026-08-21 wording) forbade same-project read-only delegation while the plan-mode text authorized exactly that. The failed case loaded the skill mid-exploration and stopped delegating; its same-day twin (same guidance, same task shape) spawned three parallel children.
3. Implementation-phase parallelism had no guidance. The 2026-08-21 decision deferred it behind the criterion "plans already grouped by subsystem, model still executes groups serially" — later sessions met that criterion (plans carried independent W1–W3 / A1–A5 groups) and every implementation fan-out still required the user to say 「充分利用并行」.

## Decision

- The plan-mode exploration sentence becomes a default with an explicit exception, in all four preset/bundle copies plus the live-profile patch override: split any repo-wide scan, cross-cutting audit, or request naming several directions into 2–5 independent angles up front and dispatch them together in one assistant message (read-and-report-only briefs); keep exploration serial only for a single-focus question one or two reads can answer. Repository copies stay tool-neutral ("background subagent delegations"); the live-profile override names `feishu_bridge_subtask`, preserving the deployment-layer routing split.
- "group implementation changes by subsystem" gains "and mark which groups are independent enough to implement in parallel versus serially dependent" — the deferred implementation-phase gate, landed on the met criterion. Marking lives in the plan the user reviews, so the approval gate stays with the user.
- The skill's exclusion boundary narrows to its cost rationale: lightweight single-focus questions (one or two reads/greps) stay serial; multi-direction research defaults to parallel no-group spawns. The 2026-08-21 boundary priced the attended-group surface; unattended spawns have ridden the native continuable seam without creating groups since 2026-08-24, so that cost premise is gone.

## Alternatives considered

- **Keep the conditional wording.** Retains the observed instability: identical guidance and task shape, divergent behavior.
- **Guidance in only one of skill or prompt.** The contradiction between the two was itself a suppression — the failing case loaded the skill and stopped. Both surfaces must state one boundary.
- **A parallelism nudge in AGENTS.md global instructions.** The plan-mode section already covers the deployment's default (plan) mode, where all the failing cases ran; non-plan direct-execution chats are the remaining uncovered surface, accepted as small.
- **Unconditional parallelism.** Every spawn is a full agent session; token cost and shallow per-angle reads are real. The single-focus exception and the 2–5 band keep the default from over-firing.

## Consequences

- Deployment: the live profile's plan-mode override replaces the whole section row, so it carries both new sentences and `/reload` activates them ahead of any bundle promote; the override remains deletable once the dsh-base release carries the text (same recovery condition as 2026-08-21).
- Tool-name routing stays where the [delegation-surface wording note](../architecture/2026-08-20-delegation-surface-selection-wording.md) put it: repository copies are tool-neutral, only the deployment-layer override names the tool. The [parallel scheduling](2026-08-09-parallel-subagent-delegations.md) and [unattended native seam](2026-08-24-feishu-bridge-native-unattended-subtasks.md) mechanisms are untouched.
- Acceptance: replay the three failed shapes (three-direction research, multi-angle verification, cross-session log analysis) without the word 「并行」 — at least two of three should fan out within one assistant message; an explicit-instruction regression run should still fan out. Watch spawn counts: a single task routinely exceeding the 2–5 band means the default over-fires and the band needs tightening.
- Known residual: part of the instability is sampling-level (identical inputs, divergent plans), so a single successful replay is not evidence; the multi-task bar above is the gate.
