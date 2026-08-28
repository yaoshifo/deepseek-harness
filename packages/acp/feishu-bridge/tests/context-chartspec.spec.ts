import { describe, expect, it } from 'vitest'
import { BUCKET_COLORS, BUCKET_KEYS, BUCKET_LABELS, compositionBarSpec, trendChartSpec } from '../src/context/chartspec.js'
import type { SixBuckets, TurnBucket } from '../src/context/types.js'

// Structure assertions over the VChart specs the Feishu card chart
// component consumes. Shapes follow the Spike A live-verified forms: the API
// server validates chart_spec (invalid specs are rejected with 230099), the
// color field must be a complete ordinal scale object, and the assertion set
// pins those exact wire forms. Specs must also round-trip through JSON
// untouched — no functions or undefined holes.

function buckets(over: Partial<SixBuckets> = {}): SixBuckets {
  return { system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, ...over }
}

function turn(over: Partial<TurnBucket> = {}): TurnBucket {
  return { turn: 1, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0, stepCount: 1, ...over }
}

const colorScale = { type: 'ordinal', domain: [...BUCKET_LABELS], range: [...BUCKET_COLORS] }

describe('bucket constants', () => {
  it('keeps the six colors verbatim from dsh-context CATS', () => {
    expect([...BUCKET_COLORS]).toEqual(['#6366f1', '#f59e0b', '#22c55e', '#a855f7', '#3b82f6', '#14b8a6'])
  })

  it('keeps the six zh labels verbatim from dsh-context i18n cat.*', () => {
    expect([...BUCKET_LABELS]).toEqual(['系统提示词', '工具定义', '用户消息', '注入内容', '助手消息', '工具结果'])
  })

  it('keeps keys, colors, and labels index-aligned over six buckets', () => {
    expect(BUCKET_KEYS.length).toBe(6)
    expect(BUCKET_COLORS.length).toBe(6)
    expect(BUCKET_LABELS.length).toBe(6)
    expect([...BUCKET_KEYS]).toEqual(['system', 'tools', 'user', 'inject', 'assistant', 'tool'])
  })
})

describe('compositionBarSpec', () => {
  it('builds the live-verified horizontal bar form: one bar per bucket', () => {
    const spec = compositionBarSpec(buckets({ system: 10, tools: 20, user: 30, inject: 40, assistant: 50, tool: 60 }))
    expect(spec.type).toBe('bar')
    expect(spec.direction).toBe('horizontal')
    expect(spec.xField).toBe('value')
    expect(spec.yField).toBe('name')
    expect(spec.seriesField).toBe('name')
    expect(spec.stack).toBeUndefined()
    expect(spec.color).toEqual(colorScale)
    const values = (spec.data as { values: Array<{ name: string; value: number }> }).values
    expect(values.length).toBe(6)
    expect(values.map(v => v.name)).toEqual([...BUCKET_LABELS])
    expect(values.map(v => v.value)).toEqual([10, 20, 30, 40, 50, 60])
  })

  it('emits zero-token buckets so the axis stays complete', () => {
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
  it('builds the live-verified stacked-column form over the six buckets', () => {
    const turns = [
      turn({ turn: 1, system: 10, user: 30, total: 40, stepCount: 2 }),
      turn({ turn: 2, tools: 20, assistant: 50, total: 70, stepCount: 1 }),
      turn({ turn: 3, tool: 60, total: 60, stepCount: 4 }),
    ]
    const spec = trendChartSpec(turns)
    expect(spec.type).toBe('bar')
    expect(spec.stack).toBe(true)
    expect(spec.seriesField).toBe('bucket')
    expect(spec.xField).toEqual(['turn', 'bucket'])
    expect(spec.yField).toBe('tokens')
    expect(spec.color).toEqual(colorScale)
    expect(spec.legends).toEqual({ visible: true, orient: 'bottom' })
    expect(spec.direction).toBeUndefined()
    const values = (spec.data as { values: Array<{ turn: number; bucket: string; tokens: number }> }).values
    // Every turn contributes all six buckets — zeros included.
    expect(values.length).toBe(turns.length * 6)
    expect(values.map(v => v.turn)).toEqual([1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3])
    expect(values.slice(0, 6).map(v => v.bucket)).toEqual([...BUCKET_LABELS])
    expect(values.map(v => v.tokens)).toEqual([
      10, 0, 30, 0, 0, 0,
      0, 20, 0, 0, 50, 0,
      0, 0, 0, 0, 0, 60,
    ])
  })

  it('keeps the turn order it was given', () => {
    const spec = trendChartSpec([turn({ turn: 7 }), turn({ turn: 8 })])
    const values = (spec.data as { values: Array<{ turn: number }> }).values
    expect(values.filter((_, i) => i % 6 === 0).map(v => v.turn)).toEqual([7, 8])
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
