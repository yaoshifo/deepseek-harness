# Agent Note: chatroom armed-gather interlock and the split askq stale hint

Status: implemented

English | [中文](2026-09-02-feishu-bridge-chatroom-followup-guards.zh.md)

## Problem

Three hazards from the 2026-09-02 mid-run participation investigation, authorized as follow-ups:

- **A repeat gather overwrites an armed barrier**: `gatherRoles` guarded only the end barrier and a pending ask-human; a second gather while `pendingGather` was armed replaced the barrier object — the old round's timer, expected set, and collected replies were dropped while its roles kept generating against a barrier nobody held.
- **A moderator `ask` during an armed gather loses the answer either way**: a busy role's reply never relayed (the gather question had already consumed the one-shot relay gate), an idle role's reply was absorbed as its gather reply.
- **The askq stale hint misdirected when no ask was parked at all**: one copy (`AskqStaleQuestion`, "the question list has changed — answer the current question in text") served both a live ask whose question list changed and a card whose ask was gone entirely (answered, superseded, or lost to a restart) — in the second case there is no current question to answer.

## Decision

- `gatherRoles` fails loud on an armed `pendingGather` (`Msg.ChatroomGatherInFlight`): the armed barrier and the seq are preserved untouched.
- `askRole` fails loud on an armed `pendingGather` (`Msg.ChatroomAskGatherBlocked`), with copy that names both alternatives — ask after the round wakes you, or fold the question into the next gather task. Safe for the ask-human reply routing path: a pending ask-human and an armed gather are mutually exclusive by the existing two-way guards, and `routePendingHumanReply` falls through when a gather is armed.
- The stale copy splits by site: `AskqStaleCard` (no parked ask — the hint points at plain chat) for `staleAskqCardAction`, `AskqStaleQuestion` (live ask, question list changed) stays inside `routeQuestionResponse`.
- The research round-cap specs that chained rounds via the old barrier-overwrite behavior now clear the barrier between rounds, mirroring the engine's completion flow; the cap semantics they pin are unchanged.
- `researchTimeoutSec: 7200` set in both live profiles' chatroom `defaults` (Mac + dev server): the 60-minute default timed out every round of the 2026-08-30 Beijing-housing session behind anti-crawl throttling, each round actually taking 73–80 minutes.

## Alternatives considered

**Make ask-during-gather work instead of rejecting it** — queue the ask behind the barrier and relay its answer separately. That is a second in-flight-ask lifecycle per role plus new relay semantics; the reject-and-guide copy reaches the same user outcome through the next round boundary at a fraction of the machinery.

## Consequences

- The moderator's mid-gather steering attempts now get an explicit error instead of silent loss; the timeout-based chase flow (催收) is unaffected — `fireGatherTimeout` clears `pendingGather` before waking the moderator.
- Both new guards are model-visible error strings pinned by specs; no engine state, tool schema, or event changes.
