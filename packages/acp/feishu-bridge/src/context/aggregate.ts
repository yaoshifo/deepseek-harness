/**
 * Pure aggregation over the dsh-context projection values, ported for the
 * Feishu context-insight cards. No React, no dsh-context imports — every
 * input is one of this module's narrow wire types.
 *
 * Upstream provenance (re-align by hand when dsh-context changes):
 * - dsh-context `src/client/headline.ts` `headlineOf`: the anchor chain
 *   (official `contextPressure` projection first, the last request's prompt
 *   estimate second, the heuristic composition total last).
 * - dsh-context `src/client/components/trendChart.tsx` `aggregateByTurn`:
 *   consecutive equal-turn runs collapse (the fold keeps one turn's requests
 *   consecutive) and the aggregate carries a `stepCount`.
 * - dsh-context `src/client/components/browser.tsx`: the tools' size sort
 *   (tokens descending) mirrors the overview's Top chips order.
 * - dsh-context `src/host/fold.ts`: requests are seq-ordered oldest-first
 *   and events are kept as the newest tail.
 *
 * @module dsh-feishu-bridge/context/aggregate
 */

import type {
  ContextHeadersValue,
  ContextPressureValue,
  ContextTimelineValue,
  HeaderToolValue,
  RequestRecord,
  TimelineEvent,
  TurnBucket,
} from './types.js'

/** The headline anchor's winning source. */
export type HeadlineSource = 'pressure' | 'estimate'

/** The derived headline: the best-known occupancy of the next request. */
export interface Headline {
  /**
   * Best-known occupancy of the next request: the pressure projection's
   * `projectedTokens`, else the last request's prompt plus the surface
   * movement since it was logged, else the heuristic composition total.
   */
  occupiedTokens: number
  /** Route capacity the ratio scales against; absent when unknown. */
  contextWindow?: number
  /**
   * occupiedTokens / contextWindow rounded to 4 decimals. May exceed 1 while
   * occupancy runs past the window (compaction has not fired yet); clamp at
   * the render site when a surface requires 0..1. Absent without a positive
   * window.
   */
  ratio?: number
  /**
   * `'pressure'` when the official `contextPressure` projection supplied the
   * anchor; `'estimate'` for both fallback tiers (the last-request estimate
   * and the heuristic composition total).
   */
  source: HeadlineSource
}

/**
 * Derive the provider-anchored headline of a context timeline.
 *
 * Ported from dsh-context `src/client/headline.ts` `headlineOf`, minus the
 * composition-parts anchoring (the Feishu cards rebuild proportions from the
 * raw six buckets instead). The window prefers the pressure projection's
 * `contextWindow` over the timeline's, and a non-number `projectedTokens`
 * falls through to the estimate exactly as upstream does.
 *
 * @param timeline - The `contextTimeline` projection value.
 * @param pressure - The `contextPressure` projection value when composed; its
 *   `projectedTokens` wins over every estimate.
 * @returns The headline with the winning anchor's source marked.
 */
export function headlineOf(
  timeline: ContextTimelineValue,
  pressure?: ContextPressureValue,
): Headline {
  const current = timeline.current
  const requests = timeline.requests
  const lastReq = requests.at(-1) ?? null
  // Official anchor: the newest usage sample carried forward by the heuristic
  // surface movement since it was taken (last-wins fields, absent until a
  // provider reports usage).
  const projected = pressure !== undefined && typeof pressure.projectedTokens === 'number'
    ? pressure.projectedTokens
    : undefined
  // Fallback anchor: the newest request's provider prompt plus the heuristic
  // surface movement since it was logged — same shape as the projection, one
  // request behind.
  const derived = lastReq !== null && typeof lastReq.prompt === 'number'
    ? lastReq.prompt + (current.total - lastReq.total)
    : undefined
  const occupiedTokens = projected ?? derived ?? current.total
  const contextWindow = pressure !== undefined && typeof pressure.contextWindow === 'number'
    ? pressure.contextWindow
    : timeline.contextWindow
  const headline: Headline = {
    occupiedTokens,
    source: projected !== undefined ? 'pressure' : 'estimate',
  }
  if (contextWindow !== undefined) headline.contextWindow = contextWindow
  if (contextWindow !== undefined && contextWindow > 0) {
    headline.ratio = Math.round((occupiedTokens / contextWindow) * 10_000) / 10_000
  }
  return headline
}

