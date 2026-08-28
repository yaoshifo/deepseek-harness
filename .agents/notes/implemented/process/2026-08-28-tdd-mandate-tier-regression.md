# Agent Note: TDD mandate tier regression — resident prompt sections over skill descriptions

Status: implemented

English | [中文](2026-08-28-tdd-mandate-tier-regression.zh.md)

## Problem

The 2026-08-24 dotfiles migration (commit `12ceaa3`, mirrored by `7c12e26012` in this repo) folded the global CLAUDE.md behavioral mandates into the `tdd` and `skillify` skill descriptions on the assumption that a catalog line visible every session carries the same behavioral weight as a standing instruction. The「默认测试驱动」and skillify-offer sections were deleted from the machine-local global instructions file; only the catalog entries remained.

Session-log measurement over the four days on either side of the migration showed the TDD practice collapsed while the mechanism stayed healthy:

- Assistant output in deepseek-harness coding sessions carried red-green-loop language in 37/56 (66%) sessions before the migration and 18/126 (14%) after; sessions with substantial practice (≥3 mentions) fell from 29/56 to 6/126.
- The `tdd` skill deployed correctly — its catalog entry appeared in 139/139 post-migration sessions — and the model was unchanged (glm-5.3 both sides). Visibility did not equal adherence.
- Pre-migration reasoning explicitly cited the mandate ("TDD: red-green loop per global instructions"); post-migration sessions that still practiced TDD deliberated over the catalog line at decision time. Tests kept being written (repo testing policy and pre-push checks require them) but flipped test-last in the sampled sessions (6 of 8).

This is the same decision-moment recall failure the [workspaceSymbol adoption study](../feature/2026-08-27-lsp-workspace-symbol-entry-point.md) documented: descriptions do not reliably trigger for practiced intents, because the model does not re-read the catalog at the moment it starts implementing.

## Decision

Restore both mandates as resident system-prompt sections deployed with the package — not back into the machine-local global instructions file:

- `tddDefaultPrompt()` registers as the `feishu-bridge-tdd-default` section (order 20) for plain sessions **and** subtask children: coding turns run in both branches, and the retired global instructions file had covered every session type.
- The skillify offer joins `agentConventionsPrompt()` as its fourth section: it is a round-end user-facing proposal, the same tier as curiosity reporting, which stays plain-only because subtask children report through their parent session.
- The `tdd` and `skillify` skills keep their catalog entries and bodies unchanged. The sections carry the mandate; the skills carry the loop details on demand. A behavioral default needs a resident imperative; a description line only routes recall.

## Alternatives considered

**Restore the mandate in ~/.claude/CLAUDE.md.** Rejected: machine-local config reintroduces the new-machine deployment gap the 2026-08-24 migration closed (the dev server's symlink state is unverified); repo-side sections deploy with `git pull` plus a daemon reload.

**Strengthen the skill description instead.** Rejected: the description was already model-visible in every session throughout the collapse, so a stronger line faces the same decision-moment recall failure it just failed.

**Give subtask children the conventions section too.** Rejected for the skillify offer: it addresses the user, and subtask children surface findings through their parent session — matching the existing plain-only tier of the curiosity and closing-card conventions.

## Consequences

Plain sessions carry ~1450 characters of conventions plus ~360 characters of TDD default; subtask children carry the TDD default alone; chatroom personas replace the system prompt wholesale and get neither, matching their existing treatment of the conventions. Coding-behavior coverage matches the retired global instructions file; chatroom roles lose nothing they had (bare personas already suppressed instruction injection).

Re-measurement criterion: red-green-loop language in deepseek-harness coding sessions should recover toward the 66% pre-migration baseline within a week of deployment. Scan methodology: `zstdcat` line-level regex over `assistant/message` events in the feishu-bridge session store, sessions split at the 2026-08-24 10:21 migration commit, coding sessions (≥1 grep/read/edit/write/glob/bash/lsp tool call) as denominator. Two methodology gotchas: resolve session directories by glob before decompressing (a truncated session id makes `zstdcat` fail silently to empty output), and filter out the mem0-slug render sessions from any per-session count.
