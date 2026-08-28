/**
 * Registration, dispatch, and card-action tests for registerContextCommands
 * (/context): the command merges into the session-command table under the
 * agent group, resolves ≥2-char prefixes, renders the insight card from the
 * adapter's ContextSnapshotReader capability (empty-state card when nothing
 * is readable), degrades to text on non-card platforms, refreshes through the
 * registered `act:/context ctx:<sessionKey>` card action, and disposes
 * cleanly.
 *
 * @module dsh-feishu-bridge/tests-engine-context-commands
 */

import { describe, expect, it } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.js'
import { registerSessionCommands } from '../../src/engine/commands.js'
import { registerContextCommands } from '../../src/engine/context-commands.js'
import { CONTEXT_REFRESH_ARG_PREFIX } from '../../src/context/render.js'
import type { ContextSnapshotValues } from '../../src/context/types.js'
import {
  createStubAgent,
  createStubCardPlatform,
  createStubPlatform,
  newControllableSession,
  newStubMessage,
  type StubCardPlatform,
} from '../stubs/engine-stubs.js'
import type { Agent, Message } from '../../src/core/types.js'
import type { Card } from '../../src/card.js'

/** Drain the voided async command replies before probing sent output. */
const flush = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** One wire-shaped timeline for the stub snapshot source. */
function snapshot(over: Partial<ContextSnapshotValues> = {}): ContextSnapshotValues {
  return {
    timeline: {
      current: { system: 1_000, tools: 2_000, user: 3_000, inject: 0, assistant: 4_000, tool: 0, total: 10_000 },
      requests: [{
        time: 0, seq: 1, turn: 1, step: 1,
        system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0,
        total: 9_000, prompt: 9_000, cacheRead: 500, output: 800,
      }],
      events: [{ seq: 1, time: 0, kind: 'compaction', tokens: 2_000, turn: 1, name: 'compaction-basic' }],
      contextWindow: 128_000,
    },
    ...over,
  }
}

/**
 * A stub agent exposing the ContextSnapshotReader capability over a mutable
 * snapshot record (tests flip it between renders to observe refreshes) and
 * the provider switcher for the header's model segment.
 */
function contextAgent(current: { snapshot: ContextSnapshotValues | undefined }): Agent {
  const agent = {
    ...createStubAgent(),
    contextSnapshot: (agentSessionID: string) =>
      agentSessionID === 'cc-live-1' ? current.snapshot : undefined,
    getActiveProvider: () => ({ name: 'r', model: 'deepseek-v4-flash' }),
    listProviders: () => [],
    setProviders: () => {},
    setActiveProvider: () => false,
  }
  return agent as Agent
}

interface Fixture {
  e: Engine
  p: StubCardPlatform
  live: { snapshot: ContextSnapshotValues | undefined }
  disposeSession: () => void
  disposeCommands: () => void
}

/** Engine + live interactive session + the /context registration. */
function newFixture(live: { snapshot: ContextSnapshotValues | undefined }, platform?: StubCardPlatform): Fixture {
  const p = platform ?? createStubCardPlatform('test')
  const e = new Engine('test', contextAgent(live), [p], '', 'en')
  const disposeSession = registerSessionCommands(e)
  const disposeCommands = registerContextCommands(e)
  // The chat's live agent session: activeAgentSessionID resolves to it over
  // the bridge session's persisted mapping.
  const state = new InteractiveState()
  state.agentSession = newControllableSession('cc-live-1')
  state.platform = p
  state.replyCtx = 'ctx'
  e.interactiveStates.set('test:ch1', state)
  return { e, p, live, disposeSession, disposeCommands }
}

function cmdMsg(content: string): Message {
  return { ...newStubMessage(), sessionKey: 'test:ch1', userID: 'u1', replyCtx: 'ctx', content }
}

function cardActionMsg(sessionKey: string, action: string): Message {
  return { ...newStubMessage(), sessionKey, platform: 'test', userID: 'u1', chatType: 'group', content: action, replyCtx: 'ctx', isCardAction: true }
}

/** Concatenated markdown content of a recorded card. */
function cardMarkdown(card: unknown): string {
  const c = card as Card
  return c.elements.filter(el => el.kind === 'markdown').map(el => (el.kind === 'markdown' ? el.content : '')).join('\n\n')
}

