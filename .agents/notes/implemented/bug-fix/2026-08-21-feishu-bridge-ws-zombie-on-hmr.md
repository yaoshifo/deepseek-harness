# Agent Note: feishu-bridge WS zombies on HMR reload silently dropped messages

Status: implemented

English | [中文](2026-08-21-feishu-bridge-ws-zombie-on-hmr.zh.md)

## Problem

Production incident 2026-08-21 22:22 (dev server, spawned chat oc_124f): minutes after a Cordis HMR config reload added seven projects, the user spawned a fresh group via `/spawn` and sent "hi" into it — the readiness card had arrived, but the message vanished without a reaction, progress card, log line, or error. A second spawn group created and exercised before the reload worked end-to-end.

Root cause: `FeishuPlatform.stop()` was a deliberate no-op ("teardown relies on process exit"). Cordis HMR config reloads dispose the plugin and rebuild every engine; `ctx.effect` disposal runs `engine.stop()` → `p.stop()`, which closed nothing. The old platform's `WSClient` stayed connected, so after the reload the Feishu app owned **two** live long connections (old zombie + new). Feishu delivers an app's events to one of its concurrent connections, so roughly half of the app's events landed on the zombie platform, whose handler pointed at the disposed engine. The "/spawn" command happened to land on the new platform (worked); the follow-up "hi" landed on the zombie. The zombie's in-memory `SpawnedChatStore` lacked the fresh chat (registered only in the new instance's memory; the shared on-disk file is not re-read), so `isSpawned` was false and the group @-mention gate silently dropped the unmentioned message. Evidence: 9 TCP connections for 8 apps (the extra was the only pre-reload app's zombie), zero log output, the session registry untouched.

Every HMR profile edit on any deployment (dev server and the local 开发虾 daemon) produced one such zombie; intermittent message loss scales with the number of config reloads since process start. Previously unexplained real-device incidents (e.g. the spawn readiness card that never appeared) plausibly trace to the same loss.

## Decision

`stop()` now closes the WS transport: `defaultWsStart` (`packages/acp/feishu-bridge/src/feishu/platform.ts`) keeps its `WSClient` reference and resolves to a close handle wrapping `close({ force: true })`; the `wsStart` seam type widens to `Promise<void | WsClose>` so the 17 test fakes that resolve nothing keep working. `FeishuPlatform.start()` stores the handle; `stop()` consumes it idempotently (a platform that never started, or a fake without a transport, stays a no-op). Force-terminate is intentional: dispose must not wait for a graceful WS close handshake.

## Alternatives considered

**Clearing `handler` on dispose without closing the socket.** The connection would still consume one of the app's Feishu connection slots and receive events that go nowhere — the delivery split persists, only the failure mode changes.

**Reusing platforms across config reloads.** Out of proportion: the plugin's per-project assembly intentionally rebuilds engines, and the dispose chain already runs; closing the owned transport is the missing half of that chain.

## Consequences

HMR config reloads are safe again: the disposed platform's connection closes, the replacement connects, and each app holds exactly one live WS connection. The `wsStart` seam can now also be used to assert teardown in tests. Note the fix only covers the plugin's own WS clients; the SDK client's internal reconnect loop is not otherwise observable.

## Testing

`tests/feishu/platform.spec.ts` → "FeishuPlatform WS teardown": stop() closes the handle returned by wsStart exactly once (repeat stop is a no-op); stop() tolerates a wsStart without a handle; stop() before start() is a no-op. Red first (close never ran), then green with the implementation. Package suite 2045 green, oxlint/tsc clean. Real-device verification: daemon restart cleared the zombie (the re-sent "hi" in the incident chat was answered), and after the fix ships an HMR touch must leave the connection count unchanged.
