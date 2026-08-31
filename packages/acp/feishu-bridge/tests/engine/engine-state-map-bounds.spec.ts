/**
 * Bounds on the per-state satellite maps (exportContent / renderStatuses /
 * planCardRender / renderedReplyHTML): export keys are per-turn card message
 * ids, and the idle reaper is off by default, so an unbounded map grows for
 * the life of an active chat. The maps evict their least-recently-set entry
 * past the capacity regardless of which module created them (plan-render
 * assigns plain Maps; the state wraps them on assignment). A
 * renderedReplyHTML eviction must also reap the evicted entry's HTML temp
 * dir — teardown only reaps what is still in the map.
 *
 * @module dsh-feishu-bridge/tests-engine-state-map-bounds
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { InteractiveState } from '../../src/engine/engine.js'

const capacity = 128

/** Poll until cond holds: eviction reaps files through async removeRenderedTemp. */
async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
  throw new Error(`timeout waiting for ${what}`)
}

describe('InteractiveState satellite map bounds', () => {
  it('exportContent evicts the oldest entry past the capacity', () => {
    const state = new InteractiveState()
    state.exportContent = new Map()
    for (let i = 0; i < capacity + 2; i++) state.exportContent.set(`k${i}`, `v${i}`)
    expect(state.exportContent?.size).toBe(capacity)
    expect(state.exportContent?.has('k0')).toBe(false)
    expect(state.exportContent?.has('k1')).toBe(false)
    expect(state.exportContent?.has(`k${capacity + 1}`)).toBe(true)
  })

  it('renderStatuses evicts the oldest entry past the capacity', () => {
    const state = new InteractiveState()
    state.renderStatuses = new Map()
    for (let i = 0; i < capacity + 2; i++) {
      state.renderStatuses.set(`k${i}`, { kind: 'reply', status: 'delivered', updatedAt: i })
    }
    expect(state.renderStatuses?.size).toBe(capacity)
    expect(state.renderStatuses?.has('k0')).toBe(false)
    expect(state.renderStatuses?.has(`k${capacity + 1}`)).toBe(true)
  })

  it('planCardRender evicts the oldest entry past the capacity', () => {
    const state = new InteractiveState()
    state.planCardRender = new Map()
    for (let i = 0; i < capacity + 2; i++) {
      state.planCardRender.set(`k${i}`, { handle: `h${i}`, baseCard: {} as never })
    }
    expect(state.planCardRender?.size).toBe(capacity)
    expect(state.planCardRender?.has('k0')).toBe(false)
    expect(state.planCardRender?.has(`k${capacity + 1}`)).toBe(true)
  })

  it('re-setting an existing key refreshes its recency (LRU, not FIFO)', () => {
    const state = new InteractiveState()
    state.exportContent = new Map()
    state.exportContent.set('old', 'v')
    for (let i = 0; i < capacity; i++) state.exportContent.set(`k${i}`, `v${i}`)
    state.exportContent.set('old', 'refreshed')
    expect(state.exportContent?.size).toBe(capacity)
    expect(state.exportContent?.has('old'), 'the refreshed key survives').toBe(true)
    expect(state.exportContent?.has('k0'), 'the stalest key is the one evicted').toBe(false)
  })
})

describe('InteractiveState renderedReplyHTML bounds', () => {
  it('evicts the oldest entry past the capacity and reaps its HTML temp dir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fb-replyhtml-bounds-'))
    const dirOf = (i: number): string => join(root, `cc-plan-render-${i}`)
    const htmlPath = (i: number): string => join(dirOf(i), 'render.html')

    const state = new InteractiveState()
    state.renderedReplyHTML = new Map()
    for (let i = 0; i < capacity + 2; i++) {
      mkdirSync(dirOf(i))
      writeFileSync(htmlPath(i), 'x')
      state.renderedReplyHTML.set(`k${i}`, htmlPath(i))
    }

    expect(state.renderedReplyHTML?.size).toBe(capacity)
    expect(state.renderedReplyHTML?.has('k0')).toBe(false)
    expect(state.renderedReplyHTML?.has('k1')).toBe(false)
    expect(state.renderedReplyHTML?.has(`k${capacity + 1}`)).toBe(true)

    await waitFor(
      () => !existsSync(dirOf(0)) && !existsSync(dirOf(1)),
      'the evicted entries temp dirs reaped',
    )
    expect(existsSync(dirOf(2)), 'a surviving entry keeps its temp dir').toBe(true)
    expect(existsSync(dirOf(capacity + 1)), 'the newest entry keeps its temp dir').toBe(true)
  })

  it('an eviction whose temp dir was already reaped does not throw and still bounds the map', () => {
    const root = mkdtempSync(join(tmpdir(), 'fb-replyhtml-bounds-'))
    const state = new InteractiveState()
    state.renderedReplyHTML = new Map()
    // A failed render reaps its temp dir while the manifest entry lingers
    // until eviction — the evict cleanup must tolerate the missing dir.
    state.renderedReplyHTML.set('k0', join(root, 'cc-plan-render-gone', 'render.html'))
    for (let i = 1; i < capacity + 2; i++) {
      state.renderedReplyHTML.set(`k${i}`, join(root, `cc-plan-render-${i}`, 'render.html'))
    }
    expect(state.renderedReplyHTML?.size).toBe(capacity)
    expect(state.renderedReplyHTML?.has('k0')).toBe(false)
    expect(state.renderedReplyHTML?.has(`k${capacity + 1}`)).toBe(true)
  })

  it('assigning an already-over-capacity plain Map trims it and reaps the trimmed entries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fb-replyhtml-bounds-'))
    const dirOf = (i: number): string => join(root, `cc-plan-render-${i}`)
    const plain = new Map<string, string>()
    for (let i = 0; i < capacity + 1; i++) {
      mkdirSync(dirOf(i))
      writeFileSync(join(dirOf(i), 'render.html'), 'x')
      plain.set(`k${i}`, join(dirOf(i), 'render.html'))
    }

    const state = new InteractiveState()
    state.renderedReplyHTML = plain
    expect(state.renderedReplyHTML?.size).toBe(capacity)
    expect(state.renderedReplyHTML?.has('k0')).toBe(false)

    await waitFor(() => !existsSync(dirOf(0)), 'the trimmed entry temp dir reaped')
    expect(existsSync(dirOf(1)), 'surviving entries keep their temp dirs').toBe(true)
  })
})
