# Agent Note: feishu-bridge user-questions answerer on the scoped waterfall

Status: implemented

English | [中文](2026-08-29-feishu-bridge-user-questions-waterfall-answerer.zh.md)

## Problem

The fork-local feishu-bridge adapter registered its user-questions answerer through `userQuestions.registerProvider(...)`. Upstream 049170c6d0 (2026-08-23, merged into dev the same day) removed that registry in favour of the agent-scoped `user-questions/request` waterfall, and the bridge adapter was never migrated. Stale builds kept the daemon working until the 2026-08-29 rebuild and restart; the first agent creation then threw `TypeError: uq.registerProvider is not a function`, and because `questionRouting.registered` was set before the registration call, every later session silently skipped registration. No answerer composed, so every `ask_user_question` call — and every plan-approval ask, including exit-plan-mode cards — returned `no user-questions answerer accepted the request` and no card rendered (oc_cd00410d follow-up incident). The adapter unit tests faked the removed service API by hand, so CI never saw the break.

## Decision

- `ensureUserQuestionsAnswerer` (formerly `ensureUserQuestionsProvider`) registers one `user-questions/request` waterfall listener through `ctx.on`. The adapter's plugin context is untagged, which the scope carrier admits globally — the same admission the adapter's existing `agent/disposed` listener already relies on.
- The listener claims a request by returning the owning adapter's `handleUserQuestion` result and delegates with `next()` otherwise; shared question routing still registers exactly one listener per plugin application and dispatches to the adapter owning the live session. The plugin application owns that listener, not the registering adapter: its disposer is never pushed into an adapter's disposers, so no single adapter's dispose can remove the daemon-wide answerer.
- The registration flags (`questionRouting.registered`, `uqRegistered`) are set only after the listener is registered, so a failed registration is retried on the next session instead of being silently skipped forever.
- An unclaimed ask surfaces as the service's NO_PROVIDER error instead of the old warn-plus-empty-answers fallback: an explicit failure the model can report in text beats silent empty selections, which were the masking signature of the 2026-08-26 cron-fbe6d268 incident.

## Alternatives considered

- **Restore `registerProvider` on the user-questions service.** Rejected: upstream owns the service contract; the scoped waterfall is the shipped extension point for UI answerers, and re-adding a registry fork-locally re-breaks on the next sync.
- **Keep the empty-answers fallback for unmatched sessions.** Rejected: it reports a successful ask the user never saw and steals requests from any other composed answerer downstream in the waterfall.

## Consequences

- A question arriving for a session the bridge does not own now rejects with NO_PROVIDER instead of answering empty; in the headless daemon the bridge is the only composed answerer, so the model sees an honest error it can relay in text.
- Disposing one sharing adapter leaves the shared listener in place; Cordis removes it only when the routing context itself is disposed, together with every adapter. A regression test disposes the first sharing adapter and asserts the listener still answers for the remaining one.
- The real-composition regression test pins the scope-delivery assumption (an untagged plugin-context listener receives agent-scoped asks); if upstream scope admission rules change, that test fails before production does.

## Testing

`tests/agent-dsh/adapter.spec.ts`: a real-composition test composes the real `UserQuestionService` and `AgentRegistry` on a real Cordis context and drives `userQuestions.ask` through the adapter to the engine ask delegate (reproduces both the registration TypeError and the NO_PROVIDER failure); the hand-written service fakes are replaced by a driver that invokes the registered waterfall listener with the service's no-answerer fallback; the shared-routing case asserts exactly one listener across two adapters and cross-adapter dispatch; a dispose case proves the shared listener survives the first adapter's dispose. Suites: feishu-bridge 158 files / 2703 tests passing; repository typecheck clean; oxlint clean on the touched files.
