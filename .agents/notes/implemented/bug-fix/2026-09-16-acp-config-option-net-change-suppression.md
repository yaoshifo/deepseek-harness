# Agent Note: ACP config-option updates fire only on net state change

Status: implemented

English | [中文](2026-09-16-acp-config-option-net-change-suppression.zh.md)

## Problem

`AcpSession` publishes a `config_option_update` for every `llm/adapters-updated` that fires while armed. Arming happens when the creating `session/new`/`session/resume` response resolves, but plugin assembly is not ordered against that point: a `registerConfigurableProviders` commit — scheduled by the provider plugin's async start — lands before arming on most runs and after it on roughly one run in six (probe evidence: identical 5-event timelines across runs, with the directory commit migrating across the arming boundary on the failing run). The straggler emits an update carrying a config state identical to the creating response, and the update's position in the session's stdout depends on the race, which made the `ask-question-multi-select-variant` ACP snapshot fail intermittently (~17% locally).

## Decision

- `armTopologyNotifications(initial)` now records the creating response's config state as `lastNotified`.
- `topologyChanged()` recomputes the options, compares them against `lastNotified` by `JSON.stringify` equality (`state()` builds options with a fixed key order, so the signature is stable), absorbs an unchanged state, and records each notified state.
- Contract shift: notifications follow net config-state change, not the adapters-updated event. The window-silence test (registration during option discovery), the post-window publication test, and the recoverable-options-on-disappearance test all keep their behavior; only the no-net-change echo is new and suppressed.

## Alternatives considered

### Why not arm at first prompt admission?

Arming when the first prompt is admitted would absorb every assembly-time straggler outright. It also absorbs genuine topology changes a client should see between session creation and its first prompt, which contradicts the shipped contract test that requires a post-window registration to notify before any prompt.

### Why not filter dispose-sourced events?

The straggler on the failing runs was a registration commit, not a dispose, and the recoverable-options contract test requires disappearance (a dispose-sourced event) to notify. Source-based filtering misses the race and breaks the contract on both ends.

### Why not a second stdout snapshot variant?

The snapshot suite supports multiple expected stdout variants, and recording the racy shape as a second variant would make the test pass. That bakes the product's timing leak into two goldens and hides the defect the transcript was showing; it is flake-masking, not a fix.

## Consequences

- A topology event whose recomputed state equals the last notified state no longer notifies — including legitimate refreshes that land on identical content. ACP clients consume state, not events, so an identical refresh carries no information; this is the accepted trade for racy-time leak removal.
- Assembly-time registrations racing the arming point can no longer surface in the session transcript, regardless of scheduling.

## Testing

- The regression `suppresses topology notifications that leave the config state unchanged` fails on the pre-fix code (2 updates) and passes after (1, the state-changing registration only).
- The acp bridge/updates/model-control/multi-session/dispose suites pass (78/78); the previously flaky snapshot scenario passes 20/20 post-fix (17% failure rate pre-fix).
