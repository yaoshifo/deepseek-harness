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
 *   figure's data model (six colored parts, one row per bucket).
 * - dsh-context `src/client/components/trendChart.tsx`: the per-turn stacked
 *   columns' structure (one column per turn, six buckets stacked).
 *
 * Feishu chart-component constraints baked in: pure VChart spec declarations
 * only; no texture (`bar.style.texture`), no conical gradients, no
 * word-cloud grid layout, no extensionMark image repeat, no svg mark
 * backgrounds (all mobile-unsupported); the platform appends its own
 * responsive media queries, so these specs never declare `media`. The API
 * server VALIDATES `chart_spec` and rejects an invalid spec with code
 * 230099 — live-tested constraints: the `color` field must be a COMPLETE
 * scale object (`{ type: 'ordinal', domain, range }`; a range-only object
 * fails with "domain is required / type is required"), and a stacked bar
 * keeps `xField` the single category field — an array xField renders GROUPED
 * bars regardless of `stack` (both forms live-verified by Spike A / Spike A
 * v2 card deliveries). Data labels are off in both builders; values ride the
 * chart's default hover tooltip.
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
 * The complete ordinal color scale over the six bucket labels — the only
 * `color` form the Feishu API server accepts (live-tested: range-only
 * objects are rejected with "domain is required / type is required").
 * Returns a fresh object per call so spec consumers cannot corrupt the
 * shared constants.
 */
function bucketColorScale(): { type: 'ordinal'; domain: string[]; range: string[] } {
  return { type: 'ordinal', domain: [...BUCKET_LABELS], range: [...BUCKET_COLORS] }
}

/**
 * Build the current-composition spec: ONE stacked horizontal bar whose six
 * colored segments are the buckets (the dsh-context web composition bar's
 * form). The single category rides `yField`; bucket segments stack via
 * `seriesField` + `stack`.
 *
 * Every bucket emits a segment — zero-token buckets included — so the bar
 * and legend always cover all six buckets in the fixed {@link BUCKET_KEYS}
 * order.
 *
 * @param current - The current six-bucket composition (heuristic counts).
 * @returns A VChart `bar` spec for the Feishu card chart component; the
 *   caller wraps it in the chart element as
 *   `{ "tag": "chart", "chart_spec": <spec>, "aspect_ratio": "2:1" }`.
 */
export function compositionBarSpec(current: SixBuckets): Record<string, unknown> {
  const values = BUCKETS.map(({ key, label }) => ({ name: '当前构成', bucket: label, tokens: current[key] }))
  return {
    type: 'bar',
    direction: 'horizontal',
    data: { values },
    // Stacked form (Spike-v2 live-verified): single-field category on yField,
    // the value on xField, bucket segments stacked via seriesField + stack.
    // Data labels stay off — values ride the default hover tooltip.
    xField: 'tokens',
    yField: 'name',
    seriesField: 'bucket',
    stack: true,
    label: { visible: false },
    legends: { visible: true, orient: 'bottom' },
    color: bucketColorScale(),
  }
}

/**
 * Build the per-turn trend chart spec: one stacked column per turn, six
 * colored buckets, the turn number on the x axis, legend at the bottom.
 *
 * Rows are emitted turn-major with every bucket present — zero-token buckets
 * included — so every column carries all six series in the fixed
 * {@link BUCKET_KEYS} order.
 *
 * @param turns - Turn aggregates (from `aggregateByTurn`), oldest first.
 * @returns A VChart `bar` spec for the Feishu card chart component; the
 *   caller wraps it in the chart element as
 *   `{ "tag": "chart", "chart_spec": <spec>, "aspect_ratio": "2:1" }`. An
 *   empty input yields an empty-values spec.
 */
export function trendChartSpec(turns: TurnBucket[]): Record<string, unknown> {
  const values = turns.flatMap(turn =>
    BUCKETS.map(({ key, label }) => ({ turn: turn.turn, bucket: label, tokens: turn[key] })),
  )
  return {
    type: 'bar',
    data: { values },
    // Stacked form (Spike-v2 live-verified): the xField must stay the SINGLE
    // turn field — an array xField (category + series) makes every
    // (turn, bucket) pair its own axis category and renders GROUPED bars no
    // matter `stack`. Data labels stay off — values ride the default hover
    // tooltip.
    xField: 'turn',
    yField: 'tokens',
    seriesField: 'bucket',
    stack: true,
    label: { visible: false },
    color: bucketColorScale(),
    legends: { visible: true, orient: 'bottom' },
  }
}
