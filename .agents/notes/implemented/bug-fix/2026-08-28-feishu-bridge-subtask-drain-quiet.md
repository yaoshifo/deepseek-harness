# Agent Note: feishu-bridge round-5 subtask follow-ups — quiet drain, interrupt contract

Status: implemented

English | [中文](2026-08-28-feishu-bridge-subtask-drain-quiet.zh.md)

## Problem

The 2026-08-28 round-5 review verified the round-4 fixes live (oc_c2e7f659: two gather waves settled in-turn, the in-flight duplicate-report guard fired twice under real load) and found two residue defects:

1. `/done` teardown after a daemon restart logged faults for children that had nothing to stop. `drainNativeDescendants` called `interruptNativeChild` for every drained record unconditionally; when the parent agent died with the old process (restart, HMR rebuild), the runtime refused the interrupt — "the parent agent session is not live" — and three warn lines per drain made routine cleanup read as a failure. Within one process parent and child agents live and die together, so a dead parent means the child has no live turn either: the interrupt could never do anything.
2. The `feishu_bridge_subtask` tool description left the interrupt action's reach unstated: interrupt routes to `interruptNativeChild` and addresses native child ids only, but a model that tried it on an attended group child got "not a native child of this project" with no prior warning in the contract. The round-4 wording pass had pinned send's busy-reject asymmetry; interrupt was the same gap left behind.

## Decision

- Drain probes before it interrupts: `drainNativeDescendants` resolves the `ContinuableDelegator` once and calls a child's interrupt only when `childLive(childId)` reports a live agent. This is the same probe and the same semantics `recoverInterruptedNativeChildren` already uses to distinguish restart-orphans from still-running children. Record clearing, worktree recycle, and barrier death accounting run identically for dead children — teardown stays complete, only the impossible interrupt is skipped.
- The tool description now states the interrupt limit in both places a model reads it: the action sentence ("native subtasks' current turn … attended group children are stopped from their own chat") and the `child` parameter ("interrupt accepts native subtask ids only").

## Alternatives considered

- **Downgrade the drain-path warn to info.** Rejected: it keeps the doomed interrupt call and its throw in the teardown path; probing liveness removes the impossible call instead of reclassifying its failure.
- **Fall back to the record's `parent_agent_session_id` when no live parent exists.** Already the behavior inside `interruptNativeChild`; the failure is that no authority exists at all after a restart, not that the wrong id was tried.

## Consequences

- A delegator without the optional `childLive` probe (none today; the dsh adapter implements it) reports nothing live, so drain interrupts nothing — the same conservative default restart recovery relies on.
- The existing drain test's fake delegator gained a controllable `childLive` defaulting to all-live, keeping its original assertions meaningful.

## Testing

`tests/engine/engine-subtask.spec.ts` (drain interrupts only the live child; the dead grandchild clears without an interrupt attempt), `tests/tools/subtask-tool.spec.ts` (interrupt contract wording pins). Suites: 160 passing; `tsc -b packages/acp/feishu-bridge` clean.
