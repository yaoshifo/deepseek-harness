/**
 * Project assembly wiring tests: buildProjectAssembly must hand the engine
 * its project-state store and the platform its data dir — the first M4
 * real-machine smoke lost /spawn --dir because apply() constructed neither
 * (the engine's per-chat workdir overrides had nowhere to persist).
 *
 * @module dsh-feishu-bridge/tests-assembly
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { buildProjectAssembly, Config, type FeishuBridgeConfig, type ProjectConfig } from '../src/index.ts'
import { ProjectStateStore } from '../src/engine/project-state.ts'

/** Structural Cordis slice the adapter consumes; nothing else boots. */
function stubContext(): Context {
  return {
    agents: {},
    on: () => () => {},
    get: () => undefined,
    logger: { error: () => {} },
    // Cordis runs the effect body immediately; mirror that so command
    // registrations mounted through ctx.effect actually mount.
    effect: (fn: () => unknown) => { void fn(); return () => {} },
  } as unknown as Context
}

function config(): FeishuBridgeConfig {
  return {
    projects: [],
    providers: {
      'mify-dsh': { route: 'mify-dsh', model: 'glm-5.2' },
    },
  }
}

function project(): ProjectConfig {
  return {
    name: 'smoke-project',
    workdir: '/workspace/project',
    feishu: { appId: 'cli_test', appSecret: 'sec' },
  }
}

describe('buildProjectAssembly', () => {
  it('wires the project state store onto the engine', () => {
    const { engine } = buildProjectAssembly(stubContext(), config(), project(), '/tmp/fb-root')
    expect(engine.projectState).toBeDefined()
  })

  it('points the platform spawn store at the project data dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-assembly-'))
    const { platform } = buildProjectAssembly(stubContext(), config(), project(), root)
    expect(platform.spawnStore.filePath).toBe(join(root, 'smoke-project', 'sessions', 'smoke-project_spawned.json'))
  })

  it('forwards the feishu platform options (notify_on_complete & co.)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-assembly-'))
    const cfg = config()
    const proj = {
      ...project(),
      feishu: {
        appId: 'cli_test',
        appSecret: 'sec',
        notifyOnComplete: true,
        reactionEmoji: 'Get',
        doneEmoji: 'Done',
        cancelEmoji: 'CrossMark',
        topNoticeFirstMessage: true,
        pinUserMessages: true,
      },
    }
    const { platform } = buildProjectAssembly(stubContext(), cfg, proj, root)
    expect(platform.notifyOnComplete).toBe(true)
    expect(platform.reactionEmoji).toBe('Get')
    expect(platform.doneEmoji).toBe('Done')
    expect(platform.cancelEmoji).toBe('CrossMark')
    expect(platform.topNoticeEnabled).toBe(true)
    expect(platform.pinEnabled).toBe(true)
    // Defaults stay off when the config omits them.
    const bare = buildProjectAssembly(stubContext(), config(), project(), root)
    expect(bare.platform.notifyOnComplete).toBe(false)
    expect(bare.platform.topNoticeEnabled).toBe(false)
    expect(bare.platform.pinEnabled).toBe(false)
  })

  it('falls back to the config default with a warning when the persisted provider is gone', async () => {
    // A runtime /provider switch persists into the project state; when the
    // operator deletes that route from cordis.yml, restart must not
    // silently resolve to no route (misconfiguration fails loud).
    const root = await mkdtemp(join(tmpdir(), 'fb-assembly-provider-'))
    const state = new ProjectStateStore(join(root, 'smoke-project', 'state.json'))
    state.setActiveProvider('removed-route')
    state.save()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { adapter } = buildProjectAssembly(stubContext(), config(), project(), root)
      expect(adapter.getActiveProvider()?.name).toBe('mify-dsh')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed-route'))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('mify-dsh'))
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps a persisted provider that is still configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-assembly-provider-'))
    const state = new ProjectStateStore(join(root, 'smoke-project', 'state.json'))
    state.setActiveProvider('mify-dsh')
    state.save()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { adapter } = buildProjectAssembly(stubContext(), config(), project(), root)
      expect(adapter.getActiveProvider()?.name).toBe('mify-dsh')
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('fails loud when agent.provider names no configured provider', () => {
    // The providers map and agent.provider sit in the same config file — a
    // typo is self-contained misconfiguration that would otherwise silently
    // resolve to no route (empty agent options, default-model drift), the
    // config-side twin of the persisted-provider fallback above.
    expect(() => buildProjectAssembly(stubContext(), config(), { ...project(), agent: { provider: 'mify-dhs' } }, '/tmp/fb-root'))
      .toThrow(/project 'smoke-project'.*'mify-dhs'.*available: mify-dsh/)
  })

  it('fails loud when a side provider reference names no configured provider', () => {
    // groupName/planRender/predictNext/turnSummary/monitor.triageProvider
    // flow into side forks; a typo there falls back to the active route just
    // as silently as agent.provider did.
    expect(() => buildProjectAssembly(stubContext(), config(), { ...project(), groupName: { provider: 'mify-dhs' } }, '/tmp/fb-root'))
      .toThrow(/groupName\.provider.*'mify-dhs'.*available: mify-dsh/)
    expect(() => buildProjectAssembly(stubContext(), config(), { ...project(), monitor: { triageProvider: 'nope' } }, '/tmp/fb-root'))
      .toThrow(/monitor\.triageProvider.*'nope'.*available: mify-dsh/)
    // An empty value legitimately means "use the active route".
    expect(() => buildProjectAssembly(stubContext(), config(), { ...project(), groupName: { provider: '' } }, '/tmp/fb-root')).not.toThrow()
  })

  it('wires a valid agent.provider as the active route and defaults to the first without one', () => {
    const cfg = config()
    cfg.providers = {
      'mify-dsh': { route: 'mify-dsh', model: 'glm-5.2' },
      turbo: { route: 'turbo-route', model: 'glm-5.3-flash' },
    }
    const named = buildProjectAssembly(stubContext(), cfg, { ...project(), agent: { provider: 'turbo' } }, '/tmp/fb-root')
    expect(named.adapter.getActiveProvider()?.name).toBe('turbo')
    const bare = buildProjectAssembly(stubContext(), cfg, project(), '/tmp/fb-root')
    expect(bare.adapter.getActiveProvider()?.name).toBe('mify-dsh')
  })
})

