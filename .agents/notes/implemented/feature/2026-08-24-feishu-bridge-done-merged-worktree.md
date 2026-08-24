# Agent Note: feishu-bridge /done auto-removes child worktrees merged into their containment target

Status: implemented

English | [中文](2026-08-24-feishu-bridge-done-merged-worktree.zh.md)

## Problem

`/done` already tears down the whole spawn subtree — child groups via `cleanupOneChat`, native continuable descendants via `drainNativeDescendants` — but every worktree with commits ahead of its base counts as dirty and is preserved (`worktreeDirty` conflated uncommitted changes with ahead-commits). Since the agent conventions make a finished task commit its work, nearly every implementing child lands in the preserve branch: the user must visit each child group, run `/done` again, and answer the Keep/Remove card, and when nobody does, worktrees accumulate (5.3 GB of orphan `.claude/worktrees/<slug>` directories and `cc/<slug>` branches observed on 2026-08-24, ~60 entries over four days). Go cc-connect had the same preserve-everything behavior, so the M4-A port reproduced it faithfully.

The preserve instinct is right for work that exists only on the child branch; it is wrong for work that already landed in the integration branch, where removal is lossless.

## Decision

Split the dirty verdict and gate auto-removal on a per-worktree containment target (`packages/acp/feishu-bridge`):

- **`worktreeDirtyDetail`** replaces the boolean `worktreeDirty` (deleted — no callers remain): `{ uncommitted, ahead }`. Uncommitted changes keep the worktree unconditionally; ahead-commits are candidates for lossless removal.
- **The target defaults to the creation-time base branch**: `createWorktree` records the branch HEAD was on (`git rev-parse --abbrev-ref HEAD`, normalized to '' when detached) alongside the base SHA, threaded through the Session tuple, the native child record, and both persistence formats. The check is per-repo and zero-config — a checkout on `dev` targets `dev`, on `main` targets `main`; a nested child spawned inside a worktree targets its parent worktree's branch, which is semantically the right landing place.
- **`spawn.integrateBranch`** (new `SpawnConfig` field + schema + `Engine.setSpawnIntegrateBranch`; '' default) is a global override for deployments whose checkouts roam feature branches but always land in one branch.
- **Containment proof** (`worktreeMergedInto`): `git merge-base --is-ancestor branch target`, falling back to `git cherry target branch` with no `+` lines — patch equivalence after a rebase or cherry-pick, and the redundant-merge case (a branch whose only unique commit is a duplicate merge of content already landed, observed in the wild). Any git failure reads as not merged, so the worktree is preserved.
- **Both teardown paths use it symmetrically**: the group path (`cleanupOneChat`) removes a merged child via `finishWorktreeRemoval`, which reports the new `worktree_removed_merged` message naming the target branch; the native drain path (`removeNativeWorktreeQuiet`) removes merged children quietly. Dirty-children summaries and the interactive Keep/Remove card remain exactly for the unmerged and uncommitted cases.

## Alternatives considered

**Force-remove every dirty child on parent `/done`.** `removeWorktree` deletes the branch with `git branch -D` regardless of merge state; commits that never landed anywhere would be destroyed silently. Rejected — the child's report text in chat is the only other artifact.

**A configured branch name as the only target (the first cut of this change).** The engine cannot know each repo's landing branch — `dev` here, `main` elsewhere — and a global config would silently no-op for repos it mismatches, demanding a remembered config line per new project. The recorded creation-time base branch derives the same fact per-repo with zero config; the explicit setting survives only as an override.

**Ancestor check only, no `git cherry` fallback.** Misses rebased or cherry-picked landings and the redundant-merge shape; those branches would keep demanding manual card answers. The two-probe form costs one extra git call per dirty child.

**An age-based periodic sweep.** No notion of merged-ness, races children that are merely slow, and adds a scheduler the engine does not own. The `/done` hook is the natural settlement point: the user has just declared the subtree finished.

## Consequences

Auto-removal is on by default for every worktree with a resolvable creation-time base branch; worktrees created from a detached HEAD (or predating the recorded field) fall back to the `spawn.integrateBranch` override, or keep the interactive path when that is unset too. Auto-removal runs `branch -D` only after a containment proof, and the deletion summary names the target branch; git reflog remains the recovery path for a misjudged containment (e.g. the target branch rewound between landing and `/done`). The containment probes add at most two git subprocesses per dirty child at teardown time. A side effect worth naming: `slugify` strips non-ASCII, so Chinese task descriptions collapse to bare `task-MMDD-HHmmss` slugs — auto-removal at `/done` is also what keeps that anonymous population from accumulating again.
