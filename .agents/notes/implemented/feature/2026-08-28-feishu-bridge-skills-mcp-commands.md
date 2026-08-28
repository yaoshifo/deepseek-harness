# Agent Note: TS-native /skills and /mcp capability-inspection commands

Status: implemented

English | [中文](2026-08-28-feishu-bridge-skills-mcp-commands.zh.md)

## Problem

Users had no in-chat way to see what the current process loaded. The skill catalog exists only as the model-facing `<available_skills>` publication, and MCP servers are observable only through their `mcp__*` tool names — so the only inspection path was asking the bot, which costs a model turn, and bare-persona/render sessions (which deny the `skill` tool) cannot answer at all. `/status` reports neither surface.

## Decision

`src/engine/skills-mcp-commands.ts` registers two read-only commands through the `Engine.registerCommand` seam (help group `tools`, ≥2-char prefix match), taking a narrow `SkillsMcpCommandDeps` of data closures wired in `buildProjectAssembly`: `listSkills` (absent when `ctx.get('skills')` is undefined — the command replies "unavailable" instead of throwing), `toolNames` (process-global `ctx.tools.schemas()` names, the same read as the mcpHealth runtime context), optional `healthServers` (the `mcpHealth` config), and optional `allowlist` (project `mcpServers`).

`/skills` renders the skill registry's invocation-neutral `list({ cwd })` for the chat's work dir (the same discovery base providers use), capping descriptions at 80 runes and marking non-model-invocable entries as command-only. `/mcp` groups `mcp__<server>__*` names by splitting on the first `__`, marks health-watched servers with no live tools as degraded, and marks live servers outside the project allowlist as hidden; tool names cap at 8 per server with a `+N` marker.

Naming: Go cc-connect never had a `/skills` command (the 2026-08-21 audit struck it as a doc typo), so both commands are TS-native additions like `/reload`, not ports; the 2026-08-21 command-curation ruling is untouched.

## Alternatives considered

**Engine setter injection** (the `setCronScheduler` pattern): rejected — the commands hold no engine state, they only read per-assembly closures; deps-at-registration matches the chatroom seam.

**Session-scoped listing** (the live agent's own catalog view, including its runtime registrations): deferred as a documented ceiling — `/skills` answers from process-level discovery for the chat's work dir, and reaching the agent's `ScopeKey` would couple the engine to adapter internals for marginal fidelity.

## Consequences

`/help` lists both commands under the tools group automatically (generated from the registered handlers). i18n gains 13 en+zh keys appended in the reload-key style. Both views state their ceilings in their usage text: `/skills` is the discovery view, not the live agent's scoped catalog; `/mcp` is the process-global tool registry, with per-project masking marked rather than enforced.

## Testing

`tests/engine/skills-mcp-commands.spec.ts` (10 cases): table merge + tools group + resolver priority, unavailable/empty/populated `/skills` (command-only marker, 80-rune cap, cwd pass-through), grouped/masked/degraded/empty `/mcp` (8-tool cap, unparseable names create no group), ≥2-char prefixes with 1-char fallthrough, card-vs-text platform split, and dispose restoring the resolver.
