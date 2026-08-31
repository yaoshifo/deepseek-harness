import { describe, expect, it } from 'vitest'
import {
  aggregateByTurn,
  headlineOf,
  recentEvents,
  topToolSchemas,
} from '../src/context/aggregate.ts'
import type {
  ContextHeadersValue,
  ContextPressureValue,
  ContextTimelineValue,
  HeaderRecordValue,
  RequestRecord,
  TimelineEvent,
} from '../src/context/types.ts'

// Ported from dsh-context tests/client/headline.spec.ts fixture shapes
// (timeline()/req()), narrowed to this module's wire types; event and header
// fixtures mirror the fold's output shapes (seq-ordered, newest last).

function timeline(over: Partial<ContextTimelineValue> = {}): ContextTimelineValue {
  return {
    current: { system: 10, tools: 20, user: 30, inject: 0, assistant: 40, tool: 0, total: 100 },
    requests: [],
    events: [],
    ...over,
  }
}

function req(over: Partial<RequestRecord> = {}): RequestRecord {
  return { time: 0, seq: 5, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 80, ...over }
}

function event(over: Partial<TimelineEvent> = {}): TimelineEvent {
  return { seq: 1, time: 0, kind: 'compaction', ...over }
}

function epoch(tools: HeaderRecordValue['tools'], over: Partial<HeaderRecordValue> = {}): HeaderRecordValue {
  return { seq: 1, time: 0, tools, ...over }
}

function headers(...epochs: HeaderRecordValue[]): ContextHeadersValue {
  return { headers: epochs }
}

describe('aggregateByTurn', () => {
  it.each([
    {
      name: 'collapses consecutive same-turn steps into per-turn sums',
      requests: [
        req({ turn: 1, step: 1, user: 100, total: 100 }),
        req({ turn: 1, step: 2, user: 60, assistant: 40, total: 100 }),
        req({ turn: 2, step: 1, user: 120, tool: 30, total: 150 }),
        req({ turn: 2, step: 2, tool: 45, total: 45 }),
        req({ turn: 2, step: 3, assistant: 10, total: 10 }),
        req({ turn: 3, step: 1, user: 90, total: 90 }),
      ],
      limit: 10,
      want: [
        { turn: 1, user: 160, assistant: 40, total: 200, stepCount: 2 },
        { turn: 2, user: 120, tool: 75, assistant: 10, total: 205, stepCount: 3 },
        { turn: 3, user: 90, total: 90, stepCount: 1 },
      ],
    },
    {
      name: 'keeps only the newest limit turns',
      requests: [
        req({ turn: 1, total: 10 }),
        req({ turn: 2, total: 20 }),
        req({ turn: 3, total: 30 }),
        req({ turn: 4, total: 40 }),
      ],
      limit: 2,
      want: [
        { turn: 3, total: 30, stepCount: 1 },
        { turn: 4, total: 40, stepCount: 1 },
      ],
    },
    {
      name: 'an empty request log yields no turns',
      requests: [],
      limit: 5,
      want: [],
    },
    {
      name: 'a non-positive limit yields no turns',
      requests: [req({ turn: 1, total: 10 })],
      limit: 0,
      want: [],
    },
    {
      name: 'records without a turn group under turn 0',
      requests: [req({ total: 10 }), req({ total: 20 }), req({ turn: 1, total: 30 })],
      limit: 10,
      want: [
        { turn: 0, total: 30, stepCount: 2 },
        { turn: 1, total: 30, stepCount: 1 },
      ],
    },
    {
      name: 'a turn number reappearing after a break opens a new bucket (consecutive-run grouping)',
      requests: [req({ turn: 1, total: 10 }), req({ turn: 2, total: 20 }), req({ turn: 1, total: 30 })],
      limit: 10,
      want: [
        { turn: 1, total: 10, stepCount: 1 },
        { turn: 2, total: 20, stepCount: 1 },
        { turn: 1, total: 30, stepCount: 1 },
      ],
    },
  ])('$name', ({ requests, limit, want }) => {
    // Array toMatchObject compares element-wise, partial per element.
    expect(aggregateByTurn(requests, limit)).toMatchObject(want)
  })

  it('sums every bucket over the turn, not just the last step', () => {
    const [turn] = aggregateByTurn([
      req({ turn: 1, system: 10, tools: 20, user: 30, inject: 40, assistant: 50, tool: 60, total: 210 }),
      req({ turn: 1, system: 1, tools: 2, user: 3, inject: 4, assistant: 5, tool: 6, total: 21 }),
    ], 5)
    expect(turn).toEqual({
      turn: 1,
      system: 11,
      tools: 22,
      user: 33,
      inject: 44,
      assistant: 55,
      tool: 66,
      total: 231,
      stepCount: 2,
    })
  })

  it('does not mutate the input records', () => {
    const requests = [req({ turn: 1, total: 10 }), req({ turn: 1, total: 20 })]
    const snapshot = requests.map(r => ({ ...r }))
    aggregateByTurn(requests, 5)
    expect(requests).toEqual(snapshot)
  })
})