describe('buildProjectAssembly group naming (Go wireGroupName)', () => {
  it('defaults group naming ON with 30s timeout and avatar set', () => {
    // Go's default-on rule keyed on the claudecode agent; this plugin's agent
    // is always dsh, so the default is on here too.
    const { engine } = buildProjectAssembly(stubContext(), config(), project(), '/tmp/fb-root')
    expect(engine.groupNameEnabled).toBe(true)
    expect(engine.groupNameProvider).toBe('')
    expect(engine.groupNameTimeout).toBe(30_000)
    expect(engine.groupNamePrompt).toBe('')
    expect(engine.groupNameSetAvatar).toBe(true)
  })

  it('honors an explicit groupName section', () => {
    const cfg = config()
    cfg.providers = {
      'mify-dsh': { route: 'mify-dsh', model: 'glm-5.2' },
      turbo: { route: 'turbo-route', model: 'glm-5.3-flash' },
    }
    const proj = {
      ...project(),
      groupName: { provider: 'turbo', timeoutSec: 45, prompt: '起个短名', setAvatar: false },
    }
    const { engine } = buildProjectAssembly(stubContext(), cfg, proj, '/tmp/fb-root')
    expect(engine.groupNameEnabled).toBe(true)
    expect(engine.groupNameProvider).toBe('turbo')
    expect(engine.groupNameTimeout).toBe(45_000)
    expect(engine.groupNamePrompt).toBe('起个短名')
    expect(engine.groupNameSetAvatar).toBe(false)
  })

  it('disables group naming and avatars when groupName.enabled=false', () => {
    const proj = { ...project(), groupName: { enabled: false } }
    const { engine } = buildProjectAssembly(stubContext(), config(), proj, '/tmp/fb-root')
    expect(engine.groupNameEnabled).toBe(false)
    expect(engine.groupNameSetAvatar).toBe(false)
  })

  it('parses the groupName section through the Config schema', () => {
    const parsed = Config({
      projects: [{
        name: 'p',
        workdir: '/w',
        feishu: { appId: 'a', appSecret: 's' },
        groupName: { enabled: true, provider: 'turbo', timeoutSec: 45, setAvatar: false },
      }],
      providers: {},
    })
    expect(parsed.projects[0]?.groupName).toEqual({
      enabled: true, provider: 'turbo', timeoutSec: 45, setAvatar: false,
    })
  })
})
