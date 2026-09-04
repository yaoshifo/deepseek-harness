/**
 * Chatroom config wiring (moved from the bridge's assembly-chatroom spec):
 * the plugin config's defaults + per-project sections resolve onto the
 * per-engine store the migrated modules read through, with the same
 * clamps, ~ expansion, and default semantics the bridge's wireChatroom
 * carried (Go [chatroom] wiring).
 *
 * @module dsh-feishu-bridge-chatroom/tests-chatroom-config
 */

import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { Engine } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { applyChatroomEngineConfig, chatroomConfig, type ChatroomProjectConfig } from '../src/chatroom-config.ts'
import { chatroomResearchWorkspace } from '../src/engine/chatroom.ts'
import { createStubAgent } from './stubs/engine-stubs.ts'

function newEngine(): Engine {
  return new Engine('config-test', createStubAgent(), [], '', 'en')
}

function configure(project: ChatroomProjectConfig | undefined, defaults: ChatroomProjectConfig = {}): Engine {
  const e = newEngine()
  applyChatroomEngineConfig(e, defaults, project)
  return e
}

describe('chatroom config wiring', () => {
  it('forwards the merged project section onto the per-engine config', () => {
    const e = configure({
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
    })
    expect(chatroomConfig(e).rolesDir()).toBe('/roles/thinkers')
    expect(chatroomConfig(e).maxRoles()).toBe(3)
    expect(chatroomConfig(e).moderatorDir()).toEqual({ dir: '/data/chatroom', ok: true })
    expect(chatroomConfig(e).gatherTimeoutDuration()).toBe(600_000)
    expect(chatroomConfig(e).endTimeoutDuration()).toBe(300_000)
    expect(chatroomConfig(e).researchTimeoutDuration()).toBe(1_800_000)
    expect(chatroomConfig(e).maxResearchRounds()).toBe(5)
    expect(chatroomConfig(e).defaultResearchMode()).toBe('manual')
    expect(chatroomResearchWorkspace(e)).toBe('/shared/research')
  })

  it('defaults the research venv base packages with pandas pinned below 3', () => {
    const e = configure({})
    // akshare's own metadata only requires pandas>=2.0.0 with no upper
    // bound, and pandas 3.x breaks it — the pin is ecosystem fact, not a
    // machine preference.
    expect(chatroomConfig(e).researchVenvPackages()).toEqual(['akshare', 'pandas<3', 'numpy', 'requests'])
    // An unswept engine (the pre-sweep window) reads the same default.
    expect(chatroomConfig(newEngine()).researchVenvPackages()).toEqual(['akshare', 'pandas<3', 'numpy', 'requests'])
  })

  it('a configured research venv package list replaces the default', () => {
    const e = configure({ researchVenvPackages: ['akshare', 'pandas<3', 'scipy'] })
    expect(chatroomConfig(e).researchVenvPackages()).toEqual(['akshare', 'pandas<3', 'scipy'])
  })

  it('resolves the research playbook path with ~ expansion; unset opts out', () => {
    const e = configure({ researchPlaybook: '~/research-playbook.md' })
    expect(chatroomConfig(e).researchPlaybook().startsWith(homedir())).toBe(true)
    expect(chatroomConfig(e).researchPlaybook().endsWith('research-playbook.md')).toBe(true)
    // A project section overrides the shared default; unset reads ''.
    expect(chatroomConfig(configure({ researchPlaybook: '/p/pb.md' }, { researchPlaybook: '/d/pb.md' })).researchPlaybook()).toBe('/p/pb.md')
    expect(chatroomConfig(configure({})).researchPlaybook()).toBe('')
    expect(chatroomConfig(newEngine()).researchPlaybook()).toBe('')
  })

  it('clamps out-of-range research values (Go EffectiveChatroomResearch)', () => {
    const e = configure({ researchTimeoutSec: 10, maxResearchRounds: 99 })
    expect(chatroomConfig(e).researchTimeoutDuration()).toBe(60_000)
    expect(chatroomConfig(e).maxResearchRounds()).toBe(20)
  })

  it('per-project section overrides the plugin-level default', () => {
    const e = configure({ rolesDir: '/project-roles' }, { rolesDir: '/shared-roles', maxRoles: 4 })
    expect(chatroomConfig(e).rolesDir()).toBe('/project-roles')
    expect(chatroomConfig(e).maxRoles()).toBe(4)
  })

  it('expands a bare ~ to the home directory', () => {
    const e = configure({ rolesDir: '~' })
    expect(chatroomConfig(e).rolesDir()).toBe(homedir())
  })

  it('expands ~ in rolesDir and moderatorDir', () => {
    const e = configure({ rolesDir: '~/chatroom-roles', moderatorDir: '~/chatroom-moderator' })
    expect(chatroomConfig(e).rolesDir().startsWith('/')).toBe(true)
    expect(chatroomConfig(e).rolesDir().endsWith('chatroom-roles')).toBe(true)
    expect(chatroomConfig(e).moderatorDir().dir.endsWith('chatroom-moderator')).toBe(true)
    expect(chatroomConfig(e).rolesDir().startsWith(homedir())).toBe(true)
  })

  it('resolves the user profile path with ~ expansion; empty opts out', () => {
    const e = configure({ userProfile: '~/user-profile.md' })
    expect(chatroomConfig(e).userProfile().startsWith(homedir())).toBe(true)
    expect(chatroomConfig(e).userProfile().endsWith('user-profile.md')).toBe(true)
    // A project section overrides the shared default; '' opts out of it.
    expect(chatroomConfig(configure({ userProfile: '/p/user.md' }, { userProfile: '/d/user.md' })).userProfile()).toBe('/p/user.md')
    expect(chatroomConfig(configure({ userProfile: '' }, { userProfile: '/d/user.md' })).userProfile()).toBe('')
    // Unset everywhere (the unswept window included) reads ''.
    expect(chatroomConfig(newEngine()).userProfile()).toBe('')
  })

  it('defaults: research venv on, ledger off, research mode auto, effective timeouts', () => {
    const e = configure(undefined)
    expect(chatroomConfig(e).researchPythonEnv).toBe(true)
    expect(chatroomConfig(e).moderatorDir().ok).toBe(false)
    expect(chatroomConfig(e).defaultResearchMode()).toBe('auto')
    expect(chatroomConfig(e).maxRoles()).toBe(5)
    expect(chatroomConfig(e).gatherTimeoutDuration()).toBe(20 * 60 * 1000)
    // End waits for replies already generating: half the gather default.
    expect(chatroomConfig(e).endTimeoutDuration()).toBe(10 * 60 * 1000)
    expect(chatroomConfig(e).researchTimeoutDuration()).toBe(60 * 60 * 1000)
    expect(chatroomConfig(e).maxResearchRounds()).toBe(3)
  })

  it('an unswept engine reads default-valued config (the pre-sweep window)', () => {
    const e = newEngine()
    expect(chatroomConfig(e).researchPythonEnv).toBe(false)
    expect(chatroomConfig(e).rolesDir().endsWith('chatroom-roles')).toBe(true)
  })

  it('research workspace falls back to the project data dir beside the session store', () => {
    const e = new Engine('config-test', createStubAgent(), [], '/tmp/fb-root/config-test/sessions.json', 'en')
    expect(chatroomResearchWorkspace(e)).toBe('/tmp/fb-root/config-test/chatroom-research')
    // An engine without a store path and without config yields ''.
    expect(chatroomResearchWorkspace(newEngine())).toBe('')
  })

  it('enabled defaults to true; defaults and project sections override per field', () => {
    // No section at all: enabled.
    expect(chatroomConfig(configure(undefined)).enabled()).toBe(true)
    // The defaults section disables every project.
    expect(chatroomConfig(configure(undefined, { enabled: false })).enabled()).toBe(false)
    // A project section re-enables its own engine.
    expect(chatroomConfig(configure({ enabled: true }, { enabled: false })).enabled()).toBe(true)
    // A project section without the key keeps the defaults value.
    expect(chatroomConfig(configure({ rolesDir: '/x' }, { enabled: false })).enabled()).toBe(false)
    // An unswept engine reads the default (the pre-sweep window).
    expect(chatroomConfig(newEngine()).enabled()).toBe(true)
  })
})
