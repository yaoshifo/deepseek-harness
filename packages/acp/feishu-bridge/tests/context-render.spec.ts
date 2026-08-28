/**
 * Pure-render tests for the /context card (src/context/render.ts): the full
 * dsh-context card's structure (headline numbers, both charts, capped event
 * lines, the tool panel, the prefixed refresh button), the token-meter
 * degraded card, the empty-state card, and the list caps plus the JSON/element
 * budget guard that degrades an over-budget card.
 *
 * @module dsh-feishu-bridge/tests-context-render
 */

import { describe, expect, it } from 'vitest'
import {
  CONTEXT_CARD_ELEMENT_CEILING,
  CONTEXT_CARD_JSON_BUDGET_BYTES,
  CONTEXT_REFRESH_ARG_PREFIX,
  cardJsonBytes,
  countElements,
  renderContextCard,
} from '../src/context/render.js'
import type { ContextCardArgs } from '../src/context/render.js'
import { newCard } from '../src/card.js'
import type { Card, CardChart, CardCollapsiblePanel } from '../src/card.js'
import type {
  ContextTimelineValue,
  RequestRecord,
  TimelineEvent,
} from '../src/context/types.js'

// Fixture shapes mirror tests/context-aggregate.spec.ts: a seq-ordered
// timeline, per-step request records, and the fold's event output.

function timeline(over: Partial<ContextTimelineValue> = {}): ContextTimelineValue {
  return {
    current: { system: 10_000, tools: 20_000, user: 30_000, inject: 0, assistant: 40_000, tool: 0, total: 100_000 },
    requests: [req({ turn: 1, step: 1, prompt: 96_000, cacheRead: 20_000, output: 3_500 })],
    events: [],
    contextWindow: 128_000,
    ...over,
  }
}

function req(over: Partial<RequestRecord> = {}): RequestRecord {
  return { time: 0, seq: 5, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 80_000, ...over }
}

function event(over: Partial<TimelineEvent> = {}): TimelineEvent {
  return { seq: 1, time: 0, kind: 'compaction', ...over }
}

function args(over: Partial<ContextCardArgs> = {}): ContextCardArgs {
  return {
    sessionKey: 'feishu:oc_1:ou_1',
    sessionTitle: '记账驴',
    model: 'deepseek-v4-flash',
    snapshot: { timeline: timeline() },
    ...over,
  }
}

/** All chart elements of a card, in order. */
function charts(card: Card): CardChart[] {
  return card.elements.filter((e): e is CardChart => e.kind === 'chart')
}

/** The first collapsible panel of a card. */
function panel(card: Card): CardCollapsiblePanel | undefined {
  return card.elements.find((e): e is CardCollapsiblePanel => e.kind === 'collapsiblePanel')
}

/** The refresh button's callback value of a card. */
function refreshValue(card: Card): string {
  const actions = card.elements.find(e => e.kind === 'actions')
  expect(actions).toBeDefined()
  const buttons = actions !== undefined && actions.kind === 'actions' ? actions.buttons : []
  expect(buttons.length).toBe(1)
  return buttons[0]?.value ?? ''
}

/** The concatenated markdown content of a card (top level only). */
function markdownOf(card: Card): string {
  return card.elements
    .filter(e => e.kind === 'markdown')
    .map(e => (e.kind === 'markdown' ? e.content : ''))
    .join('\n\n')
}

