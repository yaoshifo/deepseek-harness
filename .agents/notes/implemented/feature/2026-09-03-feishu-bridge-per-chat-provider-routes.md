# Agent Note: feishu-bridge per-chat provider routes (#9 per-session switching)

Status: implemented

English | [中文](2026-09-03-feishu-bridge-per-chat-provider-routes.zh.md)

## Problem

`/provider` switched the adapter's single project-level active pointer: every chat of the bot changed route on its next session start, so two groups wanting different models could not coexist on one bot, and a switch in one chat silently re-pointed every other chat. The switch also re-resolved project-wide derived state — the engine's context window and the usage detectors' active-name push — even though a single chat's choice has no business moving either. The deployment hit this directly: the same bot serves groups that want the GLM route and groups that want a different one.

## Decision

`ProviderSwitcher` gains `setSessionProvider(sessionKey, name)` and a session-key-aware `getActiveProvider(sessionKey?)`; the dsh adapter holds a `Map<engineKey, routeName>` whose resolution order is session override → project default (`cfg.activeProvider`, seeded at assembly from the persisted state/config) → first route. `setProviders` prunes overrides naming routes that no longer exist, and a stale override falls back to the project default. The `asProviderSwitcher` structural probe requires the new member.

`startSession` threads its already-available `options.sessionKey` into `routeAgentOptions(key)` at all four create/resume points — agentOptions were already computed per create, so nothing upstream of the adapter changes. The `/provider` family (switch/current/clear, card rows, shortcuts) acts on the commanding chat's key only; the project default pointer never moves at runtime. Persistence lives in the project state's new `provider_overrides` map (sessionKey → route name) through the re-signed `providerSaveFunc(sessionKey, name)`; a cleared entry is removed, startup seeds the adapter, and a persisted name no longer in `config.providers` warns and falls back — the same self-heal the project-level restore applies. The override key is the engine session key, so it survives `/new` (a new Session under the same chat) with no inheritance logic.

The ⌛ quota gate became per-turn: `buildCompletionUsage` resolves the completing session's effective route name and passes it into the detector gate `isActive(workDir, activeProviderName)`. The previous push mechanism — `syncUsageProvidersActive` plus each detector's stored `setActiveProvider` name — is deleted, because one pushed name cannot gate per-chat; the gate semantics themselves are unchanged (GLM matches the `glm` prefix, MiniMax matches exactly, so route names keep carrying vendor prefixes where a gate needs them). Display follows the same resolution: the 🤖 footer line, the reply footer, `/context`'s model segment, and the provider card's current line/▶ markers all take the session key. The side queries whose `''` config means "the active provider" (group naming, predict-next, turn summary, plan render, monitor triage) resolve the chat's effective route instead — every call site already held the session key.

Subtask children, chatroom-spawned groups, and cron runs resolve their own key's override — which is the project default unless that chat itself switched; children do not inherit the parent chat's route (deliberate v1 scope).

## Alternatives considered

**Store the override on the Session record (sessions.json).** Rejected: the session key is the stable chat identity across `/new`; storing on the Session record would need `/new`-inheritance semantics and touch the versioned snapshot schema, while the project state already carried the per-key map precedent (`workspace_dir_overrides`).

**Keep the project-level pointer reachable (a scope flag or a second command).** Rejected: two switching scopes in one command family is unlearnable, and after per-chat switching no runtime caller moves the project default — it stays a config/startup-owned value.

**Per-chat context-window state.** Not carried: `Engine.contextWindow` turned out to be write-only dead state (exhaustive check found no reader; the ctx%/occupancy denominators come from each session's own context snapshot), so the switch-path re-resolution calls were simply dropped rather than re-scoped.

## Consequences

Two chats of one bot run different routes concurrently, and other chats' live sessions keep the route they were created with — previously true only by accident of session lifetimes, now correct by construction. The project default route is immutable at runtime; changing it means editing config (or the persisted `active_provider`) and reloading. `state.json` gains `provider_overrides` (absent = no overrides, backward compatible); the ⌛ line, 🤖 line, and `/context` header each reflect their own chat's route. Known limitation: delegated children and chatroom groups run on the project default rather than the parent chat's route; inheritance can be added later by seeding the child's override at spawn. The context-window note's switch-path facts and the usage-sync note's push mechanism are superseded ([per-provider context_window wiring](2026-08-20-feishu-bridge-provider-context-window.md) updated in place; [usage providers never learned the active provider name](../../archived/bug-fix/2026-08-22-feishu-bridge-usage-provider-active-sync.md) archived).

## Testing

`tests/agent-dsh/adapter.spec.ts`: the resolution matrix (override → project default → other keys untouched), per-key `startSession` agentOptions, unknown-route rejection, clear semantics, `setProviders` pruning, and key-aware `getModel`/`getReasoningEffort`. `tests/engine/provider-commands.spec.ts`: per-key switch/clear/shortcut/card-row semantics, per-key persistence hook shape, the project default never moving, and the per-chat ⌛ gating. `tests/engine/project-state-shape.spec.ts`: the override map's save/reload round-trip and entry removal. `tests/engine/engine-groupname.spec.ts`, `predict.spec.ts`, `monitor.spec.ts`: the per-chat side-query fallbacks. `tests/assembly-misc.spec.ts`: the assembled chain — a card action pins one chat's route, the persisted override survives reassembly, unset chats fall back. Full package suite 2835 green; repo typecheck clean.
