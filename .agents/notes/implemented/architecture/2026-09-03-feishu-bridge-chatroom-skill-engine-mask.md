# Agent Note: the chatroom moderator skill masked per engine on disabled projects

Status: implemented

English | [中文](2026-09-03-feishu-bridge-chatroom-skill-engine-mask.zh.md)

## Problem

The 2026-09-03 oc_0ace probe: a chatroom-disabled project's spawned group carried a workspace override pointing at another project's workdir, `/chatroom` fell through to the agent as free text, and the model loaded `feishu-bridge-chatroom-moderator` from its session catalog and started following it. The three gates had mismatched scopes — the command family and the tool are per-engine (`denyTools`), but the bundled skill's visibility is the provider's `cwdPrefixes`, which cannot see engine identity. Any session whose workdir lands under an enabled project's workdir (spawn workspace overrides, per-chat `/dir`) matches the prefix and sees the entry. The tool's execute gate contained the damage (the chatroom could not start), at the cost of a misleading reply and a burned turn.

## Decision

Complete the skills capability seam symmetric to the tools registry.

- **`SkillRegistry.restrict({ allow?, deny? })`** (dsh-skill): scope-layer restrictions intersect over inherited names across the viewing scope's chain, while the exact scope's own registrations stay outside the filter — the tools registry's `restrict` mirrored exactly, including the unscoped-context throw and the empty-filter throw. Names validate against the skill-name grammar only: availability is cwd-dependent, so a denied name matching nothing under some workdir is inert there (the tools registry validates against its static global view; skills cannot).
- **The bridge service grows `denySkills`/`deniedSkillsOf`** beside `denyTools`; assembly wires `adapter.setDeniedSkills(() => service.deniedSkillsOf(engine))`, and the adapter's create-time setup applies the live names as a scoped `skills.restrict({ deny })` at the same two points the tool mask wraps (plain/resumed sessions, one-shots). The `/skills` listing filters the engine's denied names — the command lists by cwd without a scope, engine-blind like the provider, so it reads the same service registry.
- **The chatroom's disabled branch** registers `feishu-bridge-chatroom-moderator` beside the tool name; the provider's `cwdPrefixes` scoping stays as the enabled side's locality gate.

Cordis's traceable proxy is what makes the scope resolution work: a service read through a scoped context binds the service's `ctx` to that context, so `agentCtx.get('skills')?.restrict(...)` inside the setup callback files into that agent's layer — the mechanism `tools.restrict()` already relies on in the same callback.

## Alternatives considered

- **An adapter-local shadow registration**: register a non-invocable same-name runtime skill into the agent's layer from the setup callback — nearest-layer-wins plus the catalog's `isModelInvocable` filter would hide the entry with zero core-package changes. Rejected: it borrows the registration path as a mask, rides the runtime-duplicate warning machinery with a fake entry, and every future consumer re-invents it; the tools registry having `restrict` as a first-class seam is the precedent for completing the seam instead.
- **Filtering inside tool-skill** (the catalog consumer) from a per-session denied list in session options: couples the generic consumer to bridge-specific wiring, and the `skill` tool's execute path needs the same list duplicated — the registry lookup is the one point both paths share.

## Consequences

- The oc_0ace shape is closed end to end: the real Loader composition boots the factory pair (dsh-llm + dsh-agent-loop) and creates a session through the gated project's adapter at the enabled project's workdir, asserting the agent-scoped view has no moderator skill while the unscoped view at the same cwd keeps it. Mutation-verified: removing the chatroom registration alone turns the test red.
- Ceilings that remain: subtask children of a disabled project's sessions may still list the skill (the continuable-subagent request carries no skills hook; their inherited `toolFilter` still denies `feishu_bridge_chatroom`, so following it fails loud); the startup window is unchanged (both masks register in the same sweep, and pre-sweep sessions are contained by the execute gate); the enabled side keeps the cwd proxy (an enabled project's session switched elsewhere loses the entry but keeps the commands and tool).

## Related

- [Per-project chatroom gating](2026-08-29-feishu-bridge-chatroom-per-project-gating.md) — its decision and `denyTools` reasoning stand; this change supersedes its cwd-proxy ceiling consequence for disabled projects.
- [Chatroom extraction into its own package](2026-08-29-feishu-bridge-chatroom-extraction.md) — the sibling-plugin mount whose disabled branch now registers both masks.
