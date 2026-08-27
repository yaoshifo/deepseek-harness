# Agent Note: feishu-bridge exposes its extension seams as feishuBridge/* events

Status: implemented

English | [中文](2026-08-27-feishu-bridge-chatroom-service-events.zh.md)

## Problem

The chatroom feature (role groups, moderator orchestration, the `/chatroom` command family) lived inline in the feishu-bridge engine: 186 chatroom references in `engine.ts`, 242 in `session.ts`, and 32 in the dsh adapter, plus direct `commandHandlers` mutation and chatroom fields on the `Message`/`QueuedMessage` protocol types. The extraction plan moves all of it into a sibling plugin package, which requires the bridge to expose every coupling point as a seam a sibling plugin can consume — while engines and adapters hold no Cordis context. Hand-rolled hook or policy-voting interfaces would not comply with the repo's event rules (interception and policy belong on typed events), and keeping the chatroom halves in the engine would force the bridge to reverse-import the chatroom package after the move.

## Decision

C1 of the extraction lands the seam itself, behavior unchanged:

- `FeishuBridgeService` (`super(ctx, 'feishuBridge')`) owns the live-project registry and caller routing (`route`/`nativeRoute`, plan D4) and *is* the dispatch face: it implements `BridgeDispatch`, the Cordis event bus narrowed to `feishuBridge/*` keys. `apply()` mounts it before any engine is built (apply is now async) and passes it to every engine constructor and adapter.
- Nine typed events carry the coupling points: `permission-policy`, `mode-policy`, `rename-exemption`, and `auto-render-policy` (waterfalls over session-start decisions), `turn-start` (serial; consumes the queue metadata), `turn-end` (waterfall; role-reply relay), `ask-approval` (waterfall returning a decision or `undefined` to fall through), `platforms-ready` (emit; barrier recovery), and `session-start-options` (waterfall mutating the shared options object). Waterfall dispatchers pass the built-in base as the innermost `next`, so a listener-less dispatch equals the pre-existing engine behavior.
- The chatroom listener halves live in `engine/chatroom-policy.ts`, registered once process-wide by `apply()` — a separate module because `chatroom-pick.ts` already imports runtime symbols from `chatroom.ts`, and putting the registration there would close an import cycle.
- Engines and adapters constructed outside a Cordis tree (unit tests) default to `bareBridgeDispatch()`: no listeners, built-in bases run, emits drop. Tests that exercise chatroom behavior wire `ctxBridgeDispatch(new Context())` with the policy listeners registered (the production composition).
- The `Message`/`QueuedMessage` chatroom protocol fields became one opaque `metadata` bag owned by the feature that sets its keys.
- Generic seams were de-chatroomed: `GroupFamilyAvatarSetter` (was `ChatroomFamilyAvatarSetter`), `renameHubToTopic` takes an injectable topic namer, tool tag colors are declared at registration (`declareToolFamily`) instead of hardcoded tool names, and `Engine.registerCommand` owns command registration (handler + resolver matcher + help-card group) as a reversible effect.
- The supported sibling-plugin import surface is the `./exports` subpath (its own bundle; a spec resolves and pins it).

Alongside: the `packages/acp/feishu-bridge-chatroom` skeleton (release-member manifest per the current constraints gate), the generic subtask prompts split out of `chatroom-persona.ts`, and the i18n `lookupMessage` helper.

## Alternatives considered

- **Hand-rolled policy interfaces on Engine (vote/intercept methods).** Rejected: the cordis-primer rule routes interception and policy through typed events; engine-side hook objects would also recreate the reverse dependency after the move.
- **A service that only exposes routing, with events dispatched ad hoc.** Rejected: the dispatch face and the registry have one owner — splitting them leaves engines deciding per call site how to reach the bus, and the face is the natural injection point for the bare default.
- **Keep the chatroom halves inline in C1, move them in C2.** Rejected: the move is only "pure file relocation" if every branch already dispatches through the seam; C1 is deliberately the behavior-preserving half so C2 carries no inline-branch surgery.
- **Default engines to a context-bound face created lazily.** Rejected: silent context acquisition inside the engine hides the wiring; the bare default makes the no-listener case explicit and test-visible.

## Consequences

- `apply()` is async; callers (and tests) must await it — a fire-and-forget apply racing a fiber dispose surfaces as the service-mount failure, which now fails loud.
- An engine or adapter constructed in a production path without the service face silently runs with no `feishuBridge/*` listeners (every event's built-in base applies). The `BridgeDispatch` JSDoc names this; the assembly is the only sanctioned constructor path.
- Chatroom policy behavior in tests now depends on the listener registration, not the engine: bare-engine tests that previously exercised chatroom policy by construction now assert the subtask/plain bases, and chatroom specs wire the policy-listener face (`tests/stubs/bridge-policy.ts`).
- C2 continued from here and shipped: [the extraction Agent Note](2026-08-29-feishu-bridge-chatroom-extraction.md) records the move boundary, the snapshot-v3 `featureState` migration (whose survive-reset carry is the codec hook, not a key set — armed barriers are live instances), and the configuration migration.
