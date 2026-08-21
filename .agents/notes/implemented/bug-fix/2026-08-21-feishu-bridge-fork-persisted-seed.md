# Agent Note: Plain /fork seeds from the persisted log — the live-only ceiling lifted

Status: implemented

English | [中文](2026-08-21-feishu-bridge-fork-persisted-seed.zh.md)

## Problem

A plain `/fork` (no quoted message) seeded its child only from a **live** parent: `startSession`'s `__fork__` branch looked the parent up in the `ctx.agents` registry and, on a miss, silently started a fresh session with a log warn. After a daemon restart or an idle reap — the parent existing only in the persisted log — `/fork` produced a group that remembered nothing, and the same liveness requirement leaked into the subtask guard (`prepareForkSession` rejected merely-persisted sources). Go never had this gap: its fork reads the on-disk transcript.

## Decision

The `__fork__` branch resolves its seed in two steps: the live registry first (its in-memory log is fresher than the write-behind persisted one), then `persistedForkSeed` — `sessionPersistence.inspect(id)` followed by the same completed-turn trim. The trim lives in `trimCompletedTurnPrefix`, shared by the live path (previously `completedTurnPrefix`); both log views carry sequence numbers equal to array indexes, so a prefix sliced by `turn/end` satisfies the seed's contiguous-from-seq-0 contract unchanged. The lineage metadata (`parentSession` + `seedLength`) is now recorded on both paths, not only the live one; when the source is nowhere the behavior is unchanged (warn + fresh session, no chat message).

`prepareForkSession` (the subtask pre-spawn guard) follows: reachability is "live OR inspectable in persistence", so `feishu_bridge_subtask` `fork: true` works for dead parents too, while a truly missing source still fails fast before the group exists. Its engine call site passes no workDir arguments anymore — the old message blamed directory mismatch, but the guard never compared directories (the persistence service resolves ids globally, with none of Claude Code's per-cwd projects-dir locality), so cross-directory forks have always worked in TS and the [subtask skill](../../../../packages/acp/feishu-bridge/skills/feishu-bridge-subtask/SKILL.md) no longer forbids them.

## Alternatives considered

**Route plain /fork through the fork-at copy path (persistence create + append + resume).** Lost: the copy exists because a rollback fork must pre-materialize its truncated log at command time — the quoted-message locator cannot travel in the sentinel. A plain fork's sentinel already carries everything (the source id), so lazy expansion with a seed is simpler and creates no orphan artifacts; the asymmetry is deliberate, not drift.

**Always read the persisted log, never the live registry.** Lost: persistence is write-behind, so a live parent's freshest completed turns may not be on disk yet; live-first keeps the current, tested behavior for the common case and only adds a fallback.

**Reply a degradation message when the source is gone (Go's guard wording).** Lost: the adapter has no platform surface to reply on, and the missing-source case collapses to a broken id once persistence is consulted; keeping the silent warn preserves the documented behavior instead of growing an engine-side detection path for a rare failure.

## Consequences

`/fork` and subtask `fork: true` now survive daemon restarts and idle reaps — the last user-visible divergence from Go's fork semantics (the rollback fork had already closed its side). The stale persisted log can trail a live parent by at most the write-behind window; the live-first order makes that window irrelevant. The skill's cross-directory prohibition is gone from the docs the model reads, so subtask dispatches no longer drop `fork` defensively when `dir` differs.

## Testing

`tests/agent-dsh/adapter-fork.spec.ts` seeds from a persisted-only parent (asserting the seed prefix and lineage metadata), prefers the live parent over a stale persisted log, still degrades when the source is nowhere despite the service being present, and covers `prepareForkSession` resolving for a persisted source while rejecting a missing one; `tests/engine/engine-subtask.spec.ts` pins the guard as an existence check that passes no workDir.
