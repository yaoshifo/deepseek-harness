# Agent Note: feishu-bridge auto-mounts its bundled skills as an isolated provider

Status: implemented

English | [中文](2026-08-24-feishu-bridge-bundled-skills-mount.zh.md)

## Problem

The package ships `skills/` — the bridge-specific skills (`feishu-bridge-subtask`, `feishu-bridge-chatroom-moderator`, `feishu-bridge-render`) plus the deployment's working-style skills (`tdd`, `skillify`) — but nothing in the plugin made them reachable. Every deployment had to list the package path in its live profile's `skill-filesystem.customSkillDirs`, and the omission was silent: the dev server's profile (and even the repo's own `profile/cordis.patch.yml` template) never carried the entry, so all nine dev bots ran without the subtask/chatroom skills while their hint buttons still advertised `/tdd` and `/skillify`. The hand-wired path is also structurally fragile: it is absolute and machine-specific, and because patch-layer config replaces keys wholesale, any later `customSkillDirs` edit can silently drop it again.

## Decision

`apply()` in `packages/acp/feishu-bridge/src/index.ts` mounts a second, isolated skill-filesystem instance through `mountBundledSkills()`:

- `ctx.plugin(SkillFileSystem, { providerName: 'feishu-bridge-skills', includeDefaultRoots: false, customSkillDirs: [<package>/skills] })`. The isolated provider sees only its explicit root — the `includeDefaultRoots: false` contract skill-filesystem already documents for multi-provider deployments — so it never re-discovers project, user, or env-bundled roots.
- The directory is computed from `import.meta.url` (`dirname() + '../skills'`), so source runs (`src/`) and the tsdown-bundled `lib/index.js` resolve the same package root with zero per-deployment paths. `package.json` `files` ships `skills/` for published installs.
- The bundled root lands at the custom rank (300): project `.dsh/skills` and project `.agents/skills` entries keep their lower ranks and override same-name bundled skills, matching the registry's precedence semantics ([skill system](2026-07-05-skill-system.md)).
- The mount is a child fiber: disposing the feishu-bridge fiber (HMR reload) unregisters the provider and closes its watchers; the skills directory stays chokidar-watched, so editing a bundled skill file hot-refreshes the catalog.

Deployments keep `customSkillDirs` for user-level skill roots (`~/.claude/skills` etc.); the Mac live profile's manual package entry was removed in the same change to avoid same-name duplicate warnings between the two providers.

## Alternatives considered

**Keep hand-wiring `customSkillDirs` per deployment.** That is the status quo this note retires: the dev server proved the omission is easy and silent, and the entry must be repeated in every live profile forever.

**Reuse `DSH_BUNDLED_SKILL_DIR`.** That env var is the app-level bundled-root channel (the web app sets it); one process has a single bundled root, so a plugin staking it out would collide with the host app's own bundled skills and only work for whichever claim lands.

**A dedicated packaged provider like `dsh-skill-badge`.** The [badge decision](2026-08-06-bundled-dsh-badge-skill.md) registers one immutable skill through a purpose-built provider package. The bridge's skills are a directory of editable Markdown files that want frontmatter parsing, directory resource bases, and hot watching — exactly what skill-filesystem already provides — so composing it as an isolated instance with a distinct `providerName` reuses that machinery instead of duplicating a parser.

## Consequences

Every feishu-bridge deployment now gets the bridge skills with no configuration, and the failure mode shifts from silent omission to impossible. The skills appear under provider `feishu-bridge-skills` with source `custom`; the provider label is catalog metadata only (directory-based skills render their resource hint from the base path, so model-visible text is unchanged). Cost: the plugin gains a runtime dependency on `@deepseek-ai/dsh-skill-filesystem` (already present in every base composition), and deployments that still hand-list the package skills directory get a same-name duplicate warning until the manual entry is dropped.

## Testing

`tests/bundled-skills.spec.ts` boots a real Cordis context with the skill registry and asserts the packaged skills appear under the isolated provider, that disposing the mounted fiber unregisters them (the registry-contribution HMR-safety rule), and that a same-name registration outranks the bundled entry. Full feishu-bridge suite: 2285 passing.