/**
 * Collapse per-step request records into one bucket per turn.
 *
 * Consecutive records with an equal `turn` (absent turns group under 0) fold
 * into one {@link TurnBucket} whose six buckets and `total` are the sums over
 * the run — mirroring upstream's guarantee that the fold keeps one turn's
 * requests consecutive. `total` sums the per-record totals, which the fold
 * defines as each record's own six buckets added.
 *
 * @param requests - Per-step request records, oldest first (seq-ordered).
 * @param limit - Maximum number of turns to keep, counting from the newest;
 *   values ≤ 0 yield an empty result.
 * @returns The most recent `limit` turns, oldest first.
 */
export function aggregateByTurn(requests: RequestRecord[], limit: number): TurnBucket[] {
  if (limit <= 0) return []
  const turns: TurnBucket[] = []
  let current: TurnBucket | null = null
  for (const req of requests) {
    const turn = req.turn ?? 0
    if (current !== null && current.turn === turn) {
      current.system += req.system
      current.tools += req.tools
      current.user += req.user
      current.inject += req.inject
      current.assistant += req.assistant
      current.tool += req.tool
      current.total += req.total
      current.stepCount++
    } else {
      current = {
        turn,
        system: req.system,
        tools: req.tools,
        user: req.user,
        inject: req.inject,
        assistant: req.assistant,
        tool: req.tool,
        total: req.total,
        stepCount: 1,
      }
      turns.push(current)
    }
  }
  return turns.slice(-limit)
}

/** A tool schema row of a Feishu card's top-tools list. */
export interface ToolSchemaSummary {
  /** Tool name as the model sees it. */
  name: string
  /** Heuristic token count of the JSON schema. */
  tokens: number
  /** Registering plugin's label, when attribution is known. */
  plugin?: string
}

/**
 * Pick the top tool schemas by token count.
 *
 * Reads the NEWEST header epoch (the last of `headers.headers`, newest last)
 * and ranks its tools by tokens descending — the order of the web overview's
 * Top chips; the producer's header order is not meaningful. Ties keep the
 * epoch's declaration order (a stable sort).
 *
 * @param headers - The `contextHeaders` projection value; `undefined` when
 *   the projection is not composed (an older host).
 * @param n - Maximum number of tools to return; values ≤ 0 yield an empty
 *   result.
 * @returns Up to `n` tool rows, largest first.
 */
export function topToolSchemas(headers: ContextHeadersValue | undefined, n: number): ToolSchemaSummary[] {
  if (headers === undefined || n <= 0) return []
  const current = headers.headers.at(-1) ?? null
  if (current === null) return []
  const ranked = current.tools.slice().sort((a: HeaderToolValue, b: HeaderToolValue) => b.tokens - a.tokens)
  const top = ranked.slice(0, n)
  return top.map((t) => {
    const summary: ToolSchemaSummary = { name: t.name, tokens: t.tokens }
    if (t.plugin !== undefined) summary.plugin = t.plugin
    return summary
  })
}

/**
 * Pick the most recent context events.
 *
 * @param events - Context events, oldest first (seq-ordered).
 * @param n - Maximum number of events to keep; values ≤ 0 yield an empty
 *   result.
 * @returns The newest `n` events, preserving the log order (oldest first
 *   within the slice); reverse at the render site for newest-first lists.
 */
export function recentEvents(events: TimelineEvent[], n: number): TimelineEvent[] {
  if (n <= 0) return []
  return events.slice(-n)
}
