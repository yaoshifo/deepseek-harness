# Agent Note: feishu-bridge provider card (#9 card surface)

Status: implemented

English | [中文](2026-08-28-feishu-bridge-provider-card.zh.md)

## Problem

The `/provider` family (M7-c) answered every surface with plain text: the bare command printed a route list with a ▶ marker and asked the user to retype `/provider switch <name>` — the interaction Go's provider card had replaced with one tap per route. MIGRATION.md deferred the card to the render domain; meanwhile the engine's generic card-action registry (`Engine.registerCardAction`) had shipped for feature pickers with zero production consumers, so the deferral also left that path unproven outside its unit tests.

## Decision

Card platforms (`supportsCards`) render the bare `/provider` as the provider card (port of Go `renderProviderCard`, engine_provider.go): an indigo card with the current-route line, one `listItemBtn` row per route (`▶`/`◻` + name + optional model in backticks) whose button carries `act:/provider <name>`, a hint line (tap = new session; the `-r` hot-switch stays text-only), and a back button. A pressed row runs through `registerCardAction(['/provider'])` registered by `registerProviderCommands`: a non-empty arg is a plain switch through the same `applyProviderSwitch` core the text command uses (setActiveProvider → context-window re-resolve → usage-detector sync → agent-session id drop → persistence), and the engine PATCHes the returned card in place; a failed lookup (a stale card after the route table changed) re-renders with the not-found notice instead of switching. The help card's provider row opens the card in place (`nav:/provider`, no args → render only). Both prefixes share one handler because the card owns every action value it emits: any producer of `nav:/provider <name>` would have to be added deliberately, and none exists.

## Alternatives considered

**An inline `/provider` branch in `Engine.handleCardAction`, beside `/dir` and `/switch`.** Rejected: the registry exists exactly for feature card pickers, keeps engine.ts untouched (the M7 engine-hotspot discipline), and finally gives the registry path a production consumer; the act:/nav: distinction the inline branches carry is unnecessary here (see Decision).

**Hot-switch (`--resume`) buttons on the card.** Rejected: doubling every row for a rarely used variant; the hint names the text command instead, and Go's card likewise offers only the plain switch.

**Go's NeedNew hint wording.** Not carried over: the TS switch already drops the agent session id, so the next message starts fresh on the new route without `/new`; the card hint states the actual semantics (tap = new session).

## Consequences

Switching is one tap on Feishu and the pressed card becomes the outcome view (switched notice + moved ▶ marker) instead of a fresh text message; text platforms and the list/current/clear subcommands are unchanged. Clicking the already-active route re-runs the switch (agent session id dropped again) — deliberate parity with `/provider <current-name>` and the /dir card's re-select. The plain-switch side effects now have two entry points sharing one core, so future switch-semantics changes land in `applyProviderSwitch` once. The registry path is proven in production; a card action arriving after `registerProviderCommands` disposal falls through silently like any unknown action (HMR safety). Persistence across a card switch rides the existing providerSaveFunc → project-state chain, unchanged.

## Testing

`tests/engine/provider-commands.spec.ts`: the bare command renders the card (rows, ▶ marker, act: values, model backticks) and sends no text; a pressed row switches, drops the session id, persists, and PATCHes in place with the moved marker and switched notice; an unknown route keeps state and shows the not-found notice; `nav:/provider` renders without switching; disposal removes the action. `tests/assembly-misc.spec.ts`: a card action on the assembled engine flips the adapter's active route (registration → registry → adapter chain, on an isolated temp root so the persisted switch cannot leak into the shared-default-root assemblies). Full package suite 2548 green.