describe('renderContextCard — full card', () => {
  it('renders the header, headline numbers, both charts, stats, and the prefixed refresh button', () => {
    const card = renderContextCard(args())
    expect(card.header?.title).toBe('📊 上下文 · 记账驴 · deepseek-v4-flash')
    expect(card.header?.color).toBe('blue')
    // Headline: pressure-less estimate = last prompt + surface movement
    // (96k + 100k - 80k = 116k) over the 128k window.
    expect(markdownOf(card)).toContain('**上下文占用** 116k / 128k（90.6%）· 余量 12.0k')
    const chartEls = charts(card)
    expect(chartEls.length).toBe(2)
    expect(chartEls[0]?.spec.type).toBe('bar')
    expect(chartEls[1]?.spec.type).toBe('bar')
    expect(markdownOf(card)).toContain('**统计**：1 轮 · 1 步')
    expect(markdownOf(card)).toContain('**token 用量**（末次请求，原始）：输入 96.0k · 缓存读 20.0k · 输出 3.5k')
    expect(refreshValue(card)).toBe(`act:/context ${CONTEXT_REFRESH_ARG_PREFIX}feishu:oc_1:ou_1`)
  })

  it('flags an over-window headline with the red template and the overrun line', () => {
    const card = renderContextCard(args({
      snapshot: {
        timeline: timeline({ contextWindow: 100_000 }),
        pressure: { projectedTokens: 130_000, contextWindow: 100_000 },
      },
    }))
    expect(card.header?.color).toBe('red')
    expect(markdownOf(card)).toContain('⚠️ **超出上下文窗口**：占用 130k / 100k（130.0%）· 超出 30.0k')
  })

  it('renders the window-less headline form when no window is known', () => {
    const { contextWindow: _omit, ...windowless } = timeline({ requests: [req()] })
    const card = renderContextCard(args({ snapshot: { timeline: windowless } }))
    expect(markdownOf(card)).toContain('**上下文占用** ~100k（窗口未知）')
  })

  it('caps trend turns, event lines, and tool rows at their limits', () => {
    const requests: RequestRecord[] = []
    for (let turn = 1; turn <= 40; turn++) {
      requests.push(req({ turn, step: 1, total: 1_000, seq: turn }))
    }
    const events: TimelineEvent[] = []
    for (let i = 0; i < 20; i++) {
      events.push(event({ seq: i + 1, kind: i % 2 === 0 ? 'inject' : 'prune', tokens: 100 }))
    }
    const tools = Array.from({ length: 20 }, (_v, i) => ({ name: `tool${i}`, tokens: 1_000 + i }))
    const card = renderContextCard(args({
      snapshot: {
        timeline: timeline({ requests, events }),
        headers: { headers: [{ seq: 1, time: 0, tools }] },
      },
    }))
    // Trend-spec turn ordinals are wire-form strings (the live-verified
    // category-axis form, chartspec.ts).
    const trendRows = charts(card)[1]?.spec.data as { values: Array<{ turn: string }> }
    expect(new Set(trendRows.values.map(v => v.turn)).size).toBe(20)
    expect(trendRows.values.map(v => v.turn)).toContain('40')
    const eventLines = markdownOf(card).split('\n').filter(l => l.startsWith('- '))
    expect(eventLines.length).toBe(8)
    const panelLines = (panel(card)?.elements[0] as { content: string } | undefined)?.content.split('\n') ?? []
    expect(panelLines.length).toBe(5)
    expect(panelLines[0]).toContain('`tool19` · 1.0k')
  })

  it('lists recent events newest-first with kind, tokens, turn/step, and name', () => {
    const card = renderContextCard(args({
      snapshot: {
        timeline: timeline({
          events: [
            event({ seq: 1, kind: 'compaction', tokens: 12_000, turn: 5, name: 'compaction-basic' }),
            event({ seq: 2, kind: 'inject', tokens: 4_500, turn: 6, step: 2, name: 'file-reference' }),
            event({ seq: 3, kind: 'model', from: 'deepseek-chat', to: 'deepseek-reasoner', turn: 8 }),
          ],
        }),
      },
    }))
    const text = markdownOf(card)
    const lines = text.split('\n').filter(l => l.startsWith('- '))
    expect(lines[0]).toContain('🔀 模型切换')
    expect(lines[0]).toContain('deepseek-chat → deepseek-reasoner')
    expect(lines[0]).toContain('t8')
    expect(lines[1]).toContain('💉 注入 · +4.5k · t6s2 · file-reference')
    expect(lines[2]).toContain('✂ 压缩 · -12.0k · t5 · compaction-basic')
    expect(text).toContain('**统计**：1 轮 · 1 步 · 注入 1 · 压缩 1')
  })

  it('falls back to the pressure figure when no request carries usage', () => {
    const card = renderContextCard(args({
      snapshot: {
        timeline: timeline({ requests: [req()] }),
        pressure: { pressureTokens: 88_000 },
      },
    }))
    expect(markdownOf(card)).toContain('**token 用量**（最近请求，原始）：输入 88.0k')
  })

  it('omits the tool panel when no header epoch carries tools', () => {
    expect(panel(renderContextCard(args()))).toBeUndefined()
    const emptyEpoch = { headers: [{ seq: 1, time: 0, tools: [] }] }
    expect(panel(renderContextCard(args({ snapshot: { timeline: timeline(), headers: emptyEpoch } })))).toBeUndefined()
  })

  it('truncates the session title and model in the header', () => {
    const card = renderContextCard(args({ sessionTitle: '很'.repeat(80), model: 'x'.repeat(100) }))
    expect(card.header?.title).toContain('…')
    expect((card.header?.title.match(/很/g) ?? []).length).toBe(47)
    expect((card.header?.title.match(/x/g) ?? []).length).toBe(63)
    expect(Array.from(card.header?.title ?? '').length).toBeLessThan(130)
  })
})

