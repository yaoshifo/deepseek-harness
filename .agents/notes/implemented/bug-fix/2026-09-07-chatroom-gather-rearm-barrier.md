# Agent Note: Chatroom gather re-arm barrier — a timeout buys one more window before free relay

Status: implemented

English | [中文](2026-09-07-chatroom-gather-rearm-barrier.zh.md)

## Problem

The 2026-09-06 auto-mode research round-1 incident: the hub's 5-role chatroom gather collected only 1/5 at the 1200 s timeout, and `fireGatherTimeout` destroyed the barrier while partially waking the moderator. The moderator ended its turn on the reasonable assumption "the remaining roles' reports will wake me when they land" — but the 4 late deliveries (all on disk 5-10 minutes past the timeout) hit the ask-identity router as superseded asks (`turn from a superseded ask; relayed as free reply`): group-visible relay cards, never injected into the hub, never waking anything. The stall supervisor needed 30-60 more minutes to drag the room back; net loss ≈ 60 minutes. The structural flaw: the barrier's timeout conflated "the window elapsed" with "no reply will ever arrive", and the superseded-ask degradation — correct for genuinely stale rounds — silently ate replies that were merely minutes late against a barrier nobody re-armed.

## Decision

- **A timed-out gather re-arms once instead of destroying the barrier** (`fireGatherTimeout` in `packages/acp/feishu-bridge-chatroom/src/engine/chatroom.ts`): on the first timeout the still-missing roles' expected set stays armed, the fallback timer restarts at `gatherRearmSec` (default 1200, a `Config` field overridable from `cordis.patch.yml` through `defaults`/per-project `projects`), and the moderator gets a partial wake whose prefix (`chatroom_gather_rearmed`) states the re-arm contract — late replies keep funneling in, a second wake comes either with every reply or, on window lapse, with whatever arrived. Late replies need no new routing: with the barrier alive the ask stamp still matches the round, so `maybeAutoRelayRole` takes the existing gather fan-in path (`chatroom: gathered role reply (waiting for more)` → `chatroom: gather complete; woke moderator with all replies` with the batch-injected summary).
- **The second timeout is the real degradation**: `timeoutFire` runs its original path — barrier destroyed, progress card terminal, partial wake with the named missing roles — and replies landing after that fall to the pre-existing superseded-ask free relay. One re-arm per round (a `rearmed` flag on the barrier) bounds the total wait at ≈ 2× the gather timeout; no infinite renewals.
- **The `rearmed` flag persists in the barrier's `featureState` snapshot** (aligned with the supervisor's recoverable design, 2026-09-06 wake-chain-freeze): restart recovery still closes a restored gather at once — no role turn survives a restart, so a restored barrier never re-arms a window, and the persisted flag keeps a mid-window restart from restarting the re-arm budget on any future path that does restore timers.

## Alternatives considered

- **Prompt-level fixes** ("moderator: wait for late replies before summarizing"). Rejected by the plan: advisory prose is exactly what failed in the incident — the moderator's assumption was already reasonable; nothing owned the window that would honor it.
- **Lengthen `gatherTimeoutSec`.** Taxes every round for the few that run late; a late-by-minutes reply still dies against a barrier destroyed at any fixed timeout.
- **Re-arm the barrier through the ask-identity router (treat late replies as fresh asks).** The superseded-ask router is what misrouted the deliveries; routing around it per-role duplicates correlation the round stamp already provides, and the free-relay degradation outside the window is kept deliberately.
- **Extend the subagent package's generic gather barrier.** Out of scope by plan: the generic parent-side gather has its own timeouts and consumers; the incident is chatroom-specific (role turn-end relays against a hub barrier).

## Consequences

- Tests pin the full behavior ladder: first timeout re-arms (barrier identity preserved, expected set intact, re-arm timer armed, partial wake carries the re-arm notice naming the missing role); late deliveries inside the window funnel through the gather path (waiting-for-more journal fingerprint, no extra wake) and the last one wakes the moderator with ALL replies batch-injected; the second timeout destroys the barrier, later replies relay as free replies, and no third window ever exists; a configured `gatherRearmSec` drives the armed timer (a 1 s window burns at +1 s); the snapshot carries `rearmed` and a restart mid-window closes the round once with the collected replies, waking nobody after; the supervisor's armed-barrier evidence gate (both relation kinds) keeps covering the re-armed window unchanged, so the supervisor cannot preempt a live re-arm.
- The first-timeout wake is a new model-visible input riding the existing `wakeChatroomModerator` path; its text must keep telling the moderator not to re-run the round while the window is live (the `gatherRoles` in-flight guard would reject it anyway).
- End/interrupt guards see the re-armed window exactly like the original one: `endChatroom` keeps rejecting while `pendingGather` is armed (`force: true` remains the escape hatch), and `/chatroom stop` still consumes barriers.
- Total worst-case round wall time grows from 1× to ≈ 2× the gather timeout for rounds that run late; rounds that complete in-window are unaffected. Research progress cards stay live through the re-arm window (the barrier is still waiting), which also keeps the interjection hint in front of the user.
- Deployment: bridge-chatroom plugin rebuild + `/reload`; the config default requires no `cordis.patch.yml` change, and the new field is overridable per project like every other chatroom tuning field.
