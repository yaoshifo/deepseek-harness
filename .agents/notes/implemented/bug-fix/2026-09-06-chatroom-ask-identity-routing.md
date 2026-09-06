# Agent Note: Chatroom ask-identity routing — replies route by identity, not gate inference

Status: implemented

English | [中文](2026-09-06-chatroom-ask-identity-routing.zh.md)

## Problem

The relay answered "which ask does this reply belong to?" by inference: a one-shot gate (`chatroomAsked`, armed at ask, consumed at the first turn end) plus a gather-seq stamp for stale detection. Three incidents share this root cause. 2026-09-02 oc_e51a: a deferred research conclusion turn stranded its armed gather until the research timeout. The stale guard itself: only armed-gather seq mismatches were detectable — serial re-asks (askSeq 0) were invisible. 2026-09-06 oc_97be4a1c (same run as the wake-chain freeze): after the round-3 gather timed out, the moderator serially re-asked marks at 09:55; marks' still-running round turn ended at 09:56 and consumed the re-armed gate, so the serial ask's own answer turn hit the consumed-gate early return and was dropped wholesale — the content survived only because marks had also written the list to a file. Two further gaps: a serial ask carried no deadline anywhere (the plain-chatroom analog of the freeze — a silently hung role stalls the room forever), and a restart left outstanding serial asks invisible to recovery while `endChatroom` could only guess in-flight state from a non-persisted flag.

## Decision

- **Every ask mints an identity** from the hub's shared `chatroomGatherSeq` counter — gather rounds and serial asks share one id space. The id rides the turn-message metadata and is stamped on the session at turn start (the existing stamping hook).
- **A serial ask registers a durable entry** (`pendingSerialAsks`, keyed by role name: `{ id, question, armedAt, lastWakeAt, wakeCount }`) persisted through the codec with the key riding the entry.
- **Turn-end routes by identity**: a stamp matching the armed gather enters the fan-in (an armed end barrier drains every stamped turn first); a stamp matching the role's outstanding serial entry relays, wakes the moderator, and completes the entry; a stamp matching nothing outstanding is a superseded/late turn — relayed as a free reply (card + ledger), consuming no gate and clearing no in-flight flag (the newer ask owns it).
- **The one-shot gate survives as the answered-latch.** A metadata-less wake (an assistant report opening the deferred conclusion turn) inherits the persisted identity; resetting the stamp to 0 on such turns would strand deferred research rounds — the existing "zero metadata keeps the round" test pins this. The gate is no longer the correlation mechanism, only the completion bit.
- **Supersede rules**: a new gather round retires every serial entry (their turns free-relay instead of being absorbed as round answers); a repeat serial ask to the same role replaces its entry; a mid-gather steer belongs to the armed round — it stamps the round's seq and its reply counts as the round reply (no new identity); a steer to a free role mints and stamps directly, because steer never opens a turn.
- **The stall supervisor gains a second relation class** — outstanding serial asks — with the same three-layer discipline (evidence gates including `researchAwaitingAssistant`-gated assistant waits, an organic role-activity clock `roleActivityAt`, a breaker notice per window). Plain chatrooms get their first deadline; `assistantStallSec` now governs every supervised relation.
- **Restart recovery retires restored entries** with one bounded wake each ("re-ask or move on"), mirroring barrier recovery — never wait for a reply whose turn died with the process. Retiring at recovery also keeps `endChatroom` from draining dead turns through entries that describe dead work.
- **The research progress card is the single projection of barrier state**: a 60 s heartbeat PATCHes the live card with waiting roles and elapsed minutes; live updates coalesce through a 2 s merge window; terminal states bypass the window and land immediately; `startedAt` rides the durable barrier snapshot.
- **RECORD.md rotates** past 64 KB into line-boundary `RECORD-<n>.md` archives (archive written first — a crash window may duplicate into the next archive number but never loses data), and the ledger-read prompt points roles at the tail plus archives.

## Alternatives considered

- **A per-role epoch counter** (the first design): still version-inference patchwork layered on the gate; collapses during design review because steer and serial re-ask each need their own exemption.
- **Retire the gate for pure registry routing**: a metadata-less wake turn has no identity to route by; the deferred-research flow requires inheriting the persisted identity. The gate stays as the latch, and the registry owns correlation.
- **Armed timers as the serial-ask deadline**: restart-fragile and against the supervisor's level-triggered design ("no armed timers to lose across a restart").
- **Stop missing roles' turns at gather timeout**: destroys deep-research work; the late reply's free relay preserves it.
- **Prompt-level "do not re-ask a busy role"**: advisory; prose promises are exactly what failed in the freeze incident.

## Consequences

- Tests pin the full routing table (non-ask silence, fan-in, serial completion, free relay), the 2026-09-06 repro end to end (both replies delivered), mid-gather steer round attribution, gather-supersedes-serial, entry completion with post-answer silence, entry persistence and restart retirement with a bounded wake, every supervisor evidence gate plus the breaker, and the heartbeat/merge/terminal-bypass card behavior.
- Disclosed behavior changes from Go parity: a steer reply now counts as the round reply through the round's identity (the old comment's absorb-through-gate-rearm is replaced); a gather superseding an outstanding serial ask leaves the late reply as a free reply instead of absorbing it as a round answer; a superseded turn no longer clears `chatroomInFlight`.
- Known behavior: two queue-delivery serial asks to the same role before the first turn runs — the first reply free-relays (content never dropped, form differs).
- `endChatroom` drain detection and the gather-timeout status text still read in-flight state; the supersede rule keeps that state owned by the newest ask.
- Deployment: bridge rebuild + `/reload`; verification lines in the journal are `chatroom: supervisor woke stalled moderator about serial ask`, `chatroom: retired restored serial ask after restart`, and the heartbeat PATCH cadence on the live research card.
