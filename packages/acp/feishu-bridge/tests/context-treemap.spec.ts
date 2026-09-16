/**
 * Behavior tests for the /context map treemap pipeline: treemapSegments
 * shapes the projection snapshot into context-ordered segments (system →
 * per-tool schemas → dropped-nodes placeholder → surface nodes by seq),
 * squarify lays the segments out as an order-preserving squarified treemap,
 * and renderTreemapHTML emits the self-contained zero-JS HTML document with
 * every interpolated string escaped.
 *
 * @module dsh-feishu-bridge/tests-context-treemap
 */

import { describe, expect, it } from 'vitest'
import { renderTreemapHTML, squarify, treemapSegments } from '../src/context/treemap.ts'
import type { ContextSnapshotValues, ContextTimelineValue } from '../src/context/types.ts'

/** One wire-shaped timeline overridable per test. */
function timeline(over: Partial<ContextTimelineValue> = {}): ContextTimelineValue {
  return {
    current: { system: 1_200, tools: 3_000, user: 1_800, inject: 200, assistant: 1_500, tool: 500, total: 8_200 },
    requests: [],
    events: [],
    droppedNodes: 2,
    nodes: [
      { seq: 5, cat: 'user', tokens: 800, text: '帮我看看这个' },
      { seq: 3, cat: 'inject', tokens: 200, text: 'AGENTS.md 注入' },
      { seq: 9, cat: 'assistant', tokens: 0, text: '' },
      { seq: 7, cat: 'tool', tokens: 500, tool: 'bash' },
      { seq: 11, cat: 'assistant', tokens: 1_500, text: '分析结果如下' },
    ],
    ...over,
  }
}

/** A snapshot carrying one header epoch: system text plus two tool schemas. */
function snapshot(over: Partial<ContextSnapshotValues> = {}): ContextSnapshotValues {
  return {
    timeline: timeline(),
    headers: {
      headers: [{
        seq: 2, time: 0,
        system: 'You are a coding agent powered by the deepseek model.',
        tools: [
          { name: 'bash', tokens: 1_800, plugin: 'dsh-shell' },
          { name: 'read', tokens: 1_200 },
        ],
      }],
    },
    ...over,
  }
}

describe('treemapSegments', () => {
  it('orders segments system → tools (epoch order) → dropped placeholder → nodes by seq, skipping zero-token nodes', () => {
    const segments = treemapSegments(snapshot())
    expect(segments.map(s => s.kind)).toEqual(['system', 'tool', 'tool', 'dropped', 'node', 'node', 'node', 'node'])
    expect(segments.map(s => s.tokens)).toEqual([1_200, 1_800, 1_200, 1_000, 200, 800, 500, 1_500])
    // Node segments keep their surface category and arrive seq-ordered.
    expect(segments.filter(s => s.kind === 'node').map(s => s.cat)).toEqual(['inject', 'user', 'tool', 'assistant'])
    // The dropped placeholder's tokens are the message-bucket sum minus the
    // served nodes' sum (4_000 − 3_000).
    const dropped = segments.find(s => s.kind === 'dropped')
    expect(dropped?.label).toContain('2')
  })

  it('omits the dropped placeholder when every live node is served', () => {
    const segments = treemapSegments(snapshot({
      timeline: timeline({
        droppedNodes: 0,
        current: { system: 1_200, tools: 3_000, user: 800, inject: 200, assistant: 1_500, tool: 500, total: 7_200 },
      }),
    }))
    expect(segments.filter(s => s.kind === 'dropped')).toEqual([])
  })
})

