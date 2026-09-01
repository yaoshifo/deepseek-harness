# Agent Note: Deployment-class bridge config lives in the bundle patch

Status: implemented

English | [中文](2026-09-01-feishu-bridge-deployment-class-config-in-bundle-patch.zh.md)

## Problem

After the [plan-mode migration](2026-09-01-feishu-bridge-plan-mode-guidance-in-bundle-patch.md) retired the first per-profile shim, the two live profiles still carried ~15 more behavioral rows — identical on both machines, each a hand-copied drift surface: the goal family / workflow / ralph / second-editor disables (2026-08-20, cc-connect lineage), the `tool-ask-user` and `dsh-memory` inserts, the `system-prompt` identity suppression, and the `agent-instructions` CLAUDE.md candidates. Any future change to these rows must be re-copied into each machine's profile; the plan-mode shim already demonstrated the failure (the dev profile missed the 2026-09-01 rewording).

The two-machine diff is the discriminator: rows identical across Mac and dev are deployment-class bridge behavior, while rows that differ are per-machine policy — the sandbox and permission presets differ today (`workspace-write` on Mac, `danger-full-access` on dev), proving those belong in the profile.

## Decision

Six groups move from the profile patch into `packages/acp/feishu-bridge/cordis.patch.yml`:

- The goal family (domain, round driver, `/goal` command, tool — disabling only the tool row would leave `/goal`-created goals with no tool to close), workflow, and ralph disables: low-frequency orchestration whose schemas cost request context every turn.
- The `tool-str-replace-editor` disable: the session editor is `dsh-tool-fs`'s edit; dsh-base still mounts the row, and the same [single-editor decision](../simplification/2026-08-10-default-presets-single-editor.md) keeps it out of the general-purpose presets.
- The `tool-ask-user` insert: the ask-card / user-questions machinery has no dsh-base row, so every bridge composition needs it.
- The `dsh-memory` insert with index limits (25600 per-session, 8192 global): the session memory surface is part of the bridge product experience.
- `system-prompt` `includeHarnessIdentity: false` (bridge sessions carry their own identity/persona injection); `persona: ''` repeats base's value because patch config is key-replacement.
- `agent-instructions` CLAUDE.md / CLAUDE.local.md candidates (the Claude Code-compatible convention); `maxBytes` repeats base's value.

Inserted rows must appear in the resolver manifest's dependencies, so `@deepseek-ai/dsh-tool-ask-user` and `@deepseek-ai/dsh-memory` joined the bridge package's dependencies. `tests/bundle-patch.spec.ts` pins all six groups through the real `applyEntryPatches` composition (rows present or disabled, config values exact).

What stays in the profile, deliberately: `sandbox-policy` and `permission` (machines differ today — ops policy, not product behavior), the `llm-pi-ai` route, `session-persistence-jsonl` paths, the `feishu-bridge` row (bot credentials, engine tuning), the MCP and lsp inserts (tokens, URLs, absolute binary paths), the `tool-web` disable (coupled to per-machine MCP presence and key availability), and `skill-filesystem`'s `customSkillDirs` (a machine path).

## Alternatives considered

- **Keep hand-syncing the rows.** The drift class the migration removes; the dev plan-mode miss is the recorded instance.
- **Migrate the sandbox/permission presets too.** Wrong direction — the two machines run different values on purpose; a bundle-level default would fight the profile override instead of replacing hand-copies.
- **A profile-inheritance or templating mechanism so profiles could share rows.** The bundle layer already is that mechanism: later bundles override earlier rows by id, link-mounted packages update on pull + `/reload`, and the composition spec gates the shared copy.
- **Leave `tool-web` disabled in the bundle.** The disable's reason is machine state (no direct provider key; the MCP pair provides the wired web path); a bridge deployment without that MCP pair would lose web access entirely.

## Consequences

- A fresh bridge deployment gets the lean tool roster and the full question/memory machinery by default; profiles shrink to true per-machine config (credentials, paths, model routing, ops policy).
- Rollout keeps the plan-mode ordering constraint: pull the linked package before deleting the profile rows, or the daemon falls back to dsh-base defaults until the next reload.
- The `pnpm install` that added the two dependencies deduped `content-type` from 2.0.0 to the already-present 2.1.0 for `body-parser`/`type-is` in the lockfile — a benign normalization recorded here so the lockfile diff needs no second reading.
