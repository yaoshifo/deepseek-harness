/**
 * Ported from cc-connect core/engine_provider.go + the provider sections of
 * engine_test.go (#9 全局 Providers / #12 切换): the /provider command family
 * (list/switch/current/clear) and the provider_shortcuts quick commands
 * (/strong → provider + new session). The add/remove/preset flows are not
 * ported — a provider is a named llm route in the profile config, which the
 * runtime cannot create.
 *
 * @module dsh-feishu-bridge/tests-provider-commands
 */

import { describe, expect, it } from 'vitest'
import { Engine } from '../../src/engine/engine.js'
import { registerProviderCommands } from '../../src/engine/provider-commands.js'
import { registerSessionCommands } from '../../src/engine/commands.js'
import type { Agent, Message } from '../../src/core/types.js'
import { createStubAgent, createStubPlatform, type StubPlatform } from '../stubs/engine-stubs.js'

/** Go stubProviderAgent: a ProviderSwitcher over a static route table. */
function providerAgent(providers: string[], active: string): Agent & {
  calls: string[]
  getActive(): string
} {
  let current = active
  const calls: string[] = []
  return {
    ...createStubAgent(),
    calls,
    getActive: () => current,
    setProviders: () => {},
    setActiveProvider: (name: string) => {
      calls.push(name)
      if (name !== '' && !providers.includes(name)) return false
      current = name
      return true
    },
    getActiveProvider: () => (current !== '' ? { name: current } : undefined),
    listProviders: () => providers.map(name => ({ name })),
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
  it('switches the active provider and resets the session', async () => {
    const agent = providerAgent(['openai', 'azure'], 'openai')
    const { e, p, dispose } = newEngine(agent)
    const saved: string[] = []
    e.setProviderSaveFunc((name) => { saved.push(name) })
    const s = e.sessions.getOrCreateActive('test:user1')
    s.setAgentSessionID('agent-sid-1', 'dsh')
    s.addHistory('user', 'hello')

    e.dispatchCommand(p, msg(), '/provider switch azure')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(agent.getActive()).toBe('azure')
    expect(s.getAgentSessionID()).toBe('')
    expect(s.getHistory(0).length).toBe(0)
    expect(saved).toEqual(['azure'])
    expect(p.getSent()).toEqual([e.i18n.tf('provider_switched', 'azure')])
    dispose()
  })

  it('keeps the agent session id with --resume', async () => {
    const agent = providerAgent(['openai', 'azure'], 'openai')
    const { e, p, dispose } = newEngine(agent)
    const s = e.sessions.getOrCreateActive('test:user1')
    s.setAgentSessionID('agent-sid-1', 'dsh')
    s.addHistory('user', 'hello')

    e.dispatchCommand(p, msg(), '/provider azure --resume')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(agent.getActive()).toBe('azure')
    expect(s.getAgentSessionID()).toBe('agent-sid-1')
    expect(s.getHistory(0).length).toBe(1)
    expect(p.getSent()).toEqual([e.i18n.tf('provider_hot_switched', 'azure')])
    dispose()
  })

  it('replies not-found for an unknown provider', () => {
    const agent = providerAgent(['openai'], 'openai')
    const { e, p, dispose } = newEngine(agent)

    e.dispatchCommand(p, msg(), '/provider switch gcp')

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

  it('clears the active provider and resets the session', async () => {
    const agent = providerAgent(['openai', 'azure'], 'openai')
    const { e, p, dispose } = newEngine(agent)
    const saved: string[] = []
    e.setProviderSaveFunc((name) => { saved.push(name) })
    const s = e.sessions.getOrCreateActive('test:user1')
    s.setAgentSessionID('agent-sid-1', 'dsh')
    s.addHistory('user', 'hello')

    e.dispatchCommand(p, msg(), '/provider clear')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(agent.getActive()).toBe('')
    expect(s.getAgentSessionID()).toBe('')
    expect(s.getHistory(0).length).toBe(0)
    expect(saved).toEqual([''])
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
  it('switches the provider, rotates to a new session, and persists', async () => {
    const agent = providerAgent(['glm', 'mimo'], 'glm')
    const p = createStubPlatform('test')
    const e = new Engine('test', agent, [p], '', 'en')
    const disposeProvider = registerProviderCommands(e)
    registerSessionCommands(e)
    const saved: string[] = []
    e.setProviderSaveFunc((name) => { saved.push(name) })
    e.setProviderShortcuts({ strong: 'glm', weak: 'mimo' })
    const old = e.sessions.getOrCreateActive('test:user1')
    old.setAgentSessionID('agent-sid-1', 'dsh')
    old.addHistory('user', 'hello')

    e.dispatchCommand(p, msg(), '/weak')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(agent.getActive()).toBe('mimo')
    expect(saved).toEqual(['mimo'])
    // The old session was rotated off: its history is cleared and the
    // active session for the key is a fresh one.
    expect(old.getHistory(0).length).toBe(0)
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
