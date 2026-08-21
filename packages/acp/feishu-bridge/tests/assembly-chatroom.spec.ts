/**
 * Chatroom config-path wiring tests for buildProjectAssembly (M5): the
 * [chatroom] schema block forwards onto the engine setters, per-project
 * sections override the shared top-level defaults, and the /chatroom
 * command registers alongside the session commands.
 *
 * @module dsh-feishu-bridge/tests-assembly-chatroom
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { buildProjectAssembly, type FeishuBridgeConfig, type ProjectConfig } from '../src/index.js'
import { chatroomResearchWorkspace } from '../src/engine/chatroom.js'

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

function baseConfig(): FeishuBridgeConfig {
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

function assemble(cfg: FeishuBridgeConfig, proj: ProjectConfig = project(), root = '/tmp/fb-root') {
  return buildProjectAssembly(stubContext(), cfg, proj, root)
}

describe('chatroom config wiring', () => {
  it('forwards the project chatroom block onto the engine setters', () => {
    const { engine } = assemble(baseConfig(), {
      ...project(),
      chatroom: {
        rolesDir: '/roles/thinkers',
        maxRoles: 3,
        moderatorDir: '/data/chatroom',
        gatherTimeoutSec: 600,
        endTimeoutSec: 300,
        researchTimeoutSec: 1800,
        maxResearchRounds: 5,
        defaultResearchMode: 'manual',
        researchWorkspace: '/shared/research',
        researchPythonEnv: false,
      },
    })
    expect(engine.chatroomRolesDir()).toBe('/roles/thinkers')
    expect(engine.maxChatroomRoles()).toBe(3)
    expect(engine.chatroomModeratorDir()).toEqual({ dir: '/data/chatroom', ok: true })
    expect(engine.chatroomGatherTimeoutDuration()).toBe(600_000)
    expect(engine.chatroomEndTimeoutDuration()).toBe(300_000)
    expect(engine.chatroomResearchTimeoutDuration()).toBe(1_800_000)
    expect(engine.maxChatroomResearchRoundsValue()).toBe(5)
    expect(engine.defaultChatroomResearchModeValue()).toBe('manual')
    expect(chatroomResearchWorkspace(engine)).toBe('/shared/research')
  })

  it('clamps out-of-range research values (Go EffectiveChatroomResearch)', () => {
    const { engine } = assemble(baseConfig(), {
      ...project(),
      chatroom: { researchTimeoutSec: 10, maxResearchRounds: 99 },
    })
    expect(engine.chatroomResearchTimeoutDuration()).toBe(60_000)
    expect(engine.maxChatroomResearchRoundsValue()).toBe(20)
  })

  it('per-project section overrides the shared top-level default', () => {
    const { engine } = assemble(
      { ...baseConfig(), chatroom: { rolesDir: '/shared-roles', maxRoles: 4 } },
      { ...project(), chatroom: { rolesDir: '/project-roles' } },
    )
    expect(engine.chatroomRolesDir()).toBe('/project-roles')
    expect(engine.maxChatroomRoles()).toBe(4)
  })

  it('expands ~ in rolesDir and moderatorDir', () => {
    const { engine } = assemble(baseConfig(), {
      ...project(),
      chatroom: { rolesDir: '~/chatroom-roles', moderatorDir: '~/chatroom-moderator' },
    })
    expect(engine.chatroomRolesDir().startsWith('/')).toBe(true)
    expect(engine.chatroomRolesDir().endsWith('chatroom-roles')).toBe(true)
    expect(engine.chatroomModeratorDir().dir.endsWith('chatroom-moderator')).toBe(true)
  })

  it('defaults: research venv on, ledger off, research mode auto', () => {
    const { engine } = assemble(baseConfig())
    expect(engine.chatroomResearchPythonEnv).toBe(true)
    expect(engine.chatroomModeratorDir().ok).toBe(false)
    expect(engine.defaultChatroomResearchModeValue()).toBe('auto')
  })

  it('registers the /chatroom command with its /cr alias', () => {
    const { engine } = assemble(baseConfig())
    expect(engine.commandHandlers?.get('chatroom')).toBeDefined()
    expect(engine.commandResolver?.('chatroom')).toBe('chatroom')
    expect(engine.commandResolver?.('cr')).toBe('chatroom')
    // The session commands are still resolvable.
    expect(engine.commandResolver?.('new')).toBe('new')
  })
})
