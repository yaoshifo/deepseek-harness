/**
 * Card rendering for the /context command: one Feishu schema 2.0 insight card
 * built from a session-projection snapshot (dsh-context's timeline/headers
 * plus token-meter's pressure/breakdown/usage). Every function here is pure
 * over its arguments — the engine-side command only assembles
 * {@link ContextCardArgs}; no engine state is read.
 *
 * Degradation ladder: a snapshot without a `contextTimeline` (dsh-context not
 * mounted) renders the token-meter headline/breakdown/usage card with the
 * mount hint; no snapshot at all (no live agent session) renders the friendly
 * empty-state card. List caps (trend turns, event lines, tool rows) and the
 * final JSON/element budget guard bound every path — the budget guard
 * degrades by dropping the trend chart and the event section before falling
 * back to a headline-only card, so the emitted card always fits Feishu's
 * 30KB hard limit with the 20KB internal control as the target.
 *
 * @module dsh-feishu-bridge/context/render
 */

import { newCard } from '../card.js'
import type { Card, CardElement } from '../card.js'
import { renderCardMap } from '../feishu/card.js'
import { aggregateByTurn, headlineOf, recentEvents, topToolSchemas } from './aggregate.js'
import type { Headline } from './aggregate.js'
import { compositionBarSpec, trendChartSpec } from './chartspec.js'
import type {
  ContextBreakdownValue,
  ContextSnapshotValues,
  ContextTimelineValue,
  RequestRecord,
  TimelineEvent,
  TokenUsageValue,
} from './types.js'

/** Per-turn trend columns kept in the full card. */
const TREND_TURN_LIMIT = 20

/** Recent context events listed in the full card. */
const EVENT_LINE_LIMIT = 8

/** Tool schema rows in the full card's collapsible panel. */
const TOOL_SCHEMA_LIMIT = 5

/** Session-title cap (runes) in the card header. */
const TITLE_MAX_RUNES = 48

/** Model-name cap (runes) in the card header. */
const MODEL_MAX_RUNES = 64

/**
 * Event text-field cap (runes) per rendered field. Generous by intent: eight
 * events at the cap can still exceed the JSON budget, which is exactly what
 * the budget guard's degradation ladder exists to catch.
 */
const EVENT_FIELD_MAX_RUNES = 256

/** Tool-name cap (runes) in the collapsible panel. */
const TOOL_NAME_MAX_RUNES = 96

/**
 * Card JSON byte budget, the internal control; Feishu rejects cards over
 * 30KB, and the margin absorbs the button value's session-key stamping.
 */
export const CONTEXT_CARD_JSON_BUDGET_BYTES = 20_000

/** Element-count ceiling of a schema 2.0 card body. */
export const CONTEXT_CARD_ELEMENT_CEILING = 200

/** The refresh button's action path (registered via Engine.registerCardAction). */
const REFRESH_ACTION = 'act:/context'

/** Prefix the refresh button's arguments carry before the session key. */
export const CONTEXT_REFRESH_ARG_PREFIX = 'ctx:'

/** Rendering arguments: everything the card shows, resolved by the caller. */
export interface ContextCardArgs {
  /** Interactive session key; the refresh button's callback targets it. */
  sessionKey: string
  /** Session display name ('' omits the header segment). */
  sessionTitle: string
  /** Active provider route's model name ('' omits the header segment). */
  model: string
  /**
   * Projection snapshot of the chat's live agent session; undefined (no live
   * session or unreadable) renders the friendly empty-state card.
   */
  snapshot: ContextSnapshotValues | undefined
}

/**
 * Render the /context insight card for one chat.
 *
 * @param args - Session title/model, the projection snapshot, and the refresh
 *   target session key.
 * @returns The assembled card, always within the JSON/element budget.
 */
export function renderContextCard(args: ContextCardArgs): Card {
  const full = buildContextCard(args, true, true)
  if (withinBudget(full, args.sessionKey)) return full
  // Pathological payloads (long CJK event fields at the rune caps) degrade by
  // dropping the two heaviest sections; the capped remainder always fits.
  const lean = buildContextCard(args, false, false)
  if (withinBudget(lean, args.sessionKey)) return lean
  return buildCompactContextCard(args)
}

/** Whether the rendered card fits both the JSON byte budget and the element ceiling. */
function withinBudget(card: Card, sessionKey: string): boolean {
  return cardJsonBytes(card, sessionKey) <= CONTEXT_CARD_JSON_BUDGET_BYTES
    && countElements(card) <= CONTEXT_CARD_ELEMENT_CEILING
}

