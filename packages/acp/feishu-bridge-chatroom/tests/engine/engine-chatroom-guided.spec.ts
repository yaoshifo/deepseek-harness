/**
 * The /chatroom guided-start flow: the start picker (new discussion vs
 * continuing a past chatroom) and the mode picker (plain roundtable /
 * research auto / research manual) guide decisions the user did not state
 * explicitly — every explicitly-given flag still skips its card.
 *
 * @module dsh-feishu-bridge/tests-engine-chatroom-guided
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Engine } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { ProjectStateStore } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { registerSessionCommands } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { registerChatroomCommands } from '../../src/engine/chatroom-cmd.ts'
import {
  executeChatroomCardAction,
  getChatroomModePickState,
  getChatroomPickState,
  getChatroomStartPickState,
  getChatroomTopicPickState,
  renderChatroomPickCardAndPush,
} from '../../src/engine/chatroom-pick.ts'
import { initChatroomLedger } from '../../src/engine/chatroom-ledger.ts'
import { chatroomConfig } from '../../src/chatroom-config.ts'
import { chatroomState } from '../../src/chatroom-state.ts'
import { uvHooks } from '../../src/engine/chatroom.ts'
import {
  createStubAgent,
  createStubChatroomSpawnerEx,
} from '../stubs/engine-stubs.ts'
import { chatroomPolicyFace } from '../stubs/bridge-policy.ts'
import type { Message, Platform } from '@deepseek-ai/dsh-feishu-bridge/exports'
import '../stubs/messages.js'

/** One macrotask tick: flushes the microtask chain behind fire-and-forget sends. */
async function settle(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (cond()) return
    if (Date.now() > deadline) throw new Error(`timeout waiting for: ${what}`)
    await settle()
  }
}

function newChatroomTestEngine(p: Platform): Engine {
  const e = new Engine('test', createStubAgent(), [p], '', 'zh', chatroomPolicyFace())
  e.setProjectStateStore(new ProjectStateStore(''))
  registerSessionCommands(e)
  registerChatroomCommands(e)
  return e
}

/** Two scaffolded roles (taleb, munger) under a temp roles dir. */
async function scaffoldTwoRoles(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fb-guided-roles-'))
  for (const n of ['taleb', 'munger']) {
    await mkdir(join(root, n), { recursive: true })
    await writeFile(join(root, n, 'CLAUDE.md'), `# ${n}\n`, 'utf8')
  }
  return root
}

/** A temp moderator home with one recorded ledger entry. */
async function scaffoldHistory(topic: string, roles: string[]): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'fb-guided-mod-'))
  await initChatroomLedger(join(home, 'ledgers', '0001'), topic, roles)
  return home
}

const savedLookup = uvHooks.lookupPath
const savedCreate = uvHooks.createVenv
const savedInstall = uvHooks.pipInstall

afterEach(() => {
  uvHooks.lookupPath = savedLookup
  uvHooks.createVenv = savedCreate
  uvHooks.pipInstall = savedInstall
})

function hubMsg(hub: string, overrides: Partial<Message> = {}): Message {
  return { ...newStubMessage(), sessionKey: hub, platform: 'test', userID: 'user-1', replyCtx: 'hub-ctx', ...overrides }
}

/** All text content of a recorded card (markdown bodies + list-item rows). */
function cardBody(card: unknown): string {
  const c = card as { elements: Array<{ content?: string; text?: string }> }
  const parts: string[] = []
  for (const el of c.elements) parts.push(el.content ?? el.text ?? '')
  return parts.join('\n')
}

function newStubMessage(): Message {
  return {
    sessionKey: 'test:hub:user-1',
    platform: 'test',
    messageID: '',
    userID: 'user-1',
    userName: 'u',
    chatName: '',
    chatType: 'group',
    content: '',
    originalContent: '',
    images: [],
    files: [],
    extraContent: '',
    replyCtx: 'hub-ctx',
    fromVoice: false,
    isSpawnedGroup: false,
    isPermissionAction: false,
    isAskqCardAction: false,
    isCardAction: false,
    parentMessageID: '',
    quotedText: '',
  }
}

