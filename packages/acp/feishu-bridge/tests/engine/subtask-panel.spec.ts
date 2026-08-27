/**
 * Background-subtask live panel: the pure renderer's layout and the engine
 * lifecycle around it (post at settle-with-pending, PATCH on flips and ticks,
 * finalize at zero, drain and stop-all paths).
 *
 * @module dsh-feishu-bridge/tests-subtask-panel
 */

import { describe, expect, it } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.js'
import { renderSubtaskPanelCard, type PanelI18n } from '../../src/engine/subtask-panel.js'
import { ProjectStateStore } from '../../src/engine/project-state.js'
import type { Message, Platform } from '../../src/core/types.js'
import { messages } from '../../src/i18n/messages.js'
import {
  createStubAgent,
  createStubCardPlatformFull,
  newControllableSession,
  newStubMessage,
  type RecordedCard,
  type StubCardPlatform,
} from '../stubs/engine-stubs.js'

/** Card platform that can also post and PATCH cards by handle. */
interface PanelPlatform extends StubCardPlatform {
  postedCards: unknown[]
  updateCards: unknown[]
  sendCardWithHandle(replyCtx: unknown, card: unknown): Promise<unknown>
  updateCardWithHandle(handle: unknown, card: unknown): Promise<void>
}

function panelPlatform(): PanelPlatform {
  const p = createStubCardPlatformFull('test') as unknown as PanelPlatform
  p.postedCards = []
  p.updateCards = []
  p.sendCardWithHandle = async (_replyCtx, card) => {
    p.postedCards.push(card)
    return `handle-${p.postedCards.length}`
  }
  p.updateCardWithHandle = async (_handle, card) => {
    p.updateCards.push(card)
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
    expect(cardText(card)).toContain('just now')
    expect(cardText(card)).toContain('reported 1')
    const buttons = card.elements.filter(e => e.kind === 'actions').flatMap(e => e.buttons)
    expect(buttons.some(b => b.value === 'act:/subtask-panel stop')).toBe(true)
  })

  it('flags a silent child as stalled past the window', () => {
    const stalled = { ...child, lastEventAt: now - 300_000 }
    const card = renderSubtaskPanelCard(i18n, { pending: [stalled], reportedCount: 0, startedAt: now - 60_000, phase: 'running' }, now, 120_000)
    expect(cardText(card)).toContain('silent for 5 min')
  })

  it('marks a child without events as waiting', () => {
    const waiting = { ...child, toolCalls: 0, lastEventAt: 0 }
    const card = renderSubtaskPanelCard(i18n, { pending: [waiting], reportedCount: 0, startedAt: now, phase: 'running' }, now, 120_000)
    expect(cardText(card)).toContain('no events yet')
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

  function seedChild(e: Engine, childId: string, reported: boolean): void {
    e.projectState?.setNativeChild(childId, {
      parent_key: parentKey,
      parent_agent_session_id: 'parent-native-1',
      label: `task ${childId}`,
      worktree_path: '', worktree_branch: '', worktree_base: '', worktree_base_branch: '', worktree_root: '',
      reported,
    })
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
