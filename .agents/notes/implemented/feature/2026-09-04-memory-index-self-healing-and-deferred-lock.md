# Agent Note: Memory index self-healing signals and the deferred cross-session index lock

Status: implemented

English | [中文](2026-09-04-memory-index-self-healing-and-deferred-lock.zh.md)

## Problem

MEMORY.md is an aggregate one model session maintains through two disciplined steps: write the topic file, then upsert its pointer line with `memory_index`. Two failure classes break recall:

1. **Discipline miss** — a session writes the topic file and never calls `memory_index`. The file exists on disk but no session-start injection ever lists it, so it is never recalled. One deployment's logs show this at roughly 1 in 77 written memories: the session that wrote `codex-lsp-absence-audit.md` called `memory_write` four times and `memory_index` zero times, despite the prompt and tool-description both teaching the second step.
2. **Lost update** — `updateMemoryIndex` (`packages/memory/memory/src/store.ts`) reads the whole index, transforms it in memory, and renames the result over `MEMORY.md` with no coordination. Two concurrent calls on one directory can each write a base state that drops the other's pointer line.

## Decision

No locking ships. The two failure classes get different treatment, decided on measured evidence:

- **Discipline miss: two self-healing signals, both shipped.** A topic-file `memory_write` result carries `indexed: boolean` (computed by the new store primitive `hasMemoryPointer`, spelling-insensitive like `updateMemoryIndex`'s matching); when `false`, the rendered result names the missing `memory_index` call while the writing session still holds the context to write a good title and hook. Independently, the session-start index injection appends one note listing unindexed files (new primitive `listUnindexedMemoryFiles`, capped at five names plus an overflow count), so an orphan survives at most until the next session in that scope. The note is spelling-insensitive in both directions, excludes `MEMORY.md` itself and dot-prefixed artifacts, and costs one extra directory read per scope per session start — zero extra tokens when no orphan exists.
- **Lost update: deferred with recorded revisit triggers.** Within one session the tool runtime already serializes memory tools: a tool that declares no `isConcurrencySafe` executes exclusively, in submission order (`packages/core/tools/src/index.ts`), so same-message bursts cannot race. Cross-session and cross-process writers stay uncoordinated — including Claude Code sessions, which are equally uncoordinated among themselves. The package README's Known Limitations carries the full characterization and the triggers: a first observed real cross-session overlap, chatroom persona memory volume growing materially, or CLI and daemon sessions routinely sharing a workdir.

## Forensics: where concurrent index writes actually race

Two investigations grounded the deferral.

**Claude Code 2.1.228 (binary reverse-engineering, local install).** CC ships exactly three memory tools — `memory_list`, `memory_read`, `memory_write` — and no `memory_index` and no locking; index maintenance is prompt discipline (a "add a one-line pointer" paragraph) carried out by whole-file rewrites through `memory_write`. The only lock-adjacent strings in the binary belong to Bun's package manager. Its team-memory layer resolves concurrency by server-authoritative overwrite plus a user-facing warning to move content out. So there is no CC solution to port; dsh's `memory_index` (a dsh-only tool) is what makes engine-side index maintenance possible at all.

**One deployment's session logs (2,650 sessions, ~10 days, busiest directory: 235 index calls).** Interval-overlap analysis of every `memory_index` call (dispatch timestamp through result timestamp) found: zero same-session overlaps (the exclusive-execution guarantee held everywhere), zero cross-session overlaps between distinct conversations, twelve stall-resume mirror session pairs writing identical content at identical timestamps (benign double execution), zero `memory_write` calls targeting `MEMORY.md` in 353 writes (the wide stale-rewrite window never materialized), and the single on-disk orphan proven to be the discipline miss above, not a lost update.

Method warning for future audits: a same-line-count signature across a burst of upserts does **not** prove a lost update — sequential in-place replacements produce the identical signature. Only interval overlap (or byte-arithmetic inconsistency) discriminates; the first analysis pass here misread one four-call burst as a clobber before the interval check corrected it.

## Alternatives considered

**Serialize `updateMemoryIndex` (and full-index `memory_write`) with `withFileLock` from `@deepseek-ai/dsh-atomic-write`.** Airtight across sessions and processes, four existing consumers in the repo, and the designed fix if a trigger fires. Deferred because it trades a measured-zero incident rate for a new failure surface: a crashed holder leaves `MEMORY.md.lock` blocking every writer until an operator removes it, and the lock file churns inside directories shared with Claude Code.

**Optimistic re-read merge (verify the base before rename, re-apply on conflict).** Leaves a silent residual race between the final read and the rename — the exact failure mode being eliminated — and adds a retry loop of owned code where the repo already ships a lock utility.

**Auto-derive pointer lines from frontmatter on `memory_write`.** Rejected: pointer lines are deliberately model-authored because hook quality drives recall, and it diverges from the Claude Code observed behavior this package is locked to.

**Optional `title`/`hook` parameters on `memory_write` (atomic write-plus-index in one call).** Deferred escalation path, not rejected: it removes the second-step failure mode for adopters and saves one LLM round trip per memory, at ~30 schema tokens per request and a prompt re-teach. Escalate if the write-time nudge proves ignorable or the orphan rate does not fall.

**Session-start orphan listing alone.** Insufficient alone — it heals only after the writing session ends, without its context for a good hook — but kept and shipped alongside the write-time signal.

## Consequences

Bought: deterministic in-flow correction at zero standing token cost (the nudge fires only on an unindexed write), cross-session healing that surfaces any existing orphan on the next session start in that scope, and an honest README limitation entry in place of the previous "identical to two concurrent Claude Code sessions" claim, which was accurate but hid the exclusive-execution same-session guarantee and the measured cross-session record.

Cost: one extra directory read per scope per session start; a few result tokens when the nudge fires; a spurious one-time nudge if a concurrent session removes a pointer line between write and check (harmless — re-indexing is idempotent); and the cross-session lost-update window remains open by documented choice, repaired only by the revisit triggers above.

## Testing

Package specs pin both signals end to end: `hasMemoryPointer` and `listUnindexedMemoryFiles` behaviors in `tests/store.spec.ts`, the tool result and rendered nudge in `tests/index.spec.ts`, the note rendering and cap in `tests/inject.spec.ts`, and the composed injection through the real plugin body. The keyless recorded-session snapshot `snapshots/acp/dsh-memory` replays green with the nudge visible in both `memory_write` results; its refresh also re-synced pre-existing source drift in that scenario's expected files (the `web_fetch` prompt section, the `send_message`/`agent_id` schema rename) — the wider snapshot suite on dev carries ~95 scenario failures predating this change and unrelated to it.

## Related

- [dsh-memory package rename](../architecture/2026-08-28-dsh-memory-package-rename.md) — the package's place in the layout.
