/**
 * Chatroom engine tests ported 1:1 from cc-connect
 * core/engine_chatroom_test.go. Assertion semantics match the Go stubs; sync
 * Go calls with async delivery tails get a settle()/waitFor tick before
 * counting platform sends. Command-level cases (cmdChatroom etc.) exercise
 * the chatroom-cmd module registered on the engine.
 *
 * @module dsh-feishu-bridge/tests-engine-chatroom
 */

import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Engine, InteractiveState } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { ProjectStateStore } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { registerSessionCommands } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { registerChatroomCommands } from '../../src/engine/chatroom-cmd.ts'
import {
  ChatroomGather,
  askHuman,
  askRole,
  endChatroom,
  interruptChatroom,
  listChatroomRoles,
  maybeAutoRelayRole,
  resolveChatroomHubKey,
  routePendingHumanReply,
  startChatroom,
} from '../../src/engine/chatroom.ts'
import { roleDir } from '../../src/engine/chatroom-roles.ts'
import {
  clearChatroomPickState,
  executeChatroomCardAction,
  executeChatroomPickAction,
  executeChatroomTopicPickAction,
  getChatroomPickState,
  getChatroomTopicPickState,
  renderChatroomPickCardAndPush,
  renderChatroomTopicPickCardAndPush,
} from '../../src/engine/chatroom-pick.ts'
import { Msg, type ChatroomMsgKey } from '../../src/i18n.ts'
import type { Message, Platform, SessionStartOptions } from '@deepseek-ai/dsh-feishu-bridge/exports'
import {
  clearCards,
  createStubAgent,
  createStubAgentSession,
  createStubChatroomSpawner,
  createStubChatroomSpawnerEx,
  newControllableSession,
  newStubMessage,
  type ControllableAgentSession,
  type RecordedCard,
} from '../stubs/engine-stubs.ts'
import { chatroomPolicyFace } from '../stubs/bridge-policy.ts'
import type { ChatroomPickState } from '../../src/engine/chatroom-pick.ts'
import { chatroomState } from '../../src/chatroom-state.ts'
import { chatroomConfig } from '../../src/chatroom-config.ts'
import '../stubs/messages.js'

/** One macrotask tick: flushes the microtask chain behind fire-and-forget sends. */
async function settle(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

async function waitFor(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await cond()) return
    if (Date.now() > deadline) throw new Error(`timeout waiting for: ${what}`)
    await settle()
  }
}

/** Go newChatroomTestEngine: engine + in-memory project state + commands. */
function newChatroomTestEngine(p: Platform): Engine {
  // The chatroom policy face (the production composition): persona start
  // options, ask auto-approval, and the policy waterfalls ride the listeners.
  const e = new Engine('test', createStubAgent(), [p], '', 'zh', chatroomPolicyFace())
  e.setProjectStateStore(new ProjectStateStore(''))
  registerSessionCommands(e)
  registerChatroomCommands(e)
  return e
}

/** Create a temp roles dir with two roles (Go scaffoldTwoRoles). */
async function scaffoldTwoRoles(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fb-chatroom-roles-'))
  for (const n of ['taleb', 'munger']) {
    await mkdir(join(root, n), { recursive: true })
    await writeFile(join(root, n, 'CLAUDE.md'), `# ${n}\n`, 'utf8')
  }
  return root
}

function hubMsg(hub: string, overrides: Partial<Message> = {}): Message {
  return { ...newStubMessage(), sessionKey: hub, platform: 'test', userID: 'user-1', replyCtx: 'hub-ctx', ...overrides }
}

/** The markdown body of a recorded card. */
function cardBody(card: unknown): string {
  const c = card as RecordedCard
  const first = c.elements[0]
  return first?.kind === 'markdown' ? (first.content ?? '') : ''
}

function cardTitle(card: unknown): string {
  return (card as RecordedCard).header?.title ?? ''
}

/** The armed role-picker state (the pick module's engine-keyed map). */
function pickStateOf(e: Engine, hub: string): { chatroomPick?: ChatroomPickState } {
  const state = getChatroomPickState(e, hub)
  return state === undefined ? {} : { chatroomPick: state }
}

describe('StartChatroom', () => {
  it('spawns idle roles and wires hub/role/parent links', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })

    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb', 'munger'], '程序员还要学算法吗')
    expect(roles).toHaveLength(2)
    expect(p.count).toBe(2)
    // Roles are spawned IDLE: no first message forwarded.
    for (const fm of p.firstMsgs) expect(fm).toBe('')
    const wantNames = ['taleb', 'munger']
    for (let i = 0; i < roles.length; i++) {
      const s = e.sessions.getOrCreateActive(roles[i]!.sessionKey)
      expect(chatroomState(s).chatroomHubKey).toBe(hub)
      expect(chatroomState(s).chatroomRoleName).toBe(wantNames[i])
      expect(s.getParentSessionKey()).toBe(hub)
      expect(s.getSubtaskDepth()).toBe(0)
    }
    // Each role group got a ready card.
    expect(p.sentCards).toHaveLength(2)
  })

  it('the role persona prompt resolves the role directory through the session key', async () => {
    // The persona prompt must flatten the ROLE directory's CLAUDE.md — the
    // workdir override startChatroom persists under the role's session key.
    // Resolving through the internal session id instead misses the override
    // and silently drops every role's persona (08e1428c75 regression).
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    await startChatroom(e, hub, ['taleb', 'munger'], 'topic')

    const roles = listChatroomRoles(e, hub)
    expect(roles).toHaveLength(2)
    const role = roles[0]!
    expect(role.name).toBe('taleb')
    const roleSession = e.sessions.getOrCreateActive(role.sessionKey)

    const options = e.buildSessionStartOptions(role.sessionKey, roleSession)
    expect(options.persona, 'a role session gets a persona block').toBeDefined()
    expect(options.persona?.prompt, 'the persona text comes from the role directory CLAUDE.md').toContain('# taleb')
  })

  it('fails fast on an unknown role without spawning', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    await expect(startChatroom(e, 'test:hub:user-1', ['taleb', 'ghost'], 'topic')).rejects.toThrow()
    expect(p.count).toBe(0)
  })

  it('enforces the per-chatroom role cap', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    chatroomConfig(e).applySection({ maxRoles: 1 })
    await expect(startChatroom(e, 'test:hub:user-1', ['taleb', 'munger'], 'topic')).rejects.toThrow()
  })

  it('defaults to every role under the roles dir, sorted', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const roles = await startChatroom(e, 'test:hub:user-1', undefined, 'topic')
    expect(p.count).toBe(2)
    expect(roles.map(r => r.name)).toEqual(['munger', 'taleb'])
  })

  it('errors when no roles are configured', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await mkdtemp(join(tmpdir(), 'fb-empty-roles-')) })
    await expect(startChatroom(e, 'test:hub:user-1', undefined, 'topic')).rejects.toThrow()
    expect(p.count).toBe(0)
  })

  it('prefers the Ex spawner and passes the role dir as workdir', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    const rolesDir = await scaffoldTwoRoles()
    chatroomConfig(e).applySection({ rolesDir: rolesDir })

    const roles = await startChatroom(e, 'test:hub:user-1', ['taleb', 'munger'], 'topic')
    expect(p.exOpts).toHaveLength(2)
    for (let i = 0; i < 2; i++) {
      expect(p.exOpts[i]?.workDir).toBe(roleDir(rolesDir, i === 0 ? 'taleb' : 'munger'))
      expect(p.exFirst[i]).toBe('')
    }
    expect(roles).toHaveLength(2)
  })

  it('a mid-spawn failure leaves the hub stoppable: /chatroom stop reaps the orphan role groups', async () => {
    // Role 2's spawn fails after role 1's group already exists. The hub has
    // no chatroomModerator flag until afterChatroomStarted — which never
    // runs on the error path — so resolveChatroomHubKey could not resolve
    // the hub from the hub group itself and /chatroom stop there answered
    // not-in-room while the orphan groups live on.
    const p = createStubChatroomSpawnerEx()
    const ex = p.spawnGroupWithOptions.bind(p)
    let spawnCalls = 0
    p.spawnGroupWithOptions = async (msg, groupName, firstMsg, opts) => {
      spawnCalls++
      if (spawnCalls === 2) throw new Error('spawn boom')
      return ex(msg, groupName, firstMsg, opts)
    }
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'

    await expect(startChatroom(e, hub, ['taleb', 'munger'], 'topic')).rejects.toThrow('spawn boom')
    expect(listChatroomRoles(e, hub)).toHaveLength(1) // taleb is an orphan now

    // The hub group must resolve to its own chatroom so stop works from there.
    expect(resolveChatroomHubKey(e, hub)).toBe(hub)

    // And the interrupt reaps the orphan groups.
    const res = interruptChatroom(e, hub)
    expect(res.rolesRemoved).toBe(1)
    expect(listChatroomRoles(e, hub)).toHaveLength(0)
    expect(chatroomState(e.sessions.getOrCreateActive(hub)).chatroomModerator).toBe(false)
  })
})

