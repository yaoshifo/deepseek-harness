# Agent Note: Claude Code memory compatibility

Status: implemented

English | [中文](2026-08-14-claude-code-memory-compat.zh.md)

## Problem

The harness had no equivalent of Claude Code's persistent auto memory: `dsh-agent-instructions` covers CLAUDE.md-style workspace instructions, and `examples/mcp-memory` only wires third-party MCP memory servers (default-off, separate stores). A user working in both Claude Code and dsh accumulated memories in `~/.claude/projects/<slug>/memory/` (per-project, one file holds one fact, `MEMORY.md` as a one-line-per-memory index) that dsh sessions never saw, and every dsh-native design would fork that corpus into a second store nobody migrates.

## Decision

`@deepseek-ai/dsh-tool-claude-memory` (`packages/memory/tool-claude-memory`) reuses Claude Code's own store rather than defining a dsh-native one. It reads and writes `~/.claude/projects/<slug>/memory/` directly, where `<slug>` is the session cwd with every `/` and `.` folded to `-` (verified on disk: `/home/hm/.dsh/profiles/cc-connect` → `-home-hm--dsh-profiles-cc-connect`). Three surfaces mirror Claude Code's own split between durable guidance and runtime recall:

- A system-prompt section (order 110, tool-guidance band) with the verbatim Claude Code `## Memory` strategy, adapted only for tool names and the instantiated directory. Anchor tests in `tests/prompt.spec.ts` pin the load-bearing sentences, so prompt drift is a visible behavior change that must update the README verbatim block and snapshots.
- A one-time session-start `user/message` injection of the budget-truncated `MEMORY.md` index, sourced `{ kind: 'claude-memory', version: 1, project, digest }`, framed by a plugin-owned `<system-reminder>` with close-tag escaping, folded after the claimed prompt following the `dsh-agent-instructions` pre-step pattern. At most one injection per session log; resume and compaction do not re-inject, and the model refreshes through `memory_read`.
- Four `memory_list`/`memory_read`/`memory_write`/`memory_delete` tools over the directory.

The tools go through host `node:fs`, never the `ctx.fs` provider: the filesystem seam is swappable per deployment (e2b sandboxes address a remote world), and routing memory IO through it would sever the machine-local sharing contract. This is a deliberate exception to provider swappability, justified by the external product owning the store's location.

Parity with Claude Code means no schema enforcement: frontmatter quality, index-line hooks, dedup-before-save, and deleting wrong memories stay prompt-governed. The plugin enforces only the trust boundary (single-segment file names) and adds harness value where Claude Code does — backfilling `node_type: memory`/`originSessionId` provenance into an existing frontmatter `metadata:` block (additive, never synthesized) and warning after an over-budget `MEMORY.md` write. Index lines are never auto-generated; the one-line hook is the recall artifact, and generated hooks would silently degrade recall quality.

## Alternatives considered

**A dsh-native memory store under `$DSH_HOME/memory/`.** Rejected: it forks the corpus, requires a migration that already exists for free, and loses the "memories accumulated in Claude Code work in dsh" property that motivated the feature.

**A capability seam (Service Definition / provider / consumer split) with the file store as the first provider.** Rejected: the format is owned by the external product, so providers have nothing to vary; a sibling package per external layout is the honest topology, and `packages/memory/` is the group for that.

**Model reads/writes the memory directory through the ordinary fs tools, like Claude Code's Write.** Rejected for dsh: the product fs capability is a swappable seam, so sandbox deployments would write the remote world and silently stop sharing with Claude Code. Dedicated tools keep machine-local IO unconditional.

**Turn-end automatic extraction (Claude's earlier experimental auto memory).** Rejected: Claude Code shipped the model-authored model instead; the write timing, dedup, and "what not to save" judgments are exactly what the strategy prompt encodes, and a background pipeline would duplicate them with worse context.

**agent-instructions-style baseline-identity re-composition for the index.** Rejected for now: workspace instructions change as the model edits files mid-session, so they need reconciliation; the memory index is recall input the tools refresh on demand, and re-compose machinery buys nothing for an unobserved drift cost.

## Snapshot support

The scenario's session cwd is a random temp path and the injected message embeds its slug, so replay fixtures churned per run. `dsh-acp-snapshot` gained a `{{cwdSlug}}` token: `normalize.ts` folds each known cwd spelling to its slug and replaces standalone occurrences with slug-character boundaries (glued text like `<slug>-backup` stays verbatim, preserving the existing basename contract), and `refreshFixtureReplacements` maps a fresh run's slug onto the fixture's spelling or the token. Windows drive-letter cwds never fold (their "slug" retains separators), so they are skipped rather than guessed.

## Consequences

- The near-limit index reminder (Claude Code warns before exceeding a budget; the plugin warns only after) is an additive follow-up with no format change.
- If Claude Code's slug rule is verified on Windows, the `isPosixCwd` guard can relax without format changes.
- A second external memory layout belongs in the same group as a sibling package, not behind a provider seam.
