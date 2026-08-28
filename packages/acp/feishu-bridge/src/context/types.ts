/**
 * Narrow wire types for the dsh-context plugin's session projections
 * (`contextTimeline`, `contextHeaders`, `contextPressure`), ported for the
 * Feishu context-insight cards, plus the token-meter projections the
 * dsh-context-less degraded card reads (`contextBreakdown`, `tokenUsage`)
 * and the assembled {@link ContextSnapshotValues} the adapter returns.
 *
 * Upstream provenance (re-align by hand when dsh-context changes):
 * - dsh-context `src/shared/types.ts`: `Snapshot`/`ContextTimeline`
 *   (current composition, requests, events, cost raw material),
 *   `RequestRecord`, `ContextEventRecord`, `ContextPressure`,
 *   `SessionCostUsage`/`CostFamilyUsage`/`CostBucketTotals`,
 *   `ContextHeaders`/`HeaderRecord`/`HeaderTool`.
 * - token-meter `src/projection.ts`: `ContextBreakdownProjection`
 *   (`ContextBreakdownValue`) and `TokenUsageProjection`
 *   (`TokenUsageValue`); `ContextPressureValue` covers the same
 *   `contextPressure` key dsh-context reads for its headline.
 *
 * Field optionality mirrors upstream exactly (a projection value from a
 * current dsh-context host feeds these types unchanged); only fields the
 * cards consume survive — surface nodes, archive, and header schema/description
 * payloads are dropped. Token figures are heuristic counts; cost carries raw
 * billed-token totals only, never a currency conversion.
 *
 * @module dsh-feishu-bridge/context/types
 */

/**
 * The six priced context buckets of a composition figure: the system prompt,
 * the tool schemas, and the four surface categories. Keys are ordered as
 * upstream's `CATS` (dsh-context `src/client/categories.ts`); chartspec.ts
 * keeps colors and labels index-aligned with this order.
 */
export interface SixBuckets {
  /** Heuristic token count of the assembled system prompt. */
  system: number
  /** Heuristic token count of the assembled tool schemas. */
  tools: number
  /** Heuristic token count of live user-message nodes. */
  user: number
  /** Heuristic token count of live injected-content nodes. */
  inject: number
  /** Heuristic token count of live assistant-message nodes. */
  assistant: number
  /** Heuristic token count of live tool-result nodes. */
  tool: number
}

/**
 * The current context composition: the six buckets plus their sum
 * (`total` is exactly the six buckets added, per the dsh-context fold).
 */
export interface CurrentComposition extends SixBuckets {
  /** Sum of the six buckets. */
  total: number
}

/**
 * One answered model call (a step), ported from dsh-context
 * `src/shared/types.ts` `RequestRecord` minus the web-client-only markers
 * (`stepCount`, `net`). `turn`/`step` are optional in the durable vocabulary —
 * the fold writes them only for real numbers; `prompt`/`cacheRead`/`output`
 * are absent until the request carries usage.
 */
export interface RequestRecord extends SixBuckets {
  /** Turn ordinal; absent records group under turn 0. */
  turn?: number
  /** Step ordinal within the turn. */
  step?: number
  /** Log time (epoch ms). */
  time: number
  /** Log sequence number. */
  seq: number
  /** Sum of this record's six buckets. */
  total: number
  /** Provider-reported prompt size (input + cache) when usage was reported. */
  prompt?: number
  /** Billed cache-read prompt tokens of this request. */
  cacheRead?: number
  /** Billed output tokens of this request. */
  output?: number
}

/**
 * A notable context event (compaction, prune, injection, model or mode
 * switch), ported 1:1 from dsh-context `src/shared/types.ts`
 * `ContextEventRecord` — every field is card-visible, so none are dropped.
 */
export interface TimelineEvent {
  /** Log sequence number. */
  seq: number
  /** Log time (epoch ms). */
  time: number
  /** Event discriminant. */
  kind: 'compaction' | 'prune' | 'inject' | 'model' | 'mode'
  /** Injection form tag (inject events). */
  form?: string
  /** Token figure the event freed or added, when meaningful. */
  tokens?: number
  /** Count figure (e.g. pruned nodes), when meaningful. */
  count?: number
  /** Sub-form tag. */
  sub?: string
  /** Producer-declared name. */
  name?: string
  /** One-line producer account shown after the name. */
  detail?: string
  /** Previous value (model/mode switch events). */
  from?: string
  /** Next value (model/mode switch events). */
  to?: string
  /** Turn of the request logged right before the event (host-stamped). */
  fromTurn?: number
  /** Step of the request logged right before the event (host-stamped). */
  fromStep?: number
  /** Turn of the request this event contributed to (host-stamped). */
  turn?: number
  /** Step of the request this event contributed to (host-stamped). */
  step?: number
}

/**
 * One pricing bucket's cumulative billed-token totals, ported from
 * dsh-context `src/shared/types.ts` `CostBucketTotals`.
 */
export interface CostBucketTotals {
  /** Billed prompt tokens that missed the provider cache. */
  uncached: number
  /** Billed output tokens (reasoning included). */
  output: number
  /** Billed prompt tokens served from the provider cache. */
  cacheRead: number
  /** Billed prompt tokens written into the provider cache. */
  cacheWrite: number
}

/**
 * One model family's cost raw totals split by DeepSeek's pricing period
 * (Beijing Time), ported from dsh-context `src/shared/types.ts`
 * `CostFamilyUsage`.
 */
export interface CostFamilyUsage {
  /** Peak-period totals; absent when nothing billed in peak. */
  peak?: CostBucketTotals
  /** Off-peak-period totals; absent when nothing billed off-peak. */
  off?: CostBucketTotals
}