describe('AskRole', () => {
  it('clears the in-flight flag when the ask card send fails, so end does not drain a phantom', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    const roleKey = roles[0]!.sessionKey
    vi.spyOn(e, 'sendAsCard').mockRejectedValueOnce(new Error('card send boom'))

    await expect(askRole(e, hub, 'taleb', '问题')).rejects.toThrow('card send boom')

    // No phantom in-flight flag: endChatroom must tear down immediately
    // instead of arming a drain barrier for a turn that never started.
    expect(chatroomState(e.sessions.getOrCreateActive(roleKey)).chatroomInFlight).toBe(false)
    expect(endChatroom(e, hub).status).toBe('ended')
  })

  it('re-arms the relay and posts the question as a card', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    const roleKey = roles[0]!.sessionKey
    chatroomState(e.sessions.getOrCreateActive(roleKey)).chatroomAsked = true
    clearCards(p)

    await askRole(e, hub, 'taleb', '你怎么看厚尾风险？')
    await settle()
    expect(chatroomState(e.sessions.getOrCreateActive(roleKey)).chatroomAsked).toBe(false)
    expect(p.sentCards).toHaveLength(1)
  })

  it('resolves by session key and by name; unknown ref errors', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    await expect(askRole(e, hub, roles[0]!.sessionKey, 'q')).resolves.toBeUndefined()
    await expect(askRole(e, hub, 'taleb', 'q')).resolves.toBeUndefined()
    await expect(askRole(e, hub, 'ghost', 'q')).rejects.toThrow()
  })

  it('rejects a role belonging to another chatroom', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const roles = await startChatroom(e, 'test:hub-A:user-1', ['taleb'], 'topic')
    await expect(askRole(e, 'test:hub-B:user-2', roles[0]!.sessionKey, 'q')).rejects.toThrow()
  })
})

