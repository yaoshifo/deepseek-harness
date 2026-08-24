# Agent Note: feishu-bridge de-baggage batch 7 — session ledger on the native log

Status: implemented

English | [中文](2026-08-24-feishu-bridge-b7-session-ledger-native.zh.md)

## Problem

The bridge's session bookkeeping still carried three Go-era copies of state the native dsh session log already owns:

- `sessions.json` kept the Go snake_case field names (about 40 fields per session) plus the `past_id_tracking` / `legacy_data` machinery whose only consumer was owned-session filtering.
- Every bridge `Session` held a 100-entry in-memory history copy (`addHistory` at five engine sites, `clearHistory` at eight reset sites, persisted into `sessions.json`), consumed by token estimation, predict/turn-summary context, `/rename`, `/list` and `/status` counts, the subtask report fallback, and the spawned-group first-message check.
- `knownAgentSessionIDs` + `applySessionFilter` + `filterOwnedSessions` + the `filterExternalSessions` config flag filtered `agent.listSessions()` down to bridge-tracked sessions. Under exclusive persistence every session in the store is the bridge's own — the filter removed the bridge's own historical sessions, its only observable effect.

Two adjacent gaps: `SessionHeader` has no `updatedAt`, so `/list` ordered persisted sessions by `createdAt` (a session used for a week sorted by its birth date); and the `show_*` i18n keys for the never-ported `/show` command sat dead in the key tables.

## Decision

- **`sessions.json` version 2** is the bridge's own camelCase schema (`agentSessionID`, `subtaskDepth`, `worktreePath`, …; default-valued fields omitted; no `history`, no `past_id_tracking`, no `legacy_data`). Loading a version-1 file (Go field names, including versionless Go-era files) migrates it in memory; the first save rewrites the file as v2. The `legacyData` machinery is retired with the filter it served — a migrated file needs no legacy verdict.
- **Owned-session filtering is deleted** (`knownAgentSessionIDs`, `applySessionFilter`, `filterOwnedSessions`, the engine flag, the config key and profile-template line). `cmdList`/`cmdSwitch` consume `agent.listSessions()` directly. Child-session exclusion in `/list` is unchanged — that rides `parentSession` in the adapter, not this filter.
- **The history copy is replaced by a recent-turn projection of the native log.** `DshAgentAdapter.recentTurns(agentSessionID, limit)` is the single read surface (the `RecentTurnsReader` capability on `Agent`, resolved via `asRecentTurnsReader`): live sessions read an incrementally maintained window on `DshAgentSession` — seeded from the resumed/forked log at `startSession`, grown by the already-routed `session/event` stream (one user entry per human `user/message`, synthetic plugin injections excluded; one assistant entry per turn joining that turn's assistant texts) — and cold sessions fold `sessionPersistence.inspect()` once into an in-process cache (bounded at 512 entries; the cache entry is dropped when the id goes live). `foldRecentTurns` is the shared fold for seeds and cold reads; the window keeps the retired copy's 100-entry read cap. `Engine.recentTurnsOf`/`lastResultOrReply` wrap it for engine- and command-side consumers, resolving the native id live-agent-first (the bridge mapping can lag mid-turn).
- **Persisted-session recency is the JSONL log file's mtime**: `DshPersistenceLike` gained an optional `locate` (the jsonl backend's path resolver), and `listSessions` stats the log file, falling back to `createdAt` when the backend cannot locate the log or the file is not on disk yet. Live sessions keep `lastActivityAt`.
- **Spawned-group first-message check** is now "the chat's session has no conversation window yet" (`recentTurnsOf(..., 1)` empty) — for the first message the interactive state does not exist yet, and a previous turn's events would already be in the window.
- **`/show` i18n dead keys deleted** (`Show` … `ShowReadFailed` in `keys.ts` and `messages.ts`). `/show` itself stays on the unported-commands list; the roadmap's listing of it as a history consumer was a slip — the command never had a TS handler.

### Scoped-listener spike (negative)

