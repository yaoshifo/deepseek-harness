# Agent Note: /shell and the "!" shortcut — the engine command the feature table could not see

Status: implemented

English | [中文](2026-08-22-feishu-bridge-shell-command.zh.md)

## Problem

The cc-connect → feishu-bridge migration tracked acceptance against `docs/FEATURE-PARITY.md`, a 61-row table derived from cc-connect's `docs/features.md` — a feature list, not the engine's command inventory (`core/engine.go` `builtinCommands`, 52 entries, of which the TS engine registered ~18). `/shell` fell through exactly that gap: its i18n strings (`shell_usage`, `BuiltinCmdShell`, the `message_help` text) were ported wholesale, so the command looked migrated, but no handler existed — `/shell …` fell through to the agent as an ordinary message, and the `!` prefix shortcut reached the agent as literal text.

## Decision

`src/engine/shell-commands.ts` ports Go `cmdShell` (`core/engine_cmd_workspace.go`) under the established per-domain registration pattern: `registerShellCommands` merges into the engine's existing command table (aliases `shell`/`sh`/`exec`/`run` plus ≥2-char prefix resolution) and returns its disposer. The command runs `sh -c <command>` in `commandWorkDir(msg)` with the same spawn + AbortController shape as `executeCronShell`: combined stdout/stderr, default 60 s timeout, leading `--timeout <seconds>` parse whose failure leaves the flag inside the command, output trimmed and truncated past 4000 runes to 3997 + `...`, `(no output)` for empty success, `exit status N` only when a non-zero exit produced no output, and the fenced `$ <command>` reply. The command text is read from `msg.content`, not the dispatcher's whitespace-split args — args collapse quoted spaces (`echo "a  b"`). The `!` prefix is dispatched in `handleMessage` after `handlePendingPermission` (Go ordering: `!yes` answers a pending permission, never the shell) through `runBangShell`, which applies `gatePrivilegedCommand` first. `shell` joins `dir` and `monitor` in `commands.ts`'s `privilegedCommands` (the TS subset of Go's 8 admin-gated commands).

Deliberate cuts, unchanged from the M4-E C-class rulings: `disabled_commands` and user-role `DisabledCmds` (no mechanism ported), the multi-workspace shared-binding work dir (multi-workspace itself unported), and the `audit: command_executed` log line (no audit surface in the TS engine).

## Alternatives considered

**Run through the dsh shell capability (`packages/shell`) instead of `sh -c`.** Rejected: that Service seam is for agent tools with request/spec resolution and provider routing; the chat command needs a direct daemon-process subprocess exactly like Go's `exec.CommandContext` and the engine's existing `executeCronShell`.

**Port the whole missing command family now.** Rejected as scope creep for this change: the missing ~34 commands each need their own migrate/cut ruling (upgrade/restart/web/doctor are D-class; /help, /whoami, /history have no ruling). Recorded as a named gap below instead.

## Consequences

`/shell` and `!` work again in chat, admin-gated by `admin_from`. Two known gaps remain open: the command inventory itself (~34 Go builtin commands unported without individual rulings), and the `message_help` i18n text, which still advertises commands that do not exist — including `/help`, which is not registered either. Until an inventory diff lands (M8), a user typing `/help` gets the agent, not a command list. The timeout message keeps Go's frozen "(60s)" wording even when `--timeout` sets another value.

## Testing

`tests/engine/shell-commands.spec.ts` (15 cases): usage on empty command, workdir resolution, alias/prefix dispatch, non-zero exit with and without output, `(no output)`, 4000-rune truncation, `--timeout` kill, admin gate for both `/shell` and `!`, `!yes` permission-answer precedence, empty `!` fall-through, and registration merge/dispose. Go's two multi-workspace `TestCmdShell_*` cases are not ported with their mechanism. Real-device smoke (`/shell pwd`, `!ls`, timeout, non-admin denial) follows the MIGRATION.md reload flow.