describe('maybeAutoRelayRole', () => {
  const hub = 'test:hub:user-1'

  function newRole(e: Engine, asked: boolean): { key: string; role: ReturnType<Engine['sessions']['getOrCreateActive']> } {
    const role = e.sessions.getOrCreateActive('test:role-chat')
    chatroomState(role).chatroomHubKey = hub
    chatroomState(role).chatroomRoleName = 'Taleb'
    chatroomState(role).chatroomAsked = asked
    role.setParentSessionKey(hub)
    return { key: 'test:role-chat', role }
  }

  it('relays the reply to the hub and consumes the gate', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    const { role } = newRole(e, false)
    const st = new InteractiveState()
    st.platform = p
    maybeAutoRelayRole(e, st, role, '厚尾下平均会骗人，别用点预测', false)
    await waitFor(() => p.sentCards.length === 1, 'relay card')
    expect(chatroomState(role).chatroomAsked).toBe(true)
    const body = cardBody(p.sentCards[0])
    expect(body).toContain('【Taleb】')
    expect(body).toContain('厚尾下平均会骗人')
  })

  it('skips when already asked this round', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    newRole(e, true)
    const st = new InteractiveState()
    st.platform = p
    const role = e.sessions.getOrCreateActive('test:role-chat')
    maybeAutoRelayRole(e, st, role, 'reply', false)
    await settle()
    expect(p.sentCards).toHaveLength(0)
  })

  it('silent/empty reply wakes without a card and consumes the gate', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    const { role } = newRole(e, false)
    const st = new InteractiveState()
    st.platform = p
    maybeAutoRelayRole(e, st, role, '   ', false)
    await settle()
    // No card posted for an empty reply, but the gate is consumed so the
    // moderator is woken (no stall on NO_REPLY).
    expect(p.sentCards).toHaveLength(0)
    expect(chatroomState(role).chatroomAsked).toBe(true)
    // A second turn-end on the same role is gated out (no double wake/card).
    maybeAutoRelayRole(e, st, role, 'shh', true)
    await settle()
    expect(p.sentCards).toHaveLength(0)
  })

  it('skips non-role sessions', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    const plain = e.sessions.getOrCreateActive('test:plain-chat') // no chatroomHubKey
    const st = new InteractiveState()
    st.platform = p
    maybeAutoRelayRole(e, st, plain, 'hi', false)
    await settle()
    expect(p.sentCards).toHaveLength(0)
  })

  it('defers the research dispatch turn and relays the conclusion turn', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    const role = e.sessions.getOrCreateActive('test:role-chat')
    chatroomState(role).chatroomHubKey = hub
    chatroomState(role).chatroomRoleName = 'Taleb'
    chatroomState(role).chatroomAsked = false
    chatroomState(role).researchAwaitingAssistant = true
    chatroomState(role).researchDispatched = true
    const st = new InteractiveState()
    st.platform = p

    // Turn 1 (dispatched an assistant): must NOT relay — the conclusion
    // comes on the next turn after the assistant reports back.
    maybeAutoRelayRole(e, st, role, '已派助手去拉数据', false)
    await settle()
    expect(chatroomState(role).researchAwaitingAssistant).toBe(false)
    expect(chatroomState(role).chatroomAsked).toBe(false)
    expect(p.sentCards).toHaveLength(0)
    expect(chatroomState(role).researchDispatched).toBe(true)

    // Turn 2 (assistant reported → role produces conclusion): relay normally.
    maybeAutoRelayRole(e, st, role, '沪深300未过热，可定投', false)
    await waitFor(() => p.sentCards.length === 1, 'turn-2 relay')
    expect(chatroomState(role).chatroomAsked).toBe(true)
  })

  it('relays the in-turn conclusion once the dispatched assistant reported back', async () => {
    // Live-run shape (2026-09-02 oc_e51a): the role dispatches its assistant
    // and blocks on the subtask gather INSIDE the same turn; the assistant's
    // report resolves that gather and the role concludes before turn end.
    // That turn-end reply IS the conclusion — deferring it strands the armed
    // gather until the research timeout, because the assistant already
    // reported and no later conclusion turn will ever come.
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    const { role } = newRole(e, false)
    const hubSess = e.sessions.getOrCreateActive(hub)
    const g = new ChatroomGather('并行研究', 2)
    g.expected.add('Taleb')
    g.expected.add('Munger')
    chatroomState(hubSess).pendingGather = g

    const assistant = e.sessions.getOrCreateActive('test:assistant-chat')
    assistant.setSubtaskReported(true)
    chatroomState(role).researchAwaitingAssistant = true
    chatroomState(role).researchDispatched = true
    chatroomState(role).researchAssistantKey = 'test:assistant-chat'
    chatroomState(role).chatroomAskSeq = 2
    chatroomState(role).chatroomInFlight = true

    const st = new InteractiveState()
    st.platform = p
    maybeAutoRelayRole(e, st, role, '第 1 轮结论：三问全答', false)
    await settle()

    expect(g.collected.get('Taleb')).toBe('第 1 轮结论：三问全答')
    expect(chatroomState(hubSess).pendingGather).toBe(g)
    expect(chatroomState(role).chatroomAsked).toBe(true)
  })

  it('still defers while the dispatched assistant has a turn in flight', async () => {
    // The marks-r1 shape: the role re-dispatched mid-round and ended its
    // turn while the assistant was verifiably still working.
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    const { role } = newRole(e, false)
    const hubSess = e.sessions.getOrCreateActive(hub)
    const g = new ChatroomGather('并行研究', 2)
    g.expected.add('Taleb')
    chatroomState(hubSess).pendingGather = g

    const assistant = e.sessions.getOrCreateActive('test:assistant-chat')
    assistant.setSubtaskReported(true)
    const assistantTurn = new InteractiveState()
    assistantTurn.beginTurn()
    e.interactiveStates.set('test:assistant-chat', assistantTurn)
    chatroomState(role).researchAwaitingAssistant = true
    chatroomState(role).researchDispatched = true
    chatroomState(role).researchAssistantKey = 'test:assistant-chat'
    chatroomState(role).chatroomAskSeq = 2

    const st = new InteractiveState()
    st.platform = p
    maybeAutoRelayRole(e, st, role, '助手还在跑', false)
    await settle()

    expect(g.collected.size).toBe(0)
    expect(chatroomState(role).researchAwaitingAssistant).toBe(false)
    expect(chatroomState(role).chatroomAsked).toBe(false)
  })

  it('still defers when the assistant has not reported its dispatch cycle', async () => {
    // Silent or re-armed assistant (a parent follow-up resets the one-shot
    // report): the report is still owed, so the conclusion must wait.
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    const { role } = newRole(e, false)
    const hubSess = e.sessions.getOrCreateActive(hub)
    const g = new ChatroomGather('并行研究', 2)
    g.expected.add('Taleb')
    chatroomState(hubSess).pendingGather = g

    const assistant = e.sessions.getOrCreateActive('test:assistant-chat')
    assistant.setSubtaskReported(false)
    chatroomState(role).researchAwaitingAssistant = true
    chatroomState(role).researchDispatched = true
    chatroomState(role).researchAssistantKey = 'test:assistant-chat'
    chatroomState(role).chatroomAskSeq = 2

    const st = new InteractiveState()
    st.platform = p
    maybeAutoRelayRole(e, st, role, '等助手回报', false)
    await settle()

    expect(g.collected.size).toBe(0)
    expect(chatroomState(role).researchAwaitingAssistant).toBe(false)
    expect(chatroomState(role).chatroomAsked).toBe(false)
  })

  it('still defers when the assistant session cannot be resolved', async () => {
    // A stale key (assistant dissolved with an earlier room) reads as
    // pending — the conservative defer keeps the pre-fix behavior.
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    const { role } = newRole(e, false)
    const hubSess = e.sessions.getOrCreateActive(hub)
    const g = new ChatroomGather('并行研究', 2)
    g.expected.add('Taleb')
    chatroomState(hubSess).pendingGather = g

    chatroomState(role).researchAwaitingAssistant = true
    chatroomState(role).researchDispatched = true
    chatroomState(role).researchAssistantKey = 'test:gone-assistant'
    chatroomState(role).chatroomAskSeq = 2

    const st = new InteractiveState()
    st.platform = p
    maybeAutoRelayRole(e, st, role, '保守处理', false)
    await settle()

    expect(g.collected.size).toBe(0)
    expect(chatroomState(role).chatroomAsked).toBe(false)
  })

  it('relays an undispatched turn immediately (direct answer)', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    const role = e.sessions.getOrCreateActive('test:role-chat')
    chatroomState(role).chatroomHubKey = hub
    chatroomState(role).chatroomRoleName = 'Taleb'
    chatroomState(role).chatroomAsked = false
    chatroomState(role).researchAwaitingAssistant = true
    const st = new InteractiveState()
    st.platform = p

    maybeAutoRelayRole(e, st, role, '问题简单，直接答：结论是……', false)
    await waitFor(() => p.sentCards.length === 1, 'direct answer relay')
    expect(chatroomState(role).researchAwaitingAssistant).toBe(false)
    expect(chatroomState(role).chatroomAsked).toBe(true)
  })
})

describe('AskHuman', () => {
  it('marks the hub pending and posts the ⏸ card', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    clearCards(p)

    await askHuman(e, roles[0]!.sessionKey, '小孩入学落户截止日是哪天？')
    await settle()
    expect(chatroomState(e.sessions.getOrCreateActive(hub)).pendingHumanQuestionRole).toBe('taleb')
    expect(p.sentCards).toHaveLength(1)
  })

  it('rejects non-role sessions', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    await startChatroom(e, 'test:hub:user-1', ['taleb'], 'topic')
    e.sessions.getOrCreateActive('test:plain:user-1')
    await expect(askHuman(e, 'test:plain:user-1', 'hi?')).rejects.toThrow()
  })
})