describe('guided start: the start picker', () => {
  it('bare /chatroom with recorded history sends the start card instead of the topic picker', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    const home = await scaffoldHistory('旧议题', ['taleb', 'munger'])
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles(), moderatorDir: home })
    const hub = 'test:hub:user-1'

    e.commandHandlers?.get('chatroom')?.(p, hubMsg(hub), [])
    await settle()

    expect(getChatroomStartPickState(e, hub)).toBeDefined()
    expect(getChatroomTopicPickState(e, hub)).toBeUndefined()
    expect(p.sentCards.map(cardBody).join('\n')).toContain('旧议题')
    expect(p.count).toBe(0) // nothing spawned yet
  })

  it('picking 新讨论 hands off to the topic picker', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    const home = await scaffoldHistory('旧议题', ['taleb', 'munger'])
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles(), moderatorDir: home })
    const hub = 'test:hub:user-1'

    e.commandHandlers?.get('chatroom')?.(p, hubMsg(hub), [])
    await settle()
    executeChatroomCardAction(e, hub, '/chatroom-start-pick', 'new')
    await waitFor(() => getChatroomTopicPickState(e, hub) !== undefined, 'topic picker armed')

    expect(getChatroomStartPickState(e, hub)).toBeUndefined()
    expect(p.count).toBe(0) // still nothing spawned
  })

  it('picking 继续：<i> swaps in the mode picker armed with the prior cast (research undecided)', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    const home = await scaffoldHistory('旧议题', ['taleb', 'munger'])
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles(), moderatorDir: home })
    const hub = 'test:hub:user-1'

    e.commandHandlers?.get('chatroom')?.(p, hubMsg(hub), [])
    await settle()
    const card = executeChatroomCardAction(e, hub, '/chatroom-start-pick', 'continue 0')
    await settle()

    expect(getChatroomStartPickState(e, hub)).toBeUndefined()
    const ms = getChatroomModePickState(e, hub)
    expect(ms?.topic).toBe('旧议题')
    expect(ms?.roles).toEqual(['taleb', 'munger'])
    expect(ms?.prior?.dir).toContain('0001')
    // The swap-in card is the mode picker itself, echoing the topic.
    const body = card ? cardBody(card) : ''
    expect(body).toContain('旧议题')
    expect(body).toContain('taleb')
    expect(p.count).toBe(0) // not started yet
  })

  it('mode card start plain scrubs research flags and starts the chatroom', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    const home = await scaffoldHistory('旧议题', ['taleb', 'munger'])
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles(), moderatorDir: home })
    const hub = 'test:hub:user-1'

    e.commandHandlers?.get('chatroom')?.(p, hubMsg(hub), [])
    await settle()
    executeChatroomCardAction(e, hub, '/chatroom-start-pick', 'continue 0')
    const card = executeChatroomCardAction(e, hub, '/chatroom-mode-pick', 'start plain')
    await waitFor(() => p.count === 2, 'roles spawned')

    expect(card).toBeDefined() // transitional starting card
    expect(getChatroomModePickState(e, hub)).toBeUndefined()
    const hubState = chatroomState(e.sessions.getOrCreateActive(hub))
    expect(hubState.chatroomModerator).toBe(true)
    expect(hubState.chatroomResearch).toBe(false)
  })

  it('mode card start research-auto stashes auto flags and spawns the research family', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    const home = await scaffoldHistory('旧议题', ['taleb', 'munger'])
    const ws = await mkdtemp(join(tmpdir(), 'fb-guided-ws-'))
    chatroomConfig(e).applySection({
      rolesDir: await scaffoldTwoRoles(), moderatorDir: home, researchWorkspace: ws, researchPythonEnv: true,
    })
    uvHooks.pipInstall = async () => undefined
    uvHooks.createVenv = async (_uv, venv) => { await mkdir(join(venv, 'bin'), { recursive: true }) }
    const hub = 'test:hub:user-1'

    e.commandHandlers?.get('chatroom')?.(p, hubMsg(hub), [])
    await settle()
    executeChatroomCardAction(e, hub, '/chatroom-start-pick', 'continue 0')
    const card = executeChatroomCardAction(e, hub, '/chatroom-mode-pick', 'start research-auto')
    // 2 role groups + 2 role assistants + 1 data steward = 5 spawned groups.
    await waitFor(() => p.count === 5, '2 roles + 2 assistants + 1 steward')

    expect(card).toBeDefined()
    const hubState = chatroomState(e.sessions.getOrCreateActive(hub))
    expect(hubState.chatroomResearch).toBe(true)
    expect(hubState.chatroomResearchMode).toBe('auto')
    expect(hubState.chatroomModerator).toBe(true)
  })

  it('mode card start research-manual stashes manual flags', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    const home = await scaffoldHistory('旧议题', ['taleb', 'munger'])
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles(), moderatorDir: home })
    const hub = 'test:hub:user-1'

    e.commandHandlers?.get('chatroom')?.(p, hubMsg(hub), [])
    await settle()
    executeChatroomCardAction(e, hub, '/chatroom-start-pick', 'continue 0')
    executeChatroomCardAction(e, hub, '/chatroom-mode-pick', 'start research-manual')
    await waitFor(() => p.count === 2, 'roles spawned')

    const hubState = chatroomState(e.sessions.getOrCreateActive(hub))
    expect(hubState.chatroomResearch).toBe(true)
    expect(hubState.chatroomResearchMode).toBe('manual')
  })

  it('mode card research start with a failing venv sends the needs-uv card and spawns nothing', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    const home = await scaffoldHistory('旧议题', ['taleb', 'munger'])
    const ws = await mkdtemp(join(tmpdir(), 'fb-guided-ws-'))
    chatroomConfig(e).applySection({
      rolesDir: await scaffoldTwoRoles(), moderatorDir: home, researchWorkspace: ws, researchPythonEnv: true,
    })
    uvHooks.lookupPath = async () => { throw new Error('uv not found') }
    const hub = 'test:hub:user-1'

    e.commandHandlers?.get('chatroom')?.(p, hubMsg(hub), [])
    await settle()
    executeChatroomCardAction(e, hub, '/chatroom-start-pick', 'continue 0')
    executeChatroomCardAction(e, hub, '/chatroom-mode-pick', 'start research-auto')
    await waitFor(() => p.sentCards.some(c => cardBody(c).includes('uv')), 'needs-uv error card')

    expect(p.count).toBe(0)
  })

  it('mode card cancel clears the state and spawns nothing', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    const home = await scaffoldHistory('旧议题', ['taleb', 'munger'])
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles(), moderatorDir: home })
    const hub = 'test:hub:user-1'

    e.commandHandlers?.get('chatroom')?.(p, hubMsg(hub), [])
    await settle()
    executeChatroomCardAction(e, hub, '/chatroom-start-pick', 'continue 0')
    const card = executeChatroomCardAction(e, hub, '/chatroom-mode-pick', 'cancel')
    await settle()

    expect(getChatroomModePickState(e, hub)).toBeUndefined()
    expect(p.count).toBe(0)
    expect(card).toBeDefined()
  })

  it('orphaned start/mode cards swap in the expired card', () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    const hub = 'test:hub:user-1'

    const startCard = executeChatroomCardAction(e, hub, '/chatroom-start-pick', 'new')
    const modeCard = executeChatroomCardAction(e, hub, '/chatroom-mode-pick', 'start plain')
    expect(startCard).toBeDefined()
    expect(modeCard).toBeDefined()
    expect(cardBody(startCard)).toContain('失效')
    expect(cardBody(modeCard)).toContain('失效')
  })

  it('bare /chatroom without recorded history goes straight to the topic picker', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    const home = await mkdtemp(join(tmpdir(), 'fb-guided-mod-'))
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles(), moderatorDir: home })
    const hub = 'test:hub:user-1'

    e.commandHandlers?.get('chatroom')?.(p, hubMsg(hub), [])
    await settle()

    expect(getChatroomStartPickState(e, hub)).toBeUndefined()
    expect(getChatroomTopicPickState(e, hub)).toBeDefined()
  })

  it('continue with explicit --research stashed starts immediately (no mode card)', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    const home = await scaffoldHistory('旧议题', ['taleb', 'munger'])
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles(), moderatorDir: home })
    const hub = 'test:hub:user-1'

    e.commandHandlers?.get('chatroom')?.(p, hubMsg(hub), ['--research'])
    await settle()
    const card = executeChatroomCardAction(e, hub, '/chatroom-start-pick', 'continue 0')
    await waitFor(() => p.count === 2, 'roles spawned')

    expect(getChatroomModePickState(e, hub)).toBeUndefined()
    expect(card).toBeDefined()
    const hubState = chatroomState(e.sessions.getOrCreateActive(hub))
    expect(hubState.chatroomResearch).toBe(true)
  })
})