/**
 * The session-cost estimate's raw material: cumulative provider-reported
 * token totals per model family, ported from dsh-context
 * `src/shared/types.ts` `SessionCostUsage`. Raw tokens only — the client
 * prices with its own table, and this module never converts to currency.
 */
export interface SessionCostUsage {
  /** deepseek-v4-flash family totals; absent when no flash request billed. */
  flash?: CostFamilyUsage
  /** deepseek-v4-pro family totals; absent when no pro request billed. */
  pro?: CostFamilyUsage
}

/**
 * Narrow `contextTimeline` projection value (dsh-context's `ContextTimeline`):
 * the current composition, per-step request history, context events, and the
 * session-cost raw material. `requests` is seq-ordered oldest-first and
 * bounded by whole turns; `events` is the newest tail.
 */
export interface ContextTimelineValue {
  /** Current context composition (heuristic sums). */
  current: CurrentComposition
  /** Per-step request records, oldest first. */
  requests: RequestRecord[]
  /** Notable context events, oldest first. */
  events: TimelineEvent[]
  /** Route capacity, when a provider reported one. */
  contextWindow?: number
  /** Session-cost raw material; absent until a request reports usage. */
  cost?: SessionCostUsage
}

/**
 * Narrow `contextPressure` projection value (the official token-meter
 * projection dsh-context reads for its headline): provider-anchored occupancy
 * of the next request. Fields are independent last-wins records, absent until
 * a provider reports usage.
 */
export interface ContextPressureValue {
  /** Provider-reported prompt size of the most recent request (input + cache). */
  pressureTokens?: number
  /** pressureTokens plus heuristic surface movement since the sample. */
  projectedTokens?: number
  /** Newest recorded route capacity (last-wins). */
  contextWindow?: number
}

/**
 * One tool schema as assembled into a request header, ported from
 * dsh-context `src/shared/types.ts` `HeaderTool` minus the browser-only
 * `description`/`schema` payloads.
 */
export interface HeaderToolValue {
  /** Tool name as the model sees it. */
  name: string
  /** Heuristic token count of the JSON schema. */
  tokens: number
  /** Registering plugin's label (`mcp:<server>` for MCP tools), when known. */
  plugin?: string
}

/**
 * One request-header epoch ported from dsh-context `src/shared/types.ts`
 * `HeaderRecord` minus the full system-prompt text.
 */
export interface HeaderRecordValue {
  /** Log sequence number the epoch took effect at. */
  seq: number
  /** Log time (epoch ms). */
  time: number
  /** Tool schemas in force from this epoch until the next. */
  tools: HeaderToolValue[]
}

/**
 * Narrow `contextHeaders` projection value: the bounded epoch list,
 * newest last (dsh-context keeps at most 50 epochs).
 */
export interface ContextHeadersValue {
  /** Header epochs, oldest first. */
  headers: HeaderRecordValue[]
}

/**
 * One turn's aggregated figure (the `aggregateByTurn` output): the six
 * buckets summed over the turn's step records. `stepCount` mirrors upstream's
 * same-named marker on turn-aggregated records.
 */
export interface TurnBucket extends SixBuckets {
  /** Turn ordinal as stamped on the folded records. */
  turn: number
  /** Sum of this turn's six bucket sums. */
  total: number
  /** Number of step records folded into the turn. */
  stepCount: number
}

/**
 * Narrow `contextBreakdown` projection value (token-meter's
 * `ContextBreakdownProjection`): the heuristic three-part composition of the
 * next request. All figures use the meter's fixed density estimate and never
 * sum to the provider-anchored occupancy — present them as approximations,
 * never as a total.
 */
export interface ContextBreakdownValue {
  /** Heuristic tokens of the newest request envelope's system prompt; 0 before any request. */
  systemTokens: number
  /** Heuristic tokens of the newest request envelope's tool schemas; 0 before any request. */
  toolsTokens: number
  /** Heuristic tokens of the current model-visible conversation surface. */
  messageTokens: number
}

/**
 * Narrow `tokenUsage` projection value (token-meter's
 * `TokenUsageProjection`): cumulative provider-reported usage over the
 * complete durable log. The four buckets are disjoint (reasoning tokens are
 * already inside `outputTokens`).
 */
export interface TokenUsageValue {
  /** Billed prompt tokens that missed the provider cache. */
  uncachedInputTokens: number
  /** Billed output tokens (reasoning included). */
  outputTokens: number
  /** Billed prompt tokens served from the provider cache. */
  cacheReadTokens: number
  /** Billed prompt tokens written into the provider cache. */
  cacheWriteTokens: number
}

/**
 * The context-relevant projection values of one live agent session, as one
 * consistent `sessionProjections.snapshot` cut: dsh-context's
 * `contextTimeline`/`contextHeaders` plus token-meter's
 * `contextPressure`/`contextBreakdown`/`tokenUsage`. Every field is
 * independently optional — each key exists only while its registering plugin
 * is loaded, and the token-meter fields stay absent until a provider reports
 * usage.
 */
export interface ContextSnapshotValues {
  /** dsh-context timeline; absent when the plugin is not mounted. */
  timeline?: ContextTimelineValue
  /** dsh-context header epochs; absent when the plugin is not mounted. */
  headers?: ContextHeadersValue
  /** token-meter pressure of the most recent request. */
  pressure?: ContextPressureValue
  /** token-meter heuristic composition of the next request. */
  breakdown?: ContextBreakdownValue
  /** token-meter cumulative billed usage. */
  usage?: TokenUsageValue
}
