# Agent Note: feishu-bridge spawn-default provider route

Status: implemented

English | [中文](2026-09-03-feishu-bridge-spawn-default-provider.zh.md)

## Problem

Per-chat provider routes gave every existing chat its own route but left spawned groups with none: /spawn, //fork, subtask delegation groups, chatroom role groups and research assistants, and monitor subgroups are new session keys, so each resolved to the project default route (`agent.provider`) on its first turn, and children deliberately do not inherit the commanding chat's route ([per-chat provider routes](2026-09-03-feishu-bridge-per-chat-provider-routes.md)). A deployment whose main chats run the full model while spawned surfaces are research and watch groups (one chatroom research run pre-spawns dozens of role groups) could not give those groups a cheaper route without pinning each by hand after it appeared.

## Decision

The per-project field `agent.spawnProvider` names a `config.providers` route that every group this bot spawns runs on by default. Assembly validates it through the same fail-loud `providerRefError` list as the side provider references (an unknown name refuses to start; '' or absent means no default), then wires it onto `Engine.spawnProvider`.

`Engine.seedSpawnProvider(childKey)` runs at the two group-creation chokepoints, before the child's first agent turn resolves its route: `spawnGroupCommon` (shared by /spawn and //fork) and `spawnSubtask` (attended subtask groups, chatroom pre-spawned assistants including idle spawns, monitor subgroups), each right after the child session record is written. It seeds a real provider override — `setSessionProvider` on the agent switcher plus the `providerSaveFunc` persistence hook — so a seeded group behaves exactly like a chat its user pinned with `/provider`: the route survives daemon restarts and `/new`, `/provider switch` overrides it, and `/provider clear` drops the chat back to the project default route (not to `spawnProvider`; clear means "bot default", the same fallback as the workspace-dir override).

Scope (user ruling 2026-09-03): every spawn path, not only the user commands — one rule: groups the bot spawns default to the configured route while its own chats keep `agent.provider`. The child's 🤖 footer, reply footer, and `/context` model line already resolve per-session routes, so the display follows with no changes. Native continuable subtask children (unattended `feishu_bridge_subtask` spawns, no Feishu group) are not group chats: they inherit the delegating session's agent options and stay out of scope.

## Alternatives considered

**Inherit the commanding chat's route at spawn** — the seeding mechanism the per-chat note reserved. Lost: the user asked for a fixed default (a cheap route for spawned work surfaces), not propagation of whatever route the commanding chat happens to sit on; a chat pinned to the cheap route would drag its children onto it and a full-model chat would keep them expensive. Parent-route inheritance can still be added later behind the same seed call.

**Flip the project default to the cheap route and pin the main chats** — zero code. Lost: the project default also backs every chat without an override (cron runs, hub groups, every new chat), so the whole bot moves, and each existing chat then needs a hand pin that must survive restarts.

**A `/spawn --provider` flag** — mirrors `/spawn --plan`. Lost: it serves one spawn at a time and cannot reach the agent-initiated paths (subtask groups, chatroom pre-spawns, monitor) at all; a default must live in config to cover them.

## Consequences

Bought: spawned groups run the configured route (this deployment: 运维虾 `mify-flash` → `zhipuai/glm-5.3-flash`) with the project's reasoning effort, with no per-group manual pinning, and chatroom research runs bill the cheap route from the first pre-spawned assistant. Cost: the seeded entry is one `provider_overrides` row per spawned group, so the map grows with spawn volume exactly like `workspace_dir_overrides`; implementation-grade subtask groups also run the cheap route (accepted by the scope ruling — a per-path split field can be added later if delegation quality demands the full model); and existing spawned groups are not retro-pinned, only groups spawned after the config lands.

A configured name that later disappears from `config.providers` fails assembly on the next start with the shared providerRefError — it is config, checked at load, and the runtime stale-override self-heal does not apply to it.

## Testing

`tests/engine/commands.spec.ts`: /spawn and //fork seed the override and persist it through the save hook; the commanding chat keeps the project default; no value configured seeds and persists nothing. `tests/engine/engine-subtask.spec.ts`: spawnSubtask seeds the child group, idle spawn included. `tests/assembly.spec.ts`: `agent.spawnProvider` fails loud on an unknown route name ('' passes) and wires a valid name onto `engine.spawnProvider`. Full package suite green (3164 tests). Live-machine smoke pending deploy: a freshly spawned group's 🤖 line reads mify-flash while the commanding chat stays mify-dsh.
