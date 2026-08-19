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
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { buildProjectAssembly, Config, type FeishuBridgeConfig, type ProjectConfig } from '../src/index.js'

/** Structural Cordis slice the adapter consumes; nothing else boots. */
function stubContext(): Context {
  return {
    agents: {},
    on: () => () => {},
    get: () => undefined,
    logger: { error: () => {} },
    effect: () => () => {},
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
    expect(platform.spawnStore.filePath).toBe(join(root, 'smoke-project', 'sessions', 'smoke-project_feishu_spawned.json'))
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
    const proj = {
      ...project(),
      groupName: { provider: 'turbo', timeoutSec: 45, prompt: '起个短名', setAvatar: false },
    }
    const { engine } = buildProjectAssembly(stubContext(), config(), proj, '/tmp/fb-root')
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