/**
 * Measure one card's rendered JSON size in bytes (UTF-8; ASCII strings make
 * `string.length` equal the byte count, CJK does not — hence the encoder).
 * @param card - The card to measure.
 * @param sessionKey - Session key stamped into button callback values.
 * @returns The JSON byte length of the rendered card.
 */
export function cardJsonBytes(card: Card, sessionKey: string): number {
  return Buffer.byteLength(JSON.stringify(renderCardMap(card, sessionKey)))
}

/**
 * Count a card's element nodes recursively (panels and forms carry children;
 * the schema 2.0 body ceiling counts the rendered elements, of which this is
 * a close proxy).
 * @param card - The card whose elements are counted.
 * @returns The total element-node count.
 */
export function countElements(card: Card): number {
  let count = 0
  const walk = (elements: readonly CardElement[]): void => {
    for (const el of elements) {
      count++
      if (el.kind === 'collapsiblePanel') walk(el.elements)
      else if (el.kind === 'form') walk(el.elements)
      else if (el.kind === 'columnSet') for (const col of el.columns) walk(col.elements)
    }
  }
  walk(card.elements)
  return count
}

/** Build the card with optional heavy sections (the budget guard's knobs). */
function buildContextCard(args: ContextCardArgs, withTrend: boolean, withEvents: boolean): Card {
  if (args.snapshot === undefined) return buildEmptyContextCard(args)
  const timeline = args.snapshot.timeline
  if (timeline === undefined) return buildDegradedContextCard(args, args.snapshot)
  return buildFullContextCard(args, timeline, args.snapshot, withTrend, withEvents)
}

// ── full card (dsh-context timeline present) ───────────────────────────────

/**
 * The full insight card: headline, composition chart, per-turn trend, recent
 * events, session statistics, and the top-tool panel.
 */
function buildFullContextCard(
  args: ContextCardArgs,
  timeline: ContextTimelineValue,
  snapshot: ContextSnapshotValues,
  withTrend: boolean,
  withEvents: boolean,
): Card {
  const headline = headlineOf(timeline, snapshot.pressure)
  const cb = newCard().title(contextHeaderTitle(args), headline.ratio !== undefined && headline.ratio > 1 ? 'red' : 'blue')
  cb.markdown(headlineMarkdown(headline))
  cb.chart(compositionBarSpec(timeline.current), { aspectRatio: '2:1' })
  const turns = aggregateByTurn(timeline.requests, TREND_TURN_LIMIT)
  if (withTrend && turns.length > 0) {
    cb.chart(trendChartSpec(turns))
  }
  if (withEvents) {
    cb.markdown(recentEventsMarkdown(timeline.events))
  }
  cb.markdown(sessionStatsMarkdown(timeline, snapshot))
  const tools = topToolSchemas(snapshot.headers, TOOL_SCHEMA_LIMIT)
  if (tools.length > 0) {
    cb.collapsiblePanel(`🧰 工具 schema Top ${tools.length}`, false, {
      kind: 'markdown',
      content: tools.map(t =>
        `- \`${capRunes(t.name, TOOL_NAME_MAX_RUNES)}\` · ${formatTokens(t.tokens)}`
        + (t.plugin !== undefined ? ` · ${t.plugin}` : '')).join('\n'),
    })
  }
  return appendRefresh(cb, args).build()
}

/** The headline line: occupancy versus the window, headroom, and an overrun flag. */
function headlineMarkdown(headline: Headline): string {
  const occupied = formatTokens(headline.occupiedTokens)
  if (headline.contextWindow === undefined || headline.ratio === undefined) {
    return `**上下文占用** ~${occupied}（窗口未知）`
  }
  const pct = `${(headline.ratio * 100).toFixed(1)}%`
  const window = formatTokens(headline.contextWindow)
  if (headline.ratio > 1) {
    const over = formatTokens(headline.occupiedTokens - headline.contextWindow)
    return `⚠️ **超出上下文窗口**：占用 ${occupied} / ${window}（${pct}）· 超出 ${over}`
  }
  return `**上下文占用** ${occupied} / ${window}（${pct}）· 余量 ${formatTokens(headline.contextWindow - headline.occupiedTokens)}`
}

/** The recent-events markdown, newest first, capped at the line limit. */
function recentEventsMarkdown(events: readonly TimelineEvent[]): string {
  const shown = recentEvents([...events], EVENT_LINE_LIMIT).reverse()
  if (shown.length === 0) return ''
  const lines = shown.map(e => `- ${eventLine(e)}`)
  return `**最近事件**\n${lines.join('\n')}`
}

