/**
 * VChart spec builders for the Feishu context-insight cards' chart components
 * (飞书卡片图表组件, VChart-backed). Pure declarative JSON — no JS syntax, no
 * React, no dsh-context imports.
 *
 * Upstream provenance (re-align by hand when dsh-context changes):
 * - dsh-context `src/client/categories.ts` `CATS`: the six bucket colors,
 *   copied verbatim so the Feishu cards match the web client's palette.
 * - dsh-context `src/client/i18n.ts` `cat.*` (zh): the six bucket labels,
 *   copied verbatim.
 * - dsh-context `src/client/components/stackedBar.tsx`: the composition
 *   stacked bar's structure (six colored segments, one row per bucket).
 * - dsh-context `src/client/components/trendChart.tsx`: the per-turn stacked
 *   columns' structure (one column per turn, six buckets stacked).
 *
 * Feishu chart-component constraints baked in: pure VChart spec declarations
 * only; no texture (`bar.style.texture`), no conical gradients, no
 * word-cloud grid layout, no extensionMark image repeat, no svg mark
 * backgrounds (all mobile-unsupported); the platform appends its own
 * responsive media queries, so these specs never declare `media`.
 *
 * @module dsh-feishu-bridge/context/chartspec
 */

import type { SixBuckets, TurnBucket } from './types.js'

/**
 * The six buckets as presentation triples — the single source of the
 * key/color/label alignment: {@link BUCKET_KEYS}, {@link BUCKET_COLORS}, and
 * {@link BUCKET_LABELS} are derived from it, so index alignment holds by
 * construction.
 */
const BUCKETS = [
  { key: 'system', label: '系统提示词', color: '#6366f1' },
  { key: 'tools', label: '工具定义', color: '#f59e0b' },
  { key: 'user', label: '用户消息', color: '#22c55e' },
  { key: 'inject', label: '注入内容', color: '#a855f7' },
  { key: 'assistant', label: '助手消息', color: '#3b82f6' },
  { key: 'tool', label: '工具结果', color: '#14b8a6' },
] as const satisfies ReadonlyArray<{ key: keyof SixBuckets; label: string; color: string }>

/**
 * The six bucket keys in upstream `CATS` order (dsh-context
 * `src/client/categories.ts`); index-aligned with {@link BUCKET_COLORS} and
 * {@link BUCKET_LABELS}.
 */
export const BUCKET_KEYS: readonly (keyof SixBuckets)[] = BUCKETS.map(bucket => bucket.key)

/**
 * The six bucket colors, copied verbatim from dsh-context
 * `src/client/categories.ts` `CATS` so the Feishu cards keep the web client's
 * palette. Index-aligned with {@link BUCKET_KEYS}.
 */
export const BUCKET_COLORS: readonly string[] = BUCKETS.map(bucket => bucket.color)

/**
 * The six bucket labels, copied verbatim from dsh-context
 * `src/client/i18n.ts` `cat.*` (zh). Index-aligned with {@link BUCKET_KEYS}.
 */
export const BUCKET_LABELS: readonly string[] = BUCKETS.map(bucket => bucket.label)

/**
 * Build the current-composition stacked bar spec: one horizontal bar, six
 * colored segments (system/tools plus the four surface categories), legend at
 * the bottom.
 *
 * Every bucket emits a row — zero-token buckets included — so the series (and
 * legend) order stays the fixed {@link BUCKET_KEYS} order and the color array
 * maps deterministically.
 *
 * @param current - The current six-bucket composition (heuristic counts).
 * @returns A VChart `bar` spec for the Feishu card chart component; the
 *   caller embeds it as the chart element's `chart_spec`.
 */
export function compositionBarSpec(current: SixBuckets): Record<string, unknown> {
  const values = BUCKETS.map(({ key, label }) => ({
    label: '当前上下文',
    bucket: label,
    tokens: current[key],
  }))
  return {
    type: 'bar',
    direction: 'horizontal',
    data: { values },
    // Horizontal bars keep the value on xField and the category on yField
    // (飞书图表组件官方条形图示例的字段约定).
    xField: 'tokens',
    yField: 'label',
    seriesField: 'bucket',
    stack: true,
    color: [...BUCKET_COLORS],
    legends: { visible: true, orient: 'bottom' },
  }
}

/**
 * Build the per-turn trend chart spec: one stacked column per turn, six
 * colored buckets, the turn number on the x axis, legend at the bottom.
 *
 * Rows are emitted turn-major with every bucket present — zero-token buckets
 * included — so the series order stays the fixed {@link BUCKET_KEYS} order
 * and the color array maps deterministically.
 *
 * @param turns - Turn aggregates (from `aggregateByTurn`), oldest first.
 * @returns A VChart `bar` spec for the Feishu card chart component; the
 *   caller embeds it as the chart element's `chart_spec`. An empty input
 *   yields an empty-values spec.
 */
export function trendChartSpec(turns: TurnBucket[]): Record<string, unknown> {
  const values = turns.flatMap(turn =>
    BUCKETS.map(({ key, label }) => ({ turn: turn.turn, bucket: label, tokens: turn[key] })),
  )
  return {
    type: 'bar',
    data: { values },
    xField: 'turn',
    yField: 'tokens',
    seriesField: 'bucket',
    stack: true,
    color: [...BUCKET_COLORS],
    legends: { visible: true, orient: 'bottom' },
  }
}
