# Agent Note: Feishu /context insight card over the session projections

Status: implemented

English | [中文](2026-08-28-feishu-bridge-context-command.zh.md)

## Problem

A Feishu chat's context state — how full the window is, what the prompt is made of, what compaction or injection did to it, which tool schemas weigh the most — was only observable on the dsh-context web client. The chat surface had no view of it: asking the bot costs a model turn and answers from inside the very context being asked about, and `/status` reports engine state, not context state. Feishu's schema 2.0 card format gained a native `chart` element (VChart-backed) that no bridge surface used yet, and dsh-context's projections (`contextTimeline`, `contextHeaders`) plus token-meter's (`contextPressure`, `contextBreakdown`, `tokenUsage`) already fold exactly this data in the daemon's own process.

## Decision

Three layers, landed in three steps.

**Chart element** (`src/card.ts`, `src/feishu/card.ts`): the card model carries `{ kind: 'chart', spec }` where `spec` is an opaque VChart JSON object the bridge never interprets; the renderer emits `{ tag: 'chart', chart_spec: spec }` verbatim. Feishu validates the spec server-side at send time (code 230099), so spec correctness stays with the caller — the live-verified constraint is that `color` must be a complete ordinal scale (`{ type, domain, range }`), and `src/context/chartspec.ts` bakes the two wire forms a real card delivery proved (a horizontal composition bar and stacked per-turn columns). No texture, conical gradients, word-cloud grids, extensionMark image repeat, or svg mark backgrounds — all mobile-unsupported; the platform appends its own responsive media queries, so specs never declare `media`.

**Context module** (`src/context/`): dsh-context's pure functions and wire types ported into the bridge — `headlineOf` (the anchor chain: the official `contextPressure` projection first, the last request's prompt estimate second, the heuristic composition total last), `aggregateByTurn`, `topToolSchemas`, `recentEvents`, the two chart-spec builders, and the narrow types (`ContextTimelineValue`, `ContextHeadersValue`, `ContextPressureValue`, plus token-meter's `ContextBreakdownValue`/`TokenUsageValue` and the assembled `ContextSnapshotValues`). No dsh-context imports — a projection value from a current dsh-context host feeds the types unchanged, and field optionality mirrors upstream so re-alignment is a hand-diff, not a rewrite.

**/context command** (`src/engine/context-commands.ts` + `src/context/render.ts`): the command resolves the chat's live agent session (`Engine.activeAgentSessionID`, live interactive first), reads one consistent `sessionProjections.snapshot` cut through the adapter's new `ContextSnapshotReader` capability (`DshAgentAdapter.contextSnapshot(agentSessionID)` — `ctx.agents.get` → `agent.session` → the registry's `snapshot`, returning the five keys or undefined when the session has no live agent), and renders the card from pure functions of the assembled args. The card: header (📊 marker, capped session title, model), the headline (occupancy versus window, headroom, red template plus an overrun line when the ratio exceeds 1), the composition bar, the per-turn trend (last 20 turns), the newest 8 context events, turn/step/event-kind statistics with the last request's raw prompt/cacheRead/output figures, a collapsed top-5 tool-schema panel, and a refresh button. The button carries `act:/context ctx:<sessionKey>` and registers through `Engine.registerCardAction`: the pressed card's own render-time session key wins over the pressing user's chat key, and the handler re-reads the snapshot and PATCHes the pressed card in place. List caps (20 turns, 8 events, 5 tools) and per-field rune caps bound the card by construction; a final budget guard measures the rendered JSON (20KB internal control against Feishu's 30KB hard limit) and the element count (< 200), degrading past-budget cards by dropping the trend chart and the event section before a headline-only fallback.

Degradation ladder: without a `contextTimeline` (dsh-context not mounted) the card renders the token-meter headline, the heuristic three-part breakdown, the cumulative raw usage, and a mount hint; without a live agent session it renders a friendly empty-state card. Non-card platforms get the text degradation (numbers and events, charts dropped).

The plugin's `inject` array declares `sessionProjections` — dsh-base always mounts the registry, and the declaration orders the bridge's activation after it (minimal test compositions mount the row too).

## Alternatives considered

**Rendering inside the engine** (the `/status` shape): rejected — the card is a pure function of the projection values plus two display strings; `src/context/render.ts` keeps it table-testable without an Engine, and the engine module only resolves inputs.

**A `ContextSnapshotReader` on the Engine instead of the adapter**: rejected — the Engine holds no `ctx`; the adapter owns the cordis context and already exposes sibling capability reads (`childCwd` over `ctx.agents.get`), so the structural cast (`asContextSnapshotReader(e.agent)`) keeps the seam the other capabilities use.

**Cost figures from `timeline.cost`**: deferred — the card shows raw provider token counts only; the billed-token family totals exist in the timeline value but a currency conversion belongs to a usage/billing surface, not a context-insight card.

**Sizing the events section by a byte budget instead of the card-level guard**: rejected — per-field rune caps keep ordinary cards complete, and one card-level guard with a deterministic degradation ladder covers every section at once instead of one more bespoke budget to tune.

## Consequences

`/help` lists `/context` under the agent group automatically. i18n gains two keys (`context`, `context_usage`). The refresh button's callback path cannot be tested automatically (the known Feishu card-action limitation) — it is covered by the pure-function table tests over the act value plus the card-action dispatch tests, and real-device smoke runs. The inject declaration makes the projection registry a hard activation dependency of the bridge: a composition without `dsh-session-projection` will not load the bridge at all (every real profile builds on dsh-base, which mounts it); dropping the entry degrades to an empty `/context` card instead, if that trade is ever preferred. Reading a cold (non-live) session's projections is not supported — the registry's cells are keyed by live `Session` objects — so `/context` after a daemon restart renders the empty-state card until the chat's next turn resumes its agent.

## Testing

`tests/context-render.spec.ts` (14 cases): full-card structure (header, headline numbers, both charts, statistics, prefixed refresh button), red-template overrun, list caps (40 turns → 20, 20 events → 8, 20 tools → 5), event line shape and ordering, the pressure fallback, the token-meter degraded card, the empty-state card, and the budget guard (pathological CJK payloads degrade under the 20KB control; the byte/element measurers). `tests/agent-dsh/adapter-context-snapshot.spec.ts` (4 cases): the five-key pick, absent-key omission, the all-absent snapshot, and the three undefined paths. `tests/engine/context-commands.spec.ts` (7 cases): table merge and prefix resolution, card and text dispatch, the empty-state path, the in-place refresh card action (args-carried key and fallback), and dispose. The two REAL-composition suites (`tests/mcp-health.spec.ts`, feishu-bridge-chatroom's `tests/loader-composition.spec.ts`) mount the `session-projection` row the inject declaration requires.
