/**
 * Ported from cc-connect core/engine_provider.go + the provider sections of
 * engine_test.go (#9 全局 Providers / #12 切换): the /provider command family
 * (list/switch/current/clear), the provider card and its act:/provider
 * card actions in both switch modes (Go renderProviderCard +
 * executeCardAction "/provider"), the provider_shortcuts quick commands
 * (/strong → provider + new session), and the per-chat usage-provider
 * gating of the ⌛ quota line. The add/remove/preset flows are not ported —
 * a provider is a named llm route in the profile config, which the runtime
 * cannot create.
 *
 * @module dsh-feishu-bridge/tests-provider-commands
 */

import { describe, expect, it } from 'vitest'
import { Engine } from '../../src/engine/engine.ts'
import { registerProviderCommands } from '../../src/engine/provider-commands.ts'
import { registerSessionCommands } from '../../src/engine/commands.ts'
import type { Agent, Message, ProviderSwitcher } from '../../src/core/types.ts'
import type { UsageProvider } from '../../src/engine/usage.ts'
import { createStubAgent, createStubCardPlatform, createStubPlatform, type RecordedCard, type StubCardPlatform, type StubPlatform } from '../stubs/engine-stubs.ts'
import { Msg } from '../../src/i18n/index.ts'

/** Go stubProviderAgent: a ProviderSwitcher over a static route table. */
function providerAgent(
  providers: string[],
  active: string,
  models: Record<string, string> = {},
): Agent & ProviderSwitcher & {
  calls: Array<{ key: string; name: string }>
  getActive(): string
  overrideOf(key: string): string
} {
  let current = active
  const overrides = new Map<string, string>()
  const calls: Array<{ key: string; name: string }> = []
  return {
    ...createStubAgent(),
    calls,
    getActive: () => current,
    overrideOf: (key: string) => overrides.get(key) ?? '',
    setProviders: () => {},
    setActiveProvider: (name: string) => {
      if (name !== '' && !providers.includes(name)) return false
      current = name
      return true
    },
    setSessionProvider: (key: string, name: string) => {
      calls.push({ key, name })
      if (name === '') {
        overrides.delete(key)
        return true
      }
      if (!providers.includes(name)) return false
      overrides.set(key, name)
      return true
    },
    getActiveProvider: (sessionKey?: string) => {
      const override = sessionKey !== undefined && sessionKey !== '' ? overrides.get(sessionKey) : undefined
      const name = override !== undefined && providers.includes(override) ? override : current
      return name !== '' && providers.includes(name) ? { name } : undefined
    },
    listProviders: () => providers.map(name => ({
      name,
      ...(models[name] !== undefined ? { model: models[name] } : {}),
    })),
  }
}

function msg(overrides: Partial<Message> = {}): Message {
  return {
    sessionKey: 'test:user1',
    platform: 'test',
    messageID: '',
    userID: '',
    userName: '',
    chatName: '',
    chatType: '',
    content: '',
    originalContent: '',
    images: [],
    files: [],
    extraContent: '',
    replyCtx: 'ctx',
    fromVoice: false,
    isSpawnedGroup: false,
    isPermissionAction: false,
    isAskqCardAction: false,
    isCardAction: false,
    parentMessageID: '',
    quotedText: '',
    ...overrides,
  }
}

function newEngine(agent: Agent): { e: Engine; p: StubPlatform; dispose: () => void } {
  const p = createStubPlatform('test')
  const e = new Engine('test', agent, [p], '', 'en')
  const dispose = registerProviderCommands(e)
  return { e, p, dispose }
}

describe('/provider (bare)', () => {
  it('lists providers with the active marker and a switch hint', () => {
    const { e, p, dispose } = newEngine(providerAgent(['openai', 'azure'], 'openai'))

    e.dispatchCommand(p, msg(), '/provider')

    expect(p.getSent().length).toBe(1)
    const text = p.getSent()[0] ?? ''
    expect(text).toContain('openai')
    expect(text).toContain('azure')
    expect(text).toContain('▶')
    expect(text).toContain(e.i18n.t('provider_switch_hint'))
    dispose()
  })

  it('replies not-supported when the agent has no switcher', () => {
    const p = createStubPlatform('test')
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    const dispose = registerProviderCommands(e)

    e.dispatchCommand(p, msg(), '/provider')

    expect(p.getSent()).toEqual([e.i18n.t('provider_not_supported')])
    dispose()
  })
})

