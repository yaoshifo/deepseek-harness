# Agent Note: parent-chat jump notice card for /spawn and /fork

Status: implemented

English | [中文](2026-09-07-feishu-bridge-parent-jump-notice.zh.md)

## Problem

After `/spawn` or `/fork` created a sub-group, the parent chat only received a Done reaction. The new group is a separate chat, so the user had to find it manually in the chat list. The readiness card (with the ↩ parent breadcrumb) is sent into the child group, which orients the child session, not the parent user. Monitor had already solved this exact orientation problem for its triage groups (`sendMonitorSpawnNotice`: card + jump button), while the user-invoked spawn family lagged behind.

## Decision

`spawnGroupCommon` (`src/engine/commands.ts`) sends a parent-chat notice card right after the Done reaction and before the child readiness card: indigo header 🌿 已创建子群 (`spawn_parent_notice_title`), body quoting the first message truncated at 200 runes (`truncateMonitor`) or the ready-title line when the command carried no message, and one primary button 进入子群 (`spawn_jump_btn`) whose URL is `chatJumpURL(platform, extractChannelID(child session key))` — the AppLink that opens the sub-group in the Feishu client. A failed notice send is caught and warned; the spawn flow itself is unaffected. Platforms without a chat-jump URL keep the reaction-only flow: no dead-button card, no applink leak, mirroring the monitor notice discipline.

Both `/spawn` and `/fork` get the card because they share the skeleton; no per-command flag exists. Subtask children and monitor groups are excluded — the subtask panel already aggregates child visibility with jump links in the parent chat, and monitor sends its own notice.

## Alternatives considered

**/fork only, as literally requested.** Rejected: `/spawn` and `/fork` share `spawnGroupCommon` and the identical orientation gap; a per-command flag would split two parallel values for no user-visible benefit.

**Group name as the button label, following the footer/cap-notice button convention.** Rejected: with LLM group rename enabled the group is created under a placeholder name and renamed asynchronously, so a name-labeled button ships stale text; the generic verb label never goes stale.

## Consequences

The parent chat gains one card per user-invoked spawn — acceptable noise since each card corresponds to a command the user just typed. cc-connect's `spawnGroupCommon` has no parent notice, so this is a deliberate fork-local divergence from Go parity; once stable it is a candidate for an upstream seam proposal per the fork secondary-development principles. Platforms without jump support see no change.

## Testing

`tests/engine/commands.spec.ts` `/spawn //fork parent jump notice` (4 cases): the fork notice card with its jump button and quoted task, the `/spawn` symmetry case, the no-jump-platform skip (no button card, no applink leak, spawn still succeeds), and the no-message body fallback to the ready line. The readiness-card spec selects its cards structurally by purple header instead of by index, since the notice card now precedes the readiness card in the same recorder.