describe('headlineOf', () => {
  interface HeadlineCase {
    name: string
    timeline: ContextTimelineValue
    pressure: ContextPressureValue | undefined
    want: { occupiedTokens: number; contextWindow?: number; ratio?: number; source: 'pressure' | 'estimate' }
  }
  const cases: HeadlineCase[] = [
    {
      name: 'the pressure projection anchors occupancy, window, and ratio',
      timeline: timeline(),
      pressure: { projectedTokens: 200, contextWindow: 1000 } satisfies ContextPressureValue,
      want: { occupiedTokens: 200, contextWindow: 1000, ratio: 0.2, source: 'pressure' },
    },
    {
      name: 'the pressure anchor wins over the last-request estimate',
      timeline: timeline({ requests: [req({ prompt: 150 })] }),
      pressure: { projectedTokens: 200 } satisfies ContextPressureValue,
      want: { occupiedTokens: 200, source: 'pressure' },
    },
    {
      name: 'without the projection the last request derives the anchor',
      timeline: timeline({ requests: [req({ prompt: 150, total: 80 })] }),
      pressure: undefined,
      want: { occupiedTokens: 170, source: 'estimate' },
    },
    {
      name: 'a pressure value without projectedTokens falls back to the estimate',
      timeline: timeline({ requests: [req({ prompt: 150 })] }),
      pressure: { contextWindow: 500 } satisfies ContextPressureValue,
      want: { occupiedTokens: 170, contextWindow: 500, ratio: 0.34, source: 'estimate' },
    },
    {
      name: 'without any anchor the heuristic composition total serves',
      timeline: timeline(),
      pressure: undefined,
      want: { occupiedTokens: 100, source: 'estimate' },
    },
    {
      name: 'a request without a numeric prompt yields no derived anchor',
      timeline: timeline({ requests: [req()] }),
      pressure: undefined,
      want: { occupiedTokens: 100, source: 'estimate' },
    },
    {
      name: 'an empty request log yields no derived anchor',
      timeline: timeline(),
      pressure: undefined,
      want: { occupiedTokens: 100, source: 'estimate' },
    },
    {
      name: 'the pressure window wins over the timeline window',
      timeline: timeline({ contextWindow: 1000 }),
      pressure: { contextWindow: 500 } satisfies ContextPressureValue,
      want: { occupiedTokens: 100, contextWindow: 500, ratio: 0.2, source: 'estimate' },
    },
    {
      name: 'the timeline window serves when the pressure has none',
      timeline: timeline({ contextWindow: 200 }),
      pressure: {} satisfies ContextPressureValue,
      want: { occupiedTokens: 100, contextWindow: 200, ratio: 0.5, source: 'estimate' },
    },
    {
      name: 'without any window there is no ratio',
      timeline: timeline(),
      pressure: undefined,
      want: { occupiedTokens: 100, source: 'estimate' },
    },
    {
      name: 'a non-positive window yields no ratio',
      timeline: timeline({ contextWindow: 0 }),
      pressure: undefined,
      want: { occupiedTokens: 100, contextWindow: 0, source: 'estimate' },
    },
    {
      name: 'an occupancy past the window keeps an unclamped ratio',
      timeline: timeline(),
      pressure: { projectedTokens: 250, contextWindow: 100 } satisfies ContextPressureValue,
      want: { occupiedTokens: 250, contextWindow: 100, ratio: 2.5, source: 'pressure' },
    },
    {
      name: 'a junk projectedTokens falls through to the estimate path',
      timeline: timeline({ requests: [req({ prompt: 150 })] }),
      pressure: { projectedTokens: 'junk' as unknown as number } satisfies ContextPressureValue,
      want: { occupiedTokens: 170, source: 'estimate' },
    },
  ]
  it.each(cases)('$name', ({ timeline, pressure, want }) => {
    const got = headlineOf(timeline, pressure)
    expect(got).toMatchObject(want)
    if (want.contextWindow === undefined) expect(got.contextWindow).toBeUndefined()
    if (want.ratio === undefined) expect(got.ratio).toBeUndefined()
  })
})

