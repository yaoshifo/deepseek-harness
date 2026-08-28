import { describe, expect, it } from 'vitest'
import {
  BUCKET_COLORS,
  BUCKET_KEYS,
  BUCKET_LABELS,
  TREND_LEGEND_LABELS,
  compositionBarSpec,
  trendChartSpec,
} from '../src/context/chartspec.js'
import type { SixBuckets, TurnBucket } from '../src/context/types.js'

// Structure assertions over the VChart specs the Feishu card chart
// component consumes. Shapes follow the live-verified forms: the API server
// validates chart_spec (invalid specs are rejected with 230099), the color
// field must be a complete ordinal scale object, stacked bars keep xField
// the single category field (the array form renders grouped bars), data
// labels stay off (values ride the hover tooltip), the composition figure
// renders one horizontal bar row per bucket with no legend, and the trend
// legend compacts to the short labels at fontSize 10 / spaceCol 8 so six
// entries fit one row (Spike A v2 / Spike v3 card deliveries). Specs must
// also round-trip through JSON untouched — no functions or undefined holes.

function buckets(over: Partial<SixBuckets> = {}): SixBuckets {
  return { system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, ...over }
}

function turn(over: Partial<TurnBucket> = {}): TurnBucket {
  return { turn: 1, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0, stepCount: 1, ...over }
}

const compositionColorScale = { type: 'ordinal', domain: [...BUCKET_LABELS], range: [...BUCKET_COLORS] }
const trendColorScale = { type: 'ordinal', domain: [...TREND_LEGEND_LABELS], range: [...BUCKET_COLORS] }

describe('bucket constants', () => {
  it('keeps the six colors verbatim from dsh-context CATS', () => {
    expect([...BUCKET_COLORS]).toEqual(['#6366f1', '#f59e0b', '#22c55e', '#a855f7', '#3b82f6', '#14b8a6'])
  })

  it('keeps the six zh labels verbatim from dsh-context i18n cat.*', () => {
    expect([...BUCKET_LABELS]).toEqual(['系统提示词', '工具定义', '用户消息', '注入内容', '助手消息', '工具结果'])
  })

  it('keeps the six zh trend-legend short labels', () => {
    expect([...TREND_LEGEND_LABELS]).toEqual(['系统', '工具', '消息', '注入', '回复', '结果'])
  })

  it('keeps keys, colors, full labels, and short labels index-aligned over six buckets', () => {
    expect(BUCKET_KEYS.length).toBe(6)
    expect(BUCKET_COLORS.length).toBe(6)
    expect(BUCKET_LABELS.length).toBe(6)
    expect(TREND_LEGEND_LABELS.length).toBe(6)
    expect(BUCKET_KEYS.map((key, i) => [key, BUCKET_LABELS[i], TREND_LEGEND_LABELS[i]])).toEqual([
      ['system', '系统提示词', '系统'],
      ['tools', '工具定义', '工具'],
      ['user', '用户消息', '消息'],
      ['inject', '注入内容', '注入'],
      ['assistant', '助手消息', '回复'],
      ['tool', '工具结果', '结果'],
    ])
  })
})

