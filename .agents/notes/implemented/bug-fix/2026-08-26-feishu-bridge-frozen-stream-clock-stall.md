# Agent Note: feishu-bridge orphan pump pinned forever by a frozen stream clock

Status: implemented

English | [中文](2026-08-26-feishu-bridge-frozen-stream-clock-stall.zh.md)

## Problem

The 2026-08-26 evening session of chatroom hub oc_b46da516 (bot 教学驴, workspace `/home/hm/workspace/books`) hung permanently mid-discussion. Timeline: the moderator's turn ended cleanly at 19:03:46 ("question sent to popper, will wait"); the unsolicited reader opened an orphan-turn pump at 19:04:31 on a stray substantive channel frame with no engine-woken turn behind it (the spillover relay is disabled by default, `unsolicitedSpilloverGrace = 0`); the runtime projected one later frame at 19:05:49 the pump never consumed, freezing `AgentSession.lastStreamActivity` 8 seconds newer than the pump's `lastEventAt`. Every later wakeup then queued silently behind the session lock the pump held — the chatroom role-reply relay's `receiveMessage` (19:06:12, popper's reply card rendered but no moderator turn), the native subtask's report, and any user message (`queueMessageForBusySession` replies a queued hint and starts no turn). No watchdog fired: `stallConfirmed`'s blind-pump guard ([introduced for oc_29bb](2026-08-25-feishu-bridge-ask-interrupt-blind-stall.md)) compared the two frozen clocks (`streamLast > lastEventAt` holds forever), and the hard turn cap is enforced only on event arrival — a turn receiving no events never reaches the check. The 19:25:41 journal line `stall check overridden: agent is streaming but the pump saw no event (last pump event 1200s ago, last stream event 1192s ago)` is the guard firing on clocks that had both been frozen for twenty minutes. The pump itself was [the oc_9956 orphan-turn pump](2026-08-23-feishu-bridge-orphan-turn-pump.md); its admission of any substantive frame is unchanged — what was missing was mortality.

Discriminating signature for future triage: an `engine: orphan turn pump started` line with zero session-log events after it, recurring `blind pump` warns at the idle cadence whose two timestamps stop moving, and a queued hint in the chat for every subsequent message. Recovery pre-fix: a stop-family command (dispatched before the lock) or a daemon restart.

## Decision

- `Engine.stallConfirmed` shields a pump only while the stream is fresh: the blind-pump guard now additionally requires `now - streamLast < idle`. A stream that itself went quiet for the whole idle window is a frozen clock pair, not streaming; the stall confirms and the existing retry/kill machinery terminates the pump turn. The hang is bounded by about one extra idle cycle after the stream goes quiet (the oc_29bb protection is unchanged: an agent projecting continuously keeps refreshing `streamLast` and is never killed by an idle fire).
- The orphan-pump start log names the first event it opened on (`first event <type> [tool name]`), so the next incident's trigger frame is identifiable in one journal line instead of a forensic reconstruction.

## Alternatives considered

- **Gate the pump's first event** (for example, refuse a `tool_use` with no turn evidence). Rejected: a legitimate engine-woken turn may project a tool call first; frame identity cannot distinguish a stray echo from a real wake at arrival time. The missing invariant was pump mortality, not pump admission.
- **Timer-based hard turn cap** (fire the cap without event arrival). Rejected for this change: with the freshness guard every quiet turn terminates via the idle→stall path, and a second overlapping watchdog changes semantics for every turn; the arrival-gated cap matches Go. Revisit only if a no-event hang reappears through another path.
- **Shorten `unsolicitedToolInFlightTimeout`.** Rejected: the 30-minute budget is legitimate for a genuinely running background tool, and this incident cycled on the 10-minute event idle anyway; operators can tune `toolInFlightTimeoutMs` per profile without a code change.

## Consequences

- A frozen-clock pump turn now terminates at worst about two idle windows after the stray frame; during that window later messages queue with the queued hint instead of vanishing, and drain once the lock returns.
- The stall-retry path may restart an agent that was healthy-but-quiet; this is bounded by `stallMaxRetries` as before, and only after the stream has been silent a full budget.
- Residual: the exact source of the 19:04:31 stray frame (turn-B tail racing the pump exit, or a synthetic projection) remains unidentified; the enriched pump-start log will name it if it recurs.
- Covered by `tests/engine/engine-ask-interrupt.spec.ts` (frozen pair confirms the stall), `tests/engine/engine-unsolicited.spec.ts` (stray-frame pump terminates, releases the lock, and clears the interactive state), and `tests/engine/engine-stall-retry.spec.ts` (a quiet post-recovery pump terminates instead of cycling forever — its old final assertion pinned exactly this immortality).
