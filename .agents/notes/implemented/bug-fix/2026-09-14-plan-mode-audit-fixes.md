# Agent Note: Execute the fix batch from the two plan-mode audits

Status: implemented

English | [中文](2026-09-14-plan-mode-audit-fixes.zh.md)

## Problem

Two plan-mode implementation audits ([2026-09-12 primary](../../../../packages/acp/feishu-bridge/docs/plan-mode-audit-2026-09-12.md), 26 findings; [2026-09-14 complementary](../../../../packages/acp/feishu-bridge/docs/plan-mode-audit-2026-09-14.md), F1-F9; both as corrected by review) surfaced four defect families:

1. **Guidance-surface distortions**: the feishu-bridge-subtask skill taught the Go-era tool name `ExitPlanMode` in three places (the dsh name is `exit_plan_mode`) and claimed plan mode intercepts executing spawns (no such mechanism exists; child sessions get `planMode.set(agent, false)`); the patch's plan-mode section carried single-layer narration contradicting the agent-conventions two-layer contract in the same request; three texts promised stronger validation than the gate delivers.
2. **Submission/command-layer defects**: the `EMBEDDED_DETAILS_HEADING` single-line regex falsely rejected fenced headings and matched cross-line `##\n实施细节`; `/plan` collapsed queued/cancelled/noop into one "entering" message; the exit tool's guard read only the logged state, diverging from `plan:policy`'s `pending ?? logged` (a second review card could open in the same batch after approval).
3. **Render-lifecycle family**: a non-verdict clarification killed in-flight plan renders; the dedup hash was recorded at render start (a failure permanently suppressed retries); an approval-triggered abort settled a written-out render as failed; attempt-1 temp dirs leaked; heartbeat PATCHes could reorder against the terminal PATCH; attachments riding a text+attachment combo during a pending permission ask were neither staged nor delivered; two dead state fields.
4. **Records and gates**: READMEs/notes carried narratives of a revoked mechanism; the graft ledger had no rows for the plan source grafts; six `expected.*` fixtures sat at the pre-fork shape, leaving the web replay gate red on dev.

## Decision

- Executed as three file-disjoint parallel groups (plan-mode package / bridge guidance surfaces / bridge render lifecycle) in isolated git worktrees, one commit per finding, TDD red-to-green throughout; same-family out-of-list discoveries found during execution were fixed in-group (the 09-01 note's stale narrative, the reply path's F4a sibling).
- The gate rewrite took the **conservative scope**: only the four audited changes (fence tracking incl. CRLF line endings, `[ \t]+` ATX space, case-insensitive English, levels 2-6); synonym and trailing-content misses remain the design note's pinned graceful degradation, pinned as boundary tests.
- #14's fix stages attachments in routePermissionResponse's non-verdict branch (mirroring the questions path); no pure-attachment exemption was added (handleMessage stages pure attachments before the ask router — the exemption would be dead code).
- Wave 1.5 structural cleanup: Go-port signatures narrowed; 12 zero-consumer exports retracted under the "tests count as consumers" reading; the two render templates folded into shared fragments assembled in each template's original rule order (the orders differ, so a single base + placeholders cannot stay byte-identical) — accepted with `diff -r` empty across five rendered artifacts, shasums equal, and all four exported strings `===` their pre-merge values.
- The graft ledger gained three plan source-graft rows (two-layer review / rejection gate / compaction preservation) plus the 36-fixture pinning cost.
- The snapshot refresh (Wave 2) runs once, after all model-visible copy changes; refreshing earlier would force a second pass.

## Alternatives considered

- **Aggressively widening the gate's hit surface** (synonyms like `## 实现细节` / `## Technical Details`, trailing content, bold/indented/quoted shapes). No: both audits scope the fix to the four changes, and the design note pins unrecognized shapes as graceful degradation; widening the enumeration turns "teach the model layering" into heading-shaped whack-a-mole.
- **Mirroring the questions path's pure-attachment exemption for #14**. No: pure attachments are staged and returned by handleMessage before the ask router; the mirror would add production-unreachable dead code.
- **Merging the render state-machine skeletons** (09-12 #24). No: that report rates the risk above the benefit; the template fold (84% line-shared) executed as the 09-14-discovered subset.
- **Fixing the parallel session's typecheck debt in passing** (the Message cast in engine-answer-delivery.spec, two uuid accesses in platform.spec). No: u5/u6 belong to the in-flight dsh-im absorption batch; this batch fixed only the ProgressDrain stub typing it introduced.

## Consequences

- All three groups plus Wave 1.5 landed on dev: verification surfaces plan-mode 101/101, bridge guidance 175/175, render lifecycle 9 specs 285/285 (post-merge 4×232 stability), structural cleanup 260/260, template fold byte-identical; full feishu-bridge + chatroom suites 3478/3478.
- Timing-test lesson (ProgressDrain flake, ~1/4 under load): a fixed count of fake-clock advances cannot drive real fs I/O inside the flow — condition-driven waits (observable signal + real-clock budget + negative control) are the deterministic pattern for such tests.
- Known remainders: the client fixture's /plan two-outcome mirror does not yet carry the four-way copy. The tool-catalog drift against the new EXIT_DESCRIPTION closed when the catalog was regenerated from the current source, and d762ff098c refreshed the two Windows-only pwsh fixtures along with the other Wave 2 lanes.
- Wave 2 (align the six stale fixtures, refresh all affected lanes once) landed as d762ff098c; this batch is on origin/dev.
