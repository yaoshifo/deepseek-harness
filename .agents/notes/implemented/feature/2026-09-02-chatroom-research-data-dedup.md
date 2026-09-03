# Agent Note: chatroom research data deduplication — needs gather, data steward, fetch ledger

Status: implemented

English | [中文](2026-09-02-chatroom-research-data-dedup.zh.md)

## Problem

A log-mining audit of a production research chatroom (2026-08-30, five roles, three auto rounds, one topic) measured one research question consuming ~42 agent sessions and ~1391 LLM requests, with four duplication mechanisms: (1) the round-1 "everyone researches the full topic" broadcast sent all five role assistants after the same six core series — one NBS release page was pulled by all five, 14 URLs by ≥2 assistants, and five to six parallel scraper scripts were written for the same source; (2) the concurrent same-origin fetches tripped the source site's anti-crawl throttling, and the recovery loop (seven moderator chaser asks, roles degrading to self-collection) stretched round 1 to 2h13m of the 4.5h total; (3) recursive spawning was uncoordinated — 31 sub-assistants, 21 of them each fetching two NBS pages; (4) round-3 adjudication piled up — the rent series was independently pulled by four assistants where dual-source verification needed two. The shared research workspace existed but produced zero cross-assistant reads; three assistants even interleaved separate pipeline trees inside one directory. Angle-specific work, by contrast, was unique per role throughout.

## Decision

Deduplicate the data layer, not the execution — judgment independence is preserved, data sharing sinks below it.

- The engine pre-spawns one hub-parented data steward beside the role assistants (`chatroom-cmd.ts` afterChatroomStarted): same research-assistant flag, shared venv, shared workspace, and the moderator's `child "assistant"` alias resolves per caller, so the hub's key reaches the steward with zero listener changes. `finalizeChatroomEnd` cleans the steward with the room and reaches every recursive descendant of a chatroom role or the steward (role assistants and their fetchers), while the end-of-run HTML renderer subtrees stay preserved; `clearChatroomResearchFlags` drops the hub's steward pointer.
- The research moderator priming stages, before round 1: a plain (non-research) gather collecting each role's pure-judgment data-needs list (the 20-minute plain-gather fallback owns the degradation); a merged common list — bounded to ~6-8 items, never broadcast to roles — dispatched to the steward into `data/core/` with per-source parallel sub-fetchers, per-domain pacing, and `DATA_LEDGER.md` registration; a user-visible wait notice (a silent hour reads as a stall); then the round-1 broadcast points each role at the ledger so its assistant pulls only what is missing into `data/<role>/`.
- The research-assistant preamble — shared by the role assistants and the steward — carries the fetch-ledger discipline with an explicit adjudication exception (independent dual-source pulls must not reuse ledger files; they still register), the per-role data-directory convention, and the rate-limit and anti-fan-out rules (batch fetching prefers one scripted loop over per-page sub-agents).
- Round-2+ guidance reuses the ledger, routes new common data through the standing steward, and assigns adjudication targets by named allocation: one claimant by default, at most the disputant plus one neutral, everyone else judges without re-pulling.

The re-measurement method: mine the next research chatroom's session logs (per-assistant tool calls, fetched URLs, spawn counts, request totals) against the recorded baseline — core-series pulls 5 → ≤2, URLs fetched by ≥2 agents 14 → ≤3, sub-agent spawns 31 → <10, total requests −30%+.

## Alternatives considered

**Moderator doubles as the executor.** Rejected: it breaks the deliberate pure-orchestrator design — the hub's lean context (53 requests over 4.5h in the audited case) is what its synthesis rests on, every data iteration would serialize through moderator wake cycles (the slowest observed rhythm), and the blast radius concentrates: the audited chatroom finished 5/5 rounds with four assistants throttled to death, which distributed execution tolerates.

**One shared assistant serving all roles.** Rejected in its fat form: the subtask seam is strictly one parent to N children (send rejects non-parent callers; report routes to the single registered parent), and busy-reject backpressure would turn five concurrent requesters into constant rejects. The thin-dispatcher form (a fresh child per task behind one intake) is viable but needs multi-requester report routing — the recorded engine-level upgrade path if ledger compliance proves poor.

**Prefetch from the moderator's own guess.** Superseded by the needs gather: a demand-driven common list covers what roles actually need and separates common from angle-specific items naturally, at the cost of one plain-gather round; the list never reaches the roles, so round-1 independence survives.

## Consequences

The five 1:1 role-assistant loops are untouched (angle-specific work was unique per role in the audit), while the common layer is fetched once and every fetch is discoverable through the ledger, including across chatrooms sharing the workspace. The costs: one plain-gather round and a serial steward prefetch (~30-60 minutes) before round 1 — both with never-block degradation paths — and the accepted posture that ledger, pacing, and directory discipline are prompt-level convention with no mechanical gate, the same enforcement posture as the data-reliability contract. The steward's Feishu group survives `end` like every chatroom group (no dissolve API) but its session is cleaned with the room.

## Testing

`engine-chatroom-steward.spec.ts` pins the steward pre-spawn (parentage, flags, group name, alias key, workspace gating); `engine-chatroom-gather.spec.ts` pins the priming flow (needs gather, steward prefetch, ledger, claim partition, the no-workspace omission); `engine-chatroom-end.spec.ts` pins the executor-subtree cleanup (the steward, recursive fetchers at depth, preserved HTML renderer subtrees) and the hub pointer clear; `adapter-persona.spec.ts` and `chatroom-persona.spec.ts` pin the new preamble and contract discipline text. Full suites for both packages pass (244 + 2795 tests).

## Related

[chatroom research assistants carry hard data-reliability constraints](2026-08-27-feishu-bridge-research-data-reliability.md) owns the source-quality discipline of the same preamble; [research assistants keep cwd discovery](../bug-fix/2026-08-25-feishu-bridge-research-assistant-workspace-relocation.md) owns the shared-workspace placement the steward reuses.
