# Agent Note: A build-residue gate for orphaned tsc outputs

Status: implemented

English | [中文](2026-09-16-build-residue-gate.zh.md)

## Problem

`tsc -b` emits but never deletes: removing a source file leaves its `lib/types/<file>.{js,d.ts,.js.map,.d.ts.map}` outputs in place indefinitely. The tsdown bundles only pull files the fresh entry chain imports, so a stale output does not poison the daemon bundle — the poison path is any lib consumer (gates, direct imports, tooling) reading symbols from a deleted module, plus the disk cost of residue that only `pnpm run clean` (a full rebuild) removes. First run of the gate found 1124 orphaned outputs accumulated in the main tree across 219 packages, including whole lib trees of packages deleted from the workspace.

## Decision

`scripts/verify-build-residue.ts` scans every package's tsc output dir (`lib/types`, rootDir `src` — uniform across the workspace) and flags outputs whose source file no longer exists, covering both `packages/<group>/<pkg>` and `vendor/<pkg>` layouts and the deleted-package case where `src` is gone entirely. `--prune` deletes the flagged outputs. A root with neither `packages/` nor `vendor/` fails instead of passing vacuously; an unbuilt tree (no `lib/types` anywhere) passes with a zero-count report.

## Alternatives considered

**Extend `pnpm run clean`.** Clean wipes all outputs and forces a full rebuild; the residue case needs a targeted file-level pruner, not a bigger hammer.

**Flag tsdown root outputs too.** `lib/*.js` bundles and chunks regenerate wholesale per build and have no per-file source mapping; only tsc's per-file outputs orphan.

## Consequences

Run the gate after builds that follow source deletions (`tsx scripts/verify-build-residue.ts`, `--prune` to delete). Empty directories left by fully pruned packages remain `clean.ts` territory. The gate reads only the workspace trees, never `node_modules`.
