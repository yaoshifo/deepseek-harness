# Agent Note: feishu-bridge tag state files reset on platform renames; project-name keying, legacy merge, and an unbindable-id blacklist

Status: implemented

English | [中文](2026-08-25-feishu-bridge-tag-cache-platform-rename-untagged-spawns.zh.md)

## Problem

Adding `feishu.tag` per project (platform names like `riskai`, `op-dev`) renamed every per-bot state file, because both the tag-id cache and the spawned-chat registry were keyed `` `${projectName}_${platformName}` ``. The renamed files started empty, discarding the tag ids the app had already resolved — and im/v2 gives no way to look an id up: a name owned by the app answers create with its own id, but a name owned by another app answers 402 (or a duplicate pointing at the other app's tag), and the sibling-cache fallback borrows whatever id a sibling file holds. Binding another app's tag id returns `code=0` and creates nothing.

The verify-after-bind step caught each failure, but the recovery was a closed loop: evict the cached id, re-resolve, and the sibling scan (filtered to `*_feishu_tag_cache.json`, so it only saw pre-rename files) handed back the same foreign id — `re-resolved the same id; giving up`. Every spawn after the rename went out untagged. On 2026-08-25 this produced five untagged `riskai` groups and eight untagged `dev`/`harness` groups in production; the repair (seed each bot's own id back, merge the registries, rebind the missed chats directly) is ops history, not code.

## Decision

- **State files are keyed by project name only** (`<project>_spawned.json`, `<project>_tag_cache.json`); the platform tag no longer participates, so future `feishu.tag` renames cannot reset state.
- **Load merges legacy shapes underneath the primary file**: `<project>_<platformTag>` and `<project>_feishu` variants are read at load, primary entries win, and the merged map persists under the primary path. Migration covers exactly these two historical shapes; anything older is not attempted.
- **Unbindable-id blacklist in `TagManager`**: a tag id whose bind fails verification is marked unbindable (dir-tag retry path and active-tag candidate loop). `ensureTagCached` skips blacklisted ids in every source — cache, create-duplicate, discover-from-spawned-chats, sibling files — and throws when only unbindable ids remain, so the re-resolve can no longer land on the same foreign id.
- **The sibling scan accepts any `*_tag_cache.json`**, restoring sibling sharing across renamed shapes.

## Alternatives considered

**Persisting the blacklist.** Rejected: one failed bind attempt per process is cheap, and the on-disk format stays stable.

**Migrating by renaming legacy files.** Rejected: a merge is idempotent, covers both historical shapes in one pass, and never loses a primary entry.

**Validating a borrowed id before use.** Impossible: im/v2 has no tag List/Get; only a bind plus relation readback proves an id is bindable by this app.

## Consequences

The blacklist is in-memory, so a persisted foreign id is retried once per process before being re-blacklisted. Legacy files linger on disk after migration and still feed sibling scans; their entries are verified per bind, so staleness is bounded to one wasted attempt. The registry merge path runs the existing retention sweep on save, backfilling `doneAt` on inactive migrated entries — pre-existing semantics, unchanged.

## Testing

`tag.spec.ts`: an id that fails verification is not re-borrowed from a sibling file (402 create, foreign id, empty cache never persists); legacy cache files merge under the primary with primary entries winning. `tag-cache-share.spec.ts`: state files key by project name and migrate both legacy shapes; sibling-cache expectations updated to the new names. `assembly.spec.ts`: spawn-store path pin updated. Full feishu-bridge suite 2323 passed; repo typecheck passes; lint is clean on all changed files (three pre-existing dev lint errors elsewhere predate this change).
