# Agent Note: Mid-epoch report re-delivery

Status: implemented

English | [中文](2026-09-02-mid-epoch-report-redelivery.zh.md)

## Problem

A native child that reported mid-epoch and kept working stranded its final report. `reportNativeChild` dropped every report after the first (one-shot idempotency guard ported from Go M4), returning success to the child while the idle parent never woke — and `settleNativeChild` skipped the epoch's settlement because `reported` was already true. Observed live in the 2026-09-02 G6 replay: the typert child reported an intermediate status at 13:35:07 and its final result at 13:37:38 within the same epoch; the parent stalled 13 minutes until a user nudge. The group-path `reportSubtask` carried the same guard. The existing re-arm machinery — epoch start (`subagent/start` → `rearmNativeChild`) and parent follow-up (`sendToSubtask`) — covers only cross-epoch continuation, never mid-epoch multi-report.

## Decision

An explicit report always delivers; only a concurrent in-flight delivery of the same report is skipped (the race guard stays). Settlement stays one-shot: `settleNativeChild` keeps its own `reported` guard and the group-path auto-fallback keeps its guards, so an epoch never double-delivers through a fallback. The dropped "model re-calling report floods the parent" rationale loses to the observed failure: each report is a deliberate tool call in a live turn, while the silent drop produced a 13-minute invisible deadlock.

## Alternatives considered

- **Keep the one-shot guard and harden the child prompt** (report exactly once; no intermediate channel exists). Reduces occurrence; the stall failure mode remains for any violator.
- **Fail the second report loudly.** No recovery path exists for the child — send is parent-to-child only — so an error strands the final result just the same.

## Consequences

- Both delivery paths (native `reportNativeChild`, group `reportSubtask`) re-deliver explicit re-reports; regression tests in `engine-subtask.spec.ts` pin the intermediate-then-final shape for both.
- The gather in-flight set still excludes reported children (a first report still ends in-flight tracking), so a parent's gather may return early — but the final report now wakes it; the stall is gone while gather semantics stay unchanged.
- Deployment: bridge package rebuild + `/reload`; the dev server needs the same fix through its own pull and restart flow.
