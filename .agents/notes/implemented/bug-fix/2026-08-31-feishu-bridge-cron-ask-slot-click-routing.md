# Agent Note: feishu-bridge cron slot ask cards answer bare-key clicks and abort settles the parked ask

Status: implemented

English | [中文](2026-08-31-feishu-bridge-cron-ask-slot-click-routing.zh.md)

## Problem

The 2026-08-31 cron-fbe6d268 pre-market check (session mode `new_per_run`) parked its turn on `ask_user_question`, sent the multi-select follow-up card, and the user clicked options 1, 3, 4 — after which the run hung silently. The session log ends at the ask `tool/call` (no `tool/result`), followed by `agent/inbox/spliced` carrying the raw click payload `askq:0:1,3,4` with `target=next-turn`: the click had fallen through to the plain-message path and queued behind the very turn it was meant to settle. Circular wait — the turn waits for the ask answer, the inbox delivery waits for the turn to end — and the click text queued into the live agent session via the bare-key slot (whose `agentSessionID` the run's resume had bound to the cron agent session). Every weekday run since the [8/26 slot fix](2026-08-26-feishu-bridge-cron-ask-slot-routing.md) parked the same way (8/27, 8/28 tails identical: `turn/start` with no `turn/end`); only the click made it visible.

Root cause A: cards stamp the reply context's session key — the bare key — into `value.session_key` (`renderElement` via `rc.sessionKey`; the cron message's reply context carries the bare key), while the ask parks under the `#cron:` slot. `routeAskResponse` resolves the state by exact key, misses, and the click payload becomes an ordinary message. The 8/26 note's claim that the stamp routes the click back to the slot did not hold — corrected in place there.

Root cause B: nobody answering was no better. The scheduler's 30-minute timeout aborts the run (`cron: job failed (id fbe6d268): job timed out after 1800000ms` in the daemon log), and `onAbort` called `cancelTurn` — but a runtime turn-cancel never reaches the engine-side ask wait, so the parked turn (and the agent session) leaked live until a daemon restart. `/stop` cannot reach a slot state (exact-key stop), so restart was the only recovery.

Discriminating signature: a cron session log ending on an ask `tool/call` with no result, optionally followed by `agent/inbox/spliced` whose inserted text is a raw `askq:N:M` payload; `turn/start` count exceeds `turn/end` count.

## Decision

- `routeAskResponse` falls back to the newest `#cron:` slot state carrying a `pendingAsk` when the exact key misses, gated to card actions (`isAskqCardAction || isPermissionAction`) — free text stays on the exact key, since an ordinary chat message must not answer a parked cron ask. This is the answer side of the 8/26 fix: the asker-side prefix scan rejected there stays rejected (the asker cannot know the suffix), but a click names the chat's bare key unambiguously and only concurrent parked asks — the newest wins — can collide.
- `onAbort` fires `st.markStopped()` after `cancelTurn()`: the state's stop signal is what the parked ask's wait already races, so the ask settles cancelled through its own cleanup path (park cleared, no surface restart) and the run finishes at its execution timeout instead of leaking.

## Alternatives considered

- **Stamp the slot key into the ask card's callback values.** Rejected: it threads a routing key through every card builder and requires re-keying `permBodyCache`/`askqMetaCache` consistently at send and callback time, while Feishu `form_submit` callbacks may omit `action.value` entirely — the engine-side answer bridge is one contained lookup at the point of the miss.
- **Settle `pendingAsk` directly in `onAbort` (`pending.resolve`).** Rejected: resolving the decision promise makes the parked wait take the decided branch, which restarts ask surfaces on a dying state; the stop signal drives the existing stopped branch with its cleanup semantics instead.

## Consequences

- A cron run's ask or permission card click now answers the run's own parked ask regardless of which key the callback reconstructs; the card's frozen-answer rebuild stays keyed by the bare key on both the send and the callback side (unchanged).
- An unanswered cron run ends its turn cancelled at the job's execution timeout (default 30 minutes) instead of hanging forever — the whole-ask timeout the 8/26 note left unbuilt is covered for cron runs by the scheduler timeout; ordinary chat sessions keep the idle-reaper skip for parked asks.
- Free-text replies to a cron slot ask still do not route (Feishu asks are cards; only the plain-text platform fallback can hit this gap), and an in-range stale click on an older card answers the newest parked ask — the same class as same-key stale clicks.
- Covered by `tests/engine/engine-m3-askq.spec.ts` (bare-key askq click routes, free-text negative, bare-key permission click routes) and `tests/engine/cron-execute.spec.ts` (abort settles the slot-parked ask and finishes the run).
