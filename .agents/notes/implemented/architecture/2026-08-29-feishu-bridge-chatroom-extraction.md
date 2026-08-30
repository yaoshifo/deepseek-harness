# Agent Note: the chatroom feature extracted into the feishu-bridge-chatroom package

Status: implemented

English | [中文](2026-08-29-feishu-bridge-chatroom-extraction.zh.md)

## Problem

The chatroom feature (role groups, the moderator, the `/chatroom` command family, the `feishu_bridge_chatroom` tool, its i18n keys, its skill, and `ChatroomConfig`) lived inside `packages/acp/feishu-bridge`: every chatroom change touched bridge internals, and the bridge carried a product feature with no extension contract. The extraction moves all of it into `@deepseek-ai/dsh-feishu-bridge-chatroom`, mounted beside the bridge, with the dependency direction chatroom → bridge and zero behavior change. [C1](2026-08-27-feishu-bridge-chatroom-service-events.md) had already routed every coupling point through the `feishuBridge/*` dispatch seam; C2 is the complete cutover — code and configuration move in one batch, so no intermediate state has the feature unconfigured or the bridge reaching back into the plugin.

## Decision

The chatroom product faces live in the sibling plugin; the bridge owns only the generic seams they ride.

- **Moved**: the eight engine modules (`chatroom.ts`, `chatroom-pick.ts`, `chatroom-cmd.ts`, `chatroom-persona.ts`, `chatroom-priming.ts`, `chatroom-ledger.ts`, `chatroom-roles.ts`, `chatroom-policy.ts`), the `feishu_bridge_chatroom` tool, the moderator skill directory, and the i18n subtable, plus the twelve chatroom specs. Plugin-side additions own what the engine used to carry: `chatroom-state.ts` (per-session live state), `chatroom-config.ts` (the engine configuration store), `i18n.ts` (the subtable), and the `apply` entry.
- **The bridge keeps**: the fifteen `feishuBridge/*` event declarations and their dispatch through `FeishuBridgeService` (the plugin's `chatroom-policy.ts` registers a listener for every one of them); `Engine.registerCommand` / `Engine.registerCardAction` as reversible registration seams; the opaque `Session.featureState` section with its codec registry; and the `./exports` subpath — the narrow supported import face (service and dispatch types, routing types, shared engine symbols, platform capability casts, registration helpers), never the whole `Engine` class.
- **The plugin's `apply`** registers the process-level halves first (the feature-state codec and the i18n subtable must be live before the first save or lookup), then the policy listeners and the tool; after `service.whenReady()` resolves it validates its project names against the bridge's live projects and sweeps every engine — configuration and barrier recovery for every engine (recovery also runs for engines gated off; it drains chatrooms armed before the gating), and command registration for the enabled ones (a project configured `enabled: false` is gated off entirely — see the [per-project gating note](2026-08-29-feishu-bridge-chatroom-per-project-gating.md)). The bundled skills mount after the sweep, cwd-scoped to the enabled projects' workdirs.

### Snapshot v3 and the featureState codec

`sessions.json` moves to version 3: plugin feature state persists under one opaque `featureState` object on each session entry, and the chatroom's seventeen durable fields nest one level below their version-2 flat names inside `featureState.chatroom`. Loading is a chained in-memory migration: a version-1 file (Go snake_case) maps to the version-2 camelCase shape, whose flat chatroom fields the loader lifts verbatim into the section; the first save rewrites the file as v3. The rewrite is one-way, so the pre-v3 file is backed up once to `<storePath>.v2.bak` (an existing backup keeps the earliest original — a rollback reads it), and a snapshot version newer than the build's fails loud at load instead of being parsed as garbage.

A `FeatureStateCodec` owns one section key: `encode` projects the section on save (undefined means the key is omitted), `carry` moves the reset-surviving subset onto the successor record inside `carryChatScopedState`. Sections without a registered codec pass through verbatim both ways — the bridge treats them as opaque.

### Configuration migration

`ChatroomConfig` (bridge-level `[chatroom]` sections, engine setters, `wireChatroom`) became the plugin's own `Config`: `defaults` plus a `projects` map keyed by bridge project name. The two project lists are parallel fact sources guarded in both directions: a chatroom project name with no matching bridge project fails at plugin load, and a residual `chatroom` key in the bridge's own config (top-level or per-project — the typical symptom of a production `cordis.patch.yml` whose migration snippet was not merged) fails at bridge load. The residue keys stay in the bridge schema as `Schema.any` precisely because schemastery strips unknown keys silently: without them the residue would vanish instead of failing loud.

## Alternatives considered

- **Keep the chatroom fields on `Session` with typed getters and inline barrier handles.** Rejected: the barrier handle types live in the plugin, so `session.ts` would import the chatroom package — the reverse dependency the whole extraction exists to remove.
- **Declare a survive-reset key set on the codec instead of a `carry` hook** (the extraction plan's original decision-3 wording). Rejected: armed barriers are live `ChatroomGather`/`ChatroomEndBarrier` instances held per-session in the plugin, and the plugin's live state hangs off a module-level WeakMap — a key list names durable section keys only and cannot move process-local instances. The hook also keeps the bridge from interpreting section internals: carrying is feature code, the section stays opaque.
- **Bridge keeps `ChatroomConfig` and forwards it to the plugin.** Rejected: forwarding recreates the reverse dependency, and splitting the config move from the code move would leave a batch boundary where chatroom runs unconfigured.

## Consequences

- **Pre-readiness window**: messages a platform delivers between the bridge's engine start and the plugin's `whenReady()` sweep run with default-valued chatroom configuration — a window the in-bridge wiring did not have. It is structural to the sibling-plugin mount order (the package README records it); recovery and every later turn see the swept configuration.
- **Unloading the plugin loses in-memory chatroom state** (armed barrier instances, in-flight flags, gather-round stamps); the durable section survives, because the plugin's accessors write `session.featureState.chatroom` in place — a codec-less save persists it verbatim. Restart barrier recovery rides the persisted snapshots, not the instances.
- The bridge's `src/` keeps exactly the chatroom mentions the seams require: the seventeen version-2 legacy field names (lifted verbatim, never interpreted), the config residue guards, the version-1 legacy spellings, and comments naming the sibling plugin where the seam contract needs the example. Everything else was neutralized to feature-level wording.
- Production deployment still carries `[chatroom]` sections under the feishu-bridge row in self-evolved profile `cordis.patch.yml` files; until the C3 batch ships the migration snippet and profile-template updates, migrating those is manual (the bridge fails loud on the residue, so it cannot be missed).
