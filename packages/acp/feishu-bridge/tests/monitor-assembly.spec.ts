/**
 * M6b monitor assembly wiring tests: the [projects.monitor] config block must
 * reach the engine's MonitorCore with the Go defaults (spawn_notice,
 * max_concurrent, learn, react emoji, poll interval, coalescing), compile
 * deterministic rules (skipping invalid patterns), register the /monitor
 * command family without disturbing the session commands, persist runtime
 * /monitor edits through the project state store, and push the chat set to
 * the Feishu platform (MonitorChatConfigurable). Mirrors
 * tests/cron-relay-assembly.spec.ts.
 *
 * @module dsh-feishu-bridge/tests-monitor-assembly
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildProjectAssembly, type FeishuBridgeConfig, type ProjectConfig } from '../src/index.js'
import { ProjectStateStore } from '../src/engine/project-state.js'
import { newStubMessage, type StubPlatform, createStubPlatform } from './stubs/engine-stubs.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'fb-monasm-'))
}

function stubContext(): Parameters<typeof buildProjectAssembly>[0] {
  return {
    agents: {},
    on: () => () => {},
    get: () => undefined,
    logger: { error: () => {} },
    effect: () => () => {},
  } as unknown as Parameters<typeof buildProjectAssembly>[0]
}

function baseConfig(): FeishuBridgeConfig {
  return {
    projects: [],
    providers: {
      'mify-dsh': { route: 'mify-dsh', model: 'glm-5.2' },
    },
  }
}

function project(monitor?: ProjectConfig['monitor']): ProjectConfig {
  return {
    name: 'smoke-project',
    workdir: '/workspace/project',
    feishu: { appId: 'cli_test', appSecret: 'sec' },
    ...(monitor !== undefined ? { monitor } : {}),
  }
}

describe('buildProjectAssembly monitor wiring', () => {
  it('wires the config block with Go defaults, registers /monitor, and pushes chats to the platform', () => {
    const root = tempDir()
    const { engine, platform } = buildProjectAssembly(stubContext(), baseConfig(), project({
      enabled: true,
      chats: 'oc_monitor',
      triageProvider: 'mify-dsh',
      fallbackUser: 'ou_op',
      mode: 'monitor',
      dirs: [{ path: '/ws/riskai', description: '风控' }],
      rules: [{ pattern: 'panic|500', dir: '/ws/riskai', task: '排查：{{message}}' }],
    }), root)

    expect(engine.monitor.enabled).toBe(true)
    expect(engine.monitor.chatsVal()).toBe('oc_monitor')
    expect(engine.monitor.modeVal()).toBe('monitor')
    expect(engine.monitor.triageProvider).toBe('mify-dsh')
    expect(engine.monitor.spawnNotice).toBe(true)
    expect(engine.monitor.maxConcurrent).toBe(5)
    expect(engine.monitor.learnEnabled).toBe(true)
    expect(engine.monitor.learnMax).toBe(20)
    expect(engine.monitor.reactEmoji).toBe('Get')
    expect(engine.monitor.pollIntervalMs).toBe(30_000)
    expect(engine.monitor.dirs).toEqual([{ path: '/ws/riskai', description: '风控' }])
    expect(engine.monitor.rules).toHaveLength(1)
    expect(engine.monitor.rules[0]?.pattern.source).toBe('panic|500')
    expect(engine.monitor.rules[0]?.task).toBe('排查：{{message}}')
    expect(engine.monitor.coalesceEnabled).toBe(true)
    expect(engine.monitor.coalesceWindowMs).toBe(300_000)
    // /monitor registered alongside the session commands; /learn stays a
    // monitor-path-only command.
    expect(engine.commandHandlers?.get('monitor')).toBeDefined()
    expect(engine.commandHandlers?.get('new')).toBeDefined()
    expect(engine.commandHandlers?.get('learn')).toBeUndefined()
    // The platform received the chat set + fallback user push (setConfig ran
    // during assembly); a later runtime edit pushes through the same path.
    const setChats = vi.spyOn(platform, 'setMonitorChats')
    engine.monitor.persistAndApplyMonitorChats('oc_x')
    expect(setChats).toHaveBeenCalledWith('oc_x')
    setChats.mockRestore()
  })

  it('skips invalid rule patterns and applies explicit overrides', () => {
    const root = tempDir()
    const { engine } = buildProjectAssembly(stubContext(), baseConfig(), project({
      enabled: true,
      chats: 'oc_m',
      spawnNotice: false,
      maxConcurrent: 2,
      learnEnabled: false,
      learnMaxExamples: 3,
      reactEmoji: 'none',
      pollIntervalSec: 0,
      coalesceEnabled: false,
      coalesceWindowSec: 60,
      rules: [
        { pattern: 'ok', dir: '/a' },
        { pattern: '([unclosed', dir: '/b' },
      ],
    }), root)

    expect(engine.monitor.rules).toHaveLength(1)
    expect(engine.monitor.rules[0]?.dir).toBe('/a')
    expect(engine.monitor.spawnNotice).toBe(false)
    expect(engine.monitor.maxConcurrent).toBe(2)
    expect(engine.monitor.learnEnabled).toBe(false)
    expect(engine.monitor.learnMax).toBe(3)
    expect(engine.monitor.reactEmoji).toBe('')
    expect(engine.monitor.pollIntervalMs).toBe(0)
    expect(engine.monitor.coalesceEnabled).toBe(false)
    expect(engine.monitor.coalesceWindowMs).toBe(60_000)
  })

  it('leaves the domain off without a monitor block but keeps /monitor replying disabled', () => {
    const root = tempDir()
    const { engine } = buildProjectAssembly(stubContext(), baseConfig(), project(), root)
    expect(engine.monitor.enabled).toBe(false)
    expect(engine.monitor.chatsVal()).toBe('')
    expect(engine.commandHandlers?.get('monitor')).toBeDefined()
  })

  it('persists runtime /monitor edits through the project state and reloads them at assembly', () => {
    const root = tempDir()
    // First assembly: /monitor on adds a chat and persists.
    const first = buildProjectAssembly(stubContext(), baseConfig(), project({ enabled: true, chats: 'oc_a', mode: 'monitor' }), root)
    first.engine.monitor.saveChats?.('oc_a,oc_b')
    first.engine.monitor.saveMode?.('dispatch')

    const state = new ProjectStateStore(join(root, 'smoke-project', 'state.json'))
    expect(state.monitorChats()).toBe('oc_a,oc_b')
    expect(state.monitorMode()).toBe('dispatch')

    // Second assembly: the persisted values win over the config block.
    const second = buildProjectAssembly(stubContext(), baseConfig(), project({ enabled: true, chats: 'oc_a', mode: 'monitor' }), root)
    expect(second.engine.monitor.chatsVal()).toBe('oc_a,oc_b')
    expect(second.engine.monitor.modeVal()).toBe('dispatch')
  })
})

describe('monitor command coexistence', () => {
  it('/monitor dispatches through the assembled engine and persists via the state store', () => {
    const root = tempDir()
    // /monitor is privileged (Go privilegedCommands); the ops profile sets
    // admin_from = '*', mirrored here. buildProjectAssembly already ran
    // registerSessionCommands before registering the monitor family.
    const proj = project({ enabled: true, chats: 'oc_a', mode: 'monitor' })
    proj.adminFrom = '*'
    const { engine } = buildProjectAssembly(stubContext(), baseConfig(), proj, root)

    const p: StubPlatform = createStubPlatform('feishu')
    const msg = { ...newStubMessage(), sessionKey: 'feishu:oc_b:ou_user', platform: 'feishu', chatType: 'group', content: '/monitor', userID: 'ou_admin' }
    expect(engine.dispatchCommand(p, msg, '/monitor')).toBe(true)
    expect(engine.monitor.chatsVal()).toBe('oc_a,oc_b')
    const state = new ProjectStateStore(join(root, 'smoke-project', 'state.json'))
    expect(state.monitorChats()).toBe('oc_a,oc_b')
  })
})