/** One event line: kind label, token figure, turn/step, and the producer's name. */
function eventLine(e: TimelineEvent): string {
  const parts: string[] = [eventKindLabel(e.kind)]
  if (e.tokens !== undefined) {
    const sign = e.kind === 'inject' ? '+' : '-'
    parts.push(`${sign}${formatTokens(Math.abs(e.tokens))}`)
  }
  const turn = e.turn ?? e.fromTurn
  const step = e.step ?? e.fromStep
  if (turn !== undefined) parts.push(step === undefined ? `t${turn}` : `t${turn}s${step}`)
  if ((e.from ?? '') !== '' || (e.to ?? '') !== '') {
    parts.push(`${capRunes(e.from ?? '', EVENT_FIELD_MAX_RUNES)} → ${capRunes(e.to ?? '', EVENT_FIELD_MAX_RUNES)}`)
  }
  if ((e.name ?? '') !== '') parts.push(capRunes(e.name ?? '', EVENT_FIELD_MAX_RUNES))
  if ((e.detail ?? '') !== '') parts.push(capRunes(e.detail ?? '', EVENT_FIELD_MAX_RUNES))
  return parts.join(' · ')
}

/** The five event kinds' display labels (emoji + name). */
function eventKindLabel(kind: TimelineEvent['kind']): string {
  return `${eventKindEmoji(kind)} ${eventKindName(kind)}`
}

/** The five event kinds' emoji markers. */
function eventKindEmoji(kind: TimelineEvent['kind']): string {
  switch (kind) {
    case 'compaction': return '✂'
    case 'prune': return '✂'
    case 'inject': return '💉'
    case 'model': return '🔀'
    case 'mode': return '🔀'
  }
}

/** The five event kinds' plain names (statistic counters reuse them). */
function eventKindName(kind: TimelineEvent['kind']): string {
  switch (kind) {
    case 'compaction': return '压缩'
    case 'prune': return '剪枝'
    case 'inject': return '注入'
    case 'model': return '模型切换'
    case 'mode': return '模式切换'
  }
}

/** The statistics markdown: turn/step and event counts plus raw token usage. */
function sessionStatsMarkdown(
  timeline: ContextTimelineValue,
  snapshot: ContextSnapshotValues,
): string {
  const turns = aggregateByTurn(timeline.requests, timeline.requests.length).length
  const lines: string[] = []
  const counts = new Map<TimelineEvent['kind'], number>()
  for (const e of timeline.events) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1)
  const countOf = (kind: TimelineEvent['kind']): string =>
    counts.get(kind) === undefined ? '' : ` · ${eventKindName(kind)} ${counts.get(kind)}`
  lines.push(`**统计**：${turns} 轮 · ${timeline.requests.length} 步`
    + `${countOf('inject')}${countOf('compaction')}${countOf('prune')}`)
  const usage = lastRequestUsage(timeline.requests)
  if (usage !== undefined) {
    lines.push(`**token 用量**（末次请求，原始）：输入 ${formatTokens(usage.prompt)}`
      + ` · 缓存读 ${formatTokens(usage.cacheRead)} · 输出 ${formatTokens(usage.output)}`)
  } else if (snapshot.pressure?.pressureTokens !== undefined) {
    lines.push(`**token 用量**（最近请求，原始）：输入 ${formatTokens(snapshot.pressure.pressureTokens)}`)
  }
  return lines.join('\n')
}

/** The newest request carrying usage figures, if any. */
function lastRequestUsage(requests: readonly RequestRecord[]): { prompt: number; cacheRead: number; output: number } | undefined {
  for (let i = requests.length - 1; i >= 0; i--) {
    const r = requests[i]
    if (r === undefined || r.prompt === undefined) continue
    return { prompt: r.prompt, cacheRead: r.cacheRead ?? 0, output: r.output ?? 0 }
  }
  return undefined
}

// ── degraded card (no dsh-context timeline) ────────────────────────────────

/**
 * The token-meter-only card: pressure headline, heuristic three-part
 * breakdown, cumulative raw usage, and the dsh-context mount hint.
 */
