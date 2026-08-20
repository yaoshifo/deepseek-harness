# Agent Note: feishu-bridge idle reaper defaults on at two hours

Status: implemented

English | [中文](2026-08-20-feishu-bridge-idle-reaper-default.zh.md)

## Problem

Go's backend keeps `interactive_idle_timeout_mins` off by default: its workspace pool reaps idle workers after 15 minutes as the backstop, so the interactive reaper only adds a second, longer lever. The TS migration left that pool layer unported — sessions are in-process objects — while porting the config field verbatim as opt-in (`interactiveIdleTimeoutMins` absent → reaper disabled). A deployment that omits the field therefore accumulates interactive states indefinitely; the memory cost per session is now MB-scale (in-process) rather than Go's process-per-worker, but forgotten sessions still never go away, and the next message replays nothing because the state was never collected at all.

## Decision

`interactiveIdleTimeoutMins` carries a schema-level `.default(120)` (`packages/acp/feishu-bridge/src/index.ts`, the `Config` schema's project row). The Cordis loader resolves config through `resolveConfig` → `~standard.validate` on load and reload, so every deployment started through a profile gets the reaper at a 2-hour threshold without configuring anything; explicit `0` still disables it (schemastery applies defaults only to absent keys, and `Schema.natural()` accepts 0). The engine wiring keeps its `!== undefined` guard unchanged: hand-built configs that bypass the schema (unit tests) still read absent as disabled. The threshold is deliberately loose — 2 hours collects sessions forgotten overnight or over a weekend while never touching a lunch break or a long design pause mid-task.

## Alternatives considered

**Keep Go parity: default off.** Rejected: Go's default is off *because* the workspace pool provides the 15-minute backstop, and that layer was not migrated. Porting the field's default without its backstop inherits the constraint the default existed under without the mechanism that justified it.

**A 15-minute default matching Go's pool.** Rejected: the pool reaped *workers*, transparently restarted on demand. Here reaping closes an interactive session and the next message pays log-replay latency on its first reply; 15 minutes would tax ordinary work rhythm (meetings, code review) for memory the process can spare.

**Wiring-level default (`project.interactiveIdleTimeoutMins ?? 120` in the assembly path).** Rejected: the repo requires defaulting to be an explicit resolve step, never a hidden `??` inside the wiring; the schema default rides the loader's existing resolution, which is that step. It also keeps the pre-validation input shape honest — the `ProjectConfig` field stays optional because optional is what a raw profile may contain.

## Consequences

Deployments that omit the field now reap idle interactive sessions after 2 hours: the agent is closed, and the next message resumes by replaying the session log, so that first reply is slower — this is the intended memory-for-latency trade. The production profile configures `interactiveIdleTimeoutMins: 30` explicitly and is unaffected. The default lives only on the loader path: hand-built configs (unit-test assembly) still treat absent as disabled, a divergence the assembly test documents in place. The reaper still never closes sessions that are working or waiting on permission, and it does not clean up `/spawn` worktrees — that remains `/done`'s other half.

## Testing

`tests/plugin-entry.spec.ts` validates the exported `Config` schema through `~standard.validate`: absent field → 120, explicit 30 → 30, explicit 0 → 0. `tests/assembly-config.spec.ts` pins the hand-built path (absent → disabled) with a comment distinguishing it from the loader path. Engine reaper behavior (skip-while-working, skip-permission-wait) is covered by the existing engine specs.
