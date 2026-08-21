# Agent Note: Fork-at rollback — quoting a message to fork at a turn, through the persistence service

Status: implemented

English | [中文](2026-08-21-feishu-bridge-fork-at-rollback.zh.md)

## Problem

cc-connect's rollback fork — reply to a historical message (a plan card included) and run `/fork` — created a group whose session rolled back to the turn that produced the quoted message. The TS migration cut it as "claudecode-only" (FEATURE-PARITY #55, MIGRATION §0): the visible Go implementation truncated Claude Code transcript files and resumed them with `--resume <id> --fork-session`. But Go `agent/dsh/fork.go` also carried a dsh-backend implementation (`locateForkCut` over the session log plus `writeForkedLog`), so the capability was portable, not claudecode-bound. The TS bridge shipped `cmdFork` with a TODO, i18n strings, a `__forkat__` sentinel constant, and platform-side quote capture (`quotedText`/`quotedSenderType`/`quotedUpdateTimeMs`) — all pre-wired, none consumed.

## Decision

`cmdFork` treats a reply to a message (`parentMessageID` set, `quotedUpdateTimeMs > 0`) without `--worktree` as a rollback fork: it asks the agent's `ForkAtPreparer` capability to prepare a truncated copy, plants the returned id behind a `__forkat__` sentinel, and `startSession` resumes that id directly. A missing capability or a failed lookup replies and aborts before any group is created. `--worktree` skips the rollback — the worktree path is only known inside `spawnGroupCommon`, so the copy cannot be placed ahead of time (Go parity).

`DshAgentAdapter.prepareForkAtSession` performs the copy through the `sessionPersistence` service rather than raw log files: `inspect(origID)` returns the source's events (a live snapshot for a live parent, the persisted log otherwise — the parent need not be live), `locateForkCut` (ported to `src/agent-dsh/fork-at.ts` as pure logic over `SessionEvent[]`) picks the cut, and `create` + `append` persist the prefix under a fresh id whose header rewrites `id` and `cwd` and stamps `seedLength: keep`. The stamp follows the [fork-child-replay-seed-boundary rule](../testing/2026-06-22-fork-child-replay-seed-boundary.md): the whole copied log is inherited history, and the boundary is what lets replay tell it from the child's own turns — Go's `writeForkedLog` had no such field to write.

The locator ports Go's semantics: a quoted timestamp opens a 10-minute window filtered by sender type (`app` matches `assistant/message`, otherwise `user/message`); a normalized 40-rune text-prefix match inside the window wins outright (Feishu quotes truncate and decorate), otherwise the nearest message in the window; without a timestamp, the last text match. The cut keeps everything through the closing `turn/end` (an open turn cuts before the next `turn/start`).

Divergences from Go, all deliberate: no `ForkAtTranscriptReachable` capability — the jsonl backend resolves ids globally, so "the copy is unreachable" collapses into "resume fails", which the engine's existing fresh-session fallback already covers (that branch now uses the fork-degrade wording for `__forkat__` sentinels); no cleanup function — `create` is lazy and a failed `append` leaves no on-disk orphan; `planBasisName`/`spawnFromQuotedPlan` (quoting a plan card with `/spawn`) is not ported and remains a TODO in `cmdSpawn`.

## Alternatives considered

**Port Go's raw log-file copy (`writeForkedLog`).** Lost: it reimplements `encodeSegment`, zstd framing, and the project-dir layout behind the persistence layer's back. The service already owns those bytes and validates the append contract (seq contiguity from 0, header validation), so the copy cannot drift from what the backend itself would write.

**Seed at `startSession` like the plain `__fork__` path.** Lost: the locator (quoted text and time) is only known at `cmdFork` time, and the sentinel is a session-id string — smuggling the locator into it, or stashing it in engine memory, breaks restart safety between the command and the child group's first message. Pre-materializing the truncated log under a fresh id keeps the sentinel a plain id and the copy durable.

**Fold `prepareForkAtSession` into `ForkSessionPreparer` (Go's single interface).** Lost: the bridge's structural capability checks probe by method, so merging would force the subtask cross-workdir guard's fakes to implement rollback members they never use. A separate `ForkAtPreparer` mirrors the `ForkQuerierWithProvider` precedent in the same file.

**Pre-check reachability before session start (Go's guard).** Lost: with global id resolution the pre-check duplicates what the resume attempt itself proves; only the user-facing wording was kept.

## Consequences

Rollback works for merely-persisted parents and survives a daemon restart between the command and the child's first message. When shipped, this was strictly better than the plain `/fork` seed path, which then still required a live parent; that ceiling has since been lifted for plain `/fork` too ([fork-persisted-seed](../bug-fix/2026-08-21-feishu-bridge-fork-persisted-seed.md)).

The quoted timestamp is the card's PATCH time: a repeatedly refreshed card can drift past the 10-minute window, and the fork then fails loudly (`fork_at_truncate_failed`, no group) instead of silently forking the whole session — the same trade-off Go accepted. Text matching compares rune-sliced prefixes where Go byte-slices; the intent (a truncated, decorated quote still matches its source) is identical.

## Testing

Four spec files pin the behavior: `tests/agent-dsh/fork-at.spec.ts` (locator: window, text-priority, nearest-time fallback, sender filtering, open-turn and pre-turn cuts, normalization), `tests/agent-dsh/adapter-fork-at.spec.ts` (copy contract including the `seedLength` stamp, cold parent, rejection paths, `__forkat__` resume without create or seed), `tests/engine/commands-fork-at.spec.ts` (sentinel planting, fallback to plain fork without a quote / with `--worktree` / without a timestamp, abort on failure or missing capability), and `tests/engine/engine-fork-at-degrade.spec.ts` (resume failure degrades to a fresh session with the fork wording and replaces the sentinel).
