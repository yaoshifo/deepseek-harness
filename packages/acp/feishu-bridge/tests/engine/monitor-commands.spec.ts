/**
 * `/monitor` command-family tests ported 1:1 from cc-connect
 * core/engine_monitor_cmd_test.go: chat-list algebra, add/off/list/usage
 * subcommands, runtime mode switching with dispatch-hub branding (including
 * the startup branding from setConfig), save-failure rollback, command
 * registration/disposal, and isMonitorCommand. Async branding paths get a
 * short wait.
 *
 * @module dsh-feishu-bridge/tests-engine-monitor-commands
 */

import { describe, expect, it } from 'vitest'
import { Engine } from '../../src/engine/engine.js'
import { cmdMonitor, registerMonitorCommands } from '../../src/engine/monitor-commands.js'
import { addMonitorChat, containsMonitorChat, isMonitorCommand, removeMonitorChat, splitMonitorChats } from '../../src/engine/monitor.js'
import { registerSessionCommands } from '../../src/engine/commands.js'
import type { Message } from '../../src/core/types.js'
import { createStubAgent, createStubPlatform, newStubMessage, type StubPlatform } from '../stubs/engine-stubs.js'

/** One macrotask tick: flushes the microtask chain behind fire-and-forget sends. */
async function settle(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

/** stub stubMonitorChatPlatform: records SetMonitorChats pushes + BrandChat calls. */
interface BrandCall {
  sessionKey: string
  name: string
  icon: string
}

type MonitorChatPlatform = StubPlatform & {
  setChatsCalls: string[]
  brandCalls: BrandCall[]
  setMonitorChats(chats: string): void
  setMonitorFallbackUser(id: string): void
  brandChat(sessionKey: string, groupName: string, iconName: string): Promise<void>
}

function stubMonitorChatPlatform(): MonitorChatPlatform {
  const base = createStubPlatform('feishu')
  const p: MonitorChatPlatform = {
    ...base,
    setChatsCalls: [],
    brandCalls: [],
    setMonitorChats: (chats: string) => {
      p.setChatsCalls.push(chats)
    },
    setMonitorFallbackUser: (_id: string) => {},
    brandChat: async (sessionKey: string, groupName: string, iconName: string) => {
      p.brandCalls.push({ sessionKey, name: groupName, icon: iconName })
    },
  }
  return p
}

function newCmdMonitorEngine(chats: string): { e: Engine; p: MonitorChatPlatform } {
  const p = stubMonitorChatPlatform()
  const e = new Engine('test', createStubAgent(), [p], '', 'en')
  e.monitor.enabled = true
  e.monitor.setChats(chats)
  return { e, p }
}

function monitorMsg(chatID: string): Message {
  return { ...newStubMessage(), sessionKey: `feishu:${chatID}:ou_user`, platform: 'feishu', chatType: 'group', userID: 'ou_user' }
}

function sentHas(lines: string[], sub: string): boolean {
  return lines.some(l => l.includes(sub))
}

async function waitForBrand(p: MonitorChatPlatform, n: number, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (p.brandCalls.length >= n) return
    await settle()
  }
  throw new Error(`timed out waiting for ${n} BrandChat calls; got ${p.brandCalls.length}`)
}

describe('split/add/remove/contains monitor chat', () => {
  it('splits, adds idempotently, removes, contains', () => {
    expect(splitMonitorChats('')).toHaveLength(0)
    expect(splitMonitorChats(' oc_a , oc_b , oc_a ')).toEqual(['oc_a', 'oc_b'])
    expect(splitMonitorChats('*')).toEqual(['*'])

    expect(addMonitorChat('', 'oc_x')).toBe('oc_x')
    expect(addMonitorChat('*', 'oc_x')).toBe('oc_x')
    expect(addMonitorChat('oc_a', 'oc_a')).toBe('oc_a')
    expect(addMonitorChat('oc_a', 'oc_b')).toBe('oc_a,oc_b')

    expect(removeMonitorChat('oc_a,oc_b', 'oc_a')).toBe('oc_b')
    expect(removeMonitorChat('oc_a', 'oc_a')).toBe('')
    expect(removeMonitorChat('oc_a', 'oc_x')).toBe('oc_a')

    expect(containsMonitorChat('oc_a,oc_b', 'oc_a')).toBe(true)
    expect(containsMonitorChat('oc_a', 'oc_b')).toBe(false)
  })
})

