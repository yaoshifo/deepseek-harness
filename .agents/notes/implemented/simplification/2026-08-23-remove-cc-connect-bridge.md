# Agent Note: Remove the cc-connect-bridge package

Status: implemented

English | [中文](2026-08-23-remove-cc-connect-bridge.zh.md)

## Problem

The harness carried two Feishu-side bridges. `dsh-cc-connect-bridge` was the stdio JSON-RPC runtime layer of the original two-tier architecture — the Go cc-connect daemon talked dsh through it. The M8 cutover (2026-08-21/22) moved every production project, including the last claudecode-type one, to `dsh-feishu-bridge`, which holds the engine and the Feishu WS platform in one daemon process with no bridge protocol; the Dev server's `cc-connect.service` was stopped and disabled. The package then had zero consumers but still cost a tsconfig project reference, generated-catalog sections, and 16 outstanding lint errors that kept the repo-wide lint gate red.

## Decision

The user retired the cc-connect path on 2026-08-23: dsh connects through `dsh-feishu-bridge` directly. `packages/acp/cc-connect-bridge` is deleted whole, along with its tsconfig.host.json project reference, lockfile importer, and generated-catalog sections; `packages/acp/feishu-bridge/reload.sh` drops the comparison against the sibling reload script, and the current-state AGENTS.md lines list only the feishu bridge. Git history and the original Go cc-connect repository remain the behavior reference; nothing in the deleted package carried a mechanism feishu-bridge lacks.

## Alternatives considered

**Keep the package as a dormant reference.** Lost: a dead surface with no consumer still owns a build target, catalog space, and its lint debt, and every reader must re-verify it is unused.

**Move it under `experimental/`.** Lost: same dead code under a different path — exclusion from releases does not create a consumer or recover the maintenance cost.

## Consequences

Cost: the in-repo reference implementation of the extended stdio JSON-RPC bridge (resume/cancel/approvals/questions over capability seams) is gone from the tree; anyone rebuilding that transport starts from git history or the original repository. Bought: one bridge path, a repo-wide lint gate back to green (all 16 pre-existing errors lived in this package), and catalogs that list only loadable packages.

## Testing

No behavior to pin: the deletion removes a self-contained package with no dependents. `pnpm install` prunes the importer, `pnpm run clean` removes the orphaned build output, and typecheck/lint/doc-sync/hygiene gates verify the tree without it.
