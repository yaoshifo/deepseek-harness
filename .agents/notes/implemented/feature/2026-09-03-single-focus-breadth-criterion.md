# Agent Note: Single-focus breadth criterion for parallel exploration

Status: implemented

English | [中文](2026-09-03-single-focus-breadth-criterion.zh.md)

## Problem

A 2026-09-03 dev-server session (Feishu chat `oc_81b7ae794ae8ce01fb5a4efcebf18fe6`, glm-5.3, reasoning effort max) explored a 328-commit / 32-PR upstream merge review with zero subtask spawns across 86 tool calls, while every guidance surface was verifiably present in its logged request: the 2–5-angle sentence and the execution-order sentence in the system prompt, the AGENTS.md injection, and the tool in the 32-tool catalog. The first-turn reasoning classified the review as "a single-focus investigation — one or a few git commands", invoking the exception clause "keep exploration serial only for a single-focus question one or two reads can answer". That clause sizes single-focus by command count: a review whose answer must cover a whole repository's subsystems still reads as few-command skimmable, so the exception overrode the rule stated earlier in the same sentence (a repo-wide scan is several investigations). The same model and tooling fanned out on narrower multi-angle tasks in other sessions the same week, which localizes the gap to the exception wording, not to deployment or model capability.

## Decision

- The exception clause now sizes single-focus by answer breadth: "keep exploration serial only for a single-focus question one or two reads can answer — judge focus by how many subsystems or directions the answer must cover, not by how few commands could skim it."
- The split list gains an explicit category: "a repo-wide scan, cross-cutting audit, broad merge or release review, or a request naming several directions is several investigations".
- Both edits land identically in all five copies: dsh-base bundle patch, bridge bundle patch ([bundle-patch ownership](../architecture/2026-09-01-feishu-bridge-plan-mode-guidance-in-bundle-patch.md)), and the three preset copies. The base≡bridge lockstep gate still allows only the one delegation sentence as delta.
- The `feishu_bridge_subtask` tool description gains the execution-phase mirror "Judge independence by whether the groups span disjoint subsystems or directions, not by how few commands could chain them." The plan-mode section unmounts on approval, so the tool description carries the criterion at the execution decision point; `subtask-tool.spec` pins it.
- The `feishu-bridge-subtask` skill's frontmatter description and exclusion section state the criterion in Chinese: single-focus is sized by how many subsystems or directions the answer covers, not by command count; broad merge reviews, release reviews, repo-wide scans, and cross-cutting audits are not single-focus.

## Alternatives considered

- **No change — the model's judgment was defensible.** A few git commands do list a merge's surface, and that session's plan was legitimately layered. But the shipped contract ([parallel exploration default](2026-08-31-parallel-exploration-default-guidance.md), [post-approval execution](2026-09-02-post-approval-parallel-execution-guidance.md)) defaults breadth tasks to parallel, and the exception wording is what separated this case from the same week's fan-out cases.
- **A commit-count threshold mandating fan-out for large merges.** Hard thresholds in prompt text drift from how tasks actually arrive; the breadth criterion reads the task's shape directly.
- **Per-project prompt overrides.** Recreates the per-machine drift the 2026-09-01 bundle-patch consolidation retired.

## Consequences

- `bundle-patch.spec` pins both new phrases and keeps the lockstep exact-match; `subtask-tool.spec` pins the execution mirror.
- Acceptance keeps the 8-31 multi-task bar: replay a merge-review-shaped task alongside the earlier shapes — a broad review fans out 2–5 read-only spawns in one message, while a small merge staying serial is correct behavior, not a miss.
- Deployment rides the linked package's pull + `/reload` on both machines (patch yml and the built tool description); the skill markdown is live without reload. The dev server needs its routine propagation first.
- Known residual: wording adjusts model judgment, it does not bind it; the criterion raises the fan-out rate on breadth tasks without guaranteeing every one. Several replays remain the acceptance gate, per the 8-31 sampling bar.