describe('cmdMonitor add/off/list', () => {
  it('adds the current chat, persists, and pushes to the platform', async () => {
    const { e, p } = newCmdMonitorEngine('oc_a')
    let saved = ''
    e.monitor.saveChats = (c: string) => { saved = c }

    await cmdMonitor(e, p, monitorMsg('oc_b'), [])

    expect(sentHas(p.getSent(), 'now monitored')).toBe(true)
    expect(e.monitor.chatsVal()).toBe('oc_a,oc_b')
    expect(saved).toBe('oc_a,oc_b')
    expect(p.setChatsCalls).toEqual(['oc_a,oc_b'])
  })

  it('brands the chat when adding in dispatch mode', async () => {
    const { e, p } = newCmdMonitorEngine('oc_a')
    e.monitor.setMode('dispatch')
    e.monitor.saveChats = () => {}

    await cmdMonitor(e, p, monitorMsg('oc_b'), [])
    await waitForBrand(p, 1)

    const b = p.brandCalls[p.brandCalls.length - 1]
    expect(b?.name).toBe('Mailroom')
    expect(b?.icon).toBe('trending-up-down')
    expect(b?.sessionKey).toBe('feishu:oc_b:ou_user')
  })

  it('does not brand when adding in monitor mode', async () => {
    const { e, p } = newCmdMonitorEngine('oc_a')
    e.monitor.setMode('monitor')
    e.monitor.saveChats = () => {}

    await cmdMonitor(e, p, monitorMsg('oc_b'), [])
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(p.brandCalls).toHaveLength(0)
  })

  it('replies already for a chat already monitored', async () => {
    const { e, p } = newCmdMonitorEngine('oc_a')
    e.monitor.saveChats = () => { throw new Error('should not save') }

    await cmdMonitor(e, p, monitorMsg('oc_a'), [])

    expect(sentHas(p.getSent(), 'already monitored')).toBe(true)
    expect(e.monitor.chatsVal()).toBe('oc_a')
  })

  it('replies star-mode when chats = *', async () => {
    const { e, p } = newCmdMonitorEngine('*')
    e.monitor.saveChats = () => { throw new Error('should not save') }

    await cmdMonitor(e, p, monitorMsg('oc_b'), [])

    expect(sentHas(p.getSent(), 'all-groups mode')).toBe(true)
    expect(e.monitor.chatsVal()).toBe('*')
  })

  it('removes the current chat', async () => {
    const { e, p } = newCmdMonitorEngine('oc_a,oc_b')
    e.monitor.saveChats = () => {}

    await cmdMonitor(e, p, monitorMsg('oc_a'), ['off'])

    expect(sentHas(p.getSent(), 'no longer monitored')).toBe(true)
    expect(e.monitor.chatsVal()).toBe('oc_b')
  })

  it('replies not-in-list when removing an absent chat', async () => {
    const { e, p } = newCmdMonitorEngine('oc_a')
    e.monitor.saveChats = () => { throw new Error('should not save') }

    await cmdMonitor(e, p, monitorMsg('oc_x'), ['off'])

    expect(sentHas(p.getSent(), 'not in the monitor list')).toBe(true)
    expect(e.monitor.chatsVal()).toBe('oc_a')
  })

  it('lists the monitored chats', async () => {
    const { e, p } = newCmdMonitorEngine('oc_a,oc_b')
    await cmdMonitor(e, p, monitorMsg('oc_a'), ['list'])
    const sent = p.getSent()
    expect(sentHas(sent, 'Monitored chats')).toBe(true)
    expect(sentHas(sent, 'oc_a')).toBe(true)
    expect(sentHas(sent, 'oc_b')).toBe(true)
  })

  it('replies empty for an empty list', async () => {
    const { e, p } = newCmdMonitorEngine('')
    await cmdMonitor(e, p, monitorMsg('oc_a'), ['list'])
    expect(sentHas(p.getSent(), 'No chats monitored')).toBe(true)
  })

  it('replies disabled when monitor is off', async () => {
    const { e, p } = newCmdMonitorEngine('')
    e.monitor.enabled = false
    await cmdMonitor(e, p, monitorMsg('oc_a'), [])
    expect(sentHas(p.getSent(), 'not enabled')).toBe(true)
  })

  it('replies usage for a bogus subcommand', async () => {
    const { e, p } = newCmdMonitorEngine('oc_a')
    await cmdMonitor(e, p, monitorMsg('oc_a'), ['bogus'])
    expect(sentHas(p.getSent(), 'Usage:')).toBe(true)
  })

  it('rejects p2p chats', async () => {
    const { e, p } = newCmdMonitorEngine('oc_a')
    const msg: Message = { ...newStubMessage(), sessionKey: 'feishu:ou_user', platform: 'feishu', chatType: 'p2p' }
    await cmdMonitor(e, p, msg, [])
    expect(sentHas(p.getSent(), 'inside the group')).toBe(true)
    expect(e.monitor.chatsVal()).toBe('oc_a')
  })

  it('rolls back memory when saving fails', async () => {
    const { e, p } = newCmdMonitorEngine('oc_a')
    e.monitor.saveChats = () => { throw new Error('monitor save sentinel failure') }

    await cmdMonitor(e, p, monitorMsg('oc_b'), [])

    expect(sentHas(p.getSent(), 'Failed to save')).toBe(true)
    expect(e.monitor.chatsVal()).toBe('oc_a')
  })
})

