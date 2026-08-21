# Agent Note: feishu-bridge profile dropped the lsp rows in the cc-connect migration

Status: implemented

English | [中文](2026-08-21-feishu-bridge-profile-lsp-rows.zh.md)

## Problem

The M0 profile templates for `packages/acp/feishu-bridge/profile/` (commit `feb2533467`) copied the lsp dependencies from the production cc-connect profile into `package.json` (`dsh-lsp`, `dsh-lsp-stdio`, `dsh-tool-lsp`) but dropped the matching `lsp` / `lsp-stdio` / `tool-lsp` insert rows from `cordis.patch.yml`. MIGRATION.md's own carry-over list names lsp as reuse-untouched, so the omission contradicted the migration plan. Cordis composes only the plugins the patch tree names, so the packages sat installed-but-unmounted: bridge sessions exposed no `lsp` tool while the `grep` tool description (commit `b650ab0fab`) still recommended it. Tool-call statistics over two days of sessions — 1,590 calls, zero lsp — surfaced the gap.

## Decision

The profile template and the deployed profile (`~/.dsh/profiles/feishu-bridge/cordis.patch.yml`) both carry the three rows again, with a full language-server table in `lsp-stdio.servers`: typescript (profile-local `typescript-language-server`, absolute `node_modules/.bin` path), python (pyright), go (gopls), java (jdtls with `JAVA_HOME` pinned to the LTS JDK), rust (rust-analyzer), and c/c++ (clangd) — the language inventory of the workspace projects this deployment serves. `typescript-language-server` and `typescript` are profile dependencies so the TS server installs with the profile.

Deployment constraints the patch comments record:

- lsp-stdio resolves every server command at load, and one bad entry — a missing binary or a failed launch — prevents **every** provider from registering. Install binaries before editing the patch; a failed row is not a per-language degradation.
- Commands on a launchd daemon use absolute paths. `~` is not expanded, the profile `.bin` directory is not on the daemon PATH, and load-time PATH resolution is unreliable. The repo template uses bare names as the machine-neutral default and says so in its comment.
- The template's system-server rows fail loud when a deployment's daemon PATH cannot resolve them; that deployment swaps the names to absolute paths.

## Alternatives considered

**Bare command names in the deployed profile too.** Rejected: a name that fails to resolve disables all lsp providers at once, and the launchd PATH differs from an interactive shell.

**A per-project server table.** Not expressible: lsp-stdio takes one static server table per deployment. Per-project pyright interpreters or per-project jdtls data directories are accepted as a known limitation — one jdtls instance and one data directory serve all Java projects, and pyright resolves one global interpreter.

## Consequences

Bridge sessions expose the `lsp` tool for `.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs/.py/.pyi/.go/.java/.rs/.c/.h/.cpp/.cc/.hpp`. Java pays JVM startup plus import indexing on the first query and may time out once; subsequent queries answer normally. Profile patch edits reach the running daemon through Cordis HMR without a restart, and verification rides the session log (`tool/call` and `tool/result` with `isError: false`) rather than process state.
