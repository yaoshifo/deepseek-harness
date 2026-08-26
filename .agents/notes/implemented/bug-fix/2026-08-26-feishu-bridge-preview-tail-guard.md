# Agent Note: feishu-bridge preview tail guard — nothing displaces the active card

Status: implemented

English | [中文](2026-08-26-feishu-bridge-preview-tail-guard.zh.md)

## Problem

Production incident 2026-08-26 (the marks role group `oc_eae876d91b979c82fb5a348641742766`): the moderator ask card 「主持 → marks」 landed at 20:22:43.611, on top of the tool-process card created 23ms earlier (20:22:43.588), and nothing pushed the card back for over six minutes — the sidebar thumbnail stayed on the ask card, losing the "agent is still working" signal. The root cause is an enumeration defect of the push model: `bumpToEnd` was wired only to `im.chat.updated_v1` (rename/avatar), while engine-originated cards (chatroom ask/relay, research progress, subtask settlement, cron notices) never triggered it; `askRoleInternal`/`relayRoleReply` fire their card un-awaited immediately before injecting a turn, so the placeholder card races the card over HTTP — either same-second ordering loses. Human messages, member-change system messages, other bots, and manual lark-cli sends produce no event at all, so there is nothing to push from. The engine-level single-slot `activePreview` binding also gets overwritten under concurrent streams (hub + roles + research assistants), mis-routing bumps.

## Decision

Flip the model: the active preview verifies its own tail position periodically (pull) instead of enumerating senders. `StreamPreviewCfg.tailCheckMs` (default 5000, 0 disables); the guard arms its own `tailTimer` when the card is created (first send succeeds in `flushLocked`); each tick checks the terminal state first (the same guard list as `bumpToEndLocked`, plus `finished`) and disarms by not rescheduling when terminal; otherwise it calls the platform capability `PreviewTailProber.previewIsLatest(handle)` off the lock (the Feishu implementation is `message.list(ByCreateTimeDesc, 1)` compared by message_id; thread handles skip — a card inside a topic is meaningless against the root-chat tail). When not latest, the existing `bumpToEnd` deletes-and-resends back to the tail, and the next tick is scheduled only after a locked terminal re-check. `finish()` latches `finished` and disarms at entry: its delete paths neither clear `previewMsgID` nor set a terminal flag, so an in-flight tick would resurrect the deleted card. `resumeFromFreeze()` re-arms (a freeze reads as terminal and disarms naturally). The rename/avatar 2s push bump stays as the fast path.

## Alternatives considered

**Point-by-point push patches (await the card send, then bump, plus per-session engine routing).** Rejected: the trigger set is an enumeration of engine send sites, and this very incident was a missed entry; event-less system messages and external sends can never be covered; the change also scatters across engine/chatroom/commands with higher reorder risk. The pull trigger set is "the chat tail state", decoupled from message origin, so future feature cards are covered automatically.

**Event-level immediacy.** Accepted cost: pull converges per period (at most one check period of wrong display) instead of an event guarantee; each active chat costs one `message.list(pageSize=1)` per period (default 5s ≈ 0.2 QPS per chat, ~1.4 QPS across a ~7-chat research war room); a probe failure only slows healing.

**Human-message exemption.** The `listMessages` response carries a sender, so "skip when the displacer is a human user" is one line away; not exempted by default — the "always newest" semantics demand full coverage, leaving the refinement as a follow-up switch pending experience feedback.

## Consequences

Whatever message displaces the active card, it returns to the chat's newest position within one check period; terminal cards never resurrect (keeping the [parked-ask incident's guard semantics](2026-08-25-feishu-bridge-done-during-parked-ask-stray-card.md), with `finished` closing the finish-delete-path gap). Known boundaries: an active card manually recalled by the user is resurrected each period until the turn ends (upgrade path: mark the preview degraded from the `recalled_v1` hook); thread-isolated deployments skip the guard; two streaming bots in one chat would reissue over each other (no such single-bot-topology gap today). engine.ts / chatroom.ts / commands.ts are untouched — the agent execution path stays fully decoupled.

## Testing

`tests/streaming.spec.ts` "tail guard": displaced-then-healed with no further reissue while latest, still-latest cycles reissue nothing, the finish latch never resurrects the deleted card, discard disarms, a probe failure skips the cycle while the guard keeps watching, no capability or a zero period never arms, freeze disarms and `resumeFromFreeze` re-arms. `tests/feishu/preview-tail.spec.ts`: newest-first single-item query compared by message_id, empty chat reports latest, a thread handle skips the query, a non-handle argument rejects. The package suite passes 2403 tests.
