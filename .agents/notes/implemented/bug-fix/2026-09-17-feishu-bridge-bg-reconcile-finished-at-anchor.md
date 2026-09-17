# Agent Note: Anchor the owed-notice probe at the job's finishedAt

Status: implemented

English | [中文](2026-09-17-feishu-bridge-bg-reconcile-finished-at-anchor.zh.md)

## Problem

The reconcile probes shipped earlier the same day ([leak-reconcile note](2026-09-17-feishu-bridge-bg-count-leak-reconcile.md)) treated every settled job with `reported === false` as owing a completion notice. But `reported` flips only when the model collects the job — a `job_output` wait/read, a kill, a teardown cancel (jobs-local owns the flag); tool-jobs' notice delivery never flips it. A job whose notice was delivered and consumed by the turn it woke therefore stays `reported === false` forever:

- the reader's idle reconcile saw `inflight > 0` on every tick, never reconciled, and fell through to the 30-minute grace give-up — the exact unreported shape the reconcile exists for was the one it could not clear;
- the settle-time reconcile kept the `💡 N` line on the settled card for good (a settled card accepts no later render).

## Decision

Anchor the probe at time: `settledUnreportedBackgroundJobs(since)` counts a settled, unreported job only when `finishedAt > since`. A job that finished before the anchor already had its notice delivered, suppressed, or discarded with its owner; one that finished after it may still be mid-delivery and keeps every existing grace protection. Snapshots without `finishedAt` never count as owed — the registry cannot prove a pending notice for them; their live phases stay covered by `pendingBackgroundJobs()`.

Each call site passes its own wait start:

- **Reader idle reconcile → `state.bgWaitStartedAt`.** On the first tick after a count appears the anchor is still 0, so every settled job counts for one tick (conservative: a job that settled seconds ago may be mid-delivery, and clearing eagerly would eat its notice); that tick sets the anchor and the next clears the zombie — about two idle ticks instead of thirty minutes.
- **Settle-time reconcile → `state.timing.turnStart`, the settling turn's start** (the existing per-turn anchor, set at `processInteractiveEvents` entry). A job finished before the turn began cannot owe this card a notice — its notice woke an earlier turn, was suppressed, or died with its owner — while one settling mid-turn still does. `state.timing` deliberately spans queued continuations (the completion-footer clock), so jobs finishing between a turn and its queued follower stay counted: their notices sit in the drain queue. Chosen over `bgWaitStartedAt` because that field is reader-scoped and sits at 0 through the common flow — a settle anchored at 0 would count every settled job the registry still holds and defeat the fix at this call site.

## Alternatives considered

- **Flip `reported` on notice delivery (tool-jobs).** Cross-package semantics change; delivery has several shapes (followup wake, next-step inbox splice, discard with a reaped owner) and the flag's meaning — the model collected the terminal state itself — would blur. The bridge owns the count; anchoring at time keeps the registry's flag honest. Rejected.
- **Expire unreported jobs by age inside the registry.** The registry cannot know how long a notice is still worth waiting for; that policy is the bridge's grace, and the bridge already has the timestamps it needs in the snapshot. Rejected.

## Consequences

- A delivered-but-uncollected job stops counting once the wait anchor passes its `finishedAt`: the reader reconciles its leaked count within about two idle ticks, and the settle-time reconcile drops it before the terminal render.
- Jobs settling after either anchor keep the full grace and the settled-card hint (2026-09-16 oc_3c16b semantics unchanged).
- Drift alarm: the probe now anchors `JobSnapshot.finishedAt` as well as owner/status/reported; a jobs-package change to any of those shapes fails the adapter-projection filter cases loudly.
- The stub sessions' probes filter a job list (with `finishedAt`) instead of returning constants, and record the anchors they were handed so specs pin which wait start each call site used.

## Tests

- `tests/agent-dsh/adapter-projection.spec.ts`: owner/status/reported filtering unchanged, plus anchored counting — zombies settled at or before the anchor and snapshots without `finishedAt` drop out.
- `tests/engine/engine-unsolicited.spec.ts`: a pre-anchor zombie reconciles away at the second idle tick (the first tick only sets the anchor); a job settling during the wait keeps the count, the armed reader, and the probe anchored at `bgWaitStartedAt`.
- `tests/engine/engine-events.spec.ts`: the settle-time reconcile clears a pre-turn zombie before the render, keeps the `💡` line for a job settling during the turn, and anchors the probe at `state.timing.turnStart`.
