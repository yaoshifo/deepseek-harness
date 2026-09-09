# Agent Note: The scope runner's exec boundary restores blocking stdio

Status: implemented

English | [中文](2026-09-09-subprocess-scope-runner-nonblocking-stdio.zh.md)

## Problem

A cron exec job whose output exceeded the 64 KiB collected cap failed with exit 1 — `tr: write error: Resource temporarily unavailable` and `head: ... Broken pipe` — so the engine recorded a successful command as failed (the `bounds the collected job output at 64 KiB per stream` REAL-provider test was deterministically red). The first reading, "the collector stops draining at maxBytes", was wrong: the collector drains continuously and keeps a tail. The real mechanism sits at the exec boundary: the Linux scope runner is a Node process between `systemd-run` and the target, and Node's runtime leaves its pipe-backed stdout in non-blocking mode; `execve` preserves open-file-description status flags, and unlike a libuv-spawned child (whose stdio libuv makes blocking), the raw libc `execve` path never cleared the flag. The exec'd target therefore inherited a non-blocking pipe write end, and the moment the 64 KiB pipe buffer filled during a burst, `write()` returned `EAGAIN` instead of blocking — coreutils treats that as a fatal write error. Any bursty writer through the scope was exposed; the over-cap run merely made the full-pipe window near-certain.

## Decision

`loadLinuxExecve()`'s exec wrapper — the same normalization site that already clears `FD_CLOEXEC` on fd 0 through fd 2 — now also clears `O_NONBLOCK` via `F_GETFL`/`F_SETFL` on those descriptors before `execve`. The target receives the blocking stdio every conventionally spawned child gets; a target that wants non-blocking stdio can set it itself. The fix is in the subprocess service layer, so every consumer (cron exec, the bash executor) benefits; the macOS process-group fallback has no intermediate runner and was already correct, and the Windows Job path spawns through `CreateProcessW`, a different mechanism that needed no change.

## Alternatives considered

- **Enlarging the pipe or throttling the writer:** rejected — the non-blocking write end turns every transient full pipe into `EAGAIN`; only restoring the spawn convention removes the failure class.
- **Draining harder on the read side:** rejected — the reader already drains continuously; the race is between the writer's burst and the event loop, which no reader-side change closes.

## Consequences

- `bounds the collected job output at 64 KiB per stream` is green: a 2 MiB fast writer with an 8 KiB collected cap exits 0 through the scope with a byte-exact tail (new REAL-provider test in `native-containment.spec.ts`).
- The `fcntl` normalization sequence is pinned by unit tests, including the failure paths for reading and clearing status flags.
- The runner's fd hygiene now covers both flag families per descriptor: `FD_CLOEXEC` (per-fd) and `O_NONBLOCK` (per open file description).
