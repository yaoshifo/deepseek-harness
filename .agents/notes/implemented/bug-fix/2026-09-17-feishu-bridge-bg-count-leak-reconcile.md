# Agent Note: Reconcile the leaked background-task count at every idle tick

Status: implemented

English | [中文](2026-09-17-feishu-bridge-bg-count-leak-reconcile.zh.md)

## Problem

Live evidence (2026-09-17, oc_f85284): the session's turn 30 completed at 14:37:59, but the group saw a green「执行完成 · 15:09:08 · 8」card appear at 15:09 — read as a completion notice arriving 31 minutes late. The same group had an earlier occurrence at 13:58 (3 pending). The chain:

1. A `bash run_in_background` call in turn 30 bumped `backgroundTasksPending` to 1.
2. The agent collected the job in the same turn with `job_output(wait: true)`; tool-jobs marks such a job `reported` and suppresses its completion notice — the wait already delivered the terminal state (tool-jobs' own test pins this: "suppresses the notice when a wait returned the terminal state").
3. The bridge's count only decrements when the notice arrives (engine-woken turn settlement, or the `bg_task_notice` splice event). With the notice suppressed, neither path ever fires: the count leaks.
4. The leaked count held the settled card for the whole 30-minute background grace. At expiry, the give-up cleanup — 49f177d17c's registry probe correctly found no live job — zeroed the count and cleared the card hint; that PATCH tripped the displacement-heal reissue, and the reissued header stamped the render time (15:09:08) instead of the settlement time, completing the "late notice" illusion.

The 2026-09-16 fix worked as designed — its probe separates slow jobs from dead counts — but it only governs what happens *at* the grace cap; it does nothing about a count that never had a live job to wait for.

## Decision

Two independent fixes:

- **Reconcile at every idle tick** (`engine.ts`, unsolicited reader idle branch): while `backgroundTasksPending > 0`, ask the registry before any clock decision. Three states: live jobs (`pendingBackgroundJobs()`, running/stopping) keep waiting (49f177d17c semantics, unchanged); settled-unreported jobs (`settledUnreportedBackgroundJobs()`, a new probe over the same registry cut: settled + `reported === false`) mean a notice is in flight — the existing grace clock keeps waiting for those; live == 0 and inflight == 0 means every counted job settled AND was collected in-turn — a leak, cleared at this tick with the same cleanup as the exhausted path (zero the count, clear the card hint), under a distinct log line ("reconciled away" vs "grace exhausted").
- **Freeze the settled header clock** (`streaming.ts`): the first settled-state render (completed/truncated/failed plus the resolved parked-ask states) freezes the title timestamp at settlement; later renders — the hint-cleanup PATCH, the displacement-heal reissue — reuse the frozen value. Non-settled states keep advancing the clock.

Why not change tool-jobs: suppressing the notice after a wait/read delivered the terminal state is deliberate (the model must not be told twice); the bridge owns the count, so the bridge reconciles it.

## Alternatives considered

- **Decrement on the job_output tool result.** The engine sees the projected result text, not the structured job state; parsing "[status: completed]" from text is brittle and cannot map a job id to the counted call. Rejected.
- **Shrink the grace.** Treats the symptom; any smaller cap still delays the card and risks eating notices genuinely in flight. Rejected.
- **Change tool-jobs' suppression semantics.** Cross-package behavior change against a correct design; the registry probe already sees everything the bridge needs. Rejected.

## Consequences

- The "background start + collect in-turn" pattern now settles its card within one idle tick (~60s), not 30 minutes.
- A reissued or re-PATCHed settled card shows the true settlement time; a late-appearing card can no longer masquerade as a fresh completion.
- Slow jobs and in-flight notices keep every existing protection (2026-09-16 oc_3c16b semantics unchanged).
- Cost: one registry `list` per idle tick while a count is pending (in-memory filter).
- Drift alarm: the probes anchor `JobSnapshot.ownerSession`/`status`/`reported`; a jobs-package change to either shape fails the adapter-projection filter cases loudly.
- The old blind-grace test was retargeted to the in-flight-notice semantics (its no-job stub default now reads as a leak under reconciliation); the reconciliation case carries its own test.

## Tests

- `tests/engine/engine-unsolicited.spec.ts`: a leaked count reconciles away at the first idle tick; the retargeted in-flight-notice grace boundary; the live-job grace test unchanged.
- `tests/agent-dsh/adapter-projection.spec.ts`: `settledUnreportedBackgroundJobs` owner/status/reported filtering; absent registry → 0.
- `tests/streaming.spec.ts`: settled header timestamp freeze — a completed card re-rendered later keeps its settlement timestamp, a settled parked card re-issued later keeps it too, and non-settled renders keep advancing the clock.
