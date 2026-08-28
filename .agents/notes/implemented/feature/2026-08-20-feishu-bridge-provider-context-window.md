# Agent Note: per-provider context_window wiring (#12)

Status: implemented

English | [中文](2026-08-20-feishu-bridge-provider-context-window.zh.md)

## Problem

The M7-b usage domain landed the ctx-percentage consumer (the status footer's SDK token accumulation) and the engine method `applyActiveProviderContextWindow` (the port of Go `engine_provider.go`), but the value it re-resolves was always the project-level fallback: the plugin `ProviderRoute` schema had no `contextWindow` field, and the adapter's `getActiveProvider()` returned name-only configs, so `active?.contextWindow` was always undefined. Go also re-resolves the window after every provider switch (engine_provider.go's `switchProvider`/`switchProviderResume`/`cmdProviderShortcut` and the card-switch path); the TS port called it once at assembly time. Consequence: after `/provider` switched to a model with a different window, the footer's ctx% kept dividing by the old window. The FEATURE-PARITY.md re-check (2026-08-20) recorded this as the #12 ceiling; this change removes it.

## Decision

Wire the Go `ProviderConfig.ContextWindow` chain end to end. `ProviderRoute` (plugin config) gains `contextWindow?: number`; `buildProjectAssembly` forwards it onto the adapter route; `DshAgentAdapter.getActiveProvider()` includes it when set (conditional spread under `exactOptionalPropertyTypes`, and the JSDoc's "name-only" wording updated). Every provider-switch site in `provider-commands.ts` — `switchProvider` and the provider-card action (both through the shared core `applyProviderSwitch`), `switchProviderResume`, the `clear` subcommand, and `cmdProviderShortcut` — calls `e.applyActiveProviderContextWindow()` immediately after a successful `setActiveProvider`, before the interactive-session cleanup, matching Go's ordering. Routes without their own window and a cleared selection fall back to `projectContextWindow` (project `contextWindow`, default 200k), unchanged.

## Alternatives considered

**Derive the window from the llm service route's model metadata at switch time.** Rejected: the profile's model rows already carry `contextWindow` for the llm service, but the bridge deliberately keeps route detail in its own config (the adapter owns only membership and the active pointer); reaching into llm-provider internals from the bridge would couple two packages for a value the operator can state in one config line.

## Consequences

A route that declares `contextWindow` now drives the ctx% denominator from assembly time and after every switch, so multi-window fleets (e.g. 1M-window GLM vs 128k routes) report honest percentages. Configurations without the field behave exactly as before — the fallback chain is untouched. The live daemon needs no change until an operator adds the field to a route; the existing "/provider dual-route switch" daily-verification item covers the real-device check (watch ctx% change after a switch between routes with different windows).

## Testing

`tests/engine/provider-commands.spec.ts` (stub switcher extended with per-route windows): switch onto a windowed route, switch back (project fallback restored), clear (fallback), shortcut and `--resume` both re-resolve. `tests/agent-dsh/adapter.spec.ts`: `getActiveProvider` exposes the route window only when set. `tests/assembly-config.spec.ts`: the active route's window wins over the project window and reaches the adapter. Full package suite 1843 green; package typecheck and the new-file lint clean.
