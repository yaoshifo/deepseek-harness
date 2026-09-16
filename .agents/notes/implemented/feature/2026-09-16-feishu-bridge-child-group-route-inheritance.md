# Agent Note: Spawned child groups inherit the parent chat's route

Status: implemented

English | [中文](2026-09-16-feishu-bridge-child-group-route-inheritance.zh.md)
## Problem

`/provider` pins a model route per chat: the override persists in the project state, survives restarts, and never moves the project default. A spawned group took its route from `agent.spawnProvider` alone, so a chat switched to another route still produced children on the fixed spawn default — or, with none configured, on the project default. A fork that copies a conversation's full context therefore ran that context on a different model than the conversation it continued, and nothing on the child's cards told the user.

## Decision

`Engine.seedSpawnProvider(childKey, parentKey)` resolves the child's route as the parent chat's effective route when that route differs from the project default, else the configured `agent.spawnProvider`. `/spawn` and `/fork` pass the parent chat's session key through `spawnGroupCommon`, so both commands inherit alike. The seeded entry is an ordinary per-chat override: persisted through the provider save hook, switchable and clearable inside the child, and cleared back to the project default rather than to the inherited route. A parent with no override — or one whose route no longer exists in `config.providers` — reads as "on the project default" through the switcher's existing fallback, so the spawn default still applies.

Unattended subtask children, chatroom role groups, and monitor subgroups keep the spawn default: `spawnSubtask` passes no parent key on purpose, because those children are workers nobody watches per chat.

## Alternatives considered

**Read the parent's raw override entry and inherit whenever one exists.** This needs a new read method on the `ProviderSwitcher` seam, and a stale entry (its route deleted from config after it was written) would try to inherit a name the child cannot resolve. Comparing effective routes reuses the switcher's existing fallback for exactly that case. The visible difference is narrow: a parent explicitly pinned to the route that is already the project default reads as "never switched".

**Inherit on every spawned-group path.** Subtask children, chatroom roles, and monitor subgroups are unattended workers; coupling their route to whichever route the parent chat happened to be switched to would move cost and capability with nobody watching that chat.

**Keep the behaviour and document it.** A per-chat switch is user intent about the work in that chat, and a fork that copies the context but not the model fails that intent invisibly — no card shows the child's route.

## Consequences

`agent.spawnProvider` now means "the route for spawned groups whose parent chat sits on the project default": a deployment that switched a chat away and expected fixed-cost children from it loses that pin for those children. Groups created before the change keep their persisted overrides, and a running daemon carries the change only from its next reload. The engine field JSDoc, the config-schema JSDoc, and the wiring comment carry the narrowed meaning. The owning spec covers inheritance on both commands, the persisted seed, the unconfigured-spawn-default case, the parent-pinned-to-the-project-default boundary, and a parent that resolves no route at all; the subtask specs pin its unchanged spawn-default behaviour.
