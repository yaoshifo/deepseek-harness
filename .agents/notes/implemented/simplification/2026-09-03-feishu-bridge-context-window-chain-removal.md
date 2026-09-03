# Agent Note: feishu-bridge context_window chain removal

Status: implemented

English | [中文](2026-09-03-feishu-bridge-context-window-chain-removal.zh.md)

## Problem

The per-provider `context_window` wiring shipped 2026-08-20 (this note consolidates its record) pursued Go parity for the ctx% denominator: after `/provider` switched to a model with a different window, Go's footer kept dividing by the old window, so the change wired `ProviderRoute.contextWindow` (config) → adapter route → `getActiveProvider()` → `applyActiveProviderContextWindow()` → `Engine.contextWindow`, re-resolved at every switch. The TS port never carried the consumer: an exhaustive check (2026-09-03) found **no reader** of `Engine.contextWindow` — the ctx%/occupancy denominators come from each session's own context snapshot (the dsh-context projection and the reply-footer probes), which report the model's real window. The engine field was write-only dead state, and the per-chat provider change removed the last switch-path re-resolution calls, leaving config, adapter threading, two engine methods, and three fields serving nothing.

## Decision

Remove the whole chain: `Engine.modelContextWindow` / `contextWindow` / `projectContextWindow`, `setContextWindow()` and `applyActiveProviderContextWindow()`; `ProjectConfig.contextWindow` and `ProviderRoute.contextWindow` (interfaces, schema rows, assembly forwarding and wiring); `ProviderConfig.contextWindow`; `AdapterProviderRoute.contextWindow` with `getActiveProvider()` returning name-only. Alive surfaces are untouched: the monitor config's `contextWindow` (triage message count), the session-snapshot projection windows, and the `ContextUsage` probe. Tests that only verified the dead behavior are deleted with it.

## Alternatives considered

**Wire a real consumer for the engine field.** Rejected: the session snapshot already reports the truthful per-session window, so a hand-stated config override would make the displays less honest, not more — the original problem is solved better by the data the runtime already has.

**Keep the config field as forward compatibility for a future consumer.** Rejected: the field has done nothing since it shipped, and a dead config surface invites cargo-cult lines operators believe have effect.

**Remove only the engine field, keeping config and adapter threading.** Rejected: half a chain with no consumer is the same debt spread across three more files.

## Consequences

The capability given up is the operator's hand-declared per-route context window; nothing regresses because nothing consumed it. Config lines carrying `contextWindow` under bridge projects/routes are silently stripped by schemastery as unknown keys — stale lines become inert (harmless, but worth cleaning at deploy time; the live Mac profile's bridge section carries none, and its pi-ai `models:` entries are a different, alive consumer). Reintroduction condition: a real consumer needing an operator override over the session-reported window should reintroduce it on the dsh-context projection side, not as a parallel engine field. MIGRATION.md's dated progress entries still mention the wiring as history. The consolidated 2026-08-20 note's motivation is preserved above; its triplet is deleted per the consolidation rule.

## Testing

Absence verified by grep: no `contextWindow` / `setContextWindow` / `applyActiveProviderContextWindow` / `modelContextWindow` / `projectContextWindow` outside the alive clusters (monitor triage count, snapshot projection, ContextUsage probe). Deleted the dead-behavior tests (adapter `getActiveProvider` window exposure, assembly-config window wiring, provider-commands project-window pinning). Full package suite 2838 green; the repo typecheck's only failures are the three pre-existing `followups.spec.ts` errors from the parallel merge `478507eb5e` (verified identical with this change stashed); no errors in touched files.
