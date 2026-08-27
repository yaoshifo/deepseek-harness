# Agent Note: feishu-bridge dual-bundle module split moves process-global registries to globalThis

Status: implemented

English | [中文](2026-08-27-feishu-bridge-bundle-split-registries.zh.md)

## Problem

Right after the C2 chatroom extraction reached production, the chatroom topic-pick card rendered raw i18n keys (`chatroom_topic_pick_title` and siblings). The same root cause silently broke two more registries: the featureState codec registration (armed-barrier snapshot persistence and the `/new` carry semantics stopped running) and the tool-family tag-color declaration.

## Decision

The root cause is the build layout, not the registration mechanism: the package's tsdown config deliberately emits three self-contained runtime bundles (the plugin entry `lib/index.js`, `lib/invariant.js`, and the `./exports` sibling-plugin face `lib/exports.js` — no shared chunks to publish). The module-level mutable registries in `src/i18n/index.ts`, `src/engine/feature-state.ts`, and `src/streaming.ts` therefore exist once per bundle: a sibling plugin (the chatroom package) registers through the `./exports` copy while the engine reads its own bundle's copy — two registries that never meet.

The fix moves the registry **state** onto `globalThis` symbol slots (`__DSH_FEISHU_I18N_SUBTABLES__`, `__DSH_FEISHU_CODECS__`, `__DSH_FEISHU_TOOL_FAMILIES__`; precedent: client/connection's `__DSH_TRANSPORT__`), so every bundle copy reads and writes the same slot. The module-function API is unchanged and the chatroom package needed no edits.

## Alternatives considered

- Routing registrations through `FeishuBridgeService` methods (the cordis instance passes across bundles by construction): also correct, but it rewrites the exports face, the package apply, and a batch of tests, and the module-level registration functions on `./exports` would remain a trap for later consumers. Global slots make both copies agree with the smallest diff.
- tsdown shared chunks: contradicts the package's deliberate self-contained-bundle design and widens the published files list.

## Consequences

- Source-plane and artifact-plane behavior now agree: source-plane tests (tsconfig `paths`, single module instance) no longer observe a different world than production (two bundles).
- Regression guard: `packages/acp/feishu-bridge/tests/built-bundle-registries.spec.ts` consumes the built artifacts (self-skips on a clean tree; CI reaches it after build) — registrations through the exports bundle must land on the global slots, and both bundle files must reference the same slot names.
- Process rule going forward: **cross-package singleton state never lives at module level** — any multi-entry self-contained package duplicates modules; registration-style capabilities go through a cordis service instance or an explicit globalThis slot. A source-plane REAL-composition test does not substitute for an artifact-plane composition test.
