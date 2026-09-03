# Agent Note: feishu-bridge usage providers never learned the active provider name

Status: implemented
Archived: 2026-09-03

English | [中文](2026-08-22-feishu-bridge-usage-provider-active-sync.zh.md)

## Problem

The cc-connect port carried the usage-provider domain over — `engine/usage.ts` with the GLM and MiniMax providers, and the ⌛ quota line rendered as the completion card's collapsible-panel title — yet configuring `usageProviders` in a deployment profile produced no visible change. Both shipped providers gate their summary behind the optional active-detection capability (GLM: route name `startsWith('glm')`; MiniMax: exact match), and the ported engine never called `setActiveProvider` on anyone. With the name never set, `isActive()` was permanently false, so `buildCompletionUsage` skipped every provider and the ⌛ line never rendered.

Go cc-connect syncs the name in four places the TS port did not carry: `SetUsageProviders` after wiring (`core/engine.go`), plus the switch-new, flip, and switch-resume paths (`core/engine_provider.go`).

## Decision

One engine method, `syncUsageProvidersActive()`, reads the adapter switcher's current active route name and pushes it into every usage provider exposing `setActiveProvider` (structural check, the same shape as `status-footer.ts`'s `MaybeActiveDetector`). `setUsageProviders()` calls it after assignment as the initial seed, and the four active-route change points in `provider-commands.ts` — switch, switch `--resume`, shortcut, and clear — call it immediately after `applyActiveProviderContextWindow()`, symmetric with that existing re-resolution hook. Clear propagates `''`, which correctly disables every detector.

Deployment side: the live profile gained a `usageProviders` row (type `glm`, region `cn`, `api_key` resolved from the systemd unit env via `!!js process.env.FB_GLM_API_KEY`), and the bridge route key `turbo` was renamed `glm-turbo` because GLM's gate matches the route-name prefix — a `turbo` route pointing at the same GLM gateway would otherwise hide the quota line.

## Alternatives considered

**Replicating Go's per-site loops (four inline iterations over the provider list).** Same behavior; one named method keeps each call site one line and shares the initial seed with the switch paths.

**Dropping the active-detection gate (always show every configured provider).** Would show the GLM quota line while the minimax route is active — exactly the cross-provider confusion the gate exists to prevent.

## Consequences

The ⌛ line is reachable, and switching routes moves which provider's summary appears on the next completion. Route names now carry vendor prefixes where a usage-provider gate needs them (`glm`, `glm-turbo`); that is a deployment naming convention, not code.

## Testing

`tests/engine/provider-commands.spec.ts` ("usage provider active sync"): a detector stub recording `setActiveProvider` calls. The red run showed no call ever made — neither the initial seed nor any switch path; the green run asserts the seed on `setUsageProviders`, the ⌛ `providerMsg` gating (shown with `glm` active, hidden with `minimax` active), and re-sync across switch, `--resume`, shortcut, and clear. Full feishu-bridge suite: 2036 green.
