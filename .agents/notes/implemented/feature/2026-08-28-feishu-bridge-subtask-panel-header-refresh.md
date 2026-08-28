# Agent Note: Subtask panel header adopts the tool-progress running composition

Status: implemented

English | [中文](2026-08-28-feishu-bridge-subtask-panel-header-refresh.zh.md)

## Problem

The background-subtask live panel's header told the user *that* children were running but not *whether they still were*. The title ("⚙️ 后台子任务 · N 个运行中", static blue) never changed between ticks, and the per-row wording collapsed any activity younger than ten seconds into "刚刚活跃" — both halves hid age, so a child that had silently stalled read exactly like one that had just emitted an event until the ⚠️ flag appeared a full stall window (default 120s) later. The tool-progress card had already solved this shape: its `执行中 · HH:MM:SS · N` header carries the wall-clock time of the latest tool call, which keeps advancing while work happens and freezes at a glance when it stops.

## Decision

Align the panel's header with the tool-progress card's running composition and make row timing absolute-first (`renderSubtaskPanelCard`, `src/engine/subtask-panel.ts`):

- **Header**: `后台子任务 · N 个运行中 · HH:MM:SS` — the clock is the newest `lastEventAt` among pending children, re-rendered on every panel tick (15s default), so it advances while any child works and freezes when all stall. Template flips yellow → orange and the title appends `⚠️ N 个疑似停滞` once any child crosses `features.subtaskLivePanelStallMs`; a spinner icon (the platform's executing GIF) rides the header through a new `CardHeader.icon` field rendered as schema-2.0 `custom_icon`. Terminal phases keep the green done / grey drained cards, icon-free.
- **Rows**: `上次活跃 HH:MM:SS（刚刚 / N 秒前 / N 分钟前）` — the absolute clock is the primary signal (it stays readable on a card whose PATCHes are failing, because the reader compares it against their own clock), the relative age rides in parentheses, and the ⚠️ stall prefix keeps its own wording ahead of it. The <10s special case is gone.
- **Plumbing**: the platform exposes the icon through a `LiveCardIconSource` structural capability (`liveCardIconKey(): Promise<string>`, FeishuPlatform implements it over the existing `spinnerCfg()`/`spinnerKeyForState('running')`), so the engine never imports Feishu types; the panel record stores the key once at post time and every refresh PATCH reuses it. A failed lookup renders no icon and never blocks the post. The footer note moved from a markdown line to the card's note element (small grey), matching the tool card's footer styling.

## Alternatives considered

- **Relative-only wording tweaks (drop 刚刚活跃, keep "N 分钟前").** Rejected: still no glance signal — relative wording requires reading and comparing; a frozen wall clock in the title does the comparison for the reader.
- **A dedicated stall-only header color without the clock.** Rejected: color alone cannot distinguish "one child stalled, others fine" from "all stalled for 2 minutes", and it re-fires the same question the timestamp answers.
- **Header refresh on its own sub-interval (faster than the body).** Rejected: the panel already PATCHes on a timer; a second timer doubles the PATCH budget for information the same PATCH carries.

## Consequences

- A stalled child is visible at a glance twice over: the header clock stops advancing, and (after the stall window) the template turns orange with a stalled count. The wall clock makes even a dead card (PATCH failures, daemon gone) diagnosable from the frozen timestamp alone.
- `CardHeader.icon` is a general card-model field; future live cards (chatroom panels, monitor cards) can carry a header icon without touching the renderer. `LiveCardIconSource` is the only new platform capability.
- i18n: `subtask_panel_title` drops its ⚙️ emoji (the icon owns liveness), `subtask_panel_ago_*` keys become pure relative durations (`刚刚`/`N 秒前`/`N 分钟前`), and `subtask_panel_last_active` + `subtask_panel_stalled_suffix` are new. No config surface changed: interval, stall window, and enablement keep their existing `features.subtaskLivePanel*` keys.
- Pinned by `tests/engine/subtask-panel.spec.ts`: header three-part composition, yellow→orange flip with stalled suffix, clock omission before the first event, absolute+relative row pairing, icon pass-through and terminal-phase ignore, icon-lookup failure posting without an icon. Successor to [2026-08-27 background-subtask live panel](2026-08-27-feishu-bridge-background-subtask-panel.md).
