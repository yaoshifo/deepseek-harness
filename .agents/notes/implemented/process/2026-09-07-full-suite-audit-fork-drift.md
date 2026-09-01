# Agent Note: Full-suite fork-drift audit after the 08-26..09-06 syncs

Status: implemented

English | [中文](2026-09-07-full-suite-audit-fork-drift.zh.md)

## Problem

The 08-30 full-suite green run was the last complete pass before the 08-31 and 09-06 upstream syncs; both were verified with targeted checks only. A 2026-09-07 full run of the four test suites surfaced 86 failures: 41 real (nine root causes) plus 45 sandbox false positives from the agent-session file sandbox (HOME mkdtemp, posix_openpt, `/bin/ps`, nested sandbox-exec), which make an in-session full run look far worse than the tree is.

## Decision

All nine root causes are fixed on dev. The durable facts and the follow-up rule:

- Golden drift dominates. An upstream behavior change (default model v4-pro → v4-flash, the ACP initialize `config_option_update` push, the `list_agents` status legend, the `read_image` extensionless-path description, the `cwdOverride` provider capability) or a fork feature shipped without refreshed goldens (the mcp-workspace warn-once stderr line, 15 tests) leaves `test:expected` and `test:snapshot` red until `DSH_SNAPSHOT=refresh` runs — keyless — followed by a diff review against the known change classes. Inline stderr assertions (for example `expect(result.stderr).toBe('')`) are not refreshable; they move with the behavior.
- Fork-local assets must follow upstream gates that arrive by merge: six README pairs lacked the doc-standard frontmatter and skeleton (including the group README, which the two-level scans miss), and 115 session fixtures sat in the legacy packed layout — `migrate:packed-session-fixtures` is the prescribed mechanical repair.
- Attribution method: re-run the failing files under escalated sandbox access; what passes there is environment, what still fails is real. In-session `pnpm run test` also trips the pnpm store SQLite denial — invoke `node_modules/.bin/vitest` directly. A refresh must run escalated too, or the sandbox-denial text bakes into the goldens.
- Known defects found and deliberately not fixed here: `DSH_SNAPSHOT=refresh` writes `sourceEventSeqs` back in packed-range form, contradicting the canonical enumerated layout — re-run the migration after every refresh (upstream-relevant); node 24.3.0 `fs.glob` crashes the md gates on `**` plus the snapshot prompt symlinks (upstream carries the same symlinks); the `2026-08-31-parallel-exploration-default-guidance` Agent Note pair is out of sync with its sidecar; e2e subpath rows load built `lib/`, so a source change needs the package rebuilt before e2e reflects it.
- The prevention rule: an upstream sync's verification must include one full pass of `test`, `test:expected`, `test:snapshot`, and keyless `test:e2e`. Targeted checks let drift accumulate silently across three syncs. The [suppression-seam note](../architecture/2026-09-07-agent-instructions-suppression-host-plane-service.md) records the one architecture decision this audit forced.

## Alternatives considered

**Continuing targeted-check verification after syncs.** Rejected by the evidence: 41 failures accumulated across three syncs without any of the targeted gates noticing, because every root cause lived on a surface the targeted checks did not touch (goldens, README gates, preset mounting).

**Fixing the discovered defects (refresh write-back, node glob crash, stale note pair) inside the audit.** Deferred: each is upstream-relevant or independent of the nine root causes, and bundling them would have grown an already large batch; they are recorded above so the next full run can tell new drift from known defects.

## Consequences

The four suites are green again (modulo the sandbox false positives that only in-session runs see), and the sync workflow gains an explicit full-suite obligation. The cost of the rule is one longer verification pass per sync; the audit shows what skipping it buys — three syncs of silent golden and gate drift.
