# Agent Note: chatroom mid-run participation — interjection hint, per-round sync, interjection handling

Status: implemented

English | [中文](2026-09-02-feishu-bridge-chatroom-midrun-participation.zh.md)

## Problem

Research mode (`--research`, auto) was a participation dead zone. A dev-server session (2026-08-30/31, hub `oc_2edeb9831b39b7d855bb93b67a873358`, Beijing housing prices, 5 roles × 3 rounds, 22:24–03:08) recorded exactly one user interaction — the role-pick confirm — then zero human messages for 4.5 hours; the wrap-up `ask_user_question` posted at 03:07 was never answered and the room never ended. Three gaps, none of them engine capability:

- Interjection was undiscoverable: a plain hub message always woke the moderator as a normal user turn, but no card, command, or prompt said so.
- Research priming had no interjection-handling clause — normal mode's 「人类发言时，把它融入讨论」 had no research counterpart, so a mid-run user message met an unprepared moderator.
- Auto mode's round boundaries were silent by design: the priming hands iteration judgment to the moderator alone; manual mode asks the user each round, auto mode asks nothing.

## Decision

Three text-level additions; no engine, tool-schema, or event changes.

- **Interjection hint on the two cards users watch** (new i18n key `chatroom_interject_hint`, en/zh): the hub ready-summary card (beside the ledger note, `afterChatroomStarted`) and the live research progress card body (`buildResearchProgressCard`, live state only — terminal states keep their own text).
- **Auto-mode per-round sync** (research priming, auto branch): after each round's synthesis is written to the ledger, one plain reply to the user — a one-line picture plus what the next round digs into; no card, no waiting, no pausing. Manual mode keeps its per-round ask cards, so it gets no sync clause.
- **Interjection handling** (research priming, shared by both modes): a mid-run user message folds into orchestration — questions go to the relevant role via `ask`, new information and direction changes fold into the next gather task; never ignore, never abort an in-flight round.

## Alternatives considered

**Wrap-up card timeout fallback (the round's original P1a)**: arm the research-manual 10-minute whole-ask auto-default (`armResearchManualAskTimeout`) on auto-mode hubs too, defaulting the four-option menu. Rejected after owner review: the owner clicks cards and knows free text answers them, so the misrouting rationale was withdrawn; and neither default choice cleans anything — the bridge has no group-dissolve API at all (no `im/v1/chats` DELETE call exists), so `end` leaves the same ten role/assistant groups in place, merely grayed. The residual value (a daemon restart kills a parked ask and the stale-card hint misdirects) did not carry the change; both facts are recorded in the README limitations instead.

**In-round steer or pause**: the moderator's turn ends when a gather is in flight (the tool result says so), so nothing in-round can act on a steer, and a serial `ask` during an armed gather has interleave hazards — a busy role's reply never relays (its gate is consumed), an idle role's reply is absorbed as its gather reply. Round boundaries are the only safe participation points.

## Consequences

- Auto mode still ends silent-or-clicked: the wrap-up card waits indefinitely, a restart kills it, and role/assistant groups accumulate — all documented as the new README Known Limitations entry.
- The per-round sync adds one moderator message per research round in auto mode; the hint rides cards that already existed, so the message volume change is bounded.
- Keyless recorded-session snapshots for the chatroom surface remain blocked (the corpus has zero chatroom cases; carried from the 2026-08-31 scan3 round). Behavior is pinned by the four new specs: the progress-card hint (live only), the ready-card hint (with the ledger note), the auto-only sync clause, and the both-modes interjection clause.
- Follow-ups recorded in the plan and README: bridge group-dissolve capability (the root cause of group accumulation), idle room reaping, the `askq_stale_question` copy misdirecting on restart-dead cards, the ask-during-gather interleave, the missing repeat-gather guard, and the 60-minute default research timeout (the dev-server session hit it every round behind anti-crawl throttling).
