/**
 * Background-subtask live panel: the pure renderer's layout and the engine
 * lifecycle around it (post at settle-with-pending, PATCH on flips and ticks,
 * finalize at zero, drain and stop-all paths, and the reissue/finalization
 * race interleavings).
 *
 * @module dsh-feishu-bridge/tests-subtask-panel
 */

import { describe, expect, it, vi } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.ts'
import { renderSubtaskPanelCard, type PanelI18n } from '../../src/engine/subtask-panel.ts'
import { ProjectStateStore } from '../../src/engine/project-state.ts'
import type { Message, Platform } from '../../src/core/types.ts'
import { messages } from '../../src/i18n/messages.ts'
import {
  createStubAgent,
  createStubCardPlatformFull,
  newControllableSession,
  newStubMessage,
  type RecordedCard,
  type StubCardPlatform,
} from '../stubs/engine-stubs.ts'

/** Card platform that can also post and PATCH cards by handle. */
interface PanelPlatform extends StubCardPlatform {
  postedCards: unknown[]
  updateCards: unknown[]
  updatedHandles: unknown[]
  deletedHandles: unknown[]
  /** Displacement ledger: epoch ms of the last tracked chat activity. */
  lastActivityMs: number
  sendCardWithHandle(replyCtx: unknown, card: unknown): Promise<unknown>
  updateCardWithHandle(handle: unknown, card: unknown): Promise<void>
  previewDisplaced(handle: unknown, sinceMs: number): boolean
  deletePreviewMessage(handle: unknown): Promise<void>
}

function panelPlatform(): PanelPlatform {
  const p = createStubCardPlatformFull('test') as unknown as PanelPlatform
  p.postedCards = []
  p.updateCards = []
  p.updatedHandles = []
  p.deletedHandles = []
  p.lastActivityMs = 0
  p.sendCardWithHandle = async (_replyCtx, card) => {
    p.postedCards.push(card)
    return `handle-${p.postedCards.length}`
  }
  p.updateCardWithHandle = async (handle, card) => {
    p.updateCards.push(card)
    p.updatedHandles.push(handle)
  }
  p.previewDisplaced = (_handle, sinceMs) => p.lastActivityMs > sinceMs
  p.deletePreviewMessage = async (handle) => {
    p.deletedHandles.push(handle)
  }
  return p
}

/** Minimal i18n over the real key table (en wording, %d/%s substitution). */
const i18n: PanelI18n = {
  t: key => messages[key]?.en ?? key,
  tf: (key, ...args) => {
    const en = messages[key]?.en ?? key
    return en.replace(/%[ds]/g, () => {
      const arg: unknown = args.shift()
      return typeof arg === 'number' ? String(arg) : typeof arg === 'string' ? arg : ''
    })
  },
}