describe('pending human reply routing', () => {
  it('routes the human reply to the pending role and clears the flag', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    await askHuman(e, roles[0]!.sessionKey, '落户截止日是哪天？')

    clearCards(p)
    const routed = routePendingHumanReply(e, p, hub, '2029-07-01')
    expect(routed).toBe(true)
    await waitFor(() => p.sentCards.length === 1, 'routed reply card')
    expect(chatroomState(e.sessions.getOrCreateActive(hub)).pendingHumanQuestionRole).toBe('')
    expect(chatroomState(e.sessions.getOrCreateActive(roles[0]!.sessionKey)).chatroomAsked).toBe(false)
  })

  it('skips slash commands (they must not be consumed as a reply)', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    await askHuman(e, roles[0]!.sessionKey, '落户截止日？')

    expect(routePendingHumanReply(e, p, hub, '/list')).toBe(false)
    expect(chatroomState(e.sessions.getOrCreateActive(hub)).pendingHumanQuestionRole).toBe('taleb')
  })

  it('consumes the reply through the inbound pipeline before command dispatch', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    await askHuman(e, roles[0]!.sessionKey, '落户截止日？')
    clearCards(p)

    // A plain-text human reply routes to the pending role through the
    // route-human-reply seam inside receiveMessage — outranking command
    // dispatch and permission handling.
    e.receiveMessage(p, hubMsg(hub, { content: '2029-07-01' }))
    await waitFor(() => p.sentCards.length === 1, 'routed reply card')
    expect(chatroomState(e.sessions.getOrCreateActive(hub)).pendingHumanQuestionRole).toBe('')
  })

  it('routes through the bridge seam: the listener half short-circuits, the base falls through', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    await askHuman(e, roles[0]!.sessionKey, '落户截止日？')
    clearCards(p)

    // Listener half: a pending question consumes the reply (true before the
    // base); a slash command falls through to the base's false.
    expect(e.bridge.waterfall('feishuBridge/route-human-reply', { engine: e, platform: p, sessionKey: hub, content: '/list', machine: false }, () => false)).toBe(false)
    expect(e.bridge.waterfall('feishuBridge/route-human-reply', { engine: e, platform: p, sessionKey: hub, content: '2029-07-01', machine: false }, () => false)).toBe(true)
    expect(chatroomState(e.sessions.getOrCreateActive(hub)).pendingHumanQuestionRole).toBe('')
    await waitFor(() => p.sentCards.length === 1, 'routed reply card')

    // Base: no question pending anymore, the dispatch returns false.
    expect(e.bridge.waterfall('feishuBridge/route-human-reply', { engine: e, platform: p, sessionKey: hub, content: 'another', machine: false }, () => false)).toBe(false)
  })
})

describe('ListChatroomRoles', () => {
  it('lists the wired roles with session keys', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    await startChatroom(e, 'test:hub:user-1', ['taleb', 'munger'], 'topic')
    const got = listChatroomRoles(e, 'test:hub:user-1')
    expect(got).toHaveLength(2)
    const names = got.map(r => r.name)
    expect(names).toContain('taleb')
    expect(names).toContain('munger')
    for (const r of got) expect(r.sessionKey).not.toBe('')
  })
})

describe('EndChatroom teardown of non-role children', () => {
  it('marks roles done and leaves non-role children alone', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const started = await startChatroom(e, hub, ['taleb', 'munger'], 'topic')
    const roleKeys = new Set(started.map(r => r.sessionKey))
    // A plain /spawn-style child of the hub (no chatroomHubKey) must be left
    // alone — EndChatroom only tears down chatroom roles.
    const plain = e.sessions.getOrCreateActive('test:plain-child')
    plain.setParentSessionKey(hub)

    const { endChatroom } = await import('../../src/engine/chatroom.ts')
    const res = endChatroom(e, hub)
    expect(res.status).toBe('ended')
    await waitFor(() => p.doneKeys.length === 2, '2 roles cleaned')
    for (const k of p.doneKeys) expect(roleKeys.has(k)).toBe(true)
    // Ended roles no longer appear in ListChatroomRoles.
    expect(listChatroomRoles(e, hub)).toHaveLength(0)
  })
})

