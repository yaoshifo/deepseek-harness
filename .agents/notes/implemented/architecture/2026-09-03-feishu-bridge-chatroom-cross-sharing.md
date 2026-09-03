# Agent Note: Cross-chatroom sharing shares pointers, adoption passes a screening gate

Status: implemented

English | [中文](2026-09-03-feishu-bridge-chatroom-cross-sharing.zh.md)

## Problem

Chatrooms had no discoverable shared assets: the intermediate results (the three ledger files) live in per-`hashID(hubKey)` directories that simply stay on disk after `end` — no index, and a new chatroom's priming never references history; the moderator's closing summary exists only as a group message, never persisted; "continue last time" existed only as topic-picker blurb wording. Implementation research found worse: starting a second chatroom on the same hub **overwrites the previous ledger wholesale** (`initChatroomLedger` rewrites all three files), so same-group reuse — the most common pattern — does not retain history at all. And feeding a prior synthesis or dataset straight into a new chatroom lets one bad download or wrong conclusion propagate across chatrooms and accumulate across generations, with circular validation making the error look "repeatedly confirmed".

## Decision

Three sentences: **each chatroom owns its state, reads go through a directory scan; inheritance writes a pointer only; substantive content enters a new discussion only through one explicit screened adoption.**

- **Per-run ledger directories**: the hub state gains a durable `chatroomLedgerRun` counter; run 2+ lands in `<hash>-<run>` (run 1 keeps the Go layout — additive, existing moderator dirs reload unchanged); `chatroomLedgerDirFor` resolves it from the hub state. Fixes the same-group clobber.
- **Engine bookkeeping**: graceful end / interrupt append `- 结束：<time>（已收尾|已中断）` to the SYNTHESIS.md header (above the marker, so note updates preserve it); `note` gains `section: report` persisting REPORT.md.
- **Discovery**: a new `history` tool action — scans `ledgers/*/`, reads each header (topic/roles/start/end/status), probes report files, lists newest-first (dir mtime breaks same-second ties), plus a shared-research-workspace section when its `DATA_LEDGER.md` exists. Header parsing lives in one export, `readChatroomLedgerHeader`, shared by writers and readers.
- **Pointer inheritance**: `/chatroom --continue[=<ref>]` and the tool's `start: inherit` (bare = newest; exact dir name, then topic substring, newest first). `initChatroomLedger` writes a fixed-text prior section above the marker — **it never reads or copies prior content**. With no roles named, the prior's recorded cast is reused (avoiding threading inherit through the picker state machine). The missing-file / hand-edited-prior edge cases vanish with the pointer form.
- **The screening gate (error-propagation control)**: both moderator primings carry a prior section — Read the prior first, classify every judgement (adopt directly / adopt after re-check / open question / overturn), note the adopted parts into the synthesis with their source; re-check with **new independent evidence** (re-reading the same datasets is circular validation); record corrections with an explicit「修正：」prefix; inheritance is single-hop. Research side: the persona's fetch discipline upgrades from check-then-fetch to check-screen-fetch (three fetch-ledger columns, spot-check load-bearing data, re-fetch suspect datasets and register a new row), mirrored in the research priming's round-2 task text.
- **Visibility**: the plain (non-research) moderator priming gains a shared-research-data section when the workspace has a fetch ledger — data downloaded by past research chatrooms is now discoverable by plain discussions.

## Alternatives considered

**A shared `INDEX.md` index file.** Rejected: a second source of truth beside the `ledgers/` tree (drift) plus cross-chatroom write contention; with the status line in each chatroom's own SYNTHESIS.md and a read-side scan, the directory tree stays the single source of truth.

**Copying the prior synthesis wholesale on inheritance.** Rejected (the v2 design, withdrawn after user challenge): unscreened content would flow silently into every role's context (roles are told to read the ledger before answering, so they would treat the prior as established picture); the pointer plus explicit note adoption forces contamination through one explicit act.

**Automatic inheritance / automatic history reference by topic match.** Rejected: context pollution and topic drift; explicit `--continue`/`inherit` plus `history` queries suffice.

## Consequences

The sharing model is engine-written facts (directories, ended line, REPORT, resolution) under prompt-level screening discipline (compliance measurable only by re-mining session logs — the same tier as the existing research-dedup convention); role project memory is a separate pre-existing cross-chatroom channel this design does not gate (deferred). Cross-project sharing means pointing `moderatorDir`/`researchWorkspace` at the same paths (name collisions and unsynchronized appends are the known rough edges). Model-visible text is pinned in the package specs (this package's convention: priming/persona/tool texts are all asserted by package specs; the top-level snapshot tree has zero chatroom coverage, so no new recorded-session snapshot was added). Verification: 280 package tests green (ledger 17 + sharing 10 + tool 6 + priming/persona 5 new), package-level `tsc -b` clean.
