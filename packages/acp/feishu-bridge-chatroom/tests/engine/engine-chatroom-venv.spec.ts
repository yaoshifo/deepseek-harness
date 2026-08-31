/**
 * Research venv provisioning tests ported 1:1 from cc-connect
 * core/engine_chatroom_venv_test.go (uv hooks stubbed so the suite never
 * depends on a host uv install), plus the buildSessionStartOptions
 * research-venv surface.
 *
 * @module dsh-feishu-bridge/tests-engine-chatroom-venv
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Engine } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { ProjectStateStore } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { registerSessionCommands } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { registerChatroomCommands } from '../../src/engine/chatroom-cmd.ts'
import { ensureResearchPythonEnv, uvHooks } from '../../src/engine/chatroom.ts'
import { chatroomPolicyFace } from '../stubs/bridge-policy.ts'
import { createStubAgent, newStubMessage } from '../stubs/engine-stubs.ts'
import { createStubChatroomSpawner } from '../stubs/engine-stubs.ts'
import { chatroomState } from '../../src/chatroom-state.ts'
import { chatroomConfig } from '../../src/chatroom-config.ts'
import '../stubs/messages.js'

const savedLookup = uvHooks.lookupPath
const savedCreate = uvHooks.createVenv
const savedInstall = uvHooks.pipInstall

afterEach(() => {
  uvHooks.lookupPath = savedLookup
  uvHooks.createVenv = savedCreate
  uvHooks.pipInstall = savedInstall
})

function newEngine(): Engine {
  // The persona block and venv ride the session-start-options listener (the
  // production composition).
  return new Engine('test', createStubAgent(), [], '', 'zh', chatroomPolicyFace())
}

describe('ensureResearchPythonEnv', () => {
  it('is a no-op when the feature switch is off', async () => {
    const e = newEngine() // chatroomResearchPythonEnv defaults false
    const v = await ensureResearchPythonEnv(e, await mkdtemp(join(tmpdir(), 'fb-venv-')))
    expect(v).toBeUndefined()
  })

  it('errors on an empty workspace', async () => {
    const e = newEngine()
    chatroomConfig(e).applySection({ researchPythonEnv: true })
    await expect(ensureResearchPythonEnv(e, '   ')).rejects.toThrow()
  })

  it('is idempotent when uv is present', async () => {
    const e = newEngine()
    chatroomConfig(e).applySection({ researchPythonEnv: true })
    uvHooks.pipInstall = async () => undefined
    uvHooks.createVenv = async (_uv, venv) => {
      await mkdir(join(venv, 'bin'), { recursive: true })
    }
    const ws = await mkdtemp(join(tmpdir(), 'fb-venv-'))
    const v1 = await ensureResearchPythonEnv(e, ws)
    const want = join(ws, '.venv')
    expect(v1).toBe(want)
    expect(statSync(join(v1!, 'bin')).isDirectory()).toBe(true)
    // Idempotent: a second call succeeds and returns the same path.
    const v2 = await ensureResearchPythonEnv(e, ws)
    expect(v2).toBe(v1)
  })

  it('blocks when uv is absent', async () => {
    uvHooks.lookupPath = async () => { throw new Error('uv not found') }
    const e = newEngine()
    chatroomConfig(e).applySection({ researchPythonEnv: true })
    const v = await ensureResearchPythonEnv(e, await mkdtemp(join(tmpdir(), 'fb-venv-'))).catch(() => undefined)
    expect(v).toBeUndefined()
  })

  it('installs base deps once at venv creation and skips on reuse', async () => {
    const e = newEngine()
    chatroomConfig(e).applySection({ researchPythonEnv: true })
    let calls = 0
    let gotVenv = ''
    uvHooks.pipInstall = async (_uv, venv) => {
      calls++
      gotVenv = venv
    }
    uvHooks.createVenv = async (_uv, venv) => {
      await mkdir(join(venv, 'bin'), { recursive: true })
    }
    const ws = await mkdtemp(join(tmpdir(), 'fb-venv-'))
    const v = await ensureResearchPythonEnv(e, ws)
    expect(calls).toBe(1)
    expect(gotVenv).toBe(join(ws, '.venv'))
    expect(v).toBe(join(ws, '.venv'))

    // Second call reuses the existing venv — no reinstall.
    await ensureResearchPythonEnv(e, ws)
    expect(calls).toBe(1)
  })

  it('removes the half-created venv when the deps install fails', async () => {
    const e = newEngine()
    chatroomConfig(e).applySection({ researchPythonEnv: true })
    uvHooks.pipInstall = async () => { throw new Error('install failed') }
    uvHooks.createVenv = async (_uv, venv) => {
      await mkdir(join(venv, 'bin'), { recursive: true })
    }
    const ws = await mkdtemp(join(tmpdir(), 'fb-venv-'))
    const v = await ensureResearchPythonEnv(e, ws).catch(() => undefined)
    expect(v).toBeUndefined()
    // The half-created venv must be removed so the next startup retries.
    expect(existsSync(join(ws, '.venv'))).toBe(false)
  })
})

describe('cmdChatroom research uv gate', () => {
  it('blocks startup when uv is unavailable (no stash, no spawn)', async () => {
    uvHooks.lookupPath = async () => { throw new Error('uv not found') }
    const p = createStubChatroomSpawner()
    const e = new Engine('test', createStubAgent(), [p], '', 'zh')
    e.setProjectStateStore(new ProjectStateStore(''))
    registerSessionCommands(e)
    registerChatroomCommands(e)
    const root = await mkdtemp(join(tmpdir(), 'fb-venv-gate-'))
    for (const n of ['taleb', 'munger']) {
      await mkdir(join(root, n), { recursive: true })
      await writeFile(join(root, n, 'CLAUDE.md'), '# x\n', 'utf8')
    }
    chatroomConfig(e).applySection({ rolesDir: root })
    chatroomConfig(e).applySection({ researchPythonEnv: true })
    chatroomConfig(e).applySection({ researchWorkspace: await mkdtemp(join(tmpdir(), 'fb-venv-ws-')) })
    const hub = 'test:hub:user-1'
    const handler = e.commandHandlers?.get('chatroom')
    expect(handler).toBeDefined()
    handler?.(p, { ...newStubMessage(), sessionKey: hub, platform: 'test', userID: 'user-1', replyCtx: 'hub-ctx' },
      ['--research', 'taleb,munger', '研究中国股市是否过热'])
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(p.count).toBe(0)
    expect(chatroomState(e.sessions.getOrCreateActive(hub)).chatroomResearch).toBe(false)
  })
})

describe('buildSessionStartOptions research venv', () => {
  it('carries the venv root and bin dir', () => {
    const e = newEngine()
    const s = e.sessions.getOrCreateActive('test:assistant-1')
    chatroomState(s).researchVenv = '/tmp/research/.venv'
    const options = e.buildSessionStartOptions('k', s)
    expect(options.venv?.virtualEnv).toBe('/tmp/research/.venv')
  })

  it('sets no venv without a research venv', () => {
    const e = newEngine()
    const s = e.sessions.getOrCreateActive('test:plain-chat')
    expect(e.buildSessionStartOptions('k', s).venv).toBeUndefined()
  })

  it('emits the chatroom persona block for roles, moderators, and direct roles', () => {
    const e = newEngine()
    chatroomConfig(e).applySection({ moderatorDir: '/data/chatroom' })
    const hub = e.sessions.getOrCreateActive('test:hub:user-1')
    chatroomState(hub).chatroomModerator = true
    const role = e.sessions.getOrCreateActive('test:role-1')
    chatroomState(role).chatroomHubKey = 'test:hub:user-1'
    const direct = e.sessions.getOrCreateActive('test:direct:user-1')
    chatroomState(direct).chatroomDirectRole = true

    // Persona flags: moderators force the default mode (never plan), roles
    // and direct roles bypass permissions, and the prompt folds the ledger
    // dir / role contract in.
    const modOptions = e.buildSessionStartOptions('test:hub:user-1', hub)
    expect(modOptions.persona?.forceMode).toBe('default')
    expect(modOptions.persona?.bypassPermissions).toBe(false)
    // A hub-keyed moderator (the production hub shape: bound to its own
    // chatroom) takes the role branch with the same forced mode.
    chatroomState(hub).chatroomHubKey = 'test:hub:user-1'
    const hubOptions = e.buildSessionStartOptions('test:hub:user-1', hub)
    expect(hubOptions.persona?.forceMode).toBe('default')
    expect(hubOptions.persona?.bypassPermissions).toBe(true)
    chatroomState(hub).chatroomHubKey = ''
    const roleOptions = e.buildSessionStartOptions('test:role-1', role)
    expect(roleOptions.persona?.bypassPermissions).toBe(true)
    expect(roleOptions.persona?.prompt).toContain('/data/chatroom/ledgers/')
    const directOptions = e.buildSessionStartOptions('test:direct:user-1', direct)
    expect(directOptions.persona?.bypassPermissions).toBe(true)
    expect(directOptions.persona?.prompt).toContain('1:1')
  })
})
