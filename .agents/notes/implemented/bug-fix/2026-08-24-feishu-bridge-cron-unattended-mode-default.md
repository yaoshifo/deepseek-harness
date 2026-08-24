# Agent Note: cron prompt runs start in default mode, never the project plan default

Status: implemented

English | [中文](2026-08-24-feishu-bridge-cron-unattended-mode-default.zh.md)

## Problem

A prompt-based cron job injects its prompt as a synthetic user message carrying `modeOverride: job.mode` (`Engine.executeCronJob`). With no job-level `mode` set the override is empty, so the adapter resolves the session's mode from the project's `agent.mode` — and production configures `agent.mode: plan` on every project. A cron run has no human to approve an ExitPlanMode card: on the 风控驴 project the 07:03 pre-market check (job `fbe6d268`, `session_mode: new_per_run`) reached an `exit_plan_mode` call at 07:04 and then logged zero events until the scheduler's 30-minute execution timeout killed the run; the 20:30 pre-night-session job failed the same way. The job completed normally on 2026-08-21 before the plan-default rollout and timed out from that evening on. Subtask children ([effectiveMode bypass](2026-08-20-feishu-bridge-effective-mode-bypass.md)) and chatroom flows ([chatroom moderators never enter plan mode](../feature/2026-08-23-feishu-bridge-chatroom-moderator-no-plan-mode.md)) already handle their unattended seams; the cron synthetic message was the remaining path that inherited the project mode verbatim.

## Decision

`executeCronJob` constructs the synthetic message with `modeOverride: job.mode !== '' ? job.mode : 'default'`: an unset job mode starts the run in `default` — the project's permission preset applies, and a plan-mode project default no longer arms plan mode for an unattended run. An explicit job `mode` passes through verbatim, including an explicit `plan` (an operator's deliberate choice). The one-shot override is consumed where the interactive state starts the agent session, so `new_per_run` runs always receive it; this matches the pick-phase precedent (`modeOverride: 'default'` on synthetic chatroom-pick messages) rather than adding a new env flag.

## Alternatives considered

**Extend `sessionBypassesPermissions` with a cron flag (full Go effectiveMode bypass).** Rejected: bypass rewrites tool-approval semantics beyond plan mode; cron replies land in a staffed chat where approval cards remain meaningful, and the per-job `mode` field is the deliberate stronger escape hatch for jobs that want bypass. This mirrors the moderator deviation, plan mode only.

**Downgrade plan at the adapter behind a cron session-env flag.** Rejected: it needs a new session attribute plus `buildSessionEnv` plumbing to express what the message-construction site already knows; the synthetic-message override is the established seam for exactly this (pick wakes).

**Fix only the stored jobs (edit `mode` into `jobs.json`).** Rejected: the daemon keeps jobs in memory and rewrites the store on every run, so manual edits do not stick, and every future prompt job under a plan-default project re-arms the stall.

## Consequences

Prompt cron jobs under plan-default projects run to completion instead of dying at the execution timeout, executing with the project's normal permission preset — the same surface an approved plan's implementation runs under. An explicit `job.mode: plan` still stalls on its approval card; that is the operator's stated choice. A `reuse` job whose target interactive session is already live keeps that session's mode (the override applies at session start): a human present in that chat can approve the plan card. The scheduler timeout now bounds real work rather than the stall.

## Testing

`tests/engine/cron-execute.spec.ts` (`ExecuteCronJob_UnattendedModeDefault`): a `new_per_run` prompt job with no `mode` starts the agent session with `setSessionMode('default')`; an explicit `bypassPermissions` passes through verbatim. Real-device: the 风控驴 20:30 / 07:03 jobs complete and post their verdict with no `last_error`.
