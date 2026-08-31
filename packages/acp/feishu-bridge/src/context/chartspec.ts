/**
 * VChart spec builders for the Feishu context-insight cards' chart components
 * (飞书卡片图表组件, VChart-backed). Pure declarative JSON — no JS syntax, no
 * React, no dsh-context imports.
 *
 * Upstream provenance (re-align by hand when dsh-context changes):
 * - dsh-context `src/client/categories.ts` `CATS`: the six bucket colors,
 *   copied verbatim so the Feishu cards match the web client's palette.
 * - dsh-context `src/client/i18n.ts` `cat.*` (zh): the six bucket labels,
 *   copied verbatim; the trend chart's legend alone renders the derived
 *   {@link TREND_LEGEND_LABELS} short labels instead (see there for why).
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
 * v2 card deliveries). Spike v3 card deliveries live-verified the rendered
 * forms: the composition figure renders ONE HORIZONTAL BAR ROW PER BUCKET
 * (`legends.visible: false` — the axis labels name the buckets), and a
 * bottom legend fits its six entries on one row only with the
 * two-character short labels at `fontSize` 10 and `spaceCol` 8 — the full
 * dsh-context labels paginate onto multiple rows. Data labels are off in
 * both builders; values ride the chart's default hover tooltip.
 *
 * @module dsh-feishu-bridge/context/chartspec
 */

import type { SixBuckets, TurnBucket } from './types.ts'

/**
 * The six buckets as presentation quadruples — the single source of the
 * key/color/label/short-label alignment: {@link BUCKET_KEYS},
 * {@link BUCKET_COLORS}, {@link BUCKET_LABELS}, and
 * {@link TREND_LEGEND_LABELS} are derived from it, so index alignment holds
 * by construction.
 */
const BUCKETS = [
  { key: 'system', label: '系统提示词', shortLabel: '系统', color: '#6366f1' },
  { key: 'tools', label: '工具定义', shortLabel: '工具', color: '#f59e0b' },
  { key: 'user', label: '用户消息', shortLabel: '消息', color: '#22c55e' },
  { key: 'inject', label: '注入内容', shortLabel: '注入', color: '#a855f7' },
  { key: 'assistant', label: '助手消息', shortLabel: '回复', color: '#3b82f6' },
  { key: 'tool', label: '工具结果', shortLabel: '结果', color: '#14b8a6' },
] as const satisfies ReadonlyArray<{
  key: keyof SixBuckets
  label: string
  shortLabel: string
  color: string
}>

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
 * The six two-character bucket labels the trend chart's legend renders — a
 * presentation-layer compaction of {@link BUCKET_LABELS}, index-aligned with
 * {@link BUCKET_KEYS}. This is the one deliberate departure from the
 * dsh-context `cat.*` copy: the Feishu chart legend paginates onto extra
 * rows when its six full-label entries do not fit one line, so the legend
 * renders these short labels at `fontSize` 10 with `spaceCol` 8 — the
 * one-row form live-verified by the Spike v3 card delivery. The full labels
 * stay everywhere else (composition-chart axis, dsh-context itself).
 */
export const TREND_LEGEND_LABELS: readonly string[] = BUCKETS.map(bucket => bucket.shortLabel)

/**
 * The complete ordinal color scale over a bucket-label domain — the only
 * `color` form the Feishu API server accepts (live-tested: range-only
 * objects are rejected with "domain is required / type is required").
 * Returns a fresh object per call so spec consumers cannot corrupt the
 * shared constants.
 *
 * @param domain - The bucket labels the spec's series field carries —
 *   {@link BUCKET_LABELS} for the composition chart (axis names),
 *   {@link TREND_LEGEND_LABELS} for the trend chart (legend entries);
 *   index-aligned with {@link BUCKET_COLORS}, so a label maps to its
 *   bucket's color.
 */
function bucketColorScale(domain: readonly string[]): { type: 'ordinal'; domain: string[]; range: string[] } {
  return { type: 'ordinal', domain: [...domain], range: [...BUCKET_COLORS] }
}

/**
 * Build the current-composition spec: one horizontal bar row per bucket
 * (the dsh-context web composition bar's per-bucket-row form). The bucket
 * label rides `yField` as the axis category and `seriesField` as the series
 * name, so the ordinal color scale colors each row with its bucket's color.
 *
 * Every bucket emits a row — zero-token buckets included — in the fixed
 * {@link BUCKET_KEYS} order. The legend is off: the axis labels already
 * name the buckets.
 *
 * @param current - The current six-bucket composition (heuristic counts).
 * @returns A VChart `bar` spec for the Feishu card chart component; the
 *   caller wraps it in the chart element as
 *   `{ "tag": "chart", "chart_spec": <spec>, "aspect_ratio": "2:1" }`.
 */
export function compositionBarSpec(current: SixBuckets): Record<string, unknown> {
  const values = BUCKETS.map(({ key, label }) => ({ name: label, value: current[key] }))
  return {
    type: 'bar',
    direction: 'horizontal',
    data: { values },
    // One row per bucket (Spike v3 live-verified; the single stacked bar
    // form paginates its legend). Data labels stay off — values ride the
    // default hover tooltip.
    xField: 'value',
    yField: 'name',
    seriesField: 'name',
    label: { visible: false },
    legends: { visible: false },
    color: bucketColorScale(BUCKET_LABELS),
  }
}

/**
 * Build the per-turn trend chart spec: one stacked column per turn, six
 * colored buckets, the turn number on the x axis, the compacted one-row
 * legend at the bottom.
 *
 * Rows are emitted turn-major with every bucket present — zero-token buckets
 * included — so every column carries all six series in the fixed
 * {@link BUCKET_KEYS} order. The legend series names are the short
 * {@link TREND_LEGEND_LABELS} (the full labels paginate; see there), while
 * the axis keeps the plain turn ordinal as a string (the live-verified
 * category-axis form).
 *
 * @param turns - Turn aggregates (from `aggregateByTurn`), oldest first.
 * @returns A VChart `bar` spec for the Feishu card chart component; the
 *   caller wraps it in the chart element as
 *   `{ "tag": "chart", "chart_spec": <spec>, "aspect_ratio": "2:1" }`. An
 *   empty input yields an empty-values spec.
 */
export function trendChartSpec(turns: TurnBucket[]): Record<string, unknown> {
  const values = turns.flatMap(turn =>
    BUCKETS.map(({ key, shortLabel }) => ({ turn: String(turn.turn), bucket: shortLabel, tokens: turn[key] })),
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
    color: bucketColorScale(TREND_LEGEND_LABELS),
    legends: {
      visible: true,
      orient: 'bottom',
      // One-row legend form (Spike v3 live-verified): the short labels at
      // fontSize 10 with spaceCol 8 fit all six entries on a single bottom
      // row; the full dsh-context labels paginate.
      item: { label: { style: { fontSize: 10 } }, spaceCol: 8 },
    },
  }
}
