/**
 * The research-mode data steward: the hub-parented idle assistant
 * afterChatroomStarted pre-spawns beside the per-role assistants, so the
 * moderator can dispatch shared-data prefetching once instead of every
 * role's assistant re-fetching the same public datasets.
 *
 * @module dsh-feishu-bridge/tests-engine-chatroom-steward
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { ProjectStateStore } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { registerSessionCommands } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { registerChatroomCommands } from '../../src/engine/chatroom-cmd.ts'
import { uvHooks } from '../../src/engine/chatroom.ts'
import { chatroomState } from '../../src/chatroom-state.ts'
import { chatroomConfig } from '../../src/chatroom-config.ts'
import { hashID } from '../../src/engine/chatroom-ledger.ts'
import { roleDir } from '../../src/engine/chatroom-roles.ts'
import { confirmChatroomModePlain, createStubAgent, createStubChatroomSpawnerEx, newStubMessage } from '../stubs/engine-stubs.ts'
import { chatroomPolicyFace } from '../stubs/bridge-policy.ts'
import type { Message, Platform } from '@deepseek-ai/dsh-feishu-bridge/exports'
import '../stubs/messages.js'

const savedLookup = uvHooks.lookupPath
const savedCreate = uvHooks.createVenv
const savedInstall = uvHooks.pipInstall

afterEach(() => {
  uvHooks.lookupPath = savedLookup
  uvHooks.createVenv = savedCreate
  uvHooks.pipInstall = savedInstall
})

/** One macrotask tick: flushes the microtask chain behind fire-and-forget sends. */
async function settle(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

// Default sized to this spec's awaited work: every wait below counts engine
// research-startup spawns (the heaviest waits for 11 groups — venv
// provisioning, role groups, per-role assistants, the steward, the family
// rename). ~1.1s solo, >2s under concurrent full-suite event-loop contention
// (CI slower still); the 2000ms default undercut both the vitest lane budget
// and the measured contention and flaked the suite.
async function waitFor(cond: () => boolean, what: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (cond()) return
    if (Date.now() > deadline) throw new Error(`timeout waiting for: ${what}`)
    await settle()
  }
}

/** Engine + in-memory project state + the session and chatroom commands. */
function newStewardTestEngine(p: Platform): Engine {
  const e = new Engine('test', createStubAgent(), [p], '', 'zh', chatroomPolicyFace())
  e.setProjectStateStore(new ProjectStateStore(''))
  registerSessionCommands(e)
  registerChatroomCommands(e)
  return e
}

/** Create a temp roles dir with one CLAUDE.md persona per named role. */
async function scaffoldRoles(names: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fb-steward-roles-'))
  for (const n of names) {
    await mkdir(join(root, n), { recursive: true })
    await writeFile(join(root, n, 'CLAUDE.md'), `# ${n}\n`, 'utf8')
  }
  return root
}

function hubMsg(hub: string): Message {
  return { ...newStubMessage(), sessionKey: hub, platform: 'test', userID: 'user-1', replyCtx: 'hub-ctx' }
}

