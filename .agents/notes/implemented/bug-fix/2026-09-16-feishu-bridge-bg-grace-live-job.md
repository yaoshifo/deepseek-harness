# Agent Note: Ask the jobs registry before abandoning a background-task count

Status: implemented

English | [中文](2026-09-16-feishu-bridge-bg-grace-live-job.zh.md)

## Problem

Live evidence (2026-09-16, oc_3c16b03b): the last turn started a `run_in_background` build at 11:20:25 and settled at 11:21:12 with the card correctly showing 💡 1. The build ran 39 minutes (a concurrently loaded machine), but the unsolicited reader's background grace is 30 minutes — at 11:53:14 it declared the task never-completing and zeroed the count. Two defects followed from that one assumption:

1. The zeroing path never touched the card hint, so the settled card froze on 💡 1 (nothing would ever clear it — the turn had already ended, and no later PATCH existed).
2. The zeroing also disarmed the idle reaper's only shield (`backgroundTasksPending > 0` → skip). With live config `interactiveIdleTimeoutMins: 30`, the reaper disposed the agent at 11:54:00 — six minutes before the build finished. tool-jobs delivered the completion to a disposed owner and silently discarded it ("disposal before the claim discards it with the owner"), so the notice was lost forever and the frozen card was its only residue.

The grace test's own comment stated the assumption: "Grace exhausted: the task will never complete". A wall-clock cap cannot distinguish a slow task from a hung one; only the registry knows.

## Decision

Replace the clock guess with a registry probe at both give-up sites:

- `AgentSession.pendingBackgroundJobs(): number` (bridge core interface). The dsh adapter implements it via `ctx.get('jobs')` — `JobRegistry.list(caller)` filtered to snapshots whose `ownerSession` is this session and whose status is `running`/`stopping`. Absent registry or context returns 0 (unit-test construction, jobs-less composition).
- Grace exhaustion now asks first: a live job keeps the reader armed with the count and hint intact (the completion notice stays deliverable); only a count with no live job left is abandoned — and that path now clears the card hint too (`setBackgroundHint('')`, same guard shape as `consumeBackgroundNotices`), so the settled card stops rendering the stale 💡 N line.
- The idle reaper's skip condition adds `pendingBackgroundJobs() > 0` beside the count, so a slow job whose count was grace-zeroed cannot get its owner reaped.

## Alternatives considered

- **Raise the grace config.** Treats the symptom; any cap is outlived by a slower machine. Rejected.
- **Keep the count at exhaustion plus a second hard cap.** Two clock tiers with a count decoupled from reality between them; one registry query replaces both. Rejected.
- **Fix in dsh core (tool-jobs).** Discarding the notice of a disposed owner is the registry's documented lifecycle semantics, not a bug there; the bridge must simply not destroy an owner whose work is still live. Rejected.

## Consequences

- A slow job now survives the grace: its completion wakes the engine-woken turn, the card runs the 🔄 header, the count settles to zero, the hint clears.
- A genuinely hung job (process wedged, never settling) now keeps the interactive state and its agent handle alive until the user returns or kills the job — previously the 30-minute reaper force-collected and lost the notice. This is correctness over memory: one handle per hung job, no hard cap (deferred unless it hurts).
- Drift alarm: the probe anchors `JobRegistry.list`'s caller scoping and `JobSnapshot.ownerSession`/`status`. If the jobs package changes either, the adapter-projection filter cases fail loudly.
- Tests: `engine-unsolicited.spec.ts` (grace exhaustion clears the hint; a live job keeps the reader armed and the count), `engine-events.spec.ts` idle reaper (count and live job both shield), `adapter-projection.spec.ts` (owner/status filtering, absent registry → 0).
