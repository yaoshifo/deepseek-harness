# Agent Note: feishu-bridge /done auto-removes child worktrees merged into the integrate branch

Status: implemented

English | [中文](2026-08-24-feishu-bridge-done-merged-worktree.zh.md)

## Problem

`/done` already tears down the whole spawn subtree — child groups via `cleanupOneChat`, native continuable descendants via `drainNativeDescendants` — but every worktree with commits ahead of its base counts as dirty and is preserved (`worktreeDirty` conflated uncommitted changes with ahead-commits). Since the agent conventions make a finished task commit its work, nearly every implementing child lands in the preserve branch: the user must visit each child group, run `/done` again, and answer the Keep/Remove card, and when nobody does, worktrees accumulate (5.3 GB of orphan `.claude/worktrees/<slug>` directories and `cc/<slug>` branches observed on 2026-08-24, ~60 entries over four days). Go cc-connect had the same preserve-everything behavior, so the M4-A port reproduced it faithfully.

The preserve instinct is right for work that exists only on the child branch; it is wrong for work that already landed in the integration branch, where removal is lossless.

## Decision

Split the dirty verdict and gate auto-removal on a configured integration branch (`packages/acp/feishu-bridge`):

- **`worktreeDirtyDetail`** replaces the boolean `worktreeDirty` (deleted — no callers remain): `{ uncommitted, ahead }`. Uncommitted changes keep the worktree unconditionally; ahead-commits are candidates for lossless removal.
- **`spawn.integrateBranch`** (new `SpawnConfig` field + schema + `Engine.setSpawnIntegrateBranch`; unset/default `''` keeps the previous preserve-everything behavior) names the branch child commits are expected to land in, e.g. `dev`.
- **Containment proof** (`worktreeMergedInto`): `git merge-base --is-ancestor branch integrateBranch`, falling back to `git cherry integrateBranch branch` with no `+` lines — patch equivalence after a rebase or cherry-pick, and the redundant-merge case (a branch whose only unique commit is a duplicate merge of content already landed, observed in the wild). Any git failure reads as not merged, so the worktree is preserved.
- **Both teardown paths use it symmetrically**: the group path (`cleanupOneChat`) removes a merged child via `finishWorktreeRemoval`, which reports the new `worktree_removed_merged` message naming the integrate branch; the native drain path (`removeNativeWorktreeQuiet`) removes merged children quietly. Dirty-children summaries and the interactive Keep/Remove card remain exactly for the unmerged and uncommitted cases.

## Alternatives considered

**Force-remove every dirty child on parent `/done`.** `removeWorktree` deletes the branch with `git branch -D` regardless of merge state; commits that never landed anywhere would be destroyed silently. Rejected — the child's report text in chat is the only other artifact.

**Ancestor check only, no `git cherry` fallback.** Misses rebased or cherry-picked landings and the redundant-merge shape; those branches would keep demanding manual card answers. The two-probe form costs one extra git call per dirty child.

**An age-based periodic sweep.** No notion of merged-ness, races children that are merely slow, and adds a scheduler the engine does not own. The `/done` hook is the natural settlement point: the user has just declared the subtree finished.

## Consequences

Deployments opt in by setting `spawn.integrateBranch`; without it nothing changes (all current profiles). Auto-removal runs `branch -D` only after a containment proof, and the deletion summary names the integrate branch; git reflog remains the recovery path for a misjudged containment (e.g. an integrate branch rewound between landing and `/done`). The containment probes add at most two git subprocesses per dirty child at teardown time. A side effect worth naming: `slugify` strips non-ASCII, so Chinese task descriptions collapse to bare `task-MMDD-HHmmss` slugs — auto-removal at `/done` is also what keeps that anonymous population from accumulating again.