describe('topToolSchemas', () => {
  it.each([
    {
      name: 'ranks the newest epoch by tokens descending and truncates',
      headers: headers(epoch([
        { name: 'bash', tokens: 300, plugin: 'dsh-shell' },
        { name: 'read', tokens: 900 },
        { name: 'grep', tokens: 600, plugin: 'mcp:search' },
      ])),
      n: 2,
      want: [
        { name: 'read', tokens: 900 },
        { name: 'grep', tokens: 600, plugin: 'mcp:search' },
      ],
    },
    {
      name: 'the newest epoch wins over older ones',
      headers: headers(
        epoch([{ name: 'old', tokens: 500 }], { seq: 1 }),
        epoch([{ name: 'new', tokens: 50 }], { seq: 9 }),
      ),
      n: 5,
      want: [{ name: 'new', tokens: 50 }],
    },
    {
      name: 'an undefined projection value yields nothing',
      headers: undefined,
      n: 5,
      want: [],
    },
    {
      name: 'an empty epoch list yields nothing',
      headers: headers(),
      n: 5,
      want: [],
    },
    {
      name: 'a non-positive n yields nothing',
      headers: headers(epoch([{ name: 'bash', tokens: 300 }])),
      n: 0,
      want: [],
    },
    {
      name: 'fewer tools than n returns all of them',
      headers: headers(epoch([{ name: 'bash', tokens: 300 }])),
      n: 10,
      want: [{ name: 'bash', tokens: 300 }],
    },
    {
      name: 'token ties keep the epoch declaration order',
      headers: headers(epoch([
        { name: 'a', tokens: 100 },
        { name: 'b', tokens: 100 },
        { name: 'c', tokens: 100 },
      ])),
      n: 3,
      want: [
        { name: 'a', tokens: 100 },
        { name: 'b', tokens: 100 },
        { name: 'c', tokens: 100 },
      ],
    },
  ])('$name', ({ headers, n, want }) => {
    expect(topToolSchemas(headers, n)).toEqual(want)
  })

  it('does not mutate the epoch tool order', () => {
    const tools = [
      { name: 'bash', tokens: 300 },
      { name: 'read', tokens: 900 },
    ]
    const value = headers(epoch(tools))
    const snapshot = tools.map(t => ({ ...t }))
    topToolSchemas(value, 1)
    expect(tools).toEqual(snapshot)
  })
})

describe('recentEvents', () => {
  it.each([
    {
      name: 'keeps the newest n events in log order',
      events: [event({ seq: 1 }), event({ seq: 2, kind: 'prune' }), event({ seq: 3, kind: 'model' })],
      n: 2,
      wantSeqs: [2, 3],
    },
    {
      name: 'n past the length keeps everything',
      events: [event({ seq: 1 }), event({ seq: 2 })],
      n: 10,
      wantSeqs: [1, 2],
    },
    {
      name: 'an empty event list stays empty',
      events: [],
      n: 3,
      wantSeqs: [],
    },
    {
      name: 'a non-positive n yields nothing',
      events: [event({ seq: 1 })],
      n: 0,
      wantSeqs: [],
    },
  ])('$name', ({ events, n, wantSeqs }) => {
    expect(recentEvents(events, n).map(e => e.seq)).toEqual(wantSeqs)
  })
})
