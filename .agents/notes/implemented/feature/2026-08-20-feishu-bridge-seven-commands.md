# Agent Note: seven more cc-connect commands — /tag /untag /undone /notify /board /help /ps

Status: implemented

English | [中文](2026-08-20-feishu-bridge-seven-commands.zh.md)

## Problem

After `/shell` landed, the command-inventory diff still left ~34 of Go's 52 builtin commands unported. The user picked seven from a time-ordered multi-select card (the seven most recently touched in the Go repo): `/tag`, `/untag`, `/undone`, `/notify`, `/board`, `/help`, `/ps`. Notably, FEATURE-PARITY row #38 had recorded "跳转/notify/board 完成" — only the spawn-time notify card existed; the `/notify` and `/board` commands themselves had never been registered. And `/help` was unregistered while the ported `message_help` static blob advertised dozens of commands that do not exist.

## Decision

Two per-domain modules, both following the established merge-into-command-table registration pattern:

**`src/engine/spawn-family-commands.ts`** ports Go `cmdTag`/`cmdUntag`/`cmdUndone`/`cmdNotify`/`cmdDashboard` faithfully. The tag axis and the avatar axis stay independent: `/tag`/`/untag` touch only the heart tag (success is a reaction, no text reply), `/undone` restores the colored avatar and flips the spawned-chat registry back to active — matching how `/done` already dims. `/notify` re-sends the spawn readiness card via the existing `spawnJumpMarkdown` + `buildSpawnNotifyCard` helpers, with the no-children note fallback and a zeroed usage footer. `/board` shows only the current chat's family subtree: all platforms' `listActiveSpawnedChats` aggregated, parent→child links derived from `sessionKeyMap`, `familyChats` walks up to the topmost spawned ancestor and collects the subtree, and the tree renders chat links under collapsible panels with the current chat marked ←.

**`src/engine/misc-commands.ts`** ports `/help` and `/ps`. `/help` deliberately diverges from Go: the command list is **generated** from `e.commandHandlers` keys × the per-command i18n one-liners (plus a provider-shortcut line and prefix tip), and `/help <cmd>` resolves through the command resolver to the `<cmd>_usage` i18n key with a one-liner fallback. Go's `message_help` static blob, the six `help_*_section` entries, and the button-driven help-card family (`renderHelpGroupCard` + `nav:` navigation) are deleted, not ported — the hand-maintained blob is exactly the mechanism that drifted into advertising nonexistent commands. `/ps` keeps Go's three-way behavior: idle agent → strip the prefix and fall through as a normal message (handler returns false); mid-turn → straight `agentSession.send` plus a Done reaction; mid-turn and blocked on a permission → queue as the next turn, because a direct write would sit behind the CLI input queue. Mid-turn delivery now goes through agent-loop steer; see [2026-08-21-feishu-bridge-ps-steer](2026-08-21-feishu-bridge-ps-steer.md).

## Alternatives considered

**Port Go's help-card family with per-command nav buttons.** Rejected: the `nav:` help navigation is already documented as not ported (the cron card's back button), and a button-driven mirror of a generated list adds surface that must track every future command addition; the markdown card via `sendAsCard` covers discovery.

**Port the dashboard done-button snapshot machinery (dashboardCardState, greyed rows, in-place refresh).** Rejected: Go's current `renderDashboardTree` renders links only — the snapshot's `done` map has no consumer in the render path — so the machinery would be dead code here.

## Consequences

The command count rises from 19 to 26. `/help` can no longer lie: it lists exactly what the engine has registered, in every language that has one-liners. The remaining gap is ~27 commands without individual rulings (`/whoami`, `/history`, `/current`, `/search`, `/delete`, `/name`, `/memory`, `/model`, `/reasoning`, `/mode`, `/lang`, `/quiet`, `/tts`, `/allow`, `/skills`, `/config`, `/show`, `/diff`, …), recorded in the README's Known Limitations for an M8 ruling pass; `/usage`, `/web`, `/upgrade`, `/restart`, `/doctor`, `/version`, `/workspace` keep their existing cut rulings. FEATURE-PARITY #38 is corrected to state that the command surface landed 2026-08-20.

## Testing

`tests/engine/spawn-family-commands.spec.ts` (14 cases): tag/untag/undone capability paths with reactions and error replies, notify card in child/parent/plain-platform shapes, board family tree with the current marker, empty and not-in-tree hints, alias/prefix resolution, registration merge/dispose. `tests/engine/misc-commands.spec.ts` (10 cases): generated help list excludes unported commands, per-command usage and one-liner fallback, unknown-command hint, /ps empty/mid-turn/blocked/idle-fallthrough, queue-on-blocked. Tree and breadcrumb assertions read the card element tree because collapsible panels have no text degradation.
