# Agent Note: Command cwd resolves the per-chat dir override first

Status: implemented

English | [中文](2026-09-02-feishu-bridge-command-cwd-override-first.zh.md)

## Problem

`/shell` and the other chat commands ignored a chat's `/dir` override. `commandWorkDir()` resolved engine slot → per-chat override → `process.cwd()`; the project-configured slot is never empty, so the override was unreachable — the only cwd resolver with that order (`sessionWorkDir` and `effectiveWorkDirForPending` both resolve the override first). Observed live 2026-09-02 (books chat): `/shell git pull` ran in the project workdir (mem0) instead of the chat's override (deepseek-harness).

## Decision

Per-chat override first, matching the session resolvers; `/shell`, `/skills`, `/mcp`, `/status` now follow the chat's dir.

## Alternatives considered

**`planWorkDir()` following the override too.** Rejected: it names plan files, which track the project rather than the chat, so it deliberately keeps slot-first — the fix is scoped to the command resolvers whose outputs the chat actually consumes.

## Consequences

User-visible effect: `/status` dir display and the `/skills` / `/mcp` workspace lists now vary with the chat's override. Tests: `tests/engine/shell-commands.spec.ts` — "prefers the chat dir override over the agent work dir (/dir display and /shell cwd agree)" over the kept "runs in the command working directory (agent work dir)" anchor.