describe('cmdMonitor mode', () => {
  it('shows the current mode', async () => {
    const { e, p } = newCmdMonitorEngine('oc_a')
    e.monitor.setMode('dispatch')
    await cmdMonitor(e, p, monitorMsg('oc_a'), ['mode'])
    const sent = p.getSent()
    expect(sentHas(sent, 'Monitor mode:')).toBe(true)
    expect(sentHas(sent, 'dispatch')).toBe(true)
  })

  it('shows an empty mode as monitor', async () => {
    const { e, p } = newCmdMonitorEngine('oc_a')
    e.monitor.setMode('')
    await cmdMonitor(e, p, monitorMsg('oc_a'), ['mode'])
    expect(sentHas(p.getSent(), 'monitor')).toBe(true)
  })

  it('switches to dispatch and persists', async () => {
    const { e, p } = newCmdMonitorEngine('oc_a')
    e.monitor.setMode('')
    e.monitor.dirs = [{ path: '/tmp/x', description: 'x' }]
    let saved = ''
    e.monitor.saveMode = (m: string) => { saved = m }

    await cmdMonitor(e, p, monitorMsg('oc_a'), ['mode', 'dispatch'])

    expect(e.monitor.modeVal()).toBe('dispatch')
    expect(saved).toBe('dispatch')
    expect(sentHas(p.getSent(), 'switched to')).toBe(true)
  })

  it('switches to monitor and persists', async () => {
    const { e, p } = newCmdMonitorEngine('oc_a')
    e.monitor.setMode('dispatch')
    let saved = ''
    e.monitor.saveMode = (m: string) => { saved = m }

    await cmdMonitor(e, p, monitorMsg('oc_a'), ['mode', 'monitor'])

    expect(e.monitor.modeVal()).toBe('monitor')
    expect(saved).toBe('monitor')
  })

  it('normalizes case', async () => {
    const { e, p } = newCmdMonitorEngine('oc_a')
    e.monitor.dirs = [{ path: '/tmp/x', description: 'x' }]
    e.monitor.saveMode = () => {}

    await cmdMonitor(e, p, monitorMsg('oc_a'), ['mode', 'DISPATCH'])

    expect(e.monitor.modeVal()).toBe('dispatch')
  })

  it('rejects an invalid mode without saving', async () => {
    const { e, p } = newCmdMonitorEngine('oc_a')
    e.monitor.setMode('dispatch')
    e.monitor.saveMode = () => { throw new Error('should not save') }

    await cmdMonitor(e, p, monitorMsg('oc_a'), ['mode', 'xyz'])

    expect(e.monitor.modeVal()).toBe('dispatch')
    expect(sentHas(p.getSent(), 'Invalid mode')).toBe(true)
  })

  it('rolls back the mode when saving fails', async () => {
    const { e, p } = newCmdMonitorEngine('oc_a')
    e.monitor.setMode('monitor')
    e.monitor.saveMode = () => { throw new Error('monitor save sentinel failure') }

    await cmdMonitor(e, p, monitorMsg('oc_a'), ['mode', 'dispatch'])

    expect(e.monitor.modeVal()).toBe('monitor')
    expect(sentHas(p.getSent(), 'Failed to save')).toBe(true)
  })

  it('brands the hub when switching to dispatch', async () => {
    const { e, p } = newCmdMonitorEngine('oc_hub')
    e.monitor.saveMode = () => {}

    await cmdMonitor(e, p, monitorMsg('oc_hub'), ['mode', 'dispatch'])
    await waitForBrand(p, 1)

    const b = p.brandCalls[p.brandCalls.length - 1]
    expect(b?.sessionKey).toBe('feishu:oc_hub:ou_user')
    expect(b?.icon).toBe('trending-up-down')
  })

  it('adds and brands the current chat when switching to dispatch outside the list', async () => {
    const { e, p } = newCmdMonitorEngine('oc_a')
    e.monitor.saveMode = () => {}
    e.monitor.saveChats = () => {}

    await cmdMonitor(e, p, monitorMsg('oc_b'), ['mode', 'dispatch'])

    expect(sentHas(p.getSent(), 'dispatch hub')).toBe(true)
    expect(containsMonitorChat(e.monitor.chatsVal(), 'oc_b')).toBe(true)
    await waitForBrand(p, 1)
    const b = p.brandCalls[p.brandCalls.length - 1]
    expect(b?.sessionKey).toBe('feishu:oc_b:ou_user')
    expect(b?.icon).toBe('trending-up-down')
  })

  it('p2p mode switch only switches the mode', async () => {
    const { e, p } = newCmdMonitorEngine('')
    e.monitor.saveMode = () => {}
    e.monitor.saveChats = () => { throw new Error('should not add chat in p2p') }

    const msg: Message = { ...newStubMessage(), sessionKey: 'feishu:ou_user', platform: 'feishu', chatType: 'p2p' }
    await cmdMonitor(e, p, msg, ['mode', 'dispatch'])

    expect(sentHas(p.getSent(), 'switched to')).toBe(true)
    expect(sentHas(p.getSent(), 'dispatch hub')).toBe(false)
    await new Promise((resolve) => { setTimeout(resolve, 30) })
    expect(p.brandCalls).toHaveLength(0)
  })

  it('warns about missing dirs when switching to dispatch', async () => {
    const { e, p } = newCmdMonitorEngine('oc_a')
    e.monitor.setMode('')
    e.monitor.dirs = []
    e.monitor.saveMode = () => {}

    await cmdMonitor(e, p, monitorMsg('oc_a'), ['mode', 'dispatch'])

    expect(e.monitor.modeVal()).toBe('dispatch')
    expect(sentHas(p.getSent(), 'No `dirs` configured')).toBe(true)
  })

  it('does not warn about dirs when they are configured', async () => {
    const { e, p } = newCmdMonitorEngine('oc_a')
    e.monitor.setMode('')
    e.monitor.dirs = [{ path: '/tmp/x', description: 'x' }]
    e.monitor.saveMode = () => {}

    await cmdMonitor(e, p, monitorMsg('oc_a'), ['mode', 'dispatch'])

    expect(sentHas(p.getSent(), 'No `dirs` configured')).toBe(false)
  })

  it('shows the current mode with a bare "mode" arg', async () => {
    const { e, p } = newCmdMonitorEngine('oc_a')
    e.monitor.setMode('monitor')
    await cmdMonitor(e, p, monitorMsg('oc_a'), ['mode'])
    expect(sentHas(p.getSent(), 'Monitor mode:')).toBe(true)
  })
})