describe('cmdChatroom', () => {
  it('spawns roles and posts a summary card with the topic', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const handler = e.commandHandlers?.get('chatroom')
    expect(handler).toBeDefined()
    handler?.(p, hubMsg(hub), ['taleb,munger', '程序员还要学算法吗'])
    await waitFor(() => p.count === 2, '2 roles spawned')
    expect(listChatroomRoles(e, hub)).toHaveLength(2)
    await waitFor(() => p.sentCards.some(c => cardBody(c).includes('程序员还要学算法吗')), 'summary card')
  })

  it('missing topic prints usage and spawns nothing', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const handler = e.commandHandlers?.get('chatroom')
    handler?.(p, hubMsg('test:hub:user-1'), ['taleb,munger'])
    await settle()
    expect(p.count).toBe(0)
    expect(p.getSent().some(s => s.includes('用法'))).toBe(true)
  })

  it('unknown role spawns nothing (fail-fast)', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const handler = e.commandHandlers?.get('chatroom')
    handler?.(p, hubMsg('test:hub:user-1'), ['taleb,ghost', 'topic'])
    await settle()
    expect(p.count).toBe(0)
  })

  it('blocks startup when the configured user profile is unreadable', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    chatroomConfig(e).applySection({ userProfile: '/nonexistent/fb-user-profile.md' })
    const handler = e.commandHandlers?.get('chatroom')
    handler?.(p, hubMsg('test:hub:user-1'), ['taleb,munger', 'topic'])
    await settle()
    expect(p.count).toBe(0)
    expect(p.getSent().some(s => s.includes('用户背景'))).toBe(true)
    // The research flags never land on the hub.
    expect(chatroomState(e.sessions.getOrCreateActive('test:hub:user-1')).chatroomResearch).toBe(false)
  })

  it('rejects a second open while live role groups exist (stop first)', async () => {
    // No re-entry guard existed for direct→multi-role or repeated opens: a
    // second /chatroom would spawn a NEW generation of role groups under the
    // same hub while the old ones live on.
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    await startChatroom(e, hub, ['taleb'], '第一场')
    const handler = e.commandHandlers?.get('chatroom')

    handler?.(p, hubMsg(hub), ['taleb,munger', '第二场'])
    await settle()
    await settle()

    expect(p.getSent().some(s => s.includes('已有聊天室在进行中'))).toBe(true)
    // No second generation of role groups.
    expect(p.count).toBe(1)
    expect(listChatroomRoles(e, hub)).toHaveLength(1)
  })

  it('--roles with two roles overrides the default and spawns', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const handler = e.commandHandlers?.get('chatroom')
    handler?.(p, hubMsg('test:hub:user-1'), ['--roles', 'taleb,munger', '议题'])
    await waitFor(() => p.count === 2, '2 roles via --roles')
  })

  it('single-role positional enters direct 1:1 mode without spawning', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    const rolesDir = await scaffoldTwoRoles()
    chatroomConfig(e).applySection({ rolesDir: rolesDir })
    const hub = 'test:hub:user-1'
    const handler = e.commandHandlers?.get('chatroom')
    handler?.(p, hubMsg(hub), ['taleb', '厚尾下的预测失效'])
    await settle()
    expect(p.count).toBe(0)
    expect(listChatroomRoles(e, hub)).toHaveLength(0)
    const s = e.sessions.getOrCreateActive(hub)
    expect(chatroomState(s).chatroomDirectRole).toBe(true)
    expect(chatroomState(s).chatroomHubKey).toBe('')
    expect(chatroomState(s).chatroomRoleName).toBe('taleb')
    // Workdir override points at the role persona dir.
    expect(e.perChatWorkDir(e.dirOverrideKey(hub))).toBe(roleDir(rolesDir, 'taleb'))
  })

  it('direct-role wake carries the bare topic with no plan-mode hint', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const wakes: Message[] = []
    const orig = e.receiveMessage.bind(e)
    e.receiveMessage = (plat, m) => { wakes.push(m); orig(plat, m) }
    const handler = e.commandHandlers?.get('chatroom')
    handler?.(p, hubMsg('test:hub:user-1'), ['taleb', '厚尾下的预测失效'])
    await settle()
    const wake = wakes.find(m => m.content.includes('厚尾下的预测失效'))
    expect(wake?.content).toBe('厚尾下的预测失效')
  })

  it('multi-role after a direct-role session clears the direct flag', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const handler = e.commandHandlers?.get('chatroom')
    handler?.(p, hubMsg(hub), ['taleb', '议题一'])
    await settle()
    expect(chatroomState(e.sessions.getOrCreateActive(hub)).chatroomDirectRole).toBe(true)

    handler?.(p, hubMsg(hub), ['taleb,munger', '议题二'])
    await waitFor(() => p.count === 2, 'roles spawned')
    // The ready cards now carry the status footer (async git probe), so the
    // after-start flag clear trails the last spawn by a beat.
    await waitFor(() => !chatroomState(e.sessions.getOrCreateActive(hub)).chatroomDirectRole, 'direct flag cleared')
  })

  it('stashes --research/--mode/--max-rounds on the picker path', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const handler = e.commandHandlers?.get('chatroom')
    handler?.(p, hubMsg(hub), ['--research', '--mode', 'manual', '--max-rounds', '5', '研究中国股市是否过热'])
    await settle()
    const s = e.sessions.getOrCreateActive(hub)
    expect(chatroomState(s).chatroomResearch).toBe(true)
    expect(chatroomState(s).chatroomResearchMode).toBe('manual')
    expect(chatroomState(s).chatroomResearchMaxRounds).toBe(5)
    expect(p.count).toBe(0)
  })

  it('stashes --research on the explicit multi-role path and pre-spawns assistants', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const handler = e.commandHandlers?.get('chatroom')
    handler?.(p, hubMsg(hub), ['--research', 'taleb,munger', '研究中国股市是否过热'])
    // 2 role groups + 2 research-assistant subgroups = 4. The assistant
    // sessions register per role after that role's ready card (whose footer
    // runs an async git probe), so wait for both.
    await waitFor(() => p.count === 4, '2 roles + 2 assistants')
    await waitFor(() => e.collectSubtree(hub)
      .map(k => e.sessions.getOrCreateActive(k))
      .filter(sess => chatroomState(sess).researchAssistant).length === 2, 'assistant sessions registered')
    const s = e.sessions.getOrCreateActive(hub)
    expect(chatroomState(s).chatroomResearch).toBe(true)
    expect(chatroomState(s).chatroomResearchMode).toBe('auto')
    const assistants = e.collectSubtree(hub)
      .map(k => e.sessions.getOrCreateActive(k))
      .filter(sess => chatroomState(sess).researchAssistant)
    expect(assistants).toHaveLength(2)
  })

  it('rejects --research with a single role (no moderator orchestration)', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const handler = e.commandHandlers?.get('chatroom')
    handler?.(p, hubMsg(hub), ['--research', 'taleb', '议题'])
    await settle()
    const sess = e.sessions.getOrCreateActive(hub)
    expect(chatroomState(sess).chatroomDirectRole).toBe(false)
    expect(chatroomState(sess).chatroomResearch).toBe(false)
    expect(p.sentCards).toHaveLength(0)
    expect(p.getSent().some(c => c.includes('research'))).toBe(true)
  })

  it('rejects out-of-range --max-rounds before any spawn', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const handler = e.commandHandlers?.get('chatroom')
    handler?.(p, hubMsg('test:hub:user-1'), ['--research', '--max-rounds', '99', 'taleb,munger', '议题'])
    await settle()
    expect(p.firstMsgs).toHaveLength(0)
    expect(p.getSent().some(c => c.includes('max-rounds'))).toBe(true)
  })

  it('topic-only begins the #43 role picker (no spawn)', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const handler = e.commandHandlers?.get('chatroom')
    handler?.(p, hubMsg(hub), ['大模型时代程序员还要学算法吗'])
    await settle()
    expect(p.count).toBe(0)
    const ps = pickStateOf(e, hub).chatroomPick
    expect(ps).toBeDefined()
    expect(ps?.phase).toBe('picking')
    expect(ps?.topic).toBe('大模型时代程序员还要学算法吗')
    // A "picking" notice card was sent to the hub.
    expect(p.sentCards.some(c => cardBody(c).includes('挑选角色'))).toBe(true)
  })

  it('empty topic begins the #59 topic picker', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const handler = e.commandHandlers?.get('chatroom')
    handler?.(p, hubMsg(hub), [])
    await settle()
    expect(p.count).toBe(0)
    expect(getChatroomTopicPickState(e, hub)?.phase).toBe('picking')
    expect(getChatroomPickState(e, hub)).toBeUndefined()
    expect(p.sentCards.some(c => cardBody(c).includes('候选题目'))).toBe(true)
  })

  it('pick wakes carry modeOverride default so the pick turn never runs in plan mode', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const wakes: Message[] = []
    const orig = e.receiveMessage.bind(e)
    e.receiveMessage = (plat, m) => { wakes.push(m); orig(plat, m) }
    const handler = e.commandHandlers?.get('chatroom')
    handler?.(p, hubMsg('test:hub:user-1'), ['大模型时代程序员还要学算法吗'])
    await settle()
    expect(wakes.at(-1)?.modeOverride).toBe('default')
    handler?.(p, hubMsg('test:hub:user-2'), [])
    await settle()
    expect(wakes.at(-1)?.modeOverride).toBe('default')
  })

  it('roles without topic falls back to usage (no picker armed)', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const handler = e.commandHandlers?.get('chatroom')
    handler?.(p, hubMsg(hub), ['--roles', 'taleb,munger'])
    await settle()
    expect(getChatroomTopicPickState(e, hub)).toBeUndefined()
    expect(getChatroomPickState(e, hub)).toBeUndefined()
    expect(p.count).toBe(0)
  })

  it('--research with no topic stashes the flag (topic-pick path)', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const handler = e.commandHandlers?.get('chatroom')
    handler?.(p, hubMsg(hub), ['--research'])
    await settle()
    expect(chatroomState(e.sessions.getOrCreateActive(hub)).chatroomResearch).toBe(true)
  })

  it('list renders a card with role essences and spawns nothing', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    const root = await mkdtemp(join(tmpdir(), 'fb-chatroom-list-'))
    const gDir = join(root, 'graham')
    await mkdir(gDir, { recursive: true })
    await writeFile(join(gDir, 'CLAUDE.md'), '# graham\n', 'utf8')
    await writeFile(join(gDir, 'ESSENCE.md'), '## 核心框架\n\n根心智模型 = **margin of safety（安全边际）**：缓冲垫\n', 'utf8')
    await mkdir(join(root, 'munger'), { recursive: true })
    await writeFile(join(root, 'munger', 'CLAUDE.md'), '# munger\n', 'utf8')
    chatroomConfig(e).applySection({ rolesDir: root })

    const hub = 'test:hub:user-1'
    const handler = e.commandHandlers?.get('chatroom')
    handler?.(p, hubMsg(hub), ['list'])
    await settle()
    expect(p.count).toBe(0)
    expect(listChatroomRoles(e, hub)).toHaveLength(0)
    expect(p.sentCards).toHaveLength(1)
    expect(cardTitle(p.sentCards[0])).toContain('2')
  })

  it('list on an empty roles dir sends no card (text fallback)', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await mkdtemp(join(tmpdir(), 'fb-empty-list-')) })
    const handler = e.commandHandlers?.get('chatroom')
    handler?.(p, hubMsg('test:hub:user-1'), ['列表'])
    await settle()
    expect(p.count).toBe(0)
    expect(p.sentCards).toHaveLength(0)
  })
})