describe('renderContextCard — degraded and empty cards', () => {
  it('renders the token-meter headline, breakdown, usage, and the mount hint without charts', () => {
    const card = renderContextCard(args({
      snapshot: {
        pressure: { pressureTokens: 90_000, projectedTokens: 95_000, contextWindow: 128_000 },
        breakdown: { systemTokens: 10_000, toolsTokens: 20_000, messageTokens: 60_000 },
        usage: { uncachedInputTokens: 5_000, outputTokens: 8_000, cacheReadTokens: 120_000, cacheWriteTokens: 7_000 },
      },
    }))
    expect(card.header?.title).toBe('📊 上下文 · 记账驴 · deepseek-v4-flash')
    expect(charts(card).length).toBe(0)
    const text = markdownOf(card)
    expect(text).toContain('**上下文占用** 95.0k / 128k（74.2%）· 余量 33.0k')
    expect(text).toContain('**构成估算**：系统提示词 ~10.0k · 工具定义 ~20.0k · 对话消息 ~60.0k')
    expect(text).toContain('**token 用量**（累计，原始）：输入 5.0k · 缓存读 120k · 缓存写 7.0k · 输出 8.0k')
    expect(text).toContain('挂载 dsh-context 插件可见完整面板')
    expect(refreshValue(card)).toBe(`act:/context ${CONTEXT_REFRESH_ARG_PREFIX}feishu:oc_1:ou_1`)
  })

  it('keeps the degraded card without any pressure figure on the hint line', () => {
    const card = renderContextCard(args({ snapshot: {} }))
    const text = markdownOf(card)
    expect(text).not.toContain('上下文占用')
    expect(text).toContain('挂载 dsh-context 插件可见完整面板')
  })

  it('renders the friendly empty-state card when no snapshot is readable', () => {
    const card = renderContextCard(args({ snapshot: undefined, sessionTitle: '', model: '' }))
    expect(card.header?.title).toBe('📊 上下文')
    expect(markdownOf(card)).toContain('还没有可读取的上下文数据')
    expect(charts(card).length).toBe(0)
    expect(refreshValue(card)).toBe(`act:/context ${CONTEXT_REFRESH_ARG_PREFIX}feishu:oc_1:ou_1`)
  })
})

describe('renderContextCard — budget guard', () => {
  it('degrades an over-budget card until the rendered JSON fits the internal control', () => {
    // Pathological payload: eight events with every rendered field at the
    // rune cap (CJK, three bytes per rune) push the full card past 20KB, so
    // the guard drops the trend chart and the event section.
    const filler = '压'.repeat(256)
    const events = Array.from({ length: 8 }, (_v, i) =>
      event({ seq: i + 1, kind: 'compaction', tokens: 100, name: filler, detail: filler, from: filler, to: filler }))
    const requests = Array.from({ length: 20 }, (_v, i) => req({ turn: i + 1, step: 1, total: 1_000, seq: i }))
    const card = renderContextCard(args({ snapshot: { timeline: timeline({ requests, events }) } }))
    expect(cardJsonBytes(card, 'feishu:oc_1:ou_1')).toBeLessThanOrEqual(CONTEXT_CARD_JSON_BUDGET_BYTES)
    expect(countElements(card)).toBeLessThanOrEqual(CONTEXT_CARD_ELEMENT_CEILING)
    // The degraded card keeps the composition chart, the stats, and the
    // refresh button, and drops the trend chart and the event section.
    expect(charts(card).length).toBe(1)
    expect(markdownOf(card)).not.toContain('最近事件')
    expect(markdownOf(card)).toContain('**统计**')
    expect(refreshValue(card)).toBe(`act:/context ${CONTEXT_REFRESH_ARG_PREFIX}feishu:oc_1:ou_1`)
  })

  it('measures rendered JSON bytes and element counts on any card', () => {
    const oversized = newCard().markdown('压'.repeat(9_000)).build()
    expect(cardJsonBytes(oversized, '')).toBeGreaterThan(CONTEXT_CARD_JSON_BUDGET_BYTES)
    expect(countElements(oversized)).toBe(1)
    const nested = newCard()
      .collapsiblePanel('t', false, { kind: 'markdown', content: 'x' })
      .buttons({ text: 'b', type: 'default', value: 'act:/x' })
      .build()
    expect(countElements(nested)).toBe(3)
  })

  it('keeps an ordinary full card well under the budget', () => {
    const card = renderContextCard(args({
      snapshot: {
        timeline: timeline({
          requests: Array.from({ length: 20 }, (_v, i) => req({ turn: i + 1, step: 1, total: 1_000, seq: i })),
        }),
        headers: { headers: [{ seq: 1, time: 0, tools: [{ name: 'bash', tokens: 1_200, plugin: 'dsh-tool-bash' }] }] },
      },
    }))
    expect(cardJsonBytes(card, 'feishu:oc_1:ou_1')).toBeLessThan(CONTEXT_CARD_JSON_BUDGET_BYTES)
    expect(countElements(card)).toBeLessThan(20)
  })
})
