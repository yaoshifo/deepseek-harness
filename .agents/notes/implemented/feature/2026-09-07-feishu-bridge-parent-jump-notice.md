# Agent Note: parent-chat jump notice for /spawn and /fork

Status: implemented

English | [中文](2026-09-07-feishu-bridge-parent-jump-notice.zh.md)

## Problem

After `/spawn` or `/fork` created a sub-group, the parent chat only received a Done reaction. The new group is a separate chat, so the user had to find it manually in the chat list. The readiness card (with the ↩ parent breadcrumb) is sent into the child group, which orients the child session, not the parent user. Monitor had already solved this orientation problem for its triage groups (`sendMonitorSpawnNotice`: card + jump button), while the user-invoked spawn family lagged behind.

## Decision

`spawnGroupCommon` (`src/engine/commands.ts`) sends the parent chat a notice card whose **only element is the jump button**: no header, no text line — one primary button 进入子群 (`spawn_jump_btn`) whose URL is `chatJumpURL(platform, extractChannelID(child session key))`, the AppLink that opens the sub-group in the Feishu client. Two user rulings shaped it (both 2026-09-07): first the card replaced the Done reaction as the sole parent-chat success signal, then the card was reduced to the button alone — the button label carries the whole message. A failed notice send is caught and warned; the spawn flow itself is unaffected.

`sendAsCardWithButtons` gained two generalizations: an empty header title renders no header (the Feishu renderer and the plain-text fallback both already tolerated header-less cards), and when title and body are both empty the plain-text fallback degrades to the buttons' link line instead of sending an empty message. Platforms without a chat-jump URL get no parent-chat feedback at all — production is always Feishu, which produces a URL. Subtask children and monitor groups are excluded: the subtask panel already aggregates child visibility with jump links in the parent chat, and monitor sends its own notices.

The button label follows the group name (2026-09-07, user ruling). On platforms implementing `CardSenderWithUpdate` the notice is sent with `sendCardWithHandle` and the handle is registered on the engine keyed by the child session key; `handleChatRenamed` — the engine's single funnel for the platform's `im.chat.updated_v1` rename reports — then PATCHes the card so the button reads 进入 {name} (`spawn_jump_btn_named`, name capped at 20 runes). Hooking the funnel rather than each rename call site covers every rename source at once: the async LLM rename, its fallback, the sync no-LLM rename, `/rename`, and a user rename in the Feishu UI. The handle map is in-memory — a daemon restart leaves earlier cards on the generic label — and entries are dropped when `cleanupOneChat` tears the child down. A failed PATCH warns and the next rename retries.

## Alternatives considered

**/fork only, as literally requested.** Rejected: `/spawn` and `/fork` share `spawnGroupCommon` and the identical orientation gap; a per-command flag would split two parallel values for no user-visible benefit.

**Group name as the button label, following the footer/cap-notice button convention.** Rejected: with LLM group rename enabled the group is created under a placeholder name and renamed asynchronously, so a name-labeled button ships stale text; the generic verb label never goes stale.

**Keep the Done reaction as a fallback success signal.** Rejected as redundant with the card (user ruling). Accepted trade-off: a failed card send now leaves the parent chat without immediate feedback — the failure is logged, and the group still appears in the chat list.

**A text line plus the button (header removed, two elements).** Rejected mid-review: the user ruled the line should fold into the button — the label 进入子群 states both what happened and where the button leads.

**Hook each rename call site (LLM task, fallback, sync rename, /rename).** Rejected after half of them were wired: the engine already funnels every platform rename report through `handleChatRenamed`, and that funnel also catches user renames from the Feishu UI that no call site sees. One hook covers more with less code.

## Consequences

The parent chat gets exactly one interactive element per user-invoked spawn: the jump button, whose label tracks the group's current name. cc-connect's `spawnGroupCommon` has no parent notice and does add a Done reaction, so this diverges from Go parity in both directions; the divergence is deliberate and fork-local, and remains an upstream seam proposal candidate once stable. The notice's i18n surface is two keys (`spawn_jump_btn`, `spawn_jump_btn_named`); the intermediate `spawn_parent_notice_title` key was added and removed the same day. On platforms without jump support the parent chat is silent, and after a daemon restart pre-restart cards keep the generic label.

## Testing

`tests/engine/commands.spec.ts` `/spawn //fork parent jump notice` (6 cases): the button-only card shape (no header, a single actions element, one primary jump button), the no-reaction ruling (reactions stay empty across both commands while the cards land), the `/spawn` symmetry case, the no-jump-platform skip (no button card, no applink leak, spawn still succeeds), the updatable-card send path (`sendCardWithHandle` with the same button-only shape), and the rename linkage (a `handleChatRenamed` report PATCHes the label to 进入 {name}, follows later renames, and stops after `cleanupOneChat` tears the child down). The readiness-card spec selects its cards structurally by purple header instead of by index.