/** One macrotask tick: flushes the fire-and-forget panel sends. */
async function settle(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

/** Engine with a live interactive parent state over the given session key. */
function panelEngineFor(p: Platform, parentKey: string, agent: ReturnType<typeof createStubAgent> = createStubAgent()): Engine {
  const e = new Engine('test', agent, [p], '', 'en')
  e.setProjectStateStore(new ProjectStateStore(''))
  e.sessions.getOrCreateActive(parentKey)
  const state = new InteractiveState()
  state.agentSession = newControllableSession('parent-live-1')
  state.platform = p
  state.replyCtx = 'parent-rctx'
  e.interactiveStates.set(parentKey, state)
  return e
}

/** Seed one native-child record under the given parent session key. */
function seedPanelChild(e: Engine, parentKey: string, childId: string, reported: boolean): void {
  e.projectState?.setNativeChild(childId, {
    parent_key: parentKey,
    parent_agent_session_id: 'parent-live-1',
    label: `task ${childId}`,
    worktree_path: '', worktree_branch: '', worktree_base: '', worktree_base_branch: '', worktree_root: '',
    reported,
  })
}

/** Markdown text of a recorded card (all markdown elements joined). */
function cardText(card: unknown): string {
  const c = card as RecordedCard
  return c.elements.filter(e => e.kind === 'markdown').map(e => e.content ?? '').join('\n')
}

describe('renderSubtaskPanelCard', () => {
  const now = 1_000_000
  const child = { childId: 'c1', label: 'implementation task A1', toolCalls: 42, lastEventAt: now - 5_000 }

  it('renders running rows with calls, activity, and the stop-all button', () => {
    const card = renderSubtaskPanelCard(i18n, { pending: [child], reportedCount: 1, startedAt: now - 60_000, phase: 'running' }, now, 120_000)
    expect(card.header?.title).toContain('1')
    expect(cardText(card)).toContain('implementation task A1')
    expect(cardText(card)).toContain('42')
    expect(cardText(card)).toMatch(/last active \d{2}:\d{2}:\d{2}/)
    expect(cardText(card)).toContain('reported 1')
    const buttons = card.elements.filter(e => e.kind === 'actions').flatMap(e => e.buttons)
    expect(buttons.some(b => b.value === 'act:/subtask-panel stop')).toBe(true)
  })

  it('composes the running header like the tool-progress card: count, live clock, yellow template', () => {
    const card = renderSubtaskPanelCard(i18n, { pending: [child], reportedCount: 1, startedAt: now - 60_000, phase: 'running' }, now, 120_000)
    expect(card.header?.title).toMatch(/^Background subtasks · 1 running · \d{2}:\d{2}:\d{2}$/)
    expect(card.header?.color).toBe('yellow')
  })

  it('omits the header clock segment when no child has events yet', () => {
    const waiting = { ...child, toolCalls: 0, lastEventAt: 0 }
    const card = renderSubtaskPanelCard(i18n, { pending: [waiting], reportedCount: 0, startedAt: now, phase: 'running' }, now, 120_000)
    expect(card.header?.title).toBe('Background subtasks · 1 running')
    expect(card.header?.color).toBe('yellow')
  })

  it('renders only the absolute last-active clock on each row', () => {
    const card = renderSubtaskPanelCard(i18n, { pending: [child], reportedCount: 0, startedAt: now, phase: 'running' }, now, 120_000)
    expect(cardText(card)).toMatch(/last active \d{2}:\d{2}:\d{2}$/)
  })

  it('flags a silent child as stalled past the window', () => {
    const stalled = { ...child, lastEventAt: now - 300_000 }
    const card = renderSubtaskPanelCard(i18n, { pending: [stalled], reportedCount: 0, startedAt: now - 60_000, phase: 'running' }, now, 120_000)
    expect(cardText(card)).toContain('silent for 5 min')
  })

  it('flips the header orange with a stalled suffix and a frozen clock past the stall window', () => {
    const stalled = { ...child, lastEventAt: now - 300_000 }
    const card = renderSubtaskPanelCard(i18n, { pending: [stalled], reportedCount: 0, startedAt: now - 60_000, phase: 'running' }, now, 120_000)
    expect(card.header?.color).toBe('orange')
    expect(card.header?.title).toMatch(/^Background subtasks · 1 running · \d{2}:\d{2}:\d{2} · ⚠️ 1 stalled$/)
    expect(cardText(card)).toMatch(/last active \d{2}:\d{2}:\d{2}$/)
  })

  it('marks a child without events as waiting', () => {
    const waiting = { ...child, toolCalls: 0, lastEventAt: 0 }
    const card = renderSubtaskPanelCard(i18n, { pending: [waiting], reportedCount: 0, startedAt: now, phase: 'running' }, now, 120_000)
    expect(cardText(card)).toContain('no events yet')
  })

  it('renders the header spinner icon when supplied; terminal phases ignore it', () => {
    const running = renderSubtaskPanelCard(i18n, { pending: [child], reportedCount: 0, startedAt: now, phase: 'running' }, now, 120_000, 'img-key-9')
    expect(running.header?.icon).toBe('img-key-9')
    const bare = renderSubtaskPanelCard(i18n, { pending: [child], reportedCount: 0, startedAt: now, phase: 'running' }, now, 120_000)
    expect(bare.header?.icon).toBeUndefined()
    const done = renderSubtaskPanelCard(i18n, { pending: [], reportedCount: 3, startedAt: now - 60_000, phase: 'done' }, now, 120_000, 'img-key-9')
    expect(done.header?.icon).toBeUndefined()
  })

  it('renders terminal done and drained cards without buttons', () => {
    const done = renderSubtaskPanelCard(i18n, { pending: [], reportedCount: 3, startedAt: now - 60_000, phase: 'done' }, now, 120_000)
    expect(done.header?.title).toContain('all reported')
    const drained = renderSubtaskPanelCard(i18n, { pending: [], reportedCount: 0, startedAt: now, phase: 'drained' }, now, 120_000)
    expect(drained.header?.title).toContain('drained')
    for (const card of [done, drained]) {
      expect(card.elements.filter(e => e.kind === 'actions')).toHaveLength(0)
    }
  })
})

describe('background panel lifecycle', () => {
  const parentKey = 'test:panel-parent:u1'

  /**
   * Stub agent combining the delegator seam (spawn/interrupt/report) with the
   * activity source the panel reads — the real adapter implements both.
   */
  function activityAgent(): {
    agent: ReturnType<typeof createStubAgent> & {
      started: unknown[]
      followups: unknown[]
      interrupts: string[]
      reports: unknown[]
      childLive(childId: string): boolean
      subagentActivitySnapshot(): ReadonlyMap<string, { lastEventAt: number; toolCalls: number }>
      forgetSubagentActivity(ids: readonly string[]): void
      startContinuableChild(request: unknown): Promise<{ childId: string; label: string }>
      followupChild(parent: string, child: string, message: string): Promise<void>
      interruptChild(parent: string, child: string): void
      reportChildToNativeParent(child: string, content: string): Promise<void>
    }
    activity: Map<string, { lastEventAt: number; toolCalls: number }>
  } {
    const activity = new Map<string, { lastEventAt: number; toolCalls: number }>()
    const agent = Object.assign(createStubAgent(), {
      started: [] as unknown[],
      followups: [] as unknown[],
      interrupts: [] as string[],
      reports: [] as unknown[],
      childLive: () => false,
      subagentActivitySnapshot: () => activity,
      forgetSubagentActivity: (ids: readonly string[]) => { for (const id of ids) activity.delete(id) },
      startContinuableChild: async (request: unknown) => {
        agent.started.push(request)
        return { childId: 'native-child-1', label: 'spawned' }
      },
      followupChild: async (parent: string, child: string, message: string) => {
        agent.followups.push({ parent, child, message })
      },
      interruptChild: (_parent: string, child: string) => {
        agent.interrupts.push(child)
      },
      reportChildToNativeParent: async (child: string, content: string) => {
        agent.reports.push({ child, content })
      },
    })
    return { agent, activity }
  }

  function panelEngine(p: Platform, agent: ReturnType<typeof activityAgent>['agent']): Engine {
    return panelEngineFor(p, parentKey, agent)
  }

  function seedChild(e: Engine, childId: string, reported: boolean): void {
    seedPanelChild(e, parentKey, childId, reported)
  }

  it('posts a panel when a parent settles with pending children, then finalizes when all report', async () => {
    const p = panelPlatform()
    const { agent, activity } = activityAgent()
    const e = panelEngine(p, agent)
    seedChild(e, 'child-a', false)
    seedChild(e, 'child-b', false)
    seedChild(e, 'child-done', true)
    activity.set('child-a', { lastEventAt: Date.now(), toolCalls: 7 })

    e.ensureSubtaskPanel(parentKey)
    await settle()
    await settle()
    expect(e.subtaskPanels.has(parentKey)).toBe(true)
    expect(cardText(p.postedCards[0])).toContain('task child-a')
    expect(cardText(p.postedCards[0])).toContain('7')
    expect(cardText(p.postedCards[0])).toContain('no events yet') // child-b has no activity
    expect(cardText(p.postedCards[0])).toContain('reported 1 · running 2')

    // One child reports: the next refresh drops its row.
    await e.reportNativeChild('child-a', 'done result')
    await settle()
    await settle()
    expect(p.updateCards.length).toBeGreaterThan(0)
    expect(cardText(p.updateCards[p.updateCards.length - 1])).not.toContain('task child-a')

    // The last report finalizes the panel to its done card and stops the timer.
    await e.reportNativeChild('child-b', 'done result')
    await settle()
    await settle()
    expect(e.subtaskPanels.has(parentKey)).toBe(false)
    expect((p.updateCards[p.updateCards.length - 1] as RecordedCard).header?.title).toContain('all reported')
  })

  it('does not post when disabled by config', async () => {
    const p = panelPlatform()
    const { agent } = activityAgent()
    const e = panelEngine(p, agent)
    e.setSubtaskPanelConfig({ enabled: false, intervalMs: 0 })
    seedChild(e, 'child-x', false)

    e.ensureSubtaskPanel(parentKey)
    await settle()
    expect(p.postedCards).toHaveLength(0)
    expect(e.subtaskPanels.has(parentKey)).toBe(false)
  })

  it('a second ensure inside the posting window posts no duplicate card', async () => {
    const p = panelPlatform()
    const { agent } = activityAgent()
    const e = panelEngine(p, agent)
    seedChild(e, 'child-race', false)
    // Hold the card send open so the second ensure lands mid-post.
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const base = p.sendCardWithHandle.bind(p)
    p.sendCardWithHandle = async (rc: unknown, card: unknown) => { await gate; return base(rc, card) }

    e.ensureSubtaskPanel(parentKey)
    e.ensureSubtaskPanel(parentKey)
    release()
    await settle()
    await settle()

    expect(p.postedCards).toHaveLength(1)
    expect(e.subtaskPanels.has(parentKey)).toBe(true)
  })

  it('closes on drain with the drained card', async () => {
    const p = panelPlatform()
    const { agent } = activityAgent()
    const e = panelEngine(p, agent)
    seedChild(e, 'child-y', false)
    e.ensureSubtaskPanel(parentKey)
    await settle()
    await settle()
    expect(e.subtaskPanels.has(parentKey)).toBe(true)

    e.clearSubtaskPanel(parentKey, 'drained')
    await settle()
    expect(e.subtaskPanels.has(parentKey)).toBe(false)
    expect((p.updateCards[p.updateCards.length - 1] as RecordedCard).header?.title).toContain('drained')
  })

  it('posts with the platform spinner icon when the platform supplies one', async () => {
    const p = panelPlatform()
    ;(p as unknown as { liveCardIconKey(): Promise<string> }).liveCardIconKey = async () => 'img-key-x'
    const { agent, activity } = activityAgent()
    const e = panelEngine(p, agent)
    seedChild(e, 'child-icon', false)
    activity.set('child-icon', { lastEventAt: Date.now(), toolCalls: 3 })

    e.ensureSubtaskPanel(parentKey)
    await settle()
    await settle()
    expect((p.postedCards[0] as RecordedCard).header?.icon).toBe('img-key-x')
  })

  it('still posts without an icon when the icon lookup fails', async () => {
    const p = panelPlatform()
    ;(p as unknown as { liveCardIconKey(): Promise<string> }).liveCardIconKey = async () => {
      throw new Error('icon upload failed')
    }
    const { agent } = activityAgent()
    const e = panelEngine(p, agent)
    seedChild(e, 'child-noicon', false)

    e.ensureSubtaskPanel(parentKey)
    await settle()
    await settle()
    expect(p.postedCards).toHaveLength(1)
    expect((p.postedCards[0] as RecordedCard).header?.icon).toBeUndefined()
  })

  it('stop-all interrupts every pending child and finalizes the panel', async () => {
    const p = panelPlatform()
    const { agent } = activityAgent()
    const e = panelEngine(p, agent)
    seedChild(e, 'child-s1', false)
    seedChild(e, 'child-s2', false)
    e.ensureSubtaskPanel(parentKey)
    await settle()
    await settle()

    const msg: Message = { ...newStubMessage(), sessionKey: parentKey, platform: 'test', replyCtx: 'rctx' }
    await e.handleCardAction(p, msg, 'act:/subtask-panel stop')

    expect(agent.interrupts).toEqual(['child-s1', 'child-s2'])
    await settle()
    await settle()
    expect(e.subtaskPanels.has(parentKey)).toBe(false)
    expect((p.updateCards[p.updateCards.length - 1] as RecordedCard).header?.title).toContain('all reported')
  })
})

describe('panel follow-tail reclaim', () => {
  const parentKey = 'test:panel-follow:u1'

  function panelEngine(p: Platform, agent = createStubAgent()): Engine {
    return panelEngineFor(p, parentKey, agent)
  }

  function seedChild(e: Engine, childId: string, reported: boolean): void {
    seedPanelChild(e, parentKey, childId, reported)
  }

  /** Microtask flush: the panel post/reissue chains are microtask-only. */
  async function flush(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i++) await Promise.resolve()
  }

  it('reissues the panel at the chat tail when displaced, then PATCHes the new card', async () => {
    vi.useFakeTimers()
    try {
      const p = panelPlatform()
      const e = panelEngine(p)
      seedChild(e, 'child-a', false)
      e.ensureSubtaskPanel(parentKey)
      await flush()
      expect(p.postedCards).toHaveLength(1)

      // A newer message landed after the panel posted: the next tick must
      // reissue the card at the tail instead of PATCHing above the intruder.
      p.lastActivityMs = Date.now() + 10
      await vi.advanceTimersByTimeAsync(15_000)
      expect(p.postedCards).toHaveLength(2)
      expect(p.deletedHandles).toEqual(['handle-1'])

      // Nothing landed after the reissue: the next tick PATCHes in place.
      await vi.advanceTimersByTimeAsync(15_000)
      expect(p.postedCards).toHaveLength(2)
      expect(p.updatedHandles[p.updatedHandles.length - 1]).toBe('handle-2')
    } finally {
      vi.useRealTimers()
    }
  })

  it('finalizes in place when all children report, even while displaced', async () => {
    vi.useFakeTimers()
    try {
      const p = panelPlatform()
      const e = panelEngine(p)
      seedChild(e, 'child-a', false)
      seedChild(e, 'child-b', false)
      e.ensureSubtaskPanel(parentKey)
      await flush()
      p.lastActivityMs = Date.now() + 10
      await vi.advanceTimersByTimeAsync(15_000)
      expect(p.postedCards).toHaveLength(2)

      // Every child reports while the chat stays busy: the panel must settle
      // to its done card via PATCH, never jump the tail again.
      for (const childId of ['child-a', 'child-b']) {
        const rec = e.nativeChildEntries()[childId]!
        e.projectState?.setNativeChild(childId, { ...rec, reported: true })
      }
      p.lastActivityMs = Date.now() + 10
      await vi.advanceTimersByTimeAsync(15_000)
      expect(p.postedCards).toHaveLength(2)
      expect(e.subtaskPanels.has(parentKey)).toBe(false)
      expect(p.updatedHandles[p.updatedHandles.length - 1]).toBe('handle-2')
      expect((p.updateCards[p.updateCards.length - 1] as RecordedCard).header?.title).toContain('all reported')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps PATCH-only when follow-tail is disabled by config', async () => {
    vi.useFakeTimers()
    try {
      const p = panelPlatform()
      const e = panelEngine(p)
      e.setSubtaskPanelConfig({ enabled: true, intervalMs: 15_000, followTail: false })
      seedChild(e, 'child-a', false)
      e.ensureSubtaskPanel(parentKey)
      await flush()
      p.lastActivityMs = Date.now() + 10
      await vi.advanceTimersByTimeAsync(15_000)
      expect(p.postedCards).toHaveLength(1)
      expect(p.deletedHandles).toHaveLength(0)
      expect(p.updatedHandles).toEqual(['handle-1'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('defers a second tail jump inside the cooldown window', async () => {
    vi.useFakeTimers()
    try {
      const p = panelPlatform()
      const e = panelEngine(p)
      seedChild(e, 'child-a', false)
      e.ensureSubtaskPanel(parentKey)
      await flush()

      e.reclaimSubtaskPanelTail(parentKey)
      await flush()
      expect(p.postedCards).toHaveLength(2)

      // An immediate second reclaim stays inside the 2s cooldown: no jump.
      e.reclaimSubtaskPanelTail(parentKey)
      await flush()
      expect(p.postedCards).toHaveLength(2)

      // Past the cooldown the reclaim goes through again.
      await vi.advanceTimersByTimeAsync(2_500)
      e.reclaimSubtaskPanelTail(parentKey)
      await flush()
      expect(p.postedCards).toHaveLength(3)
      expect(p.deletedHandles).toEqual(['handle-1', 'handle-2'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('reclaimSubtaskPanelTail reissues without the displacement probe', async () => {
    vi.useFakeTimers()
    try {
      const p = panelPlatform()
      const e = panelEngine(p)
      seedChild(e, 'child-a', false)
      e.ensureSubtaskPanel(parentKey)
      await flush()
      // No ledger activity at all — the probe would say "not displaced";
      // the turn-end reclaim jumps anyway (the placeholder card exemption
      // keeps the probe blind to a settled turn card).
      e.reclaimSubtaskPanelTail(parentKey)
      await flush()
      expect(p.postedCards).toHaveLength(2)
      expect(p.deletedHandles).toEqual(['handle-1'])

      // No live panel, or the feature off: both stay no-ops.
      e.reclaimSubtaskPanelTail('test:other-chat:u1')
      e.setSubtaskPanelConfig({ enabled: true, intervalMs: 15_000, followTail: false })
      e.reclaimSubtaskPanelTail(parentKey)
      await flush()
      expect(p.postedCards).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the new handle when the old card delete fails, and the old card when the reissue send fails', async () => {
    vi.useFakeTimers()
    try {
      const p = panelPlatform()
      const e = panelEngine(p)
      seedChild(e, 'child-a', false)
      e.ensureSubtaskPanel(parentKey)
      await flush()

      // Delete failure only orphans the old card; the reissue stands.
      p.deletePreviewMessage = async () => { throw new Error('delete denied') }
      p.lastActivityMs = Date.now() + 10
      await vi.advanceTimersByTimeAsync(15_000)
      expect(p.postedCards).toHaveLength(2)
      p.deletePreviewMessage = async (handle: unknown) => { p.deletedHandles.push(handle) }

      // Send failure keeps the old card delivering content.
      const base = p.sendCardWithHandle.bind(p)
      p.sendCardWithHandle = async (rc: unknown, card: unknown) => {
        if (p.postedCards.length >= 2) throw new Error('send denied')
        return base(rc, card)
      }
      p.lastActivityMs = Date.now() + 10
      await vi.advanceTimersByTimeAsync(15_000)
      await vi.advanceTimersByTimeAsync(15_000)
      expect(p.postedCards).toHaveLength(2)
      expect(p.updatedHandles[p.updatedHandles.length - 1]).toBe('handle-2')

      // Restored sender: the deferred reissue goes through on the next tick.
      p.sendCardWithHandle = base
      p.lastActivityMs = Date.now() + 10
      await vi.advanceTimersByTimeAsync(15_000)
      expect(p.postedCards).toHaveLength(3)
      // handle-1 stays orphaned — its delete failed earlier; the restored
      // cleaner removes only the live predecessor of the newest card.
      expect(p.deletedHandles).toEqual(['handle-2'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('panel reissue vs finalization race', () => {
  const parentKey = 'test:panel-race:u1'

  function panelEngine(p: Platform, agent = createStubAgent()): Engine {
    return panelEngineFor(p, parentKey, agent)
  }

  function seedChild(e: Engine, childId: string, reported: boolean): void {
    seedPanelChild(e, parentKey, childId, reported)
  }

  /** Microtask flush: the panel reissue/finalize chains are microtask-only. */
  async function flush(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i++) await Promise.resolve()
  }

  /** Mark every unreported child of the panel's parent reported. */
  function reportAll(e: Engine): void {
    for (const [childId, rec] of Object.entries(e.nativeChildEntries())) {
      if (rec.parent_key === parentKey && !rec.reported) e.projectState?.setNativeChild(childId, { ...rec, reported: true })
    }
  }

  /**
   * Hold the next card send under test control: one shot, installed after the
   * initial panel post, released to land (or fail) at the chosen interleaving
   * point.
   */
  function holdNextSend(p: PanelPlatform): { land: () => void; fail: (error: unknown) => void } {
    const base = p.sendCardWithHandle.bind(p)
    let release!: () => void
    let reject!: (error: unknown) => void
    const gate = new Promise<void>((resolve, fail) => { release = resolve; reject = fail })
    p.sendCardWithHandle = (rc: unknown, card: unknown) => gate.then(() => base(rc, card))
    return {
      land: () => { release(); p.sendCardWithHandle = base },
      fail: (error: unknown) => { reject(error); p.sendCardWithHandle = base },
    }
  }

  /** Hold the next card PATCH under test control (one shot, like the send). */
  function holdNextUpdate(p: PanelPlatform): { land: () => void } {
    const base = p.updateCardWithHandle.bind(p)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    p.updateCardWithHandle = async (handle: unknown, card: unknown) => { await gate; return base(handle, card) }
    return { land: () => { release(); p.updateCardWithHandle = base } }
  }

  it('keeps the finalized card when an in-flight reissue resolves after the terminal PATCH landed', async () => {
    vi.useFakeTimers()
    try {
      const p = panelPlatform()
      const e = panelEngine(p)
      seedChild(e, 'child-a', false)
      e.ensureSubtaskPanel(parentKey)
      await flush()
      expect(p.postedCards).toHaveLength(1)

      // The next tick reissues (displaced) and the fresh card's send stays
      // in flight while the children finish.
      const held = holdNextSend(p)
      p.lastActivityMs = Date.now() + 10
      await vi.advanceTimersByTimeAsync(15_000)
      reportAll(e)

      // The following tick finalizes: the terminal PATCH lands on the
      // still-live card.
      await vi.advanceTimersByTimeAsync(15_000)
      expect(e.subtaskPanels.has(parentKey)).toBe(false)
      expect(p.updatedHandles).toEqual(['handle-1'])
      expect((p.updateCards[0] as RecordedCard).header?.title).toContain('all reported')

      // The reissue lands last: its running card is the orphan now — delete
      // that one, never the card carrying the terminal content.
      held.land()
      await flush()
      expect(p.postedCards).toHaveLength(2)
      expect(p.deletedHandles).toEqual(['handle-2'])
      expect((p.updateCards[p.updateCards.length - 1] as RecordedCard).header?.title).toContain('all reported')

      // No map residue and a dead timer: later ticks PATCH nothing.
      await vi.advanceTimersByTimeAsync(45_000)
      expect(e.subtaskPanels.has(parentKey)).toBe(false)
      expect(p.updateCards).toHaveLength(1)
      expect(p.deletedHandles).toEqual(['handle-2'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('deletes the reissued running card when it resolves between deregistration and the terminal PATCH landing', async () => {
    vi.useFakeTimers()
    try {
      const p = panelPlatform()
      const e = panelEngine(p)
      seedChild(e, 'child-a', false)
      e.ensureSubtaskPanel(parentKey)
      await flush()

      const heldSend = holdNextSend(p)
      const heldUpdate = holdNextUpdate(p)
      p.lastActivityMs = Date.now() + 10
      await vi.advanceTimersByTimeAsync(15_000)
      reportAll(e)

      // The finalize tick deregisters synchronously and fires the terminal
      // PATCH, which stays in flight — the tightest window: the panel entry
      // is gone while neither card has taken its final content.
      await vi.advanceTimersByTimeAsync(15_000)
      expect(e.subtaskPanels.has(parentKey)).toBe(false)
      expect(p.updatedHandles).toHaveLength(0)

      // The reissue resolves inside the window: its card is the orphan.
      heldSend.land()
      await flush()
      expect(p.postedCards).toHaveLength(2)
      expect(p.deletedHandles).toEqual(['handle-2'])

      // The terminal PATCH then lands on the card that kept its place.
      heldUpdate.land()
      await flush()
      expect(p.updatedHandles).toEqual(['handle-1'])
      expect((p.updateCards[0] as RecordedCard).header?.title).toContain('all reported')

      await vi.advanceTimersByTimeAsync(45_000)
      expect(e.subtaskPanels.has(parentKey)).toBe(false)
      expect(p.updateCards).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('finalizes the reissued card when the reissue resolves before the children finish', async () => {
    vi.useFakeTimers()
    try {
      const p = panelPlatform()
      const e = panelEngine(p)
      seedChild(e, 'child-a', false)
      e.ensureSubtaskPanel(parentKey)
      await flush()

      // The reverse order: the reissue completes first — new handle adopted,
      // displaced card deleted.
      p.lastActivityMs = Date.now() + 10
      await vi.advanceTimersByTimeAsync(15_000)
      expect(p.postedCards).toHaveLength(2)
      expect(p.deletedHandles).toEqual(['handle-1'])

      // The children finish afterwards: the terminal PATCH must land on the
      // newest card — the generation guard must not discard a legitimate
      // adoption as an orphan.
      reportAll(e)
      await vi.advanceTimersByTimeAsync(15_000)
      expect(e.subtaskPanels.has(parentKey)).toBe(false)
      expect(p.updatedHandles).toEqual(['handle-2'])
      expect((p.updateCards[0] as RecordedCard).header?.title).toContain('all reported')

      await vi.advanceTimersByTimeAsync(45_000)
      expect(p.updateCards).toHaveLength(1)
      expect(p.deletedHandles).toEqual(['handle-1'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not PATCH running content onto the finalized card when a late reissue fails', async () => {
    vi.useFakeTimers()
    try {
      const p = panelPlatform()
      const e = panelEngine(p)
      seedChild(e, 'child-a', false)
      e.ensureSubtaskPanel(parentKey)
      await flush()

      const held = holdNextSend(p)
      p.lastActivityMs = Date.now() + 10
      await vi.advanceTimersByTimeAsync(15_000)
      reportAll(e)
      await vi.advanceTimersByTimeAsync(15_000)
      expect(e.subtaskPanels.has(parentKey)).toBe(false)
      expect((p.updateCards[0] as RecordedCard).header?.title).toContain('all reported')

      // The reissue send fails after finalization: the fallback PATCH must
      // not overwrite the terminal card with running content.
      held.fail(new Error('send denied'))
      await flush()
      expect(p.updateCards).toHaveLength(1)
      expect((p.updateCards[p.updateCards.length - 1] as RecordedCard).header?.title).toContain('all reported')

      await vi.advanceTimersByTimeAsync(45_000)
      expect(p.updateCards).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