describe('/provider switch', () => {
  it('without a name replies the usage line from the i18n catalog', async () => {
    const { e, p, dispose } = newEngine(providerAgent(['openai'], 'openai'))
    try {
      e.dispatchCommand(p, msg({ content: '/provider switch' }), '/provider switch')
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(p.sent[p.sent.length - 1]).toBe(e.i18n.t(Msg.ProviderSwitchUsage))
    } finally {
      dispose()
    }
  })

  it('pins the chat route, resets that session, and leaves other chats alone', async () => {
    const agent = providerAgent(['openai', 'azure'], 'openai')
    const { e, p, dispose } = newEngine(agent)
    const saved: Array<{ key: string; name: string }> = []
    e.setProviderSaveFunc((key, name) => { saved.push({ key, name }) })
    const s = e.sessions.getOrCreateActive('test:user1')
    s.setAgentSessionID('agent-sid-1', 'dsh')
    e.sessions.getOrCreateActive('test:user2').setAgentSessionID('agent-sid-2', 'dsh')

    e.dispatchCommand(p, msg(), '/provider switch azure')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(agent.overrideOf('test:user1')).toBe('azure')
    expect(agent.getActiveProvider('test:user2')?.name).toBe('openai')
    // The project default pointer never moves at runtime.
    expect(agent.getActive()).toBe('openai')
    expect(s.getAgentSessionID()).toBe('')
    expect(e.sessions.getOrCreateActive('test:user2').getAgentSessionID()).toBe('agent-sid-2')
    expect(saved).toEqual([{ key: 'test:user1', name: 'azure' }])
    expect(p.getSent()).toEqual([e.i18n.tf('provider_switched', 'azure')])
    dispose()
  })

  it('keeps the agent session id with --resume', async () => {
    const agent = providerAgent(['openai', 'azure'], 'openai')
    const { e, p, dispose } = newEngine(agent)
    const s = e.sessions.getOrCreateActive('test:user1')
    s.setAgentSessionID('agent-sid-1', 'dsh')

    e.dispatchCommand(p, msg(), '/provider azure --resume')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(agent.overrideOf('test:user1')).toBe('azure')
    expect(s.getAgentSessionID()).toBe('agent-sid-1')
    expect(p.getSent()).toEqual([e.i18n.tf('provider_hot_switched', 'azure')])
    dispose()
  })

  it('replies not-found for an unknown provider', () => {
    const agent = providerAgent(['openai'], 'openai')
    const { e, p, dispose } = newEngine(agent)

    e.dispatchCommand(p, msg(), '/provider switch gcp')

    expect(agent.overrideOf('test:user1')).toBe('')
    expect(agent.getActive()).toBe('openai')
    expect(p.getSent()).toEqual([e.i18n.tf('provider_not_found', 'gcp')])
    dispose()
  })

  it('rejects unknown flags', () => {
    const { e, p, dispose } = newEngine(providerAgent(['openai'], 'openai'))

    e.dispatchCommand(p, msg(), '/provider switch openai --wat')

    expect(p.getSent()).toEqual([e.i18n.tf('provider_unknown_flag', '--wat')])
    dispose()
  })
})

describe('/provider current / clear / list', () => {
  it('reports the active provider', () => {
    const { e, p, dispose } = newEngine(providerAgent(['openai'], 'openai'))

    e.dispatchCommand(p, msg(), '/provider current')

    expect(p.getSent()).toEqual([e.i18n.tf('provider_current', 'openai')])
    dispose()
  })

  it('clears the chat override and resets the session; the project default stays', async () => {
    const agent = providerAgent(['openai', 'azure'], 'openai')
    const { e, p, dispose } = newEngine(agent)
    const saved: Array<{ key: string; name: string }> = []
    e.setProviderSaveFunc((key, name) => { saved.push({ key, name }) })
    expect(agent.setSessionProvider('test:user1', 'azure')).toBe(true)
    const s = e.sessions.getOrCreateActive('test:user1')
    s.setAgentSessionID('agent-sid-1', 'dsh')

    e.dispatchCommand(p, msg(), '/provider clear')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(agent.overrideOf('test:user1')).toBe('')
    expect(agent.getActiveProvider('test:user1')?.name).toBe('openai')
    expect(s.getAgentSessionID()).toBe('')
    expect(saved).toEqual([{ key: 'test:user1', name: '' }])
    expect(p.getSent()).toEqual([e.i18n.t('provider_cleared')])
    dispose()
  })

  it('lists providers on the list subcommand', () => {
    const { e, p, dispose } = newEngine(providerAgent(['openai', 'azure'], 'azure'))

    e.dispatchCommand(p, msg(), '/provider list')

    const text = p.getSent()[0] ?? ''
    expect(text).toContain('openai')
    expect(text).toContain('▶ azure')
    dispose()
  })
})