describe('compositionBarSpec', () => {
  it('builds the live-verified horizontal bar row per bucket', () => {
    const spec = compositionBarSpec(buckets({ system: 10, tools: 20, user: 30, inject: 40, assistant: 50, tool: 60 }))
    expect(spec.type).toBe('bar')
    expect(spec.direction).toBe('horizontal')
    expect(spec.xField).toBe('value')
    expect(spec.yField).toBe('name')
    expect(spec.seriesField).toBe('name')
    expect(spec.stack).toBeUndefined()
    expect(spec.label).toEqual({ visible: false })
    expect(spec.legends).toEqual({ visible: false })
    expect(spec.color).toEqual(compositionColorScale)
    const values = (spec.data as { values: Array<{ name: string; value: number }> }).values
    expect(values.length).toBe(6)
    // One bar row per bucket: the axis names are the full labels in the
    // fixed BUCKET_KEYS order.
    expect(values.map(v => v.name)).toEqual([...BUCKET_LABELS])
    expect(values.map(v => v.value)).toEqual([10, 20, 30, 40, 50, 60])
  })

  it('emits zero-token buckets so every bucket keeps its axis row', () => {
    const spec = compositionBarSpec(buckets({ user: 30 }))
    const values = (spec.data as { values: Array<{ name: string; value: number }> }).values
    expect(values.length).toBe(6)
    expect(values.map(v => v.name)).toEqual([...BUCKET_LABELS])
    expect(values.map(v => v.value)).toEqual([0, 0, 30, 0, 0, 0])
  })

  it('round-trips through JSON (pure declarative spec)', () => {
    const spec = compositionBarSpec(buckets({ system: 1, user: 2 }))
    expect(JSON.parse(JSON.stringify(spec))).toEqual(spec)
  })
})

describe('trendChartSpec', () => {
  it('builds the live-verified stacked-column form with the one-row compacted legend', () => {
    const turns = [
      turn({ turn: 1, system: 10, user: 30, total: 40, stepCount: 2 }),
      turn({ turn: 2, tools: 20, assistant: 50, total: 70, stepCount: 1 }),
      turn({ turn: 3, tool: 60, total: 60, stepCount: 4 }),
    ]
    const spec = trendChartSpec(turns)
    expect(spec.type).toBe('bar')
    expect(spec.stack).toBe(true)
    expect(spec.seriesField).toBe('bucket')
    // Single category field — the array xField form renders GROUPED bars
    // regardless of stack (Spike A v2 live-verified both forms).
    expect(spec.xField).toBe('turn')
    expect(spec.yField).toBe('tokens')
    expect(spec.label).toEqual({ visible: false })
    expect(spec.color).toEqual(trendColorScale)
    // The compacted one-row legend (Spike v3 live-verified): short labels
    // at fontSize 10 with spaceCol 8; the full labels paginate.
    expect(spec.legends).toEqual({
      visible: true,
      orient: 'bottom',
      item: { label: { style: { fontSize: 10 } }, spaceCol: 8 },
    })
    expect(spec.direction).toBeUndefined()
    const values = (spec.data as { values: Array<{ turn: string; bucket: string; tokens: number }> }).values
    // Every turn contributes all six buckets — zeros included.
    expect(values.length).toBe(turns.length * 6)
    expect(values.map(v => v.turn)).toEqual([
      '1', '1', '1', '1', '1', '1',
      '2', '2', '2', '2', '2', '2',
      '3', '3', '3', '3', '3', '3',
    ])
    expect(values.slice(0, 6).map(v => v.bucket)).toEqual([...TREND_LEGEND_LABELS])
    expect(values.map(v => v.tokens)).toEqual([
      10, 0, 30, 0, 0, 0,
      0, 20, 0, 0, 50, 0,
      0, 0, 0, 0, 0, 60,
    ])
  })

  it('keeps the turn order it was given', () => {
    const spec = trendChartSpec([turn({ turn: 7 }), turn({ turn: 8 })])
    const values = (spec.data as { values: Array<{ turn: string }> }).values
    expect(values.filter((_, i) => i % 6 === 0).map(v => v.turn)).toEqual(['7', '8'])
  })

  it('yields an empty-values spec for an empty turn list', () => {
    const spec = trendChartSpec([])
    expect((spec.data as { values: unknown[] }).values).toEqual([])
    expect(spec.type).toBe('bar')
    expect(spec.stack).toBe(true)
  })

  it('round-trips through JSON (pure declarative spec)', () => {
    const spec = trendChartSpec([turn({ turn: 1, user: 5, total: 5 })])
    expect(JSON.parse(JSON.stringify(spec))).toEqual(spec)
  })
})
