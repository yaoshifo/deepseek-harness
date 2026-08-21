# Agent Note: feishu-bridge tenant tags across apps and the shared tag-cache directory

Status: implemented

English | [中文](2026-08-21-feishu-bridge-tenant-tag-cross-app.zh.md)

## Problem

Spawned groups stopped receiving the project-name tag after the cutover from cc-connect to dsh-feishu-bridge (daemon log: `ensure tag "harness": no id (code=402 msg=duplicate name in tenant)`). The ported code was faithful; the failure is environmental. Feishu tenant-tag names are unique per tenant, and the new bridge bot is a different app from the old cc-connect bot: when another app already owns the name, `im/v2 Tag.Create` answers 402 **without** `duplicate_id`, and im/v2 has no List/Get, so the id cannot be recovered by name. cc-connect survived this through its single shared sessions directory — every bot's `<project>_feishu_tag_cache.json` sat together, so `lookupSiblingTagCaches` borrowed the owning bot's id (verified: 运维虾 and 开发虾 share identical ids, and a live GET as the new app shows tags bound by the old app, so cross-app id binding works). The bridge split data into per-project directories, which made the sibling fallback structurally dead.

## Decision

`FeishuPlatformOptions.tagCacheDir` places this bot's tag-id cache in a directory the assembly shares across projects (`<dataRoot>/sessions`), restoring Go's one-directory layout for exactly the tenant-shared state. The spawned-chat registry stays per-project: it is private bot state, while the tag cache is tenant-shared state — the asymmetry is deliberate and commented at the construction site. Absent the option, the per-project `sessions` dir remains the default (tests, standalone platforms). Cutover of an additional bot additionally requires seeding its cache from the legacy cc-connect cache file, because no chat may carry a binding for the squatted name to discover from — recorded in MIGRATION.md "M8 前补充 8" for the 记账驴 cutover.

## Alternatives considered

**Data-only seeding into the per-project cache file.** Fixes one bot's instance but leaves the sibling fallback dead: any tag name created by one bridge project would be unusable by another (same 402-without-id, no sibling to consult) — the sharing regression would resurface at M8 when the second project arrives.

**Widening the discovery scan to all chats the bot is in.** Rejected: im/v2 offers no chat-tags listing API beyond per-chat relations, and a name created but never bound (the harness case) is discoverable nowhere — only a cache file holds its id.

## Consequences

Two bridge projects in one tenant resolve each other's tag ids through the shared directory, matching Go. The one-time cutover step remains per deployment (merge legacy `~/.cc-connect/sessions/*_feishu_tag_cache.json` into `<dataRoot>/sessions/`, then restart the daemon). Stale ids in the seeded cache self-heal: `applySpawnDirTag` verifies the bind by reading the relation back and re-resolves once on a miss. A tenant without the legacy squat never needs seeding — fresh creates return ids directly.

## Testing

`tests/feishu/tag-cache-share.spec.ts`: bot A's create returns an id; bot B's create returns the cross-app 402-without-id squat reply; B resolves the id through the sibling cache file, and both cache files land in the shared directory (not the per-project sessions dir). The full package suite (1874 tests) stayed green.