describe('setConfig startup branding', () => {
  it('brands every configured chat in dispatch mode at startup', async () => {
    const { e, p } = newCmdMonitorEngine('')
    e.monitor.setConfig({
      enabled: true, chats: 'oc_a,oc_b', contextWindow: 0, spawnNotice: false, maxConcurrent: 0,
      triageProvider: '', triagePrompt: '', dirs: [], rules: [], learnEnabled: false, learnMax: 0,
      reactEmoji: '', pollIntervalMs: 0, fallbackUser: '', examples: undefined, mode: 'dispatch',
    })
    await waitForBrand(p, 2)
    const seen = new Set(p.brandCalls.map(c => c.sessionKey))
    expect(seen.has('feishu:oc_a')).toBe(true)
    expect(seen.has('feishu:oc_b')).toBe(true)
    for (const c of p.brandCalls) {
      expect(c.icon).toBe('trending-up-down')
      expect(c.name).toBe('Mailroom')
    }
  })

  it('does not brand in monitor mode at startup', async () => {
    const { e, p } = newCmdMonitorEngine('')
    e.monitor.setConfig({
      enabled: true, chats: 'oc_a,oc_b', contextWindow: 0, spawnNotice: false, maxConcurrent: 0,
      triageProvider: '', triagePrompt: '', dirs: [], rules: [], learnEnabled: false, learnMax: 0,
      reactEmoji: '', pollIntervalMs: 0, fallbackUser: '', examples: undefined, mode: 'monitor',
    })
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(p.brandCalls).toHaveLength(0)
  })
})