describe('registerContextCommands', () => {
  it('merges into the session command table under the agent group and keeps /new resolvable', () => {
    const { e, disposeSession, disposeCommands } = newFixture({ snapshot: snapshot() })
    try {
      expect(e.commandHandlers?.get('context')).toBeDefined()
      expect(e.commandHandlers?.get('new')).toBeDefined()
      expect(e.commandGroups.get('context')).toBe('agent')
      expect(e.commandResolver?.('context')).toBe('context')
      expect(e.commandResolver?.('con')).toBe('context')
      expect(e.commandResolver?.('c')).toBe('')
    } finally {
      disposeCommands()
      disposeSession()
    }
  })

  it('/context renders the insight card from the live session snapshot on card platforms', async () => {
    const { e, p, disposeSession, disposeCommands } = newFixture({ snapshot: snapshot() })
    try {
      expect(e.dispatchCommand(p, cmdMsg('/context'), '/context')).toBe(true)
      await flush()
      expect(p.sentCards.length).toBe(1)
      const card = p.sentCards[0] as Card
      expect(card.header?.title).toBe('📊 上下文 · default · deepseek-v4-flash')
      const text = cardMarkdown(card)
      expect(text).toContain('**上下文占用**')
      expect(text).toContain('**统计**：1 轮 · 1 步 · 压缩 1')
      expect(card.elements.filter(el => el.kind === 'chart').length).toBe(2)
    } finally {
      disposeCommands()
      disposeSession()
    }
  })

  it('/context replies the text degradation on non-card platforms', async () => {
    const text = createStubPlatform('plain')
    const e = new Engine('test', contextAgent({ snapshot: snapshot() }), [text], '', 'en')
    const disposeSession = registerSessionCommands(e)
    const disposeCommands = registerContextCommands(e)
    const state = new InteractiveState()
    state.agentSession = newControllableSession('cc-live-1')
    e.interactiveStates.set('test:ch1', state)
    try {
      expect(e.dispatchCommand(text, cmdMsg('/context'), '/context')).toBe(true)
      await flush()
      const sent = text.getSent().at(-1) ?? ''
      expect(sent).toContain('**上下文占用**')
      expect(sent).toContain('**统计**：1 轮 · 1 步 · 压缩 1')
    } finally {
      disposeCommands()
      disposeSession()
    }
  })

  it('/context renders the empty-state card when no snapshot is readable', async () => {
    const { e, p, disposeSession, disposeCommands } = newFixture({ snapshot: undefined })
    try {
      expect(e.dispatchCommand(p, cmdMsg('/context'), '/context')).toBe(true)
      await flush()
      expect(cardMarkdown(p.sentCards[0])).toContain('还没有可读取的上下文数据')
    } finally {
      disposeCommands()
      disposeSession()
    }
  })

  it('the act:/context card action re-reads the snapshot and PATCHes the pressed card', async () => {
    const live = { snapshot: snapshot() }
    const { e, p, disposeSession, disposeCommands } = newFixture(live)
    // A refreshing platform records the in-place PATCH; a plain card platform
    // would fall back to a new card.
    const refreshed: Array<{ sessionKey: string; body: string }> = []
    ;(p as StubCardPlatform & { refreshCard(sessionKey: string, card: unknown): Promise<void> }).refreshCard =
      async (sessionKey, card) => { refreshed.push({ sessionKey, body: cardMarkdown(card) }) }
    try {
      live.snapshot = snapshot({ timeline: { ...snapshot().timeline!, contextWindow: 100_000 } })
      e.receiveMessage(p, cardActionMsg('test:ch1', `act:/context ${CONTEXT_REFRESH_ARG_PREFIX}test:ch1`))
      await flush()
      expect(refreshed.length).toBe(1)
      expect(refreshed[0]?.sessionKey).toBe('test:ch1')
      // The re-read snapshot serves a 100k window; the estimate anchor (9k
      // prompt + 1k surface movement) occupies 10% of it.
      expect(refreshed[0]?.body).toContain('**上下文占用** 10.0k / 100k（10.0%）')
      expect(p.getSent()).toEqual([])
      expect(p.sentCards.length).toBe(0)
    } finally {
      disposeCommands()
      disposeSession()
    }
  })

  it('the card action falls back to the pressing chat key when the args carry none', async () => {
    const live = { snapshot: snapshot() }
    const { e, p, disposeSession, disposeCommands } = newFixture(live)
    const refreshed: Array<{ sessionKey: string; body: string }> = []
    ;(p as StubCardPlatform & { refreshCard(sessionKey: string, card: unknown): Promise<void> }).refreshCard =
      async (sessionKey, card) => { refreshed.push({ sessionKey, body: cardMarkdown(card) }) }
    try {
      e.receiveMessage(p, cardActionMsg('test:ch1', 'act:/context'))
      await flush()
      expect(refreshed.length).toBe(1)
      expect(refreshed[0]?.body).toContain('**上下文占用**')
    } finally {
      disposeCommands()
      disposeSession()
    }
  })

  it('dispose removes the command, the resolver step, and the card action', async () => {
    const { e, p, disposeSession, disposeCommands } = newFixture({ snapshot: snapshot() })
    disposeCommands()
    try {
      expect(e.commandHandlers?.get('context')).toBeUndefined()
      expect(e.commandGroups.get('context')).toBeUndefined()
      expect(e.commandResolver?.('context')).toBe('')
      expect(e.dispatchCommand(p, cmdMsg('/context'), '/context')).toBe(false)
      e.receiveMessage(p, cardActionMsg('test:ch1', `act:/context ${CONTEXT_REFRESH_ARG_PREFIX}test:ch1`))
      await flush()
      expect(p.sentCards.length).toBe(0)
      expect(p.getSent()).toEqual([])
    } finally {
      disposeSession()
    }
  })
})
