# Agent Note: A termination landing in the scope bootstrap window settles as the delivered signal

Status: implemented

English | [中文](2026-09-09-subprocess-scope-bootstrap-termination-race.zh.md)

## Problem

`times out and kills a backgrounded grandchild` failed occasionally under full-suite load and passed on re-run. The window is the scope bootstrap — from spawn until the runner consumes its launch request (hundreds of milliseconds under tsx) — and a timeout abort or disposal that fires inside it hit two stacked defects. First, `directOutcome` turned every pre-consumption exit into a startup-failure rejection ("subprocess scope exited before its bootstrap consumed the launch request"), even when the exit carried our own termination signal, so the cron timeout path surfaced the raw startup error instead of the timeout classification. Second, a kill that empties the scope cgroup while systemd is still settling the start wedges the transient scope `active` with zero tasks (systemd drops the empty-cgroup event that arrives during start-up); `rangeActive()` then reported the range live forever, `waitForExit()` never settled, and empty wedged scopes accumulated on the host (14 were found; the live daemon's own scopes were excluded and left alone). On a systemd-capable host the race is deterministic for spawn-then-immediately-terminate, which is why `disposal kills still-running processes and awaits their exit` had been failing there all along.

## Decision

A signalled exit inside the bootstrap window settles as that termination, and the empty scope it can leave behind is released instead of waited out. Both halves are realized upstream (commit b79a227cec): `LinuxScopeStartup.resolveOutcome` returns the outcome when the launcher exit carries a signal the owner itself delivered (tracked in `terminationSignals`) while the launch request is unconsumed, and an unsignalled pre-consumption exit keeps the startup-failure rejection; the leftover empty cgroup is proved by `emptyRange()` — a requested termination, a departed client, and a manager-reported zero task count — and `releaseEmptyRange()` stops the transient unit rather than inferring it stopped. See also [the exec-boundary stdio fix](2026-09-09-subprocess-scope-runner-nonblocking-stdio.md), landed from the same investigation and still fork-local.

## Alternatives considered

- **Mapping every bootstrap-window rejection to a termination at the settlement layer (`bindManagedProcess`):** rejected — it cannot see whether the launcher was signalled, would rewrite genuine runner failures (bad cwd, ENOENT) into clean terminations, and would need platform-specific signal semantics the layer does not own.
- **Waiting for request consumption before delivering a timeout kill:** rejected — a crashed runner never consumes; timeouts must terminate promptly, not hang on bootstrap progress.

## Consequences

- A cron timeout that lands during bootstrap reports `timed out`; disposal settles promptly; the wedged-active-scope hang can no longer stall `waitForExit()`.
- The behavior change updates two tests that asserted the old window artifact: the racing-teardown `local.spec.ts` case now asserts the delivered signal (its sibling still pins the non-racing spawn-failure rejection), and the pre-establishment cancellation case in `linux-scope.spec.ts` likewise.
- Two `local.spec.ts` failures remain on systemd-capable hosts (`releases a terminal after top-level exit reaches quiescence`, `retains a terminal whose automatic cleanup fails`): they mock `node-pty` but not `prepareLinuxTerminalScope`, so a real scope launch runs against a fake terminal. Pre-existing test-environment coupling, unchanged by this fix, green in CI containers that lack a user manager.
- The Windows Job runner has an analogous bootstrap window (IPC messages before the target starts); it was not examined and keeps its current semantics.
