/**
 * Bounds on the per-state satellite maps (exportContent / renderStatuses /
 * planCardRender): export keys are per-turn card message ids, and the idle
 * reaper is off by default, so an unbounded map grows for the life of an
 * active chat. The maps evict their least-recently-set entry past the
 * capacity regardless of which module created them (plan-render assigns
 * plain Maps; the state wraps them on assignment).
 *
 * @module dsh-feishu-bridge/tests-engine-state-map-bounds
 */

import { describe, expect, it } from 'vitest'
import { InteractiveState } from '../../src/engine/engine.js'

const capacity = 128

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