describe('research steward pre-spawn', () => {
  it('spawns a hub-parented steward beside the per-role assistants', { timeout: 15000 }, async () => {
    // The venv must provision for the startup gate and land on every
    // assistant; uv is stubbed so the suite never needs a host install.
    uvHooks.lookupPath = async () => 'uv'
    uvHooks.createVenv = async (_uv: string, venv: string) => {
      await mkdir(join(venv, 'bin'), { recursive: true })
    }
    uvHooks.pipInstall = async () => undefined

    const p = createStubChatroomSpawnerEx()
    const e = newStewardTestEngine(p)
    const names = ['taleb', 'munger', 'graham', 'jobs', 'kobe']
    const rolesDir = await scaffoldRoles(names)
    const ws = await mkdtemp(join(tmpdir(), 'fb-steward-ws-'))
    chatroomConfig(e).applySection({ rolesDir, researchWorkspace: ws, researchPythonEnv: true })
    const renamedChildren: string[][] = []
    vi.spyOn(e, 'renameHubToTopic').mockImplementation(
      (_p: Platform, _key: string, _chatType: string, _topic: string, childKeys: string[]) => {
        renamedChildren.push(childKeys)
      },
    )

    const hub = 'test:hub:user-1'
    e.commandHandlers?.get('chatroom')
      ?.(p, hubMsg(hub), ['--research', names.join(','), '研究中国股市是否过热'])

    // 5 role groups + 5 role assistants + 1 steward = 11 spawned groups.
    await waitFor(() => p.count === 11, '5 roles + 5 assistants + 1 steward')
    await waitFor(() => renamedChildren.length > 0, 'hub rename saw the full family')

    const hubSess = e.sessions.getOrCreateActive(hub)
    const stewardKey = chatroomState(hubSess).researchAssistantKey
    expect(stewardKey).not.toBe('')
    const steward = e.sessions.getOrCreateActive(stewardKey)
    // The steward is the hub's own idle child: flagged and named like a
    // research assistant, running in the shared workspace, and registered as
    // the hub's "assistant" alias target.
    expect(steward.getParentSessionKey()).toBe(hub)
    expect(chatroomState(steward).researchAssistant).toBe(true)
    expect(chatroomState(steward).researchVenv).toBe(join(ws, '.venv'))
    // Scratch isolation: the steward keeps its scripts and intermediate
    // products in the chatroom's own run dir (same tag as the ledger dir), so
    // parallel chatrooms never overwrite each other's root-level scratch.
    const runTag = `${hashID(hub)}-1`
    expect(chatroomState(steward).researchRunDir).toBe(join(ws, 'runs', runTag, 'steward'))
    expect(existsSync(join(ws, 'runs', runTag, 'steward'))).toBe(true)
    expect(steward.getName()).toBe('聊天室·数据管家')
    expect(e.perChatWorkDir(e.dirOverrideKey(stewardKey))).toBe(ws)
    expect(p.renamedAnyCalls().some(r => r.key === stewardKey && r.name === '聊天室·数据管家')).toBe(true)
    // The family-avatar child keys cover the steward alongside roles and
    // role assistants.
    expect(renamedChildren[0]).toContain(stewardKey)

    // Six flagged assistants in the subtree; the five role-parented ones
    // keep their own keys, so the hub's steward never shadows a role's
    // alias target (the alias resolves per caller).
    const subtree = e.collectSubtree(hub)
    expect(subtree).toHaveLength(11)
    const assistants = subtree.filter(k => chatroomState(e.sessions.getOrCreateActive(k)).researchAssistant)
    expect(assistants).toHaveLength(6)
    for (const name of names) {
      const roleKey = subtree.find(
        k => chatroomState(e.sessions.getOrCreateActive(k)).chatroomRoleName === name,
      ) ?? ''
      expect(roleKey, `role session for ${name}`).not.toBe('')
      const roleAssistant = chatroomState(e.sessions.getOrCreateActive(roleKey)).researchAssistantKey
      expect(roleAssistant, `assistant for ${name}`).not.toBe('')
      expect(roleAssistant).not.toBe(stewardKey)
      expect(e.sessions.getOrCreateActive(roleAssistant).getParentSessionKey()).toBe(roleKey)
      // Each role assistant gets its own scratch dir under the chatroom's
      // run tag, pre-created on disk.
      const wantRunDir = join(ws, 'runs', runTag, `assistant-${name}`)
      expect(chatroomState(e.sessions.getOrCreateActive(roleAssistant)).researchRunDir).toBe(wantRunDir)
      expect(existsSync(wantRunDir)).toBe(true)
    }
  })

  it('spawns no steward in a non-research chatroom, workspace or not', { timeout: 15000 }, async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newStewardTestEngine(p)
    const names = ['taleb', 'munger']
    const rolesDir = await scaffoldRoles(names)
    chatroomConfig(e).applySection({
      rolesDir,
      // The workspace resolves, so the only gate keeping the steward out is
      // the chatroom not being a research one.
      researchWorkspace: await mkdtemp(join(tmpdir(), 'fb-steward-ws-')),
    })

    const hub = 'test:hub:user-1'
    e.commandHandlers?.get('chatroom')?.(p, hubMsg(hub), [names.join(','), '该不该 all-in'])
    await confirmChatroomModePlain(e, hub)
    await waitFor(() => p.count === 2, '2 role groups only')
    await settle()

    expect(chatroomState(e.sessions.getOrCreateActive(hub)).researchAssistantKey).toBe('')
    expect(e.collectSubtree(hub)
      .filter(k => chatroomState(e.sessions.getOrCreateActive(k)).researchAssistant)).toHaveLength(0)
  })

  it('spawns no steward without a research workspace; role assistants fall back to their persona dirs', { timeout: 15000 }, async () => {
    const p = createStubChatroomSpawnerEx()
    // The storeless test engine derives no workspace and none is configured,
    // so the role assistants scatter into their persona dirs — the steward's
    // precondition (a shared area to prefetch into) is gone.
    const e = newStewardTestEngine(p)
    const names = ['taleb', 'munger']
    const rolesDir = await scaffoldRoles(names)
    chatroomConfig(e).applySection({ rolesDir })

    const hub = 'test:hub:user-1'
    e.commandHandlers?.get('chatroom')
      ?.(p, hubMsg(hub), ['--research', names.join(','), '研究中国股市是否过热'])
    await waitFor(() => p.count === 4, '2 roles + 2 assistants, no steward')
    await waitFor(() => e.collectSubtree(hub)
      .filter(k => chatroomState(e.sessions.getOrCreateActive(k)).researchAssistant).length === 2,
    'assistant sessions registered')

    expect(chatroomState(e.sessions.getOrCreateActive(hub)).researchAssistantKey).toBe('')
    for (const name of names) {
      const roleKey = e.collectSubtree(hub).find(
        k => chatroomState(e.sessions.getOrCreateActive(k)).chatroomRoleName === name,
      ) ?? ''
      expect(roleKey, `role session for ${name}`).not.toBe('')
      const assistantKey = chatroomState(e.sessions.getOrCreateActive(roleKey)).researchAssistantKey
      expect(assistantKey, `assistant for ${name}`).not.toBe('')
      expect(e.perChatWorkDir(e.dirOverrideKey(assistantKey))).toBe(roleDir(rolesDir, name))
      // No shared workspace → no run dir either: the assistant falls back to
      // its cwd (the persona dir) for scratch.
      expect(chatroomState(e.sessions.getOrCreateActive(assistantKey)).researchRunDir).toBe('')
    }
  })
})
