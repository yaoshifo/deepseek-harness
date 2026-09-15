# Agent Note: Consume mid-turn tool-jobs notices in the background-task count

Status: implemented

English | [中文](2026-09-15-feishu-bridge-bg-task-count-midturn-notice.zh.md)

## Problem

The progress card's 「💡 N 个后台任务」 count only ever rose in real sessions. Live evidence (2026-09-15, oc_1b7e133f): one long user-driven turn started 7 `run_in_background` bash jobs, every one completed and was collected with `job_output` inside that same turn — the card still showed 💡 7, and would only clear 30 minutes after turn end via the unsolicited reader's background grace reset.

The decrement had exactly one path: an engine-woken background turn settling (`background && !turnStartedBg` in the turn-settle handler), resting on the Go-era assumption that "its completion arrives as a later engine-woken turn." dsh's tool-jobs controller delivers by owner state, and only one branch matches that assumption:

- idle owner → `Agent.followup` (next-turn splice + wake) — the woken turn settles and the decrement fires;
- busy owner → `Agent.inject` (next-step splice, no wake) — the notice reaches the running turn's next step, and the bridge's adapter dropped the `agent/inbox/spliced` durable event entirely, so the engine never learned the task settled.

The busy path is not an edge case: it is the usage the tool descriptions teach ("keep working on independent steps while the job runs"), so any agent doing that in one long turn leaks one slot per job until the grace reset.

## Decision

Project the mid-turn delivery and decrement at notice delivery:

- `EventKind` gains `bg_task_notice` carrying `bgNoticeIDs` (the spliced notices' message ids).
- The adapter projects `agent/inbox/spliced` **only** when `target === 'next-step'` and the inserted message's source is `{kind: 'plugin', plugin: 'tool-jobs', form: 'notice'}`. `next-turn` splices stay unprojected: the idle path's settle-time decrement already covers them, and projecting both would double-decrement. Foreign sources (steer text, skill bodies) and removal-only splices never tracked a slot; id-less notices cannot be deduplicated and stay unprojected.
- `Engine.consumeBackgroundNotices` drops `min(fresh ids, pending)` slots (floor zero), resets `bgWaitStartedAt` at zero, and refreshes the card hint. Notice ids are FIFO-capped (64) in `consumedNoticeIDs`, mirroring `consumedToolIDs`, so a late re-projection of the same splice consumes nothing.
- Three consumers feed it: the turn pump's event switch (the busy-owner fix), the unsolicited reader **before** its substantive-event check (wake-budget exhaustion delivers next-step notices to an idle owner — the slot still settles, no turn opens), and the spillover relay's own pulls (they bypass the reader's pre-check; id dedup makes a double sighting harmless). The cross-project relay switch ignores the kind: its notices belong to the relay session's own agent, which has no interactive count in this engine.

## Alternatives considered

- **Decrement when the turn claims the notice** (true observability point). Rejected: the bridge sees the durable splice event, not the claim; there is no claim projection to hang the decrement on.
- **Decrement on `job_output` reads of settled jobs.** Rejected: parsing tool results for job state couples the count to a tool the agent may never call; the notice is the authoritative delivery signal.
- **Decrement every notice at insertion (both targets) and drop the settle-path decrement.** Rejected: the idle path's count would drop before the woken turn starts, losing the 「🔄 后台任务完成，正在处理...」 header (it keys on `background && pending > 0` at turn start).

## Consequences

- The count returns to its live semantics: +1 at the background call, −1 at notice delivery. Mid-turn card flushes now show the number decreasing as the agent collects jobs.
- The 30-minute background grace now only bounds genuinely hung tasks (no completion notice will ever arrive), which is its original purpose.
- Residual window: an unclaimed next-step notice surviving into a later engine-woken turn's settle can consume one extra slot — the settle path's per-background-turn decrement was already loose this way, and the `> 0` floor bounds it.
- Drift alarm: the projection anchors dsh core's delivery shapes — `Agent.send/inject/followup` targets (`agent-loop/src/agent.ts`) and tool-jobs' `onJobDone` source `{kind: 'plugin', plugin: 'tool-jobs', form: 'notice'}`. If core ever changes the busy-path target or the notice source shape, the adapter spec's negative cases fail loudly; if it adds a new busy-path shape without a splice event, the count leaks again and the grace reset is the only recovery.
- Tests: `adapter-projection.spec.ts` covers the projection contract (positive, id batch, next-turn/foreign-source/removal-only/id-less negatives); `engine-unsolicited.spec.ts` covers mid-turn decrement, duplicate-id single consumption, zero floor, and idle consumption without an orphan turn; the pre-existing idle-path closed loop stays green.
