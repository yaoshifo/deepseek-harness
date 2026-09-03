# Agent Note: per-provider context_window wiring (#12)

Status: implemented

English | [中文](2026-08-20-feishu-bridge-provider-context-window.zh.md)

## Problem

The M7-b usage domain landed the ctx-percentage consumer (the status footer's SDK token accumulation) and the engine method `applyActiveProviderContextWindow` (the port of Go `engine_provider.go`), but the value it re-resolves was always the project-level fallback: the plugin `ProviderRoute` schema had no `contextWindow` field, and the adapter's `getActiveProvider()` returned name-only configs, so `active?.contextWindow` was always undefined. Go also re-resolves the window after every provider switch (engine_provider.go's `switchProvider`/`switchProviderResume`/`cmdProviderShortcut` and the card-switch path); the TS port called it once at assembly time. Consequence: after `/provider` switched to a model with a different window, the footer's ctx% kept dividing by the old window. The FEATURE-PARITY.md re-check (2026-08-20) recorded this as the #12 ceiling; this change removes it.

## Decision

Wire the Go `ProviderConfig.ContextWindow` chain end to end. `ProviderRoute` (plugin config) gains `contextWindow?: number`; `buildProjectAssembly` forwards it onto the adapter route; `DshAgentAdapter.getActiveProvider()` includes it when set (conditional spread under `exactOptionalPropertyTypes`, and the JSDoc's "name-only" wording updated). The switch-path calls to `applyActiveProviderContextWindow()` (added here for Go parity) were later removed by [per-chat provider routes](2026-09-03-feishu-bridge-per-chat-provider-routes.md): a per-chat switch does not move the project pointer, so there is nothing to re-resolve. Routes without their own window and a cleared selection fall back to `projectContextWindow` (project `contextWindow`, default 200k), unchanged.

## Alternatives considered

**Derive the window from the llm service route's model metadata at switch time.** Rejected: the profile's model rows already carry `contextWindow` for the llm service, but the bridge deliberately keeps route detail in its own config (the adapter owns only membership and the active pointer); reaching into llm-provider internals from the bridge would couple two packages for a value the operator can state in one config line.

## Consequences

`Engine.contextWindow` is currently write-only state: an exhaustive check (2026-09-03) found no reader — the ctx%/occupancy denominators come from each session's own context snapshot (the `/context` projection and the reply-footer probes), not the engine field — so the config field's only live effect is `getActiveProvider()` reporting it. The startup call (`buildProjectAssembly`) and `setContextWindow` remain; wiring a real consumer (or removing the dead field) is open. Configurations without the field behave exactly as before — the fallback chain is untouched.

## Testing

`tests/agent-dsh/adapter.spec.ts`: `getActiveProvider` exposes the route window only when set. `tests/assembly-config.spec.ts`: the active route's window wins over the project window and reaches the adapter. The switch-path re-resolution tests were removed with the per-chat change (see the superseding note). Full package suite green; package typecheck clean.