describe('provider shortcuts', () => {
  it('pins the chat route, rotates to a new session, and persists', async () => {
    const agent = providerAgent(['glm', 'mimo'], 'glm')
    const p = createStubPlatform('test')
    const e = new Engine('test', agent, [p], '', 'en')
    const disposeProvider = registerProviderCommands(e)
    registerSessionCommands(e)
    const saved: Array<{ key: string; name: string }> = []
    e.setProviderSaveFunc((key, name) => { saved.push({ key, name }) })
    e.setProviderShortcuts({ strong: 'glm', weak: 'mimo' })
    const old = e.sessions.getOrCreateActive('test:user1')
    old.setAgentSessionID('agent-sid-1', 'dsh')

    e.dispatchCommand(p, msg(), '/weak')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(agent.overrideOf('test:user1')).toBe('mimo')
    expect(agent.getActive()).toBe('glm')
    expect(saved).toEqual([{ key: 'test:user1', name: 'mimo' }])
    // The old session was rotated off: the active session for the key is a fresh one.
    expect(e.sessions.getOrCreateActive('test:user1')).not.toBe(old)
    expect(p.getSent()).toEqual([e.i18n.tf('provider_shortcut_new', 'mimo')])
    disposeProvider()
  })

  it('does not intercept unknown commands', () => {
    const agent = providerAgent(['glm'], 'glm')
    const { e, p, dispose } = newEngine(agent)
    e.setProviderShortcuts({ strong: 'glm' })

    expect(e.dispatchCommand(p, msg(), '/strongs')).toBe(false)
    expect(p.getSent().length).toBe(0)
    dispose()
  })
})

// ── provider card (Go renderProviderCard + executeCardAction "/provider") ─

/** A card-capable stub platform that records in-place card refreshes. */
interface RefreshingPlatform extends StubCardPlatform {
  refreshed: Array<{ sessionKey: string; card: unknown }>
  refreshCard(sessionKey: string, card: unknown): Promise<void>
}

function newRefreshingCardPlatform(): RefreshingPlatform {
  const base = createStubCardPlatform('test')
  const p: RefreshingPlatform = {
    ...base,
    refreshed: [],
    refreshCard: async (sessionKey: string, card: unknown) => {
      p.refreshed.push({ sessionKey, card })
    },
  }
  return p
}

/** The markdown element contents of a recorded card, in order. */
function cardMarkdowns(card: unknown): string[] {
  return (card as RecordedCard).elements
    .filter(el => el.kind === 'markdown')
    .map(el => el.content ?? '')
}

/** One provider row of a recorded card: left text plus the button fields. */
interface CardRow { text: string; btnText: string; btnType: string; btnValue: string }

function cardRows(card: unknown): CardRow[] {
  return (card as { elements: Array<Record<string, string>> }).elements
    .filter(el => el.kind === 'listItem') as unknown as CardRow[]
}

/** The button rows of a recorded card (kind 'actions' elements). */
function cardActionRows(card: unknown): Array<Array<{ text: string; type: string; value: string }>> {
  return (card as { elements: Array<{ kind: string; buttons?: Array<{ text: string; type: string; value: string }> }> }).elements
    .filter(el => el.kind === 'actions')
    .map(el => el.buttons ?? [])
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
  throw new Error(`timeout waiting for ${what}`)
}