describe('guided start: the role-picker handoff', () => {
  it('role-picker confirm with mode undecided swaps in the mode card instead of starting', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'

    e.commandHandlers?.get('chatroom')?.(p, hubMsg(hub), ['议题'])
    await settle()
    renderChatroomPickCardAndPush(e, hub, [
      { name: 'taleb', recommended: true, blurb: '' },
      { name: 'munger', recommended: true, blurb: '' },
    ])
    const card = executeChatroomCardAction(e, hub, '/chatroom-pick', 'confirm')
    await settle()

    expect(p.count).toBe(0) // nothing spawned yet
    const ms = getChatroomModePickState(e, hub)
    expect(ms?.topic).toBe('议题')
    expect([...(ms?.roles ?? [])].sort()).toEqual(['munger', 'taleb'])
    expect(cardBody(card)).toContain('议题')
  })

  it('role-picker confirm with a single role starts the direct chat (no mode card)', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'

    e.commandHandlers?.get('chatroom')?.(p, hubMsg(hub), ['议题'])
    await settle()
    renderChatroomPickCardAndPush(e, hub, [{ name: 'taleb', recommended: true, blurb: '' }])
    executeChatroomCardAction(e, hub, '/chatroom-pick', 'confirm')
    await settle()

    expect(getChatroomModePickState(e, hub)).toBeUndefined()
    const hubState = chatroomState(e.sessions.getOrCreateActive(hub))
    expect(hubState.chatroomDirectRole).toBe(true)
    expect(hubState.chatroomRoleName).toBe('taleb')
  })

  it('role-picker confirm with stashed --research starts immediately (no mode card)', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'

    e.commandHandlers?.get('chatroom')?.(p, hubMsg(hub), ['--research', '议题'])
    await settle()
    renderChatroomPickCardAndPush(e, hub, [
      { name: 'taleb', recommended: true, blurb: '' },
      { name: 'munger', recommended: true, blurb: '' },
    ])
    executeChatroomCardAction(e, hub, '/chatroom-pick', 'confirm')
    await waitFor(() => p.count === 2, 'roles spawned')

    expect(getChatroomModePickState(e, hub)).toBeUndefined()
    expect(chatroomState(e.sessions.getOrCreateActive(hub)).chatroomResearch).toBe(true)
  })
})

