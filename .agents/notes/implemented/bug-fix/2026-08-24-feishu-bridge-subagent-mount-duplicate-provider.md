# Agent Note: feishu-bridge delegates the subagent runtime to dsh-base and overlays settlement delivery via its bundle patch

Status: implemented

English | [中文](2026-08-24-feishu-bridge-subagent-mount-duplicate-provider.zh.md)

## Problem

`f1ce74f8a4` mounted `SubagentRuntime` (`settlementNotice: 'external'`) plus the in-process spawn/fork providers inside the bridge's `apply()`, on the stated assumption that only a profile *also* loading `dsh-subagent` would collide. But the feishu-bridge profile's first bundle is `dsh-base`, whose patch has declared the `subagent` / `subagent-spawn-in-process` / `subagent-fork-in-process` entries since `b650ab0fab` (2026-08-16). Base registers the `spawn`/`fork` providers first; the bridge's second `registerProvider` throws `DUPLICATE_PROVIDER`, the whole plugin tree fails to load, and the daemon exits — launchd's KeepAlive then crash-loops it, user-visible as "messages get no response". The defect stayed latent until `reload.sh` rebuilt the host libs on 2026-08-24 16:24 (the running daemon still had the older lib without the self-mount). `reload.sh`'s `--dump-config` preflight composes the entry list without applying plugins, so it cannot catch apply-phase collisions — at compose level each entry appears exactly once.

## Decision

The bridge no longer mounts the subagent stack; `dsh-base` owns the runtime and both providers. The bridge's `cordis.patch.yml` overlays the base entry with `- id: subagent` + `settlementNotice: external`, because the engine drives parent turns itself and the runtime's own inbox wake would spend a model request the engine never scheduled. A type-only `SubagentRunEndInfo` import restores the `'subagent/end'` event-map declaration merging that the removed value import used to carry, and replaces the hand-rolled structural listener type. `requireSubagents` now names `dsh-base` as the mounting party.

## Alternatives

**Guard the self-mount** (mount only when `ctx.get('subagents')` is absent). Rejected: conditional composition hides the profile contract and produces different topologies per profile; a missing referent should fail loud, not silently self-heal.

**Keep the self-mount and drop the subagent entries from `dsh-base`.** Rejected: base serves every profile and the entries are base's to own; the bridge is the consumer with the one config override.

**Catch `DUPLICATE_PROVIDER` and skip.** Rejected: swallowing a registration conflict masks real double-mounts elsewhere.

## Consequences

A profile that loads the bridge without `dsh-base` (or equivalent subagent entries) has no `subagents` service; `requireSubagents` fails loud with the `mounted by dsh-base` message. The REAL-composition assembly test is unchanged — it mounts the runtime itself, mirroring what base does. `dsh-subagent-fork-in-process` left the bridge's manifest (unused after the removal); `dsh-subagent` and `dsh-subagent-spawn-in-process` stay for the tests. The `--dump-config` preflight blind spot remains: it validates composition, not plugin application — a future apply-stage conflict will again only surface at daemon boot.

## Testing

Package suite: 2249 passing (the 8 pre-existing `reload-script.spec.ts` failures predate this change and fail identically on the unmodified tree). Live verification: `reload.sh` build → WS ready, single stable process, zero `DUPLICATE_PROVIDER`, and a `/new` smoke message in the test group returns the session card.
