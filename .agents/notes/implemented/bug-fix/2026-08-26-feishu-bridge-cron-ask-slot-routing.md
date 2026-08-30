# Agent Note: feishu-bridge cron new-per-run asks route under the interactive slot key

Status: implemented

English | [中文](2026-08-26-feishu-bridge-cron-ask-slot-routing.zh.md)

## Problem

The 2026-08-26 cron-fbe6d268 pre-market check run (session mode `new_per_run`) ended with `ask_user_question` resolving `{"answers":[{"id":"followup","selected":[]}]}` within 8 milliseconds — no card was ever sent, and the agent read the empty selection as the user declining follow-ups, archiving that false conclusion into its own memory. Root cause: `executeCronJob` parks a new-per-run run's interactive state under the slot key `<runSessionKey>#cron:<sideSessionId>`, but the adapter's approval answerer and userQuestions provider passed the bare `DshAgentSession.sessionKey()` to `Engine.askUser`, which resolves the state by exact key. During the run the bare key holds no state (the chat's own state is idle-reaped or belongs to another turn), so the ask fell through to `unattendedAskDecision`: question asks answer empty, permission asks auto-allow. The same miss silently auto-approved permission asks for every cron new-per-run run, or parked them on the chat's unrelated live state when one happened to exist.

The discriminating signature for future triage: a question ask returning in single-digit milliseconds with exactly one `{id, selected: []}` entry per question (the adapter's own empty fallbacks return a zero-entry array), and no card-send calls in the daemon log.

## Decision

- `SessionStartOptions.interactiveSlotKey` ([session start options](../simplification/2026-08-24-feishu-bridge-session-start-options.md)) carries the interactive-state slot key whenever it differs from `sessionKey` — cron new-per-run `#cron:` slots. `getOrCreateInteractiveStateWith` sets it; `DshAgentSession.askSlotKey()` exposes it, falling back to the session key. The approval answerer, the questions handler, and the plan-review answerer all pass `askSlotKey()` to the [ask delegate](../simplification/2026-08-24-feishu-bridge-ask-delegate.md), so the card renders on the run's own state. The click does not route back through the card: callback values stamp the reply context's bare key, and `routeAskResponse` bridges that bare-key click to the slot ([2026-08-31 follow-up](2026-08-31-feishu-bridge-cron-ask-slot-click-routing.md)).
- Unattended fallbacks now log. `Engine.askUser` warns before answering unattended (both the no-state and the no-platform branch), and the adapter warns when a live-session miss or a missing delegate fabricates an empty answer. Silent empty answers were exactly what made the incident invisible in production logs.

## Alternatives considered

- **Scan `interactiveStates` for a `${sessionKey}#cron:` prefix inside `askUser`.** Rejected: the suffix carries the side-session id the caller does not know, concurrent runs on one chat make the scan ambiguous, and prefix matching weakens the engine's exact-key ownership of the map.
- **Match interactive states by live agent session instead of by key.** Rejected: an O(n) scan per ask, and it re-opens the `AskDelegate` signature the ask-delegate seam froze; threading the explicit slot key keeps routing deterministic and the map lookup intact.
- **Treat cron new-per-run runs as unattended and fail asks loudly.** Rejected: the run deliberately owns an interactive state, streams its report, and its bound chat can answer a card — the answerer's design comment states questions still surface as cards on unattended sessions. The bug was the routing key, not the capability.

## Consequences

- Cron new-per-run runs now surface real ask cards (questions and permissions) in the job's bound chat and block on them. A user who never answers parks the turn until the job's scheduler timeout settles it cancelled — the idle reaper skips a parked `pendingAsk`, matching ordinary chat sessions; the abort-path settlement landed in the [2026-08-31 follow-up](2026-08-31-feishu-bridge-cron-ask-slot-click-routing.md), which also routes bare-key card clicks back to the slot.
- `DshAgentSession.sessionKey()` still returns the bare key; `sessionsByEngineKey` identity checks rely on it. Only ask routing reads the slot key.
- Covered by `tests/engine/cron-execute.spec.ts` (start options carry the slot), `tests/engine/engine-m3-askq.spec.ts` (slot-keyed park/settle round-trip; bare-key miss answers unattended), and `tests/agent-dsh/adapter.spec.ts` (questions and permission delegation under the slot key).