describe('squarify', () => {
  const EPS = 1e-6

  /** Pairwise-overlap + bounds + exact-area checks over one layout. */
  function assertTiling(values: number[], canvas: { w: number; h: number }): void {
    const rects = squarify(values, { x: 0, y: 0, ...canvas })
    const total = values.reduce((a, b) => a + b, 0)
    expect(rects.length).toBe(values.length)
    for (const [i, r] of rects.entries()) {
      const value = values[i]
      if (value === undefined) throw new Error('unreachable')
      expect(r.x).toBeGreaterThanOrEqual(-EPS)
      expect(r.y).toBeGreaterThanOrEqual(-EPS)
      expect(r.x + r.w).toBeLessThanOrEqual(canvas.w + EPS)
      expect(r.y + r.h).toBeLessThanOrEqual(canvas.h + EPS)
      // Area proportional to the value's share of the canvas.
      expect(r.w * r.h).toBeCloseTo((value / total) * canvas.w * canvas.h, 6)
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j]
        if (a === undefined || b === undefined) throw new Error('unreachable')
        const overlaps = a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS
          && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS
        expect(overlaps).toBe(false)
      }
    }
  }

  it('tiles the canvas exactly with areas proportional to the values', () => {
    assertTiling([600, 300, 100], { w: 1_000, h: 600 })
    assertTiling([100, 100, 400, 50, 350], { w: 1_000, h: 800 })
    assertTiling([40, 30, 20, 10], { w: 600, h: 400 })
  })

  it('keeps the input reading order: columns advance left→right, stacks top→bottom', () => {
    const rects = squarify([100, 100, 400, 50, 350], { x: 10, y: 20, w: 1_000, h: 800 })
    // The first rectangle starts at the canvas origin.
    expect(rects[0]?.x).toBe(10)
    expect(rects[0]?.y).toBe(20)
    for (let i = 1; i < rects.length; i++) {
      const prev = rects[i - 1], cur = rects[i]
      if (cur === undefined || prev === undefined) throw new Error('unreachable')
      // Reading order never moves backward: x is non-decreasing, and within
      // one x column y grows strictly below the previous rectangle.
      expect(cur.x).toBeGreaterThanOrEqual(prev.x - EPS)
      if (cur.x < prev.x + EPS) expect(cur.y).toBeGreaterThanOrEqual(prev.y + prev.h - EPS)
    }
  })

  it('returns one full-canvas rectangle for a single value and none for no values', () => {
    expect(squarify([500], { x: 0, y: 0, w: 300, h: 200 })).toEqual([{ x: 0, y: 0, w: 300, h: 200 }])
    expect(squarify([], { x: 0, y: 0, w: 300, h: 200 })).toEqual([])
  })

  it('degenerates zero-value entries to zero-area rectangles instead of hanging', () => {
    const rects = squarify([0, 100], { x: 0, y: 0, w: 300, h: 200 })
    expect(rects[0]).toEqual({ x: 0, y: 0, w: 0, h: 0 })
    expect(rects[1]).toEqual({ x: 0, y: 0, w: 300, h: 200 })
  })
})

describe('renderTreemapHTML', () => {
  it('emits one styled rectangle per segment with the totals footer and no scripts or external references', () => {
    const html = renderTreemapHTML({ sessionTitle: '开发虾', model: 'deepseek-v4-flash', snapshot: snapshot(), time: 0 })
    // The fixture shapes 8 segments (system, 2 tools, dropped, 4 nodes).
    expect(html.match(/class="seg( bare)?"/g)?.length).toBe(8)
    expect(html).toContain('系统提示词')
    expect(html).toContain('bash')
    expect(html).toContain('更早的 2 条消息')
    // Header meta and the six-bucket legend carry the fixture's figures.
    expect(html).toContain('deepseek-v4-flash')
    expect(html).toContain('8.2k')
    // Self-contained: zero JS, zero network.
    expect(html).not.toContain('<script')
    expect(html).not.toMatch(/https?:\/\//)
  })

  it('escapes labels and previews interpolated into the document', () => {
    const hostile = snapshot({
      timeline: timeline({
        droppedNodes: 0,
        nodes: [{ seq: 1, cat: 'user', tokens: 500, text: '<script>alert(1)</script>' }],
        current: { system: 0, tools: 0, user: 500, inject: 0, assistant: 0, tool: 0, total: 500 },
      }),
      headers: { headers: [{ seq: 2, time: 0, system: '', tools: [{ name: 'onerror="x"', tokens: 300 }] }] },
    })
    const html = renderTreemapHTML({ sessionTitle: 't', model: 'm', snapshot: hostile, time: 0 })
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;script&gt;alert(1)')
    expect(html).not.toContain('onerror="x"')
    expect(html).toContain('onerror=&quot;x&quot;')
  })

  it('marks rectangles too small for text with the bare class so CSS hides their labels', () => {
    // One dominant segment leaves the others a few pixels each.
    const skewed = snapshot({
      timeline: timeline({
        droppedNodes: 0,
        nodes: [
          { seq: 1, cat: 'user', tokens: 500_000, text: '巨大' },
          { seq: 2, cat: 'tool', tokens: 40, tool: 'tiny' },
        ],
        current: { system: 0, tools: 0, user: 500_000, inject: 0, assistant: 0, tool: 40, total: 500_040 },
      }),
      headers: { headers: [] },
    })
    const html = renderTreemapHTML({ sessionTitle: 't', model: 'm', snapshot: skewed, time: 0 })
    expect(html).toContain('class="seg bare')
    expect(html).toContain('巨大')
  })
})
