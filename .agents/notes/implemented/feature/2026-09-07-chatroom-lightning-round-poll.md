# Agent Note: chatroom lightning round — every persona participates, only the core cast stays resident

Status: implemented

English | [中文](2026-09-07-chatroom-lightning-round-poll.zh.md)

## Problem

A chatroom discussion only ever involved the roles the moderator recommended at pick time: the #43 picker caps the spawned cast at `maxRoles` (default 5), the cast is fixed for the run, and the other personas in the roles dir (13 thinkers at the time of writing, growing as books finish) had no structural way to contribute — the moderator's recommendation came from skimming persona files, and a sidelined persona's unique blind spot never surfaced. Spawning all 13 as resident agents was the obvious non-fix: 13 Feishu groups per run, 13 sessions to supervise, and a full fan-out at every gather round (the gather timeout history shows single rounds already run 20-27 minutes under load).

## Decision

Participation splits into two tiers with different cost models:

- **Lightning round (every persona, every run)** — a new `poll` action on the `feishu_bridge_chatroom` tool. The engine sends each non-spawned persona one single-turn query through a new `pollQuery` capability on the agent backend (`ForkQuerierWithProvider`, adapter `oneShotQuery` with `toolFilter: { allow: [] }`): no group, no resident session, every tool masked at the engine level (a polled persona cannot start research — the constraint is enforced by the mask, not the brief), while the workspace instructions at the persona dir stay assembled so the CLAUDE.md persona loads exactly as resident role sessions load it. Role memory continuity is kept (the one-shot session runs without the `oneshot` origin, so the memory-index injection stays on; the LLM title call per throwaway session is the accepted overhead — swap to a `oneshot` origin later if that trade tips).
- **Core cast (≤ maxRoles resident agents)** — unchanged; the opening poll now feeds the recommendation instead of file skimming: the pick priming's first act is `poll(round: opening)` (stance / blind spot / willingness in one statement each), and the pick-roles recommendations must build on the collected statements. A closing sweep (`round: closing`) before the wrap-up asks sidelined personas — specifically those that self-marked 「想深聊」 — what the final picture still misses; both moderator primings (plain and research) carry the instruction, and the books-repo moderator `chatroom/CLAUDE.md` mirrors the tool contract (persona-side companion change, committed in that repo).

Engine mechanics (`chatroom-poll.ts`, `chatroom.ts`):

- The barrier mirrors `ChatroomGather`'s accumulate/forget/timeout shape but deliberately differs in two ways: it is **engine-memory only** (the one-shot queries it tracks die with the process, so there is nothing to persist or recover), and a timeout **degrades in one shot** with （未表态） annotations — no re-arm window, because a poll statement is minutes, not research rounds, and the closing sweep is the built-in second chance.
- Dispatch is a worker pool capped at `pollMaxConcurrent` (default 4): a 13-persona library fans the LLM gateway out gradually, respecting the 2026-08-31 lesson that rate-limit windows hang instead of returning 429. The worker count is snapshotted before dispatch — a live `queue.length` in the loop condition decays the pool to one worker (caught by the concurrency test, not by reading).
- On settle, the engine — not the moderator — writes one RECORD.md line per polled persona (absent ones annotated （未表态）): the every-role attendance record is a structural guarantee, and one merged statement card posts to the hub group so the user sees the whole library appear without 13 messages.
- The #43 pick watchdog defers while a poll is in flight (re-arming one window at a time), so the opening poll's wake — not a stale five-minute fallback card — carries the moderator into pick-roles.
- Configuration: `pollTimeoutSec` (default 600), `pollMaxConcurrent` (default 4), `pollProvider` ('' = default route; a cheap named route such as `glm-flash` is one config line away).

## Alternatives considered

- **The moderator role-playing all personas in one context.** Rejected: one context homogenizes the stances — the very reason roles are separate agents — and it breaks the moderator contract of never voicing a role's view.
- **Spawning all personas resident but rarely addressing them.** Rejected: idle agents cost little but the group and supervision surface does not, and the clarify-stage gather would still fan out to everyone.
- **Native continuable subtasks + `settleNativeChild` capture.** Explored and superseded: the settlement path does carry the final output, but `oneShotQuery` returns the turn's text directly, needs no report-protocol cooperation from the persona, and already supported provider routing and tool filtering — strictly less machinery for the same guarantees.
- **Prompt-level only (moderator drives `feishu_bridge_subtask` per persona).** Rejected by the user's explicit choice: the engine owns the barrier, timeout, attendance record, and concurrency cap so the moderator's orchestration burden does not scale with library size.

## Testing

`chatroom-poll.spec.ts` (9 tests): barrier accumulate/fail/timeout one-shot degrade; `pollRoles` polls exactly the non-spawned personas under their persona dirs and wakes the moderator with the tagged summary; the concurrency cap holds a second query back until a worker frees; gather/poll mutual exclusion; timeout degrade aborts still-pending queries (asserted via the stub's abort signal) and annotates absentees; the pick watchdog defers mid-poll and re-arms after settle; RECORD.md gains one line per persona including （未表态） and one merged statement card posts. Tool-surface: enum snapshot, poll routing proof, REAL-composition enum. Config: defaults and overrides. `buildChatroomPickPriming` and both moderator primings assert their new poll-driven text. Full chatroom package (26 files, 375 tests) and bridge package (160 files, 2890 tests) green.

## Consequences

Every `/chatroom` run gains one opening round of N one-shot statements (N = library size minus cast; ~13 × a few thousand tokens today) and, when sidelined personas self-marked interest, one closing sweep — the cost scales linearly and stays an order of magnitude below spawning residents. The pick flow's wall time grows by the opening poll's settle (minutes; the 10-minute timeout bounds it). Statement quality is the core bet — the acceptance check is whether a field's RECORD shows a sidelined persona's blind spot actually absorbed into the core discussion; if statements collapse into ESSENCE slogans, the brief's 「具体盲点」 requirement is the first knob. Known deferrals, recorded in the package README: the closing sweep runs only when the moderator's priming is followed (no `end`-time enforcement), and a restart mid-poll loses the round (the moderator re-issues it). Hot-joining (lazy-spawning a sidelined persona mid-discussion when its statement proves crucial) stays out of scope; the closing sweep is the current second chance.