describe('hub rename on /chatroom', () => {
  it('renames the hub group to the topic via renameGroupAny', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const handler = e.commandHandlers?.get('chatroom')
    handler?.(p, hubMsg(hub, { chatType: 'group' }), ['taleb,munger', '换房计划'])
    await waitFor(() => p.renamedAnyCalls().length > 0, 'hub renamed')
    const calls = p.renamedAnyCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.key).toBe(hub)
    expect(calls[0]?.name).toBe('换房计划')
  })

  it('single-role direct path also renames the hub', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const handler = e.commandHandlers?.get('chatroom')
    handler?.(p, hubMsg(hub, { chatType: 'group' }), ['taleb', '厚尾下的预测失效'])
    await waitFor(() => p.renamedAnyCalls().length > 0, 'hub renamed (single-role)')
    const calls = p.renamedAnyCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.key).toBe(hub)
    expect(calls[0]?.name).toBe('厚尾下的预测失效')
  })

  it('skips p2p chats (no group name to set)', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const handler = e.commandHandlers?.get('chatroom')
    handler?.(p, hubMsg('test:hub:user-1', { chatType: 'p2p' }), ['taleb,munger', 'topic'])
    await settle()
    await settle()
    expect(p.renamedAnyCalls()).toHaveLength(0)
  })

  it('truncates a long topic to the 60-rune ceiling with ... suffix', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const handler = e.commandHandlers?.get('chatroom')
    const longTopic = '字'.repeat(80)
    handler?.(p, hubMsg(hub, { chatType: 'group' }), ['taleb,munger', longTopic])
    await waitFor(() => p.renamedAnyCalls().length > 0, 'hub renamed')
    const calls = p.renamedAnyCalls()
    expect(calls).toHaveLength(1)
    const name = calls[0]?.name ?? ''
    expect(Array.from(name)).toHaveLength(60)
    expect(name.endsWith('...')).toBe(true)
  })

  it('works without a GroupRenamer (no panic, roles still spawn)', async () => {
    // stubChatroomSpawner implements spawnGroup but NOT renameGroupAny.
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const handler = e.commandHandlers?.get('chatroom')
    handler?.(p, hubMsg('test:hub:user-1', { chatType: 'group' }), ['taleb,munger', 'topic'])
    await waitFor(() => p.count === 2, '2 roles spawned without renamer')
  })
})

describe('RenderChatroomPickCard', () => {
  it('drops hallucinated roles and preselects recommended', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const handler = e.commandHandlers?.get('chatroom')
    handler?.(p, hubMsg(hub), ['议题'])
    await settle()

    renderChatroomPickCardAndPush(e, hub, [
      { name: 'taleb', recommended: true, blurb: 'why' },
      { name: 'ghost', recommended: false, blurb: 'hallucinated' },
    ])
    const ps = pickStateOf(e, hub).chatroomPick
    expect(ps?.phase).toBe('select')
    expect(ps?.recs.map(r => r.name)).toEqual(['taleb'])
    expect(ps?.selected.get('taleb')).toBe(true)
  })

  it('overrides the watchdog fallback (late curated recommendations win)', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const handler = e.commandHandlers?.get('chatroom')
    handler?.(p, hubMsg(hub), ['议题'])
    await settle()

    // Simulate the watchdog having fired: phase 'select', all roles, none
    // selected, stale hint.
    const ps = pickStateOf(e, hub).chatroomPick
    expect(ps).toBeDefined()
    ps!.phase = 'select'
    ps!.hint = '主持人未及时推荐，已列出全部角色供你自选。'
    ps!.recs = ps!.allNames.map(n => ({ name: n, recommended: false, blurb: '' }))
    ps!.selected = new Map()

    renderChatroomPickCardAndPush(e, hub, [{ name: 'taleb', recommended: true, blurb: 'why' }])
    expect(ps!.phase).toBe('select')
    expect(ps!.recs.map(r => r.name)).toEqual(['taleb'])
    expect(ps!.selected.get('taleb')).toBe(true)
    expect(ps!.hint).toBe('')
  })

  it('preserves user selections after a toggle (late pick-roles ignored)', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const handler = e.commandHandlers?.get('chatroom')
    handler?.(p, hubMsg(hub), ['议题'])
    await settle()

    // Simulate the watchdog fallback card: phase 'select', all roles listed.
    const ps = pickStateOf(e, hub).chatroomPick
    ps!.phase = 'select'
    ps!.recs = ps!.allNames.map(n => ({ name: n, recommended: false, blurb: '' }))
    ps!.selected = new Map()

    // User toggles "munger" on the fallback card.
    executeChatroomPickAction(e, hub, 'toggle munger')

    // The moderator's pick-roles finally arrives, recommending only taleb.
    renderChatroomPickCardAndPush(e, hub, [{ name: 'taleb', recommended: true, blurb: 'why' }])
    expect(ps!.selected.get('munger')).toBe(true)
    expect(ps!.selected.get('taleb')).toBeUndefined()
    expect(ps!.recs).toHaveLength(ps!.allNames.length)
    expect(ps!.userTouched).toBe(true)
  })
})

describe('chatroomPickActive', () => {
  it('is true only during the picking phase', async () => {
    const { chatroomPickActive } = await import('../../src/engine/chatroom-pick.ts')
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const handler = e.commandHandlers?.get('chatroom')
    expect(chatroomPickActive(e, hub)).toBe(false)

    handler?.(p, hubMsg(hub), ['议题'])
    await settle()
    expect(chatroomPickActive(e, hub)).toBe(true)

    const ps = pickStateOf(e, hub).chatroomPick
    ps!.phase = 'select'
    expect(chatroomPickActive(e, hub)).toBe(false)

    // Cleared (confirm/cancel) → not active.
    clearChatroomPickState(e, hub)
    expect(chatroomPickActive(e, hub)).toBe(false)
  })

  it('a plan-review ask inside the pick window auto-approves without a card', async () => {
    const { chatroomPickActive } = await import('../../src/engine/chatroom-pick.ts')
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const handler = e.commandHandlers?.get('chatroom')
    handler?.(p, hubMsg(hub), ['议题'])
    await settle()
    expect(chatroomPickActive(e, hub)).toBe(true)

    // The moderator's plan review in the pick window is a formality (priming
    // pre-bakes a trivial plan): the ask settles allowed-once with no card.
    clearCards(p)
    await expect(e.askUser(hub, { kind: 'plan-review', heading: '# P', plan: '# P' }))
      .resolves.toEqual({ outcome: 'allowed-once' })
    expect(p.sentCards).toHaveLength(0)
  })
})

