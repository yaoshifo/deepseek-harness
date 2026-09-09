# Agent Note: Read-only extra roots for the JSONL persistence backend

Status: implemented

English | [中文](2026-09-09-session-persistence-readonly-roots.zh.md)

## Problem

A dsh process lists and reads sessions only through the single persistence root it mounts. The feishu-bridge daemon stores fully standard sessions (same plugin, same SessionEventMap, same on-disk layout) under its own root (`~/.dsh/feishu-bridge-sessions`, set by its profile patch), so the Web UI process — mounting `~/.dsh/sessions` — cannot see them at all. The sessions are otherwise interchangeable: the bridge writes no package-local durable events, and cold reads need no bridge-side metadata.

## Decision

`session-persistence-jsonl` gains a `readOnlyRoots: string[]` config. The aggregation lives inside the one backend instance: `listProjectDirs` walks every root (writable first), `findLog` resolves an id across all of them with the same highest-generation and migration rules, and `assertStoredIdentity` accepts the header-to-path relation under any configured root. Every write path still targets `root` only — `create` refuses an id that exists under any root, and write-opening a read-only-root session refuses with an error naming both roots. A session id appearing under more than one root fails loudly rather than picking a copy. Load refuses a read-only root that is absent, unreadable, repeated, or equal to `root`, because the backend never creates these roots. No consumer above the seam changes: session-query, session-controller, and the Web UI list/follow/chat/trajectory paths pick the mounted sessions up unchanged.

Two operational companions ship with the feature (both outside the repository, in `~/.dsh/profiles/web/`): the Web profile patch mounts the bridge store as a read-only root, and `bridge-takeover.patch.yml` is an emergency `--patch` overlay that points the writable root at the bridge store — with `readOnlyRoots` explicitly cleared — for continuing bridge conversations from the Web UI only while the bridge daemon is down and holds no write leases.

## Alternatives considered

**Symlink the bridge store into the default root.** Rejected: listing scans `readdir({ withFileTypes: true })` and keeps only `Dirent.isDirectory()` entries, which is false for symlinks — the mounted sessions would be silently invisible.

**Share or migrate to one root for both daemons.** Rejected: the lease model assumes one live writer per session root per process; a running bridge daemon plus a Web process on one root invites ownership and projection-cache races, and migrating ~3000 live session directories under a running writer is a crash risk.

**A Web-client plugin reading the bridge store beside the controller.** Rejected: it re-implements listing, paging, and event streaming that the standard chain already provides, and forfeits the existing chat/trajectory renderers.

**Multiple persistence service instances.** Rejected: `ctx.sessionPersistence` is a single service slot; aggregating at that seam would change the abstract service contract and every consumer for what is a backend-internal concern.

## Consequences

The Web UI shows bridge sessions (id prefix `cc-`) alongside local ones, grouped by their cwd project directories; opening one replays its JSONL events through the standard renderers. Sessions whose v0 header the format catalog refuses (the recorded 60% deprecated corpus, e.g. `origin: 'oneshot'`) stay invisible exactly as under the writable root — mounting changes nothing about that ruling. Bridge subagent sessions keep their existing sidebar-hidden `origin: 'subagent'` behavior. Full-list cost scales with the total directory count: one cold scan measured 1.8 s over 3156 on-disk session directories (1826 listed) on this machine, repeated on every `list()` since the backend has no index — acceptable for a control-panel session list, and the baseline is recorded here for future indexing work. A profile patch entry's `config` replaces the bundle layer wholesale, so any patch overriding this plugin must restate `root` (the Web profile patch does, with the same `dshHomePath('sessions')` expression).

## Testing

`packages/session/session-persistence-jsonl/tests/readonly-roots.spec.ts` (8 cases, REAL composition through `ctx.plugin` over real temp roots): cross-root listing; read-only-root `stat` and cold `open('read')` leaving the artifact untouched; write-open refusal naming both roots with the writable root unaffected; `create` refusal for a read-only-root id; cross-root duplicate id failing loudly in both `list` and `open`; a released v0 generation listed and byte-identical afterwards; a schema-refused v0 generation skipped exactly as under the writable root; and load-time rejection of absent, self-duplicating, and writable-root-duplicating read-only root config. The full package suite (348 tests) passes unchanged.
