# Agent Note: Cron exec jobs run through the subprocess service, not a bare spawn

Status: implemented

English | [中文](2026-09-08-feishu-bridge-cron-exec-subprocess-containment.zh.md)

## Problem

`Engine.executeCronShell` ran exec jobs with a bare `spawn('sh', ['-c', job.exec])`: no process group, no sandbox, an abort signal that killed only the direct `sh`, and unbounded output accumulation. A job like `long-task & echo started` exited 0 at once while the backgrounded descendant kept running unsupervised, and a chatty job buffered its whole output in memory. This was the only subprocess surface in the daemon below the bash tool's isolation level.

## Decision

The engine delegates foreground execution to a host-wired `EngineSubprocess` runner (spec: argv, cwd, per-stream byte bound, abort signal; result: merged output, exit facts, timed-out flag). `buildProjectAssembly` wires `createCronSubprocessRunner`, which runs jobs through the composition's `subprocess` service (`ctx.subprocess.spawn`): the managed range owns backgrounded descendants (process group on macOS, systemd scope / Job Object on Linux and Windows), so a timeout terminates the whole tree and the range's quiescence — not the direct child's exit — settles the run. Collected output is capped at 64 KiB per stream. Cron exec fails loud without a runner.

## Alternatives considered

- Keep the bare spawn and add `detached: true` plus manual group-kill in the engine: rejected — reimplements a fraction of the subprocess provider's termination ladder (TERM→grace→KILL, range quiescence) inside the port layer.
- Route cron exec through the bash tool executor: rejected — the executor carries turn-scoped shell semantics (stdin, spill policy) that a cron job does not have, and the engine would need an agent session to reach it.

## Consequences

- A timeout now kills the whole job tree; a `while true` loop backgrounded behind an `echo` no longer outlives its run (REAL-provider test pins this with a heartbeat file that stops growing).
- The engine constructor grew an optional `EngineSubprocess` param; every existing engine construction without it keeps working, and cron exec is the only path that fails loud.
- Exit-status, timeout, and success message formats are unchanged; the 64 KiB per-stream bound is a memory invariant, not a tunable — the chat message truncates to a few thousand characters far below it.