describe('ExecuteChatroomPickAction', () => {
  async function armedPicker(e: Engine, p: Platform, hub: string): Promise<ChatroomPickState> {
    const handler = e.commandHandlers?.get('chatroom')
    handler?.(p, hubMsg(hub), ['议题'])
    await settle()
    renderChatroomPickCardAndPush(e, hub, [
      { name: 'taleb', recommended: true, blurb: '' },
      { name: 'munger', recommended: true, blurb: '' },
    ])
    return pickStateOf(e, hub).chatroomPick!
  }

  it('confirm with two selected spawns the multi-role chatroom', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    await armedPicker(e, p, hub)
    executeChatroomPickAction(e, hub, 'confirm')
    await waitFor(() => p.count === 2, '2 roles spawned on confirm')
    expect(listChatroomRoles(e, hub)).toHaveLength(2)
  })

  it('toggle down to one then confirm enters direct mode', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    await armedPicker(e, p, hub)
    // Deselect munger → only taleb selected → direct mode.
    executeChatroomPickAction(e, hub, 'toggle munger')
    executeChatroomPickAction(e, hub, 'confirm')
    await waitFor(() => chatroomState(e.sessions.getOrCreateActive(hub)).chatroomDirectRole, 'direct mode entered')
    expect(p.count).toBe(0)
    const s = e.sessions.getOrCreateActive(hub)
    expect(chatroomState(s).chatroomRoleName).toBe('taleb')
    expect(chatroomState(s).chatroomHubKey).toBe('')
  })

  it('empty confirm is blocked and keeps the picker alive', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const ps = await armedPicker(e, p, hub)
    executeChatroomPickAction(e, hub, 'toggle taleb')
    executeChatroomPickAction(e, hub, 'toggle munger')
    executeChatroomPickAction(e, hub, 'confirm')
    await settle()
    expect(ps.phase).toBe('select')
    expect(ps.hint).not.toBe('')
    expect(p.count).toBe(0)
  })

  it('over-max confirm is blocked and keeps the picker alive', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    chatroomConfig(e).applySection({ maxRoles: 1 })
    const hub = 'test:hub:user-1'
    const ps = await armedPicker(e, p, hub)
    // Force both roles selected (2 > max 1).
    ps.selected.set('taleb', true)
    ps.selected.set('munger', true)
    executeChatroomPickAction(e, hub, 'confirm')
    await settle()
    expect(ps.phase).toBe('select')
    expect(ps.hint).not.toBe('')
    expect(p.count).toBe(0)
  })
})

describe('orphaned picker cards (state lost to a daemon restart)', () => {
  it('renders the expired card for any action when no picker state exists', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    const hub = 'test:hub:user-1'
    const expired = e.i18n.t(Msg.ChatroomPickExpired)
    const cases: Array<[cmd: string, args: string, title: ChatroomMsgKey]> = [
      ['/chatroom-pick', 'confirm', Msg.ChatroomPickTitle],
      ['/chatroom-pick', 'toggle taleb', Msg.ChatroomPickTitle],
      ['/chatroom-pick', 'cancel', Msg.ChatroomPickTitle],
      ['/chatroom-topic-pick', 'confirm', Msg.ChatroomTopicPickTitle],
    ]
    for (const [cmd, args, title] of cases) {
      const card = executeChatroomCardAction(e, hub, cmd, args)
      expect(card, `${cmd} ${args}`).toBeDefined()
      expect(card!.header?.color).toBe('grey')
      expect(card!.header?.title).toBe(e.i18n.t(title))
      expect(card!.renderText()).toContain(expired)
    }
    expect(p.count).toBe(0)
  })

  it('the registered card actions run through the engine dispatch and dispose cleanly', async () => {
    // registerChatroomCommands also claims the picker card paths: a pressed
    // orphaned card routes through the engine's card-action registry.
    const base = createStubChatroomSpawnerEx()
    const refreshed: unknown[] = []
    const p = { ...base, refreshCard: async (_k: string, card: unknown): Promise<void> => { refreshed.push(card) } }
    const e = new Engine('test', createStubAgent(), [p], '', 'zh', chatroomPolicyFace())
    e.setProjectStateStore(new ProjectStateStore(''))
    registerSessionCommands(e)
    const dispose = registerChatroomCommands(e)
    const hub = 'test:hub:user-1'

    e.receiveMessage(p, { ...hubMsg(hub), isCardAction: true, content: 'act:/chatroom-pick confirm' })
    await waitFor(() => refreshed.length === 1, 'expired card refresh')
    expect((refreshed[0] as { header?: { title?: string } }).header?.title).toBe(e.i18n.t(Msg.ChatroomPickTitle))

    // The disposer removes both the command and the card-action claim: a
    // pressed card falls through to the engine's unknown-card handling.
    dispose()
    expect(e.commandHandlers?.has('chatroom')).toBe(false)
    e.receiveMessage(p, { ...hubMsg(hub), isCardAction: true, content: 'act:/chatroom-pick confirm' })
    await settle()
    expect(refreshed).toHaveLength(1)
  })
})

describe('topic picker (#59)', () => {
  it('drops empty titles and preselects the first recommended', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const handler = e.commandHandlers?.get('chatroom')
    handler?.(p, hubMsg(hub), [])
    await settle()

    renderChatroomTopicPickCardAndPush(e, hub, [
      { title: '反脆弱', recommended: true, blurb: 'why' },
      { title: '  ', recommended: false, blurb: 'empty' },
      { title: '预测失效', recommended: false, blurb: 'x' },
    ])
    const ps = getChatroomTopicPickState(e, hub)!
    expect(ps.phase).toBe('select')
    expect(ps.recs.map(t => t.title)).toEqual(['反脆弱', '预测失效'])
    expect(ps.selected).toBe('反脆弱')

    // User toggles another topic → late pick-topic must not overwrite.
    executeChatroomTopicPickAction(e, hub, 'toggle 预测失效')
    renderChatroomTopicPickCardAndPush(e, hub, [{ title: '新题目', recommended: true, blurb: '' }])
    expect(ps.selected).toBe('预测失效')
  })

  it('radio confirm hands off to the role picker; empty confirm and cancel behave', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const handler = e.commandHandlers?.get('chatroom')
    handler?.(p, hubMsg(hub), [])
    await settle()

    // Empty confirm is blocked.
    renderChatroomTopicPickCardAndPush(e, hub, [{ title: '反脆弱', recommended: false, blurb: '' }])
    executeChatroomTopicPickAction(e, hub, 'confirm')
    await settle()
    const ps2 = getChatroomTopicPickState(e, hub)
    expect(ps2?.phase).toBe('select')
    expect(ps2?.hint).not.toBe('')

    // Cancel clears state.
    executeChatroomTopicPickAction(e, hub, 'cancel')
    expect(getChatroomTopicPickState(e, hub)).toBeUndefined()

    // Radio confirm hands off to #43: pick the non-recommended topic.
    handler?.(p, hubMsg(hub), [])
    await settle()
    renderChatroomTopicPickCardAndPush(e, hub, [
      { title: '反脆弱', recommended: true, blurb: '' },
      { title: '预测失效', recommended: false, blurb: '' },
    ])
    executeChatroomTopicPickAction(e, hub, 'toggle 预测失效')
    executeChatroomTopicPickAction(e, hub, 'confirm')
    await waitFor(() => {
      return getChatroomTopicPickState(e, hub) === undefined
        && getChatroomPickState(e, hub)?.phase === 'picking'
    }, 'topic-pick confirm hands off to role picker')
    expect(getChatroomPickState(e, hub)?.topic).toBe('预测失效')
  })
})

