# Agent Note: /reload failure replies now carry the script output tail

Status: implemented

English | [中文](2026-09-03-feishu-bridge-reload-failure-tail.zh.md)

## Problem

Production incident 2026-09-03 (Mac). The 09:13 /reload failed during `tsc -b tsconfig.host.json` (a TS2345 test-file error) and the chat reply carried only the exit code and the log path. Every triage of a failed reload then begins with tailing the log by hand, while the tsc diagnostic sits in the log's last lines — the failure clue is one hop away from the message that reports the failure.

## Decision

`cmdReload` records the log's byte offset right after writing its own `==> /reload by` header line, and the failure path (`finish`, non-zero exit before the daemon unload) reads the script's output from that offset (`readReloadOutput` in packages/acp/feishu-bridge/src/engine/reload-commands.ts). The reply uses the new `reload_failed_tail` message (exit code + log path + output) when the read yields anything, and keeps the old `reload_failed` form when it does not (spawn error, unopenable log). ANSI CSI sequences are stripped — build tools color their output and chat renders the escapes as raw noise — and the excerpt is bounded to the last 15 lines within the last 4 KB: a full build log runs to hundreds of KB and the failure reason sits at its end.

## Alternatives considered

**Always sending the tail, with a placeholder when empty.** A spawn error produces no output at all; a "(no output captured)" placeholder is noise where the old form already says everything that is true.

**Streaming the whole build log.** Hundreds of KB do not fit a chat message, and the head of a build log is progress noise, not the failure.

## Consequences

A pre-restart failure now self-describes in chat — the 2026-09-03 shape (tsc diagnostic plus the ELIFECYCLE line) arrives with the reply. The ceiling documented in the module header is unchanged: a failure that only appears after the restart (the WS probe timing out) still cannot produce a chat failure reply. The excerpt covers only the current reload's output (the recorded offset), never earlier runs, and a multi-byte UTF-8 character split at the 4 KB boundary renders as one replacement character.

## Testing

`tests/engine/reload-commands.spec.ts` → "appends the script output tail to the failure reply (a build error lands only in the log)" (red first: the reply lacked the error line), "strips ANSI color codes from the failure tail", and "truncates an oversized output to the last lines (the error sits at the end)"; the existing exact-match `ReloadFailed` assertions cover the empty-tail fallback. The reload and i18n domain specs pass 76/76; host-face tsc clean.
