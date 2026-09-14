# Agent Note: daemon build age surfaces in /status and the reload notice

Status: implemented

English | [中文](2026-09-14-daemon-build-age-observability.zh.md)

## Problem

The running daemon's code identity was invisible: a daemon left behind by a rebuild or by new commits looked identical to a current one, and checking required hand-assembling three evidence sources (process start time, lib file mtimes, git history). 2026-09-14: a daemon two days stale passed as reloaded — the user believed `/reload` had run when the last one was two days earlier; a fresh on-disk build from a parallel session made the tree look current.

## Decision

Capture the daemon's build identity once per boot (`src/engine/build-info.ts`, called from the plugin's startup settle before `completePendingReload`): start time, mtime of the loaded plugin dist file and of the daemon entry (`process.argv[1]`), and the git HEAD beside the module. Render it in two surfaces:

- `/status` appends a build row after the existing template text: `构建: daemon <start> 启动 · lib <mtime> · HEAD <short-sha>`; drift lines follow when the disk build is newer than the loaded one (>1s mtime delta, hint `跑 /reload 生效`) or HEAD moved past the captured sha (`+N 提交`, count via `git rev-list --count`, `+?` when not computable).
- The `/reload` completion notice appends the same row — a commit landing mid-build leaves the fresh daemon instantly stale, and the notice is the moment to say so.

Everything is read-only and fail-soft: unusable git degrades the sha to `-` and drops the HEAD-drift line; unstatable files degrade to `-`; a missing capture (startup before the settle) renders nothing. The line templates live in i18n (`status_build*` keys, en+zh per the table convention).

## Alternatives considered

**A build-time stamp file written by reload.sh.** Rejected for now: it covers only reload-driven builds (a manual `pnpm run build` + restart leaves it stale or missing) and adds a cross-process contract for marginal accuracy. The startup HEAD is a close proxy in the reload flow (build and restart are seconds apart).

**A daemon build age on every completion card footer.** Rejected: the incident needed an on-demand check and a reload-time check, not a permanent footer; `status-footer` composition is per-turn hot path.

## Consequences

- HEAD-at-start approximates the built commit: in the reload flow they coincide; commits landing between build start and daemon start over-report (the loaded code may predate the captured HEAD), and a dirty build tree is not reflected. Ceiling recorded here; the stamp-file alternative is the upgrade path if this bites.
- `/status` and the notice each add two bounded git calls (2s timeout) on their existing paths; daemon startup gains the capture (one `rev-parse`, milliseconds locally) before the settle.
- Non-repo deployments (if any) show `HEAD -` and never a HEAD-drift line; the disk-newer drift still works (pure stat).

## Testing

`tests/engine/build-info.spec.ts`: summary row from injected identity; disk-newer flags the /reload hint; sub-second mtime jitter is ignored; HEAD move adds the counted line; uncomputable count degrades to `+?`; empty captured sha and unavailable live sha both suppress the HEAD line; uncaptured renders nothing; `captureBuildInfo` populates from the real module path with the repo HEAD asserted against git itself. `tests/engine/commands.spec.ts`: /status appends the row (full drift trio) and stays silent before capture. `tests/engine/reload-commands.spec.ts`: the completion notice carries the build row only when captured (the pre-existing exact-equality notice tests pass unchanged, pinning the uncaptured shape). 90 tests green across the three specs; repo typecheck green.
