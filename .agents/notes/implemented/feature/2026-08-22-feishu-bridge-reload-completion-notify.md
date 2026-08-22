# Agent Note: /reload completion notice — the restarted daemon reports back

Status: implemented

English | [中文](2026-08-22-feishu-bridge-reload-completion-notify.zh.md)

## Problem

A successful `/reload` was completely silent in chat. The reply listener lives in the old daemon process and dies with it; only `feishu-bridge-reload.log` recorded the outcome (the documented ceiling, OPERATIONS.md §3.3). An operator issuing `/reload` had to leave the chat and tail a log on the server to learn that the minutes-long build and restart actually finished.

## Decision

The completion notice is delivered by the restarted daemon itself: its ability to send the message is the proof that the restart landed. `cmdReload` (`packages/acp/feishu-bridge/src/engine/reload-commands.ts`) writes `$LOG_DIR/feishu-bridge-reload-pending.json` before the spawn — `{ pid, platform, replyCtx, at }`, where `replyCtx` round-trips the triggering message's context so the notice lands as a reply to the `/reload` message. `index.ts` collects the per-project `engine.start()` promises and, once all resolve, calls the new `completePendingReload(engines)` exactly once per daemon start:

- No marker — a plain start, no-op.
- `marker.pid === process.pid` — an HMR plugin reload re-ran `apply()` while the reload is still in flight (the 2026-08-22 exit-notice trigger shape): skip and keep the marker; the real restart is still ahead.
- Different pid, fresh (15-minute TTL covering the build-plus-restart window) — find the recorded platform among the engines' platforms, send the `reload_completed` notice through it, delete the marker.
- Stale, unknown platform (project removed from config), corrupt JSON, or a failed send (e.g. the /reload message withdrawn) — warn and delete; every consumed path deletes, so one daemon start yields at most one notice.

The old daemon's `finish()` clears the marker on a non-zero script exit (failures before the restart, where the failure reply already fires) so an unrelated later start cannot mis-notify. The wording claims only what is always true — the daemon restarted, sent by the new process, details in the log — never "new build" or "WS ready".

## Alternatives considered

**The surviving reload.sh sends the notice itself.** The script has no Feishu credentials or send channel; opening one is far more machinery than reusing the new daemon's platform.

**A status file written by the script (ok / probe-failed) that the daemon polls.** The daemon is up before the script's probe finishes, so this needs a polling loop plus a shell↔TS status protocol — to distinguish an outcome the wording can simply decline to claim.

**Per-engine invocation of the notification check.** Engines start concurrently; several projects could share the default platform name `feishu`, so per-engine checks could double-send. One post-`Promise.all` invocation with first-match-wins is race-free.

## Consequences

`/reload` now closes the loop in chat: started reply up front, completion reply after the restart. Known gap: an unrelated crash during a reload's build (systemd pulls the daemon back up, the script died to the cgroup kill) also delivers the notice — the daemon did restart, and the wording claims nothing beyond that; details stay in the log. Failures that only appear after the restart (WS probe timeout) remain log-only — no failure reply is possible for that window. The `index.ts` start sequencing change (collect starts, await together after the loop) is behavior-neutral: the loop body has no await, so engine starts keep their concurrency; per-project startup error logging is unchanged.

## Testing

`tests/engine/reload-commands.spec.ts` (25 cases total, red first): cmdReload writes the marker before the spawn (pid/platform/replyCtx/at) and a non-zero exit clears it alongside the failure reply; `completePendingReload` sends through the matching platform and clears, keeps the marker on a pid match (HMR), drops stale (TTL boundary), drops on platform mismatch, is a no-op without a marker, drops corrupt JSON, and still clears after a failed send. Full package suite 2085 green; `tsc` clean; no snapshot — the chat notification cannot enter the record-replay harness (same documented gap as the /reload command itself). Real-device smoke on the dev server: `/reload` in chat receives the completion notice as a reply to the command message; the marker file appears then disappears.
