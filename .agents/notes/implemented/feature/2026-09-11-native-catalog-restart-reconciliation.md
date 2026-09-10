# Agent Note: Subagent-catalog restart reconciliation — absorbing the upstream parent-subagent catalog read side

Status: implemented

English | [中文](2026-09-11-native-catalog-restart-reconciliation.zh.md)

## Problem

The 2026-09-10 upstream merge (9fe54af7a3) landed the parent-owned subagent catalog: every continuable child the bridge spawns now writes a `subagent/catalog` creation fact to the parent session log (the write side is inherited at zero cost), but the fork's read side had zero references. The bridge's own `NativeChildRecord` (projectState JSON) has two loss windows it cannot cover: (1) the crash window — the catalog fact is persisted inside `startContinuable`, while the projectState save happens after it returns; a crash between the two leaves the child with neither a notice nor a worktree-cleanup trail; (2) a damaged or deleted state file loads silently as empty. Restart recovery (`recoverInterruptedNativeChildren`) only declares death for children that are recorded and unreported; a child whose record was lost is entirely invisible.

## Decision

Absorb only the narrow "restart reconciliation + lost-record notice completeness" scenario; the panel data source stays on projectState plus the in-memory activity map:

- **Tombstones** (`project-state.ts`): before the drain clears a child record it calls `markNativeChildCleared` (FIFO cap 512), because the catalog only records creation, never removal — without tombstones the reconciliation would report deliberately drained children as lost.
- **Cold reader** (`src/index.ts`, `createNativeCatalogReader`): follows the `createPendingInboxReader` pattern — one `observeSession` (projectionMode `'all'`) reading the direct-child list from the `subagentCatalog` projection; the projection unit is registered here (a fresh host has no subagent runtime), which required adding a runtime export of `subagentCatalogProjectionDefinition` to the `dsh-subagent` main entry (the same seam as dsh-agent-loop's exported `inboxProjectionDefinition`). Unknown or unreadable sessions resolve to an empty list.
- **Reconciliation** (`engine.ts`, `reconcileNativeCatalog`): fires **before** `recoverInterruptedNativeChildren`'s early return (lost records are an independent failure class from interrupted ones); for every active session the catalog is cold-read, and a catalog child with neither a record nor a tombstone produces a red warning card (new keys `SubtaskCatalogLostCardTitle/Notice`) stating "registration lost, the session remains in storage, worktrees need manual cleanup". Visibility only — nothing is auto-acted-on.

## Alternatives considered

**Switch the panel data source to the catalog as the membership authority.** Rejected: the catalog is a creation-time fact; it carries no run state (activity lives in memory) and no reported/worktree fields, so it would need a join against projectState — no net gain under single-engine ownership, days of work.

**Compensating events at drain time (a catalog removal face).** Rejected: that edits the upstream event surface; tombstones in the fork's own state achieve the same discrimination.

**Auto-rebuilding the subtask panel from reconciliation.** Rejected: after a restart the in-flight epochs are genuinely dead; rebuilding the panel would mislead users into thinking they can continue; reconciliation only restores notice completeness.

## Consequences

- Both loss classes (crash window, damaged state) are now visible through a red card carrying the child session id (revivable for follow-up via `feishu_bridge_subtask action=send`).
- Tombstone window of 512: an extremely old historical child evicted from the window whose record is also long gone would be falsely flagged once — an accepted boundary (per-session child counts are far below this scale).
- The O(log-length) cold observation happens once at restart and never enters the 15s panel tick.
- The one-line `dsh-subagent` export is an upstream-file change, recorded in the graft ledger's subagent group (same pattern as the inboxProjectionDefinition export, to be proposed upstream with its batch).

## Testing

`tests/engine/project-state-shape.spec.ts`: tombstone round-trip and FIFO cap. `tests/engine/engine-subtask.spec.ts`: drain writes tombstones; reconciliation's three cases (lost → notice carrying id+label, tombstoned → silent, fully tracked → silent, no reader → skipped). `tests/agent-dsh/native-catalog-reader.spec.ts`: real-composition cold read (real projection + persistence; the fork-cut semantics come from the projection itself). Full bridge suite 3394 tests with one load-induced timeout only (done-worktree-merged, green in isolation).