describe('guided start: explicit invocations', () => {
  it('/chatroom <roles> <topic> with no flags arms the mode card instead of starting', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'

    e.commandHandlers?.get('chatroom')?.(p, hubMsg(hub), ['taleb,munger', '议题'])
    await settle()

    expect(p.count).toBe(0) // not started yet
    const ms = getChatroomModePickState(e, hub)
    expect(ms?.topic).toBe('议题')
    expect(ms?.roles).toEqual(['taleb', 'munger'])
    expect(p.sentCards.map(cardBody).join('\n')).toContain('议题')
  })

  it('/chatroom --research <roles> <topic> starts immediately (mode already decided)', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'

    e.commandHandlers?.get('chatroom')?.(p, hubMsg(hub), ['--research', 'taleb,munger', '议题'])
    await waitFor(() => p.count === 2, 'roles spawned')

    expect(getChatroomModePickState(e, hub)).toBeUndefined()
    expect(chatroomState(e.sessions.getOrCreateActive(hub)).chatroomResearch).toBe(true)
  })

  it('bare --continue resolves the newest prior and arms the mode card with its cast', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    const home = await scaffoldHistory('旧议题', ['taleb', 'munger'])
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles(), moderatorDir: home })
    const hub = 'test:hub:user-1'

    e.commandHandlers?.get('chatroom')?.(p, hubMsg(hub), ['--continue'])
    await settle()

    expect(p.count).toBe(0) // mode undecided: stopped at the mode card
    const ms = getChatroomModePickState(e, hub)
    expect(ms?.topic).toBe('旧议题')
    expect(ms?.prior?.topic).toBe('旧议题')
    expect(ms?.roles).toEqual(['taleb', 'munger'])
  })

  it('guided continue with an empty-cast prior falls back to the role picker (explicit-path parity)', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    const home = await scaffoldHistory('旧议题', [])
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles(), moderatorDir: home })
    const hub = 'test:hub:user-1'

    e.commandHandlers?.get('chatroom')?.(p, hubMsg(hub), [])
    await settle()
    executeChatroomCardAction(e, hub, '/chatroom-start-pick', 'continue 0')
    await waitFor(() => getChatroomPickState(e, hub) !== undefined, 'role picker armed')

    expect(getChatroomModePickState(e, hub)).toBeUndefined()
    expect(p.count).toBe(0)
  })
})