function buildDegradedContextCard(args: ContextCardArgs, snapshot: ContextSnapshotValues): Card {
  const cb = newCard().title(contextHeaderTitle(args), 'blue')
  const pressure = snapshot.pressure
  const occupied = pressure?.projectedTokens ?? pressure?.pressureTokens
  if (occupied !== undefined && pressure?.contextWindow !== undefined && pressure.contextWindow > 0) {
    cb.markdown(headlineMarkdown({
      occupiedTokens: occupied,
      contextWindow: pressure.contextWindow,
      ratio: Math.round((occupied / pressure.contextWindow) * 10_000) / 10_000,
      source: 'pressure',
    }))
  } else if (occupied !== undefined) {
    cb.markdown(`**上下文占用** ~${formatTokens(occupied)}（窗口未知）`)
  }
  if (snapshot.breakdown !== undefined) cb.markdown(breakdownMarkdown(snapshot.breakdown))
  if (snapshot.usage !== undefined) cb.markdown(usageMarkdown(snapshot.usage))
  cb.markdown('💡 挂载 dsh-context 插件可见完整面板（六桶构成、逐轮趋势、上下文事件）。')
  return appendRefresh(cb, args).build()
}

/** The heuristic three-part composition line (never a total — see the meter's contract). */
function breakdownMarkdown(breakdown: ContextBreakdownValue): string {
  return `**构成估算**：系统提示词 ~${formatTokens(breakdown.systemTokens)}`
    + ` · 工具定义 ~${formatTokens(breakdown.toolsTokens)}`
    + ` · 对话消息 ~${formatTokens(breakdown.messageTokens)}`
}

/** The cumulative raw billed-usage line. */
function usageMarkdown(usage: TokenUsageValue): string {
  return `**token 用量**（累计，原始）：输入 ${formatTokens(usage.uncachedInputTokens)}`
    + ` · 缓存读 ${formatTokens(usage.cacheReadTokens)} · 缓存写 ${formatTokens(usage.cacheWriteTokens)}`
    + ` · 输出 ${formatTokens(usage.outputTokens)}`
}

// ── empty card / shared pieces ─────────────────────────────────────────────

/** The friendly empty-state card (no live agent session to read). */
function buildEmptyContextCard(args: ContextCardArgs): Card {
  const cb = newCard().title(contextHeaderTitle(args), 'blue')
  cb.markdown('当前会话还没有可读取的上下文数据——先对话一轮，再点刷新。')
  return appendRefresh(cb, args).build()
}

/** The budget guard's terminal fallback: headline only (degraded or empty). */
function buildCompactContextCard(args: ContextCardArgs): Card {
  const cb = newCard().title(contextHeaderTitle(args), 'blue')
  const snapshot = args.snapshot
  if (snapshot === undefined) {
    cb.markdown('当前会话还没有可读取的上下文数据——先对话一轮，再点刷新。')
  } else if (snapshot.timeline !== undefined) {
    cb.markdown(headlineMarkdown(headlineOf(snapshot.timeline, snapshot.pressure)))
  } else {
    const occupied = snapshot.pressure?.projectedTokens ?? snapshot.pressure?.pressureTokens
    cb.markdown(occupied === undefined
      ? '💡 挂载 dsh-context 插件可见完整面板。'
      : `**上下文占用** ~${formatTokens(occupied)}`)
  }
  return appendRefresh(cb, args).build()
}

/** The card header title: 📊 marker plus the capped title and model segments. */
function contextHeaderTitle(args: ContextCardArgs): string {
  const segments = [capRunes(args.sessionTitle, TITLE_MAX_RUNES), capRunes(args.model, MODEL_MAX_RUNES)]
    .filter(s => s !== '')
  return segments.length === 0 ? '📊 上下文' : `📊 上下文 · ${segments.join(' · ')}`
}

/** Append the divider plus the refresh button row targeting the session key. */
function appendRefresh(cb: ReturnType<typeof newCard>, args: ContextCardArgs): ReturnType<typeof newCard> {
  return cb.divider().buttons({
    text: '🔄 刷新',
    type: 'default',
    value: `${REFRESH_ACTION} ${CONTEXT_REFRESH_ARG_PREFIX}${args.sessionKey}`,
  })
}

/**
 * Compact token count with one decimal below 100k (`999`, `45.2k`, `128k`).
 * @param tokens - Raw token count.
 * @returns The compact display form.
 */
function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${Math.max(0, Math.round(tokens))}`
  const k = tokens / 1000
  return k < 100 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`
}

/**
 * Cap a value to maxLen runes, appending an ellipsis when truncated.
 * @param value - The string to cap.
 * @param maxLen - Maximum rune count.
 * @returns The capped string.
 */
function capRunes(value: string, maxLen: number): string {
  const runes = Array.from(value)
  if (runes.length <= maxLen) return value
  return `${runes.slice(0, maxLen - 1).join('')}…`
}