describe('registerMonitorCommands', () => {
  it('merges into the session command table and dispatches /monitor', async () => {
    const { e, p } = newCmdMonitorEngine('oc_a')
    // /monitor is privileged (Go privilegedCommands): allow the stub user.
    e.setAdminFrom('*')
    const disposeSession = registerSessionCommands(e)
    const disposeMonitor = registerMonitorCommands(e)
    try {
      expect(e.commandHandlers?.get('monitor')).toBeDefined()
      expect(e.commandHandlers?.get('new')).toBeDefined()

      expect(e.dispatchCommand(p, { ...monitorMsg('oc_b'), content: '/monitor' }, '/monitor')).toBe(true)
      await settle()
      expect(sentHas(p.getSent(), 'now monitored')).toBe(true)
      expect(e.monitor.chatsVal()).toBe('oc_a,oc_b')

      expect(e.dispatchCommand(p, { ...monitorMsg('oc_x'), content: '/mon list' }, '/mon list')).toBe(true)
    } finally {
      disposeMonitor()
      disposeSession()
    }
  })

  it('disposes cleanly', () => {
    const { e } = newCmdMonitorEngine('oc_a')
    const dispose = registerMonitorCommands(e)
    dispose()
    expect(e.commandHandlers?.get('monitor')).toBeUndefined()
    expect(e.commandResolver?.('monitor') ?? '').toBe('')
  })
})

describe('isMonitorCommand', () => {
  it('matches the exact command word only', () => {
    const cases: Array<[string, boolean]> = [
      ['/monitor', true],
      ['/monitor off', true],
      [' /monitor ', true],
      ['/monitoring', false],
      ['/mon', false],
      ['hello', false],
      ['', false],
    ]
    for (const [input, want] of cases) {
      expect(isMonitorCommand(input)).toBe(want)
    }
  })
})