B7's roadmap item "evaluate replacing the adapter's manual `session/event` routing (`liveSessions` map + lineage walk) with dsh-scope scoped listeners" was investigated and **rejected**; the manual routing stays:

1. Host agent scopes carry no ancestry. `AgentLoop` mints its scope with `createScope(loopCtx, this)` and no parent binding (`packages/core/agent-loop/src/agent.ts`), and nothing in the subagent runtime binds a child agent's scope to its parent's — `bindScopeParent` has no production caller outside `agent-presets`. The "ancestor scope receives descendant events" semantics therefore has no producer for agent session events; only the client runtime composes value-keyed scopes. There is no ancestor scope for the bridge to subscribe as.
2. Delivery would not replace attribution. Even with ancestry, an ancestor-scope listener still receives `(session, event)` for every descendant mixed together and must resolve which bridge channel owns the emitting child — exactly the `parentSession` lineage walk the manual routing performs.
3. Bridge routing policy is not expressible in scope filters: the broken-chain drop (a mid-lineage session no longer live), the depth cap of 8, and excluding foreign/one-shot sessions are bridge decisions, not scope topology.
4. The adapter's structural `DshContextLike` (`on`/`get`) keeps its unit tests Cordis-free; `createScope` would couple it to a real `Context` for no behavioral gain.

## Alternatives considered

- **Fold the live agent's full event log on every read** instead of an incremental window. Rejected: each read becomes O(total events) and `/list` enrichment would re-fold every listed session's whole log per command; the seeded incremental window costs one fold per `startSession`.
- **Record user entries in `AgentSession.send()`** for a race-free first-message check. Rejected: `send` receives the built prompt (sender prefixes, attachment refs), not the raw message the old history stored, and the native `user/message` event already carries the model-visible text — one recording site beats two diverging ones.
- **Keep `knownAgentSessionIDs` as a Go-parity surface with the filter gone.** Rejected: its only production consumer was the filter; `findByAgentSessionID` (which `/switch`-back and enrichment still use) reads `pastAgentSessionIDs` directly.
- **Persisted recency via `listSnapshots` revisions.** Rejected: revisions are opaque change tokens that distinguish stores, not timestamps; mtime is the physical recency the Go store's file listing exposed.

## Consequences

- Migration tests cover v1 → load → field-complete → save → v2-on-disk (plus the versionless Go-era file); `tests/agent-dsh/adapter-list.spec.ts` asserts real mtime ordering with `locate` and the `createdAt` fallbacks; `tests/agent-dsh/adapter-recent-turns.spec.ts` covers the fold (injection skipping, per-turn joining, cap) and the live/cold/cache read paths; the `/list` `/switch` `/fork` `/new` `/dir` `/provider` families, reset-on-idle, auto-compress, predict, and the subtask-report fallback were rewritten against the projection. Nine test failures remain in this sandbox, all environmental and untouched by the diff: `reload-script.spec.ts` (the script's pnpm/launchctl orchestration cannot run inside the sandboxed daemon session) and one `commands-fork-at.spec.ts` case whose `git worktree add` writes refs into the main repository's `.git`, which the sandbox denies.
- Known drift, accepted: user window entries hold the model-visible prompt text (sender prefix included), not the raw platform message the old history stored — `/list` summaries and predict context can carry that prefix. A session whose agent id was invalidated (agent-type switch) reads an empty window until a new agent session starts, so `reset_on_idle` no longer rotates backend-less sessions (their next message starts a fresh agent regardless). A spawned group whose first turn died before any turn event now renames on the second message instead of never.
- Real-machine restart recovery remains user-verified: a daemon restart must show `/list` ordered by true recency with summaries and counts from the native logs, and a pre-B7 `sessions.json` must reload and rewrite as v2 on first save.
- Pre-existing, out of scope: `pnpm run lint` fails on three errors in `packages/core/tools` (`src/index.ts:1889` unnecessary optional chain ×2, `tests/tools.spec.ts:773` unnecessary assertion) introduced by commit e704d3b8bb (B1); the files are untouched here.
