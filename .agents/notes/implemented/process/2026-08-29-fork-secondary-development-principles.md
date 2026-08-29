# Agent Note: Fork secondary-development principles

Status: implemented

English | [中文](2026-08-29-fork-secondary-development-principles.zh.md)

## Problem

The fork absorbs upstream batches on `dev` while carrying its own features, and nothing codified where fork changes should land, how large an absorption batch may grow, or which infrastructure the fork may deviate from. The 2026-08-29 absorption of 1079 upstream commits (the `dsh-v0.1.2-alpha.1` range) made the missing policy's cost explicit. Conflict resolution itself stayed tractable; the verification convergence loop behind it did not:

- Roughly 40% of the 165 conflicts were bilingual README pairs whose only fork payload was feature prose, and the translation-pairing gate priced every one of them in two languages — it blocked the merge commit twice.
- Every fork feature grafted onto an upstream-owned seam (approval standing grants, session origin, delegation `cwd`, lsp symbol lookup) had to be re-grafted at the seam's new location, while fork-local packages (`feishu-bridge`, 270 files) passed through with zero conflicts.
- A fork toolchain deviation — [native tsconfig-paths resolution](2026-08-27-vite-native-tsconfig-paths.md) — loaded a second module-singleton copy through package `exports` for upstream's new face-split packages and produced 33 false test failures, attributed only by comparing against a pristine `upstream/master` worktree.
- A mid-absorption `pnpm add` silently dropped a package-local dependency and manufactured three more false failures.

## Decision

Five principles govern secondary development on `dev`:

1. **Sync cadence ceiling.** Absorb upstream at most every 2–3 days while upstream is restructuring (directory retirements, package splits, launcher changes) and at most weekly otherwise; treat a pending batch above ~800 commits as a signal to sync immediately. Convergence cost grows faster than batch size, because larger batches contain more seam moves that fork changes must follow.
2. **Placement layering.** Fork changes land in fork-local packages first. A change that must touch an upstream-owned seam stays minimal in file count, and once stable is proposed upstream: merging an upstream equivalent at the next absorption is cheaper than re-grafting a fork difference at every one.
3. **Upstream document prose stays untouched.** Fork features document in fork-owned files — fork-local package READMEs or dedicated fork sections — not by editing the bilingual README pairs of upstream-owned packages. The pairing gate re-prices every such edit on every later merge.
4. **No toolchain forks.** Build and test infrastructure matches upstream verbatim. A deviation needs a concrete failure it fixes plus a recorded revert trigger; a cosmetic motive (silencing a migration warning) is not one. The native-resolution deviation is the reference failure: its per-importer walk-up discovery could not see the face-split packages upstream later added.
5. **Absorption operation discipline.** Never run `pnpm add` mid-absorption without a full `CI=true pnpm install` afterwards; attribute unfamiliar test failures against a pristine `upstream/master` worktree before diagnosing the merge; re-run `typecheck` after each conflict-resolution batch instead of accumulating one final pass.

The [sync skill](../../../.agents/skills/dsh-sync-upstream/SKILL.md) carries the operational procedure and its gotchas; this note owns the standing principles.

## Alternatives considered

- **Cadence alone.** Syncing daily without the other principles shrinks each batch but keeps paying the seam-graft and toolchain-drift taxes at every absorption.
- **Upstream everything fork-shaped.** Upstream review adds latency and rejection risk, and fork-only product decisions (the Feishu bridge) have no upstream home. Principles 2 and 3 keep the split deliberate rather than maximal.
- **Rebase-based maintenance.** Rejected for a shared pushed `dev`: it force-pushes the public branch the merge-based sync procedure exists to protect.

## Consequences

- Fork changes concentrate in fork-local packages, so later absorptions should see their conflict surface shrink toward the fork-local seam set.
- Features proposed upstream carry latency and may land amended; the fork carries the difference until they land, and a landed equivalent still needs a semantic merge at the next absorption.
- Fork documentation grows fork-owned files instead of upstream-pair edits, so their discoverability relies on the fork-policy pointer in `AGENTS.md`.
- The cadence ceiling costs more frequent, smaller sync sessions; each one re-runs install, generators, and the focused suites.