describe('provider card (Go renderProviderCard + card actions)', () => {
  it('bare /provider replies the provider card on card platforms', async () => {
    const agent = providerAgent(['openai', 'azure'], 'openai', { azure: 'gpt-5.2' })
    const p = createStubCardPlatform('test')
    const e = new Engine('test', agent, [p], '', 'en')
    const dispose = registerProviderCommands(e)
    try {
      e.dispatchCommand(p, msg(), '/provider')
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(p.sentCards).toHaveLength(1)
      const card = p.sentCards[0] as RecordedCard
      expect(card.header?.title).toBe(e.i18n.t(Msg.ProviderCardTitle))
      expect(card.header?.color).toBe('indigo')
      expect(cardMarkdowns(card).join('\n')).toContain(e.i18n.tf(Msg.ProviderCardCurrent, 'openai'))
      const rows = cardRows(card)
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({ text: '▶ **openai**', btnValue: 'act:/provider openai -r', btnType: 'primary' })
      expect(rows[1]).toMatchObject({ text: '◻ **azure**  `gpt-5.2`', btnValue: 'act:/provider azure -r', btnType: 'default' })
      // Mode row first: hot selected by default, hot button leftmost.
      expect(cardActionRows(card)[0]).toEqual([
        { text: e.i18n.t(Msg.ProviderCardModeHot), type: 'primary', value: 'nav:/provider -r' },
        { text: e.i18n.t(Msg.ProviderCardModePlain), type: 'default', value: 'nav:/provider' },
      ])
      // The card replaces the plain-text listing entirely.
      expect(p.getSent()).toEqual([])
    } finally {
      dispose()
    }
  })

  it('a pressed row switches the route and refreshes the pressed card in place', async () => {
    const agent = providerAgent(['openai', 'azure'], 'openai')
    const p = newRefreshingCardPlatform()
    const e = new Engine('test', agent, [p], '', 'en')
    const dispose = registerProviderCommands(e)
    try {
      const saved: Array<{ key: string; name: string }> = []
      e.setProviderSaveFunc((key, name) => { saved.push({ key, name }) })
      const s = e.sessions.getOrCreateActive('test:user1')
      s.setAgentSessionID('agent-sid-1', 'dsh')

      e.receiveMessage(p, { ...msg(), content: 'act:/provider azure', isCardAction: true })
      await waitFor(() => p.refreshed.length === 1, 'refreshCard')

      expect(agent.overrideOf('test:user1')).toBe('azure')
      expect(agent.getActive()).toBe('openai')
      expect(s.getAgentSessionID()).toBe('')
      expect(saved).toEqual([{ key: 'test:user1', name: 'azure' }])
      const card = p.refreshed[0]!.card
      expect(cardMarkdowns(card).join('\n')).toContain(e.i18n.tf(Msg.ProviderSwitched, 'azure'))
      const rows = cardRows(card)
      expect(rows[0]).toMatchObject({ text: '◻ **openai**', btnType: 'default' })
      expect(rows[1]).toMatchObject({ text: '▶ **azure**', btnType: 'primary' })
      // A card action never starts an agent turn nor sends a new card.
      expect(p.getSent()).toEqual([])
      expect(p.sentCards).toEqual([])
    } finally {
      dispose()
    }
  })

  it('nav:/provider -r renders the hot-switch mode without switching', async () => {
    const agent = providerAgent(['openai', 'azure'], 'openai')
    const p = newRefreshingCardPlatform()
    const e = new Engine('test', agent, [p], '', 'en')
    const dispose = registerProviderCommands(e)
    try {
      e.receiveMessage(p, { ...msg(), content: 'nav:/provider -r', isCardAction: true })
      await waitFor(() => p.refreshed.length === 1, 'refreshCard')

      expect(agent.getActive()).toBe('openai')
      const card = p.refreshed[0]!.card
      const rows = cardRows(card)
      expect(rows[0]).toMatchObject({ text: '▶ **openai**', btnText: e.i18n.t(Msg.ProviderCardHotBtn), btnValue: 'act:/provider openai -r' })
      expect(rows[1]).toMatchObject({ text: '◻ **azure**', btnValue: 'act:/provider azure -r' })
      // Hot mode is the selected one in the mode row, with the hot button leftmost.
      expect(cardActionRows(card)[0]).toEqual([
        { text: e.i18n.t(Msg.ProviderCardModeHot), type: 'primary', value: 'nav:/provider -r' },
        { text: e.i18n.t(Msg.ProviderCardModePlain), type: 'default', value: 'nav:/provider' },
      ])
    } finally {
      dispose()
    }
  })

  it('a pressed hot row hot-switches keeping the agent session id', async () => {
    const agent = providerAgent(['openai', 'azure'], 'openai')
    const p = newRefreshingCardPlatform()
    const e = new Engine('test', agent, [p], '', 'en')
    const dispose = registerProviderCommands(e)
    try {
      const s = e.sessions.getOrCreateActive('test:user1')
      s.setAgentSessionID('agent-sid-1', 'dsh')

      e.receiveMessage(p, { ...msg(), content: 'act:/provider azure -r', isCardAction: true })
      await waitFor(() => p.refreshed.length === 1, 'refreshCard')

      expect(agent.overrideOf('test:user1')).toBe('azure')
      expect(agent.getActive()).toBe('openai')
      // --resume semantics: the transcript survives, the route does not.
      expect(s.getAgentSessionID()).toBe('agent-sid-1')
      const card = p.refreshed[0]!.card
      expect(cardMarkdowns(card).join('\n')).toContain(e.i18n.tf(Msg.ProviderHotSwitched, 'azure'))
      // The refreshed card stays in hot mode for further hot switches.
      expect(cardRows(card)[1]).toMatchObject({ btnValue: 'act:/provider azure -r' })
    } finally {
      dispose()
    }
  })

  it('an unknown route on a stale card shows the not-found notice without switching', async () => {
    const agent = providerAgent(['openai'], 'openai')
    const p = newRefreshingCardPlatform()
    const e = new Engine('test', agent, [p], '', 'en')
    const dispose = registerProviderCommands(e)
    try {
      e.receiveMessage(p, { ...msg(), content: 'act:/provider gcp', isCardAction: true })
      await waitFor(() => p.refreshed.length === 1, 'refreshCard')

      expect(agent.getActive()).toBe('openai')
      expect(cardMarkdowns(p.refreshed[0]!.card).join('\n')).toContain(e.i18n.tf(Msg.ProviderNotFound, 'gcp'))
    } finally {
      dispose()
    }
  })

  it('nav:/provider re-renders the card without switching', async () => {
    const agent = providerAgent(['openai', 'azure'], 'openai')
    const p = newRefreshingCardPlatform()
    const e = new Engine('test', agent, [p], '', 'en')
    const dispose = registerProviderCommands(e)
    try {
      e.receiveMessage(p, { ...msg(), content: 'nav:/provider', isCardAction: true })
      await waitFor(() => p.refreshed.length === 1, 'refreshCard')

      expect(agent.getActive()).toBe('openai')
      // Current line + hint only: no switch notice markdown.
      expect(cardMarkdowns(p.refreshed[0]!.card)).toHaveLength(2)
    } finally {
      dispose()
    }
  })

  it('dispose removes the card action; presses fall through without effects', async () => {
    const agent = providerAgent(['openai', 'azure'], 'openai')
    const p = newRefreshingCardPlatform()
    const e = new Engine('test', agent, [p], '', 'en')
    const dispose = registerProviderCommands(e)
    dispose()

    e.receiveMessage(p, { ...msg(), content: 'act:/provider azure', isCardAction: true })
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(agent.getActive()).toBe('openai')
    expect(p.refreshed).toEqual([])
    expect(p.sentCards).toEqual([])
    expect(p.getSent()).toEqual([])
  })
})

