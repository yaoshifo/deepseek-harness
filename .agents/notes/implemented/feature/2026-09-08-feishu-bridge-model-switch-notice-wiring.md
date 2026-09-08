# Agent Note: Feishu bridge wires the upstream model-switch notice into session setup

Status: implemented

English | [中文](2026-09-08-feishu-bridge-model-switch-notice-wiring.zh.md)

## Problem

A hot provider switch (`/provider switch --resume`, the card's default mode) keeps the session id and resumes the transcript on the new route, but the new model received no attribution for assistant turns written by a different model. The bridge's user-side feedback (switch receipt, the 🤖 footer line) already covered the user; upstream's `installModelSelection` (PR #3507) closed the model side, and the bridge composition never installed it, so the notice never fired in the daemon. Upstream's motivating failure applies directly: a vision model reading a text model's image-omission placeholders attributes the limitation to itself.

## Decision

`DshAgentAdapter.startSession` wraps its session setup chain with a `withModelSelection` layer that installs `installModelSelection` with the session's effective route (`routeAgentOptions(key)`, captured per start) as the live selection. The first request on the new model carries a model-visible `[model changed: ...]` user-role notice; it is `source.kind: 'plugin'`, which chat rendering and the recent-turns window already exclude, so Feishu chats stay noise-free.

## Mechanics

- Provider and model flow straight through the selection; `reasoningEffort` converts through the `ReasoningEffortId` brand constructor. Sessions without a resolved route keep `current` unset, leaving request config to the loop's own resolution.
- The bridge's effort is project-level and rides every route (the 2026-08-30 effort-label fix), so the listener's strip-and-restamp of the request effort is behavior-neutral in every expressible configuration: both routes carry the same effort or neither does.
- Plain switches drop the session, so no resume means no notice; same-route resumes match the persisted request header and stay silent.

## Alternatives considered

- Pin the notice into the engine's message pipeline (synthesizing a visible bridge message on switch): rejected — the gap is model-side, and the bridge deliberately keeps plugin-source notices out of chat rendering.
- Extend the config with per-route effort and consume the listener's route-as-authority semantics: rejected — per-route effort does not exist in the bridge config surface, and adding it is a separate product decision, not wiring.

## Consequences

- After a hot switch the new model knows the transcript's model provenance; the notice costs ~30 retained tokens per real route change and lands at the history tail, leaving the prefix cache untouched.
- Hand-rolled adapter test contexts gained the `on` member their `DshContextLike` slice always required (`adapter-mcp-mask`, `adapter-persona`); REAL-composition coverage lives in `tests/agent-dsh/model-switch-notice.spec.ts` (notice after switch, silence on same-route resume, project effort preserved). The mock LLM must declare its reasoning efforts or the runtime rejects the effort-stamped request before it reaches the adapter.
- If per-route effort is ever added to the config, the listener's clearing behavior (a route without effort clears an inherited one) becomes live and needs its own product decision.