describe('chatroom ledger engine wiring', () => {
  it('startChatroom creates the ledger; relay appends; note updates sections', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const modDir = await mkdtemp(join(tmpdir(), 'fb-chatroom-mod-'))
    chatroomConfig(e).applySection({ moderatorDir: modDir })
    const hub = 'test:hub:user-1'

    const roles = await startChatroom(e, hub, ['taleb'], '该不该 all-in')
    const { chatroomLedgerDirFor, noteChatroom } = await import('../../src/engine/chatroom.ts')
    const dir = chatroomLedgerDirFor(e, hub)
    expect(dir).toBeDefined()
    await waitFor(async () => false, 'noop', 1).catch(() => undefined)
    await settle()
    const syn = await readFile(join(dir!, 'SYNTHESIS.md'), 'utf8')
    expect(syn).toContain('该不该 all-in')

    // A relayed role reply is appended to RECORD.md only.
    const roleSess = e.sessions.getOrCreateActive(roles[0]!.sessionKey)
    const st = new InteractiveState()
    st.platform = p
    maybeAutoRelayRole(e, st, roleSess, '厚尾下平均会骗人', false)
    await waitFor(async () => (await readFile(join(dir!, 'RECORD.md'), 'utf8')).includes('厚尾下平均会骗人'), 'record appended')

    // A moderator note (synthesis) updates SYNTHESIS.md without losing RECORD.
    await noteChatroom(e, hub, '', '图景：taleb 指出厚尾风险。')
    expect((await readFile(join(dir!, 'SYNTHESIS.md'), 'utf8'))).toContain('图景：taleb 指出厚尾风险')
    expect((await readFile(join(dir!, 'RECORD.md'), 'utf8'))).toContain('厚尾下平均会骗人')

    // note --section subproblems writes SUBPROBLEMS.md.
    await noteChatroom(e, hub, 'subproblems', '1. 择时\n2. 仓位')
    expect((await readFile(join(dir!, 'SUBPROBLEMS.md'), 'utf8'))).toContain('择时')

    // Unknown section is rejected.
    await expect(noteChatroom(e, hub, 'bogus', 'x')).rejects.toThrow()

    // Disabled when no moderator dir is configured.
    const e2 = newChatroomTestEngine(p)
    await expect(noteChatroom(e2, hub, '', 'x')).rejects.toThrow()
  })
})

describe('afterChatroomStarted recycles the hub agent process', () => {
  it('closes the stale agent, respawns with the moderator persona, keeps the session id', async () => {
    const p = createStubChatroomSpawner()
    // An agent that records startSession options and serves controllable sessions.
    const moderatorStarts: boolean[] = []
    let startCalls = 0
    const session: { next: ControllableAgentSession | undefined } = { next: undefined }
    const agent = {
      ...createStubAgent(),
      startSession: async (_sessionID: string, options?: SessionStartOptions) => {
        startCalls++
        moderatorStarts.push(options?.persona?.forceMode === 'default')
        return session.next ?? createStubAgentSession()
      },
    }
    const e = new Engine('test', agent, [p], '', 'zh', chatroomPolicyFace())
    e.setProjectStateStore(new ProjectStateStore(''))
    registerSessionCommands(e)
    registerChatroomCommands(e)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')

    // Simulate the topic-pick stage: the hub already runs an agent process
    // AND the Session object is bound to its ID (set at spawn time).
    const oldSess = newControllableSession('old-topic-pick')
    oldSess.channel.push({ type: 'result', content: 'topic picked', done: true })
    const hubSession = e.sessions.getOrCreateActive(hub)
    hubSession.setAgentSessionID('old-topic-pick', 'test')
    const st = new InteractiveState()
    st.platform = p
    st.agentSession = oldSess
    e.interactiveStates.set(hub, st)
    const oldID = hubSession.id

    // The wake turn spawns a fresh (recycled) session; pre-seed its result.
    session.next = newControllableSession('moderator-wake')
    session.next.channel.push({ type: 'result', content: 'ok', done: true })

    const { afterChatroomStarted } = await import('../../src/engine/chatroom-cmd.ts')
    await afterChatroomStarted(e, p, hub, 'user-1', 'group', 'ctx', roles, 'topic')

    // 1. The stale hub agent process is recycled (its close ran).
    await waitFor(() => oldSess.closed, 'old agent closed')
    // 2. The wake turn respawned the agent with the moderator persona.
    await waitFor(() => startCalls > 0, 'fresh agent spawned')
    expect(moderatorStarts[0]).toBe(true)
    // 3. Same session id: the wake turn resumes the topic-pick history.
    expect(e.sessions.getOrCreateActive(hub).id).toBe(oldID)
    expect(chatroomState(e.sessions.getOrCreateActive(hub)).chatroomModerator).toBe(true)
  })
})

describe('hub ready card', () => {
  it('carries the interjection hint beside the ledger note', async () => {
    const p = createStubChatroomSpawner()
    const agent = {
      ...createStubAgent(),
      startSession: async () => createStubAgentSession(),
    }
    const e = new Engine('test', agent, [p], '', 'zh', chatroomPolicyFace())
    e.setProjectStateStore(new ProjectStateStore(''))
    registerSessionCommands(e)
    registerChatroomCommands(e)
    const rolesRoot = await scaffoldTwoRoles()
    const moderatorHome = await mkdtemp(join(tmpdir(), 'chatroom-ready-'))
    chatroomConfig(e).applySection({ rolesDir: rolesRoot, moderatorDir: moderatorHome })
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb', 'munger'], 'topic')

    const bodies: string[] = []
    vi.spyOn(e, 'sendAsCard').mockImplementation(async (_p: Platform, _rc: unknown, content: string) => {
      bodies.push(content)
    })

    const { afterChatroomStarted } = await import('../../src/engine/chatroom-cmd.ts')
    await afterChatroomStarted(e, p, hub, 'user-1', 'group', 'ctx', roles, 'topic')

    const card = bodies.find(b => b.includes('主持人正在开场'))
    expect(card).toBeDefined()
    expect(card).toContain('账本目录')
    expect(card).toContain('💡 随时在本群发消息即可插话、追问或调整方向，主持人会处理。')
  })
})

describe('topic-pick priming ledger history', () => {
  it('surfaces the ledger dir when a moderator dir is configured', async () => {
    const { buildChatroomTopicPickPriming } = await import('../../src/engine/chatroom-priming.ts')
    const s = buildChatroomTopicPickPriming(['taleb', 'munger'], '/roles', '/chatroom-home')
    expect(s).toContain('/chatroom-home/ledgers')
    expect(s).toContain('避免')
    expect(s).toContain('重复')
  })

  it('omits the ledger hint when no moderator dir is configured', async () => {
    const { buildChatroomTopicPickPriming } = await import('../../src/engine/chatroom-priming.ts')
    const s = buildChatroomTopicPickPriming(['taleb'], '/roles', '')
    expect(s).not.toContain('ledgers')
  })
})
