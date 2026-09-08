# Agent Note: The pick watchdog defers through the ranking leg; a dropped pick-roles is reported as dropped

Status: implemented

English | [中文](2026-09-08-chatroom-pick-watchdog-race.zh.md)

## Problem

The 2026-09-08 oc_9b99fe794e82aeec4bceb077f9cc784e incident (vault hub 「知识驴 副本」, topic 美股定投): the role-pick watchdog fired one second after the opening poll settled. The timeline from the daemon journal and the moderator session log:

1. 23:08:16 the discussion group spawned; `beginChatroomPick` armed the 5-minute fallback watchdog.
2. 23:09:31 the moderator dispatched the opening poll (14 roles); it settled 14/14 at 23:13:51 and woke the moderator to rank.
3. 23:13:52 the watchdog fired with the poll no longer in flight, so its only defer condition (`hasActiveChatroomPoll`) did not apply: it painted the fallback card — every role listed, none recommended, no blurbs.
4. The user toggled 5 roles on that card (`userTouched = true`).
5. 23:16:03 the moderator's `pick-roles` arrived (2m12s of ranking at `reasoningEffort: max` — normal generation latency, not a stall) and the `userTouched` guard dropped it by design.
6. The tool still returned the canned success text ("the role-selection card has been rendered"), so the moderator told the user a recommendation card with 9 preselected roles had been sent — false.

The user's manual five picks were all inside the dropped nine and the discussion started normally at 23:23:51; the casualties were the recommendation ever reaching the card and the moderator reporting truthfully.

## Root cause

The designed pick flight (opening poll ≈ 4.5 min + ranking ≈ 2 min) exceeds the 5-minute watchdog window counted from arming, and the defer condition protected only the poll leg. The gap between poll settle and `pick-roles` arrival — the ranking leg — had no protection, so any watchdog expiry landing there painted a no-recommendation card that invites the user to start selecting, after which the guard must drop the real picks.

## Decision

Two changes in `packages/acp/feishu-bridge-chatroom`:

1. **Defer through the ranking leg.** `wakeChatroomModerator` stamps the per-hub wake time (`lastChatroomWakeAt`), and the pick watchdog now defers while the poll is in flight **or** a wake is inside one window: every wake re-opens a full timeout for the wake→`pick-roles` leg. The fallback card lands no earlier than one window past the moderator's most recent wake. No timer registry and no `chatroom.ts` → `chatroom-pick.ts` back-import — the lazy defer reads the stamp at fire time, keeping the existing one-directional import.
2. **Report a dropped pick as dropped.** `renderChatroomPickCardAndPush` returns `'rendered' | 'ignored-user-selecting'`, and the `pick-roles` tool result for the ignored case states that the picks were not applied to any card, forbids claiming the card shows them, and suggests naming the recommendations in text instead.

## Alternatives considered

- **Eagerly reset the watchdog at poll settle.** Requires `chatroom.ts` to call into `chatroom-pick.ts` (import cycle) plus a per-hub timer registry; the lazy defer achieves the same window with one timestamp.
- **Merge late recommendation badges into the user-touched card.** Rejected for now: it changes what the card the user is actively editing means mid-selection; deferred until an incident asks for it.
- **A longer fixed timeout.** Still races — poll duration scales with the role library.

## Consequences

- `tests/engine/engine-chatroom.spec.ts` pins both watchdog timings under fake timers (fires one window after arming with no wake; stays `picking` past the original deadline after a wake, fires one window past the wake) and the return-value contract; `tests/tools/chatroom-tool.spec.ts` pins the honest ignored-case message.
- `tests/engine/chatroom-poll.spec.ts`'s post-settle expectation changed with the behavior: the settle wake now owns a full window, so the fallback renders one window past the wake rather than at the next expiry.
- The topic picker (`pick-topic`) keeps the same canned-success pattern over an identical `userTouched` drop and is not covered by this change; deferred.
- Deployment: bridge rebuild + `/reload`.
