# Agent Note: Eight postmortem fixes from the 2026-09-13 chatroom session

Status: implemented

English | [中文](2026-09-14-chatroom-session-postmortem-fixes.zh.md)

## Problem

The 2026-09-13 「闲钱定投」 chatroom run (ledger `f64eb48bd04b26b0`) completed cleanly — 81 sessions, zero errors, full closed loop — but the postmortem triage surfaced one engine bug and a cost/robustness tail:

1. The first closing ask card (02:13:09) was consumed 3 seconds later as a "free-text answer" by the HTML-render subtask's formal report (hub log seq 287/288): `routeAskResponse` accepted any inbound text while an ask was parked, including machine-injected subtask receipts. The card became dead; only the supervisor's 60-minute re-wake recovered the room.
2. Every pre-render-eligible reply forked an LLM render session — 43 of the run's 81 sessions (53%) existed to distill replies that were already small enough to deliver as-is (~0.83M input + ~1M cache per run).
3. Lightning-round polls minted one-shot sessions for the whole role library with LLM title generation on (~23 wasted title calls per run), the poll worker pool serialized a 9-seat closing round over ~10 minutes, and plain-mode rooms had no supervisor coverage: a lost gather wake froze the room silently (barrier cleared before the wake, `reconstructReplyCtx` failure only warned).
4. Subtask results were delivered twice verbatim (runtime send_message + formal report), one-shot sessions carried no parent lineage (triage attributed them by timestamp archaeology), the ledger duplicated section headings, `SYNTHESIS.md` replaced its body without archiving, pre-start poll rows leaked into the next run's ledger, `SessionManager.save()` rewrote the whole registry on every state change (several times per chatroom turn), the supervisor tick was a hardcoded constant, and the stall breaker posted one group notice per window forever.

## Decision

- **Machine messages never answer a parked ask** (`routeAskResponse` returns `false` for `machine: true`); the exemption order sits behind the followups-card one. All internal injection paths were audited to carry the machine flag — `spawnSubtask`'s synthetic first message was the one bypass and now sets it. `/spawn`'s equivalent first message stays unflagged: it targets a brand-new session key that cannot have a parked ask.
- **Reply rendering stays fork-only**: the length tier this batch shipped (`planRenderDirectLen`, default 2000 runes) was reverted before deployment — see [the revert note](2026-09-14-reply-render-tier-revert.md) — because the direct fragment broke the template contract (no `.wrap` padding, no `<h1>` title) and duplicated the completion card verbatim. Every ≥500-rune reply forks a render session; the mid-reply fork cost stays an open item.
- **Poll one-shots keep memory, drop titles**: `pollQuery` runs with `origin: 'oneshot'` (no LLM title, hidden from /list) and re-injects the role-directory memory index in the session's own agent scope, because the dsh-memory plugin hard-disables injection for any non-undefined origin. The worker pool cap stays a config value (`pollMaxConcurrent`).
- **The report dedup observes the runtime relay**: the adapter forwards relayed `agent-message` user events on live sessions to an engine-registered notifier (`AgentDirectMessageSource` capability → `noteAgentDirectMessage`); a formal report whose body is verbatim-identical to the child's last direct message injects a one-line status while the parent-facing card keeps the full text.
- **A completed gather is durable until consumed**: the hub records `completedGather {seq, wakeContent, completedAt}` when a round settles (or times out, or its broadcast fails, or a restart restores it); the moderator's next turn-start consumes it, and the supervisor's new sweep branch re-wakes a stalled completed gather in plain rooms too — three wakes, then the breaker notice under the notice cap.
- **One-shot lineage rides the native header**: `pollQuery` and `renderQuery` pass the originating chat's native session id as `parentSession`; the bridge registry links through the hub's `agentSessionID`.
- **Ledger hygiene**: a leading heading restating the section name is stripped from `SUBPROBLEMS` bodies; a replaced `SYNTHESIS` body is archived to `SYNTHESIS-HISTORY.md` under the same serialized write chain. Pre-start poll rows keep landing in the next run's ledger (documented as a Known Limitation — the picker's cancellation points are scattered with no shared cleanup hook).
- **Hot-path and noise discipline**: `SessionManager.save()` debounces into one trailing write per second with `flushNow()` on dispose and beforeExit (internal mutators stay synchronous); the supervisor tick (`superviseTickSec`, default 60) and the breaker notice cap (`supervisorBreakerNoticeCap`, default 2) are config fields; past the cap the breaker only logs until organic activity re-arms it.

## Alternatives considered

- **Queue machine receipts while an ask is parked, deliver after resolution.** Rejected as the primary fix: the parked turn's queue belongs to human conversation flow and has a length cap — a machine message that must never answer the ask also must not silently die at the cap. The flag exemption keeps the existing queue/steer semantics.
- **Skip the render fork entirely (write every reply directly).** Rejected: long replies genuinely need the distillation card; a single threshold keeps that while deleting the flood.
- **Track gather completion on the gather object itself.** Rejected: seven-plus `pendingGather` guards read "present = in flight"; a separate durable `completedGather` field on the hub state leaves that semantics untouched.
- **Engine-side deletion of leaked pre-start poll rows.** Deferred as a Known Limitation: it needs a durable per-hub line ledger plus hooks across the four picker cancellation paths, and still misses the "settled, then abandoned via restart" window.

## Consequences

- Tests: `engine-ask-machine.spec.ts` (machine exemption + human/card regressions), `plan-render-fork.spec.ts` (reply fork contract + render parent lineage), `adapter-agent-message.spec.ts` (relay observation), `subtask-report-dedup.spec.ts` (dedup + engine wiring), `session-save-debounce.spec.ts`, `adapter-oneshot.spec.ts` (poll origin + memory re-injection + parent links), `chatroom-ledger.spec.ts` (heading strip, synthesis archive), `engine-chatroom-supervise.spec.ts` (tick config, breaker cap, completed-gather re-wake), `engine-chatroom-gather.spec.ts`. Merged-tree suites: 198 files, 3444 passed.
- Deployment: host build + `/reload`; production raises `pollMaxConcurrent` to 14 (the role library size) in the profile patch. Live signals: polls with no title-generation calls, `chatroom: supervisor` lines only on genuine stalls.
- Known limits: the dedup record is in-memory only (a restart between direct message and report re-delivers the full text — harmless); the mid-reply render-fork cost is open (see the revert note above); serial-ask breaker notice counts live per entry with no organic reset (the entry's retirement resets them); pre-start poll rows still leak into an abandoned next run's ledger.
- A future chatroom run should re-check: poll statements still draw on persona memory, closing asks survive concurrent subtask reports, and a deliberate wake loss recovers within one stall window.
