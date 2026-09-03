# Agent Note: feishu-bridge provider card hot-switch mode (#9)

Status: implemented

English | [中文](2026-08-28-feishu-bridge-provider-card-hot-mode.zh.md)

## Problem

The provider card ([provider card](2026-08-28-feishu-bridge-provider-card.md)) shipped with plain switching only: every row dropped the agent session id, and the `-r` hot switch (keep the transcript, swap the route) stayed a text-only command. The rejection's rationale — doubling every route row for a rarely used variant — left real demand unanswered: preserving conversation context across a model change is the common way to switch providers mid-task, and retyping `/provider <name> -r` defeats the tap-to-switch surface.

## Decision

The card gains a switch-mode row between the current line and the route rows: two equal-width buttons — 「热切换（保留上下文）」 (`nav:/provider -r`, the card's default, leftmost) and 「切换（新会话）」 (`nav:/provider`) — the active mode styled primary. The pressed mode re-renders the card in place (`nav:` — no side effects) with every route row carrying the matching action: `act:/provider <name>` in plain mode, `act:/provider <name> -r` in hot mode (row button label 热切换). The card-action handler parses the shared `-r` grammar (`parseProviderResumeFlag`), so one value space serves mode rendering (empty route name) and switching (named route); the notice after a hot switch reuses `provider_hot_switched`, and the re-rendered card stays in the mode of the pressed action. The help card's provider entry opens the card in its hot default (`nav:/provider -r`). `applyProviderSwitch` gains the resume flag and becomes the single core for all three entry points — text plain, text `--resume`, card row — preserving each path's effect order (capture the agent session id before the interactive-session stop, restore it after).

## Alternatives considered

**Per-route double rows (the variant rejected when the card landed).** Still rejected: two buttons per route doubles the card for a choice that is per-session, not per-route — the mode is naturally card-level state.

**A confirm step after pressing a route row.** Rejected: it taxes the high-frequency plain switch with an extra tap; the mode row keeps the default path at one tap.

## Consequences

Hot switching is now first-class on the card: select the mode once, then every row preserves context, with the 🔄 notice and the route rows re-rendered in place. The card opens hot-switched by default — the hot button sits leftmost and every route row carries `-r`; plain mode is one tap away on the mode row, and stale cards carrying only the plain values keep working — the `-r` flag can only arrive on values this card emits. Switch semantics have one owner (`applyProviderSwitch`), so the plain/resume divergence is a flag, not two diverging copies. The hint text changed to describe mode-dependent rows.

## Testing

`tests/engine/provider-commands.spec.ts`: `nav:/provider -r` renders hot mode (rows carry `-r`, 热切换 labels, hot button primary) without switching; a pressed hot row keeps the agent session id, shows the 🔄 notice, and stays in hot mode; the bare card asserts the hot default (hot button leftmost and primary, route rows carrying `-r`). `tests/assembly-misc.spec.ts`: a hot card action on the assembled engine flips the adapter route with the session id preserved. Full package suite green; text-path `--resume` tests unchanged and green.