// ── usage provider gating (the ⌛ quota line follows the chat's route) ─────

/** Detector usage provider gating its summary on the effective route name passed per turn. */
function detectorUsageProvider(match: (activeName: string) => boolean, summary = 'wk: 84%(9%)'): UsageProvider & {
  isActive(workDir: string, activeName: string): boolean
  fetchSummary(): Promise<string>
} {
  return {
    name: () => 'det',
    summary: () => summary,
    refresh: () => {},
    isActive: (_workDir: string, activeName: string) => match(activeName),
    fetchSummary: async () => summary,
  }
}

/** Turn accounting with all token counters zeroed (usage line only). */
const zeroTurn = {
  totalInputTokens: 0, sdkPlausible: false, selfPct: 0,
  nonCachedDelta: 0, nonCachedCum: 0, cachedDelta: 0, cachedCum: 0,
  numTurns: 0, compactionCount: 0,
}

describe('usage provider gating (the ⌛ quota line follows the chat\'s route)', () => {
  it('gates the ⌛ line on the session route, not the project default', async () => {
    const agent = providerAgent(['glm', 'minimax'], 'glm')
    const { e, dispose } = newEngine(agent)
    e.setUsageProviders([detectorUsageProvider(name => name.startsWith('glm'))])
    // Chat b pins minimax; chat a stays on the project default (glm).
    expect(agent.setSessionProvider('test:b', 'minimax')).toBe(true)

    await e.buildCompletionUsage(zeroTurn, 'test:b')
    expect(e.usage.providerMsg).toBe('')

    await e.buildCompletionUsage(zeroTurn, 'test:a')
    expect(e.usage.providerMsg).toBe('💰 wk: 84%(9%)')
    dispose()
  })
})
