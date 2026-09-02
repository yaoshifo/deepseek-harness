# Agent Note: feishu-bridge notifyOnComplete gates the completion card

Status: implemented

English | [中文](2026-09-02-feishu-bridge-notify-on-complete-gates-completion-card.zh.md)

## Problem

`projects[].feishu.notifyOnComplete` (Go `notify_on_complete`, FEATURE-PARITY #2) is documented as the switch for the ✅ completion notification, and M2 shipped it that way: the plain-text `CompletionNotifier` path checked it before replying. M7-b replaced that path on card platforms with the purple status-footer card (`sendTurnCompletionCard` through `sendCardWithHandle`) without inheriting the check. `FeishuPlatform` always structurally carries `sendCardWithHandle`, so the engine's card branch ran unconditionally and the gate inside `sendCompletionNotification` became unreachable — the config key was dead on every Feishu deployment while OPERATIONS.md §2 and FEATURE-PARITY #2 still claimed it worked, and no configuration could silence the per-turn ✅ card.

## Decision

`sendTurnCompletionCard` consults a new optional platform capability, `CompletionNoticePreference.completionNoticeEnabled()`, before any footer work: a platform that implements it and reports disabled skips both the purple card and the text fallback. `FeishuPlatform.completionNoticeEnabled()` returns `notifyOnComplete`, so `notifyOnComplete: false` — or omission, the flag stays opt-in per Go parity — silences the ✅ card per bot. The probe is opt-in like every `as*` capability check: a platform without the method keeps the unconditional card, so test stubs and future platforms are unaffected. The internal check in `FeishuPlatform.sendCompletionNotification` stays; it still guards that capability's own method contract.

## Alternatives considered

**Gate inside `FeishuPlatform.sendCardWithHandle`.** Wrong granularity: the method is shared by progress cards, ask cards, insight cards, and spawn readiness cards, so the gate would remove every card the bot sends.

**Invert to an opt-out default (card on unless `notifyOnComplete: false`).** Would change live behavior for any bot omitting the key. Both deployments (Mac 2 bots, dev server 9 bots) set `true` explicitly, so keeping the documented opt-in default changes nothing at deploy time and restores the FEATURE-PARITY #2 semantics.

**Thread the flag into the Engine constructor.** The engine is platform-agnostic; a Feishu config key does not belong in its assembly. The capability probe keeps the decision in the platform that owns the config.

## Consequences

A bot with `notifyOnComplete` unset or false no longer sends the ✅ card — including its status footer (model/ctx/workdir/git), spawn jump links, subtask diff, and pending-children hint; `/notify` re-sends the readiness card on demand, and insight cards, cron notices, and error notifications keep their own switches. The footer content decisions are untouched: durations exclude parked-ask time ([2026-08-30](2026-08-30-feishu-bridge-completion-duration-park-exempt.md)), and the pending-subtasks hint still rides the push when enabled ([2026-08-26](../feature/2026-08-26-feishu-bridge-pending-subtasks-card-visibility.md)). The gate sits at the single entry point — `sendTurnCompletionCard` is the only completion-notice call site — so both renderings enforce one decision.

## Testing

`tests/engine/status-footer.spec.ts`: a card-update platform stub reporting `completionNoticeEnabled: false` receives no card and stores no handle; the same stub with `true` keeps the card; a card-less notifier platform with the preference disabled receives no text notification. `tests/assembly.spec.ts`: `completionNoticeEnabled()` returns the configured `notifyOnComplete` and defaults to false.
