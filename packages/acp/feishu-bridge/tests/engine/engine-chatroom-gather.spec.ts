/**
 * Chatroom gather tests ported 1:1 from cc-connect
 * core/engine_chatroom_gather_test.go: the fan-in barrier, GatherRoles
 * broadcast, stale-turn handling, research round caps, the progress card,
 * the research-manual AskUserQuestion auto-default, and the priming texts.
 *
 * @module dsh-feishu-bridge/tests-engine-chatroom-gather
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.js'
import { ProjectStateStore } from '../../src/engine/project-state.js'
import { registerSessionCommands } from '../../src/engine/commands.js'
import { registerChatroomCommands } from '../../src/engine/chatroom-cmd.js'
import {
  ChatroomGather,
  askHuman,
  gatherRoles,
  maybeAutoRelayRole,
  buildGatherTimeoutWake,
} from '../../src/engine/chatroom.js'
import { chatroomResearchManualAskTimeout, uvHooks } from '../../src/engine/chatroom.js'
import {
  buildChatroomModeratorPriming,
  buildChatroomResearchModeratorPriming,
} from '../../src/engine/chatroom-priming.js'
import type { ChatroomRole } from '../../src/engine/chatroom.js'
import {
  clearCards,
  createStubAgent,
  createStubCardPlatformFull,
  createStubChatroomSpawner,
  createStubProgressCardPlatform,
} from '../stubs/engine-stubs.js'
import type { AskDecision, PendingAsk, Platform, UserQuestion } from '../../src/core/types.js'
import type { RecordedCard } from '../stubs/engine-stubs.js'

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
  const e = new Engine('test', createStubAgent(), [p], '', 'zh')
  e.setProjectStateStore(new ProjectStateStore(''))
  registerSessionCommands(e)
  registerChatroomCommands(e)
  return e
}

async function scaffoldTwoRoles(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fb-gather-roles-'))
  for (const n of ['taleb', 'munger']) {
    await mkdir(join(root, n), { recursive: true })
    await writeFile(join(root, n, 'CLAUDE.md'), `# ${n}\n`, 'utf8')
  }
  return root
}

/** A gather with NO timer (Go newGather). */
function newGather(question: string, roleNames: string[]): ChatroomGather {
  const g = new ChatroomGather(question, 1)
  for (const n of roleNames) g.expected.add(n)
  return g
}

function cardBody(card: unknown): string {
  const c = card as RecordedCard
  const first = c.elements[0]
  return first?.kind === 'markdown' ? (first.content ?? '') : ''
}

describe('chatroom gather timeout duration', () => {
  it('defaults to 20m and is overridable', () => {
    const e = new Engine('test', createStubAgent(), [], '', 'zh')
    expect(e.chatroomGatherTimeoutDuration()).toBe(20 * 60 * 1000)
    e.setChatroomGatherTimeout(90_000)
    expect(e.chatroomGatherTimeoutDuration()).toBe(90_000)
  })
})

describe('ChatroomGather accumulate', () => {
  it('returns done only on the last reply with the tagged summary', () => {
    const g = newGather('需要追问吗？', ['taleb', 'munger'])
    expect(g.accumulate('taleb', '需要问预算').done).toBe(false)
    expect(g.expected.size).toBe(1)
    const { done, wakeContent } = g.accumulate('munger', '无需追问')
    expect(done).toBe(true)
    expect(wakeContent).toContain('并行收集完成')
    expect(wakeContent).toContain('【taleb】需要问预算')
    expect(wakeContent).toContain('【munger】无需追问')
  })

  it('counts an empty/silent reply as replied', () => {
    const g = newGather('q', ['a', 'b'])
    g.accumulate('a', '') // NO_REPLY
    expect(g.accumulate('b', 'x').done).toBe(true)
    expect(g.collected.get('a')).toBe('')
  })

  it('second completion is a no-op', () => {
    const g = newGather('q', ['a', 'b'])
    g.accumulate('a', '1')
    expect(g.accumulate('b', '2').done).toBe(true)
    expect(g.accumulate('a', 'late').done).toBe(false)
  })

  it('concurrent accumulates wake exactly once', async () => {
    const g = newGather('q', ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'])
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, idx) => Promise.resolve(g.accumulate(`r${idx}`, 'reply'))),
    )
    expect(results.filter(r => r.done)).toHaveLength(1)
  })
})

describe('ChatroomGather timeoutFire', () => {
  it('fires with partial replies and sorted missing names', () => {
    const g = newGather('q', ['taleb', 'munger', 'ghost'])
    g.accumulate('taleb', '已答')
    const { done, wake, missing } = g.timeoutFire()
    expect(done).toBe(true)
    // The named-status prefix is assembled by the caller; the barrier returns
    // the base summary + the missing names.
    expect(missing).toEqual(['ghost', 'munger'])
    expect(wake).not.toContain('超时未回复')
    expect(wake).toContain('【taleb】已答')
    // Second fire is a no-op.
    expect(g.timeoutFire().done).toBe(false)
  })

  it('is a no-op after completion', () => {
    const g = newGather('q', ['a', 'b'])
    g.accumulate('a', '1')
    g.accumulate('b', '2')
    expect(g.timeoutFire().done).toBe(false)
  })
})

describe('summary phase-neutrality', () => {
  it('carries the phase-neutral tail nudge, not the old clarify-only one', () => {
    const g = newGather('测试问题', ['taleb', 'munger'])
    g.accumulate('taleb', '无需追问')
    const { wakeContent } = g.accumulate('munger', '子问题A；子问题B')
    expect(wakeContent).toContain('按你当前所处阶段推进')
    expect(wakeContent).not.toContain('跳过提问直接进入下一步')
  })
})

describe('GatherRoles', () => {
  it('fails loud on a dangling hub key and mints no phantom hub', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    e.setChatroomRolesDir(await scaffoldTwoRoles())
    const ghost = 'test:ghost-hub:user-1'
    const before = e.sessions.allSessions().length

    // A registry that lost the moderator record must not gain one back as
    // an empty phantom whose flags silently degrade the protocol.
    expect(() => { gatherRoles(e, ghost, '问题', false) }).toThrow('hub session missing')
    expect(e.sessions.allSessions().length).toBe(before)
  })

  it('buildSessionStartOptions reads a dangling hub as no chatroom state, minting nothing', () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    const role = e.sessions.getOrCreateActive('test:role-9:user-1')
    role.setChatroomHubKey('test:ghost-hub:user-1')
    const before = e.sessions.allSessions().length

    const options = e.buildSessionStartOptions('test:role-9:user-1', role)
    expect(options.chatroom?.research).toBe(false)
    expect(e.sessions.allSessions().length).toBe(before)
  })

  it('sets the barrier, arms the timer, broadcasts to every role', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    e.setChatroomRolesDir(await scaffoldTwoRoles())
    const hub = 'test:hub:user-1'
    const { startChatroom } = await import('../../src/engine/chatroom.js')
    const roles = await startChatroom(e, hub, ['taleb', 'munger'], 'topic')
    clearCards(p)
    await settle()
    clearCards(p)

    gatherRoles(e, hub, '针对议题，是否需要向用户追问？', false)
    await settle()
    await settle()

    const g = e.sessions.getOrCreateActive(hub).getPendingGather()
    expect(g).toBeDefined()
    expect(g!.expected.size).toBe(2)
    expect(g!.expected.has('taleb')).toBe(true)
    expect(g!.expected.has('munger')).toBe(true)
    expect(g!.timer).toBeDefined()
    g!.stopTimer()

    // Each role got a question card (broadcast in parallel).
    expect(p.sentCards.length).toBeGreaterThanOrEqual(2)
    // Each role's relay gate is armed.
    for (const r of roles) {
      expect(e.sessions.getOrCreateActive(r.sessionKey).getChatroomAsked()).toBe(false)
    }
  })

  it('research mode uses the research prefix and longer timeout', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    e.setChatroomRolesDir(await scaffoldTwoRoles())
    e.setChatroomResearchTimeout(90 * 60 * 1000)
    const hub = 'test:hub:user-1'
    const { startChatroom } = await import('../../src/engine/chatroom.js')
    await startChatroom(e, hub, ['taleb', 'munger'], 'topic')
    clearCards(p)
    await settle()
    clearCards(p)

    gatherRoles(e, hub, '研究中国股市是否过热', true)
    await settle()
    await settle()

    expect(p.sentCards.length).toBeGreaterThanOrEqual(2)
    const researchCards = p.sentCards.filter(c => cardBody(c).includes('[并行研究]'))
    const collectCards = p.sentCards.filter(c => cardBody(c).includes('[并行收集]'))
    expect(researchCards.length).toBeGreaterThan(0)
    expect(collectCards.length).toBe(0)
    const g = e.sessions.getOrCreateActive(hub).getPendingGather()
    g?.stopTimer()
  })

  it('hard-caps auto-mode research rounds; manual is uncapped', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    e.setChatroomRolesDir(await scaffoldTwoRoles())
    e.setMaxChatroomResearchRounds(2)
    const hub = 'test:hub:user-1'
    const { startChatroom } = await import('../../src/engine/chatroom.js')
    await startChatroom(e, hub, ['taleb', 'munger'], 'topic')
    const hubSess = e.sessions.getOrCreateActive(hub)
    hubSess.setChatroomResearch(true)
    hubSess.setChatroomResearchMode('auto')

    gatherRoles(e, hub, 'r1', true)
    hubSess.getPendingGather()?.stopTimer()
    gatherRoles(e, hub, 'r2', true)
    hubSess.getPendingGather()?.stopTimer()

    // Round 3 must be rejected (cap = 2).
    expect(() => { gatherRoles(e, hub, 'r3', true) }).toThrow()

    // Manual mode is uncapped.
    hubSess.setChatroomResearchMode('manual')
    expect(() => { gatherRoles(e, hub, 'r3 manual', true) }).not.toThrow()
    hubSess.getPendingGather()?.stopTimer()
  })

  it('errors when the hub has no roles', () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    expect(() => { gatherRoles(e, 'test:hub:user-1', 'q', false) }).toThrow()
  })

  it('stamps a monotonic per-hub seq on the barrier', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    e.setChatroomRolesDir(await scaffoldTwoRoles())
    const hub = 'test:hub:user-1'
    const { startChatroom } = await import('../../src/engine/chatroom.js')
    await startChatroom(e, hub, ['taleb', 'munger'], 'topic')

    gatherRoles(e, hub, '第一轮问题', false)
    const h = e.sessions.getOrCreateActive(hub)
    const g1 = h.getPendingGather()
    expect(g1?.seq).toBe(1)
    g1?.stopTimer()
    h.setPendingGather(undefined)

    gatherRoles(e, hub, '第二轮问题', false)
    const g2 = h.getPendingGather()
    expect(g2?.seq).toBe(2)
    g2?.stopTimer()
  })
})

describe('gather fan-in via maybeAutoRelayRole', () => {
  it('N-1 replies keep the barrier; the Nth clears it', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    e.setChatroomRolesDir(await scaffoldTwoRoles())
    const hub = 'test:hub:user-1'
    const { startChatroom } = await import('../../src/engine/chatroom.js')
    const roles = await startChatroom(e, hub, ['taleb', 'munger'], 'topic')
    const g = newGather('需要追问吗？', ['taleb', 'munger'])
    e.sessions.getOrCreateActive(hub).setPendingGather(g)

    const relay = (roleKey: string, reply: string): void => {
      const role = e.sessions.getOrCreateActive(roleKey)
      role.setChatroomAsked(false)
      const st = new InteractiveState()
      st.platform = p
      maybeAutoRelayRole(e, st, role, reply, false)
    }

    // First reply: relayed as a card but the barrier is NOT cleared.
    clearCards(p)
    relay(roles[0]!.sessionKey, '需要问预算范围')
    await settle()
    expect(e.sessions.getOrCreateActive(hub).getPendingGather()).toBeDefined()
    expect(p.sentCards).toHaveLength(1)

    // Second reply: completes the barrier — pendingGather cleared.
    relay(roles[1]!.sessionKey, '无需追问')
    expect(e.sessions.getOrCreateActive(hub).getPendingGather()).toBeUndefined()
  })

  it('a stale turn falls through as a free reply without consuming gates', async () => {
    const hub = 'test:hub:user-1'
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)

    // Live barrier is round 2; the role's turn belongs to round 1.
    const hubSess = e.sessions.getOrCreateActive(hub)
    const g = new ChatroomGather('q', 2)
    g.expected.add('Taleb')
    hubSess.setPendingGather(g)

    const role = e.sessions.getOrCreateActive('test:role-chat')
    role.setChatroomHubKey(hub)
    role.setChatroomRoleName('Taleb')
    role.setChatroomAsked(false)
    role.setChatroomAskSeq(1)
    role.setChatroomInFlight(true)
    role.setResearchAwaitingAssistant(true) // must NOT be consumed by the stale turn

    const st = new InteractiveState()
    st.platform = p
    maybeAutoRelayRole(e, st, role, '上轮迟到的结论', false)
    await settle()

    expect(role.getChatroomAsked()).toBe(false)
    expect(role.getResearchAwaitingAssistant()).toBe(true)
    expect(hubSess.getPendingGather()?.collected.size).toBe(0)
    expect(role.getChatroomInFlight()).toBe(false)
    // The reply still has value: relayed as a free-reply card.
    expect(p.sentCards).toHaveLength(1)
  })

  it('a matching-seq turn enters the barrier', async () => {
    const hub = 'test:hub:user-1'
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    const hubSess = e.sessions.getOrCreateActive(hub)
    const g = new ChatroomGather('q', 2)
    g.expected.add('Taleb')
    g.expected.add('Munger')
    hubSess.setPendingGather(g)

    const role = e.sessions.getOrCreateActive('test:role-chat')
    role.setChatroomHubKey(hub)
    role.setChatroomRoleName('Taleb')
    role.setChatroomAsked(false)
    role.setChatroomAskSeq(2) // current round
    role.setChatroomInFlight(true)

    const st = new InteractiveState()
    st.platform = p
    maybeAutoRelayRole(e, st, role, '本轮结论', false)

    expect(hubSess.getPendingGather()?.collected.get('Taleb')).toBe('本轮结论')
    expect(role.getChatroomAsked()).toBe(true)
  })
})

describe('stampChatroomAskOnTurnStart', () => {
  it('stamps round + awaiting on ask turns; zero metadata is a no-op; non-roles untouched', () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    const hub = 'test:hub-chat:user-1'
    const role = e.sessions.getOrCreateActive('test:role-chat')
    role.setChatroomHubKey(hub)

    // Ask turn: stamps round + arms awaiting.
    e.stampChatroomAskOnTurnStart(role, 3, true)
    expect(role.getChatroomAskSeq()).toBe(3)
    expect(role.getResearchAwaitingAssistant()).toBe(true)

    // Conclusion wake (report injection): zero metadata keeps the round.
    e.stampChatroomAskOnTurnStart(role, 0, false)
    expect(role.getChatroomAskSeq()).toBe(3)
    expect(role.getResearchAwaitingAssistant()).toBe(true)

    // Non-role session: no-op.
    const plain = e.sessions.getOrCreateActive('test:plain-chat')
    e.stampChatroomAskOnTurnStart(plain, 5, true)
    expect(plain.getChatroomAskSeq()).toBe(0)
  })
})

describe('AskHuman vs gather', () => {
  it('is rejected while a gather is in flight', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    e.setChatroomRolesDir(await scaffoldTwoRoles())
    const hub = 'test:hub:user-1'
    const { startChatroom } = await import('../../src/engine/chatroom.js')
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    e.sessions.getOrCreateActive(hub).setPendingGather(newGather('q', ['taleb']))
    await expect(askHuman(e, roles[0]!.sessionKey, '预算多少？')).rejects.toThrow()
  })

  it('is allowed outside a gather', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    e.setChatroomRolesDir(await scaffoldTwoRoles())
    const hub = 'test:hub:user-1'
    const { startChatroom } = await import('../../src/engine/chatroom.js')
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    await expect(askHuman(e, roles[0]!.sessionKey, '预算多少？')).resolves.toBeUndefined()
  })
})

describe('buildGatherTimeoutWake', () => {
  it('names missing roles with their per-role state', () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    const hub = 'test:hub:user-1'

    // Three roles: taleb replied (not missing); munger dispatched its
    // assistant; ghost never started.
    const taleb = e.sessions.getOrCreateActive('test:role-taleb')
    taleb.setChatroomHubKey(hub)
    taleb.setChatroomRoleName('taleb')
    taleb.setParentSessionKey(hub)
    const munger = e.sessions.getOrCreateActive('test:role-munger')
    munger.setChatroomHubKey(hub)
    munger.setChatroomRoleName('munger')
    munger.setParentSessionKey(hub)
    munger.setResearchDispatched(true)
    const ghost = e.sessions.getOrCreateActive('test:role-ghost')
    ghost.setChatroomHubKey(hub)
    ghost.setChatroomRoleName('ghost')
    ghost.setParentSessionKey(hub)

    const wake = buildGatherTimeoutWake(e, hub, ['ghost', 'munger'], '已收到的回复…')
    for (const want of ['2 个角色超时未回复', 'munger（已派发助手未答）', 'ghost（未开始）', '已收到的回复…']) {
      expect(wake).toContain(want)
    }
  })
})

describe('research progress card', () => {
  it('is sent for research gathers only, and PATCHed to done on completion', async () => {
    const p = createStubProgressCardPlatform()
    const e = newChatroomTestEngine(p)
    e.setChatroomRolesDir(await scaffoldTwoRoles())
    const hub = 'test:hub:user-1'
    const { startChatroom } = await import('../../src/engine/chatroom.js')
    await startChatroom(e, hub, ['taleb', 'munger'], 'topic')
    e.sessions.getOrCreateActive(hub).setChatroomResearch(true)
    clearCards(p)
    await settle()
    clearCards(p)

    gatherRoles(e, hub, '研究中国股市', true)
    const g = e.sessions.getOrCreateActive(hub).getPendingGather()
    expect(g).toBeDefined()
    g!.stopTimer()
    await waitFor(() => g!.progressHandle !== undefined, 'progress card handle stored')

    // Plain gather: no progress card.
    e.sessions.getOrCreateActive(hub).setPendingGather(undefined)
    gatherRoles(e, hub, '普通收集', false)
    const g2 = e.sessions.getOrCreateActive(hub).getPendingGather()
    g2!.stopTimer()
    expect(g2!.progressHandle).toBeUndefined()
  })

  it('PATCHes 1/2 in-progress then the done terminal title on relay', async () => {
    const hub = 'test:hub:user-1'
    const p = createStubProgressCardPlatform()
    const e = newChatroomTestEngine(p)

    const hubSess = e.sessions.getOrCreateActive(hub)
    const g = new ChatroomGather('q', 1)
    g.expected.add('Taleb')
    g.expected.add('Munger')
    g.progressHandle = 'progress-handle'
    hubSess.setPendingGather(g)

    for (const name of ['Taleb', 'Munger']) {
      const role = e.sessions.getOrCreateActive(`test:role-${name}`)
      role.setChatroomHubKey(hub)
      role.setChatroomRoleName(name)
      role.setChatroomAsked(false)
      role.setChatroomAskSeq(1)
      role.setChatroomInFlight(true)
      const st = new InteractiveState()
      st.platform = p
      maybeAutoRelayRole(e, st, role, `结论${name}`, false)
      await settle()
    }

    const titles = p.patchedTitles()
    expect(titles).toHaveLength(2)
    expect(titles[titles.length - 1]).toContain('全部角色已回复')
  })
})

describe('research config range clamping', () => {
  it('clamps the timeout to [1m, 24h] and rounds to [1, 20]', () => {
    const e = new Engine('test', createStubAgent(), [], '', 'zh')
    e.setChatroomResearchTimeout(1_000)
    expect(e.chatroomResearchTimeoutDuration()).toBe(60_000)
    e.setChatroomResearchTimeout(48 * 60 * 60 * 1000)
    expect(e.chatroomResearchTimeoutDuration()).toBe(24 * 60 * 60 * 1000)
    e.setMaxChatroomResearchRounds(99)
    expect(e.maxChatroomResearchRoundsValue()).toBe(20)
  })
})

// ── research-manual whole-ask auto-default (B2: one timeout per card) ─────

const savedTimeout = chatroomResearchManualAskTimeout.ms

afterEach(() => {
  chatroomResearchManualAskTimeout.ms = savedTimeout
  uvHooks.lookupPath = savedLookup
  uvHooks.pipInstall = savedPipInstall
})

const savedLookup = uvHooks.lookupPath
const savedPipInstall = uvHooks.pipInstall

describe('armResearchManualAskTimeout', () => {
  /** Hub session armed as a manual-mode research moderator. */
  function manualHub(e: Engine, mode: 'manual' | 'auto' = 'manual'): string {
    const hub = 'test:hub-chat:user-1'
    const sess = e.sessions.getOrCreateActive(hub)
    sess.setChatroomModerator(true)
    sess.setChatroomResearch(true)
    sess.setChatroomResearchMode(mode)
    return hub
  }

  /** A parked questions ask with its settle recorder. */
  function parkedAsk(e: Engine, p: Platform, hub: string, questions: UserQuestion[]): { pending: PendingAsk; settled: AskDecision[] } {
    const settled: AskDecision[] = []
    const pending: PendingAsk = {
      request: { kind: 'questions', questions },
      answers: new Map(),
      resolve: (decision) => { settled.push(decision) },
    }
    const state = new InteractiveState()
    state.platform = p
    state.pendingAsk = pending
    e.interactiveStates.set(hub, state)
    return { pending, settled }
  }

  it('settles the whole ask with defaults and notifies the hub', async () => {
    chatroomResearchManualAskTimeout.ms = 50
    const p = createStubCardPlatformFull('test')
    const e = newChatroomTestEngine(p)
    const hub = manualHub(e)

    const { pending, settled } = parkedAsk(e, p, hub, [{
      id: 'continue',
      question: '继续吗',
      header: '',
      options: [{ label: '继续迭代', description: '' }, { label: '结束', description: '' }],
      multiSelect: false,
    }])

    const { armResearchManualAskTimeout } = await import('../../src/engine/chatroom.js')
    armResearchManualAskTimeout(e, p, hub, 'ctx', pending)

    await waitFor(() => settled.length > 0, 'auto-answer fired')
    // Unanswered questions default to their first option.
    expect(settled[0]).toEqual({ answers: [{ id: 'continue', selected: ['继续迭代'] }] })
    // The timeout notice must reach the hub.
    expect(p.getSent().some(s => s.includes('已按默认选项推进'))).toBe(true)
  })

  it('keeps already-collected answers and defaults only the rest', async () => {
    chatroomResearchManualAskTimeout.ms = 50
    const p = createStubCardPlatformFull('test')
    const e = newChatroomTestEngine(p)
    const hub = manualHub(e)

    const { pending, settled } = parkedAsk(e, p, hub, [
      { id: 'db', question: 'Which database?', header: '', options: [{ label: 'PostgreSQL', description: '' }, { label: 'SQLite', description: '' }], multiSelect: false },
      { id: 'fw', question: 'Which framework?', header: '', options: [{ label: 'Gin', description: '' }, { label: 'Echo', description: '' }], multiSelect: false },
    ])
    pending.answers.set(0, { selected: ['SQLite'] })

    const { armResearchManualAskTimeout } = await import('../../src/engine/chatroom.js')
    armResearchManualAskTimeout(e, p, hub, 'ctx', pending)

    await waitFor(() => settled.length > 0, 'auto-answer fired')
    expect(settled[0]).toEqual({
      answers: [
        { id: 'db', selected: ['SQLite'] },
        { id: 'fw', selected: ['Gin'] },
      ],
    })
  })

  it('skips non-research (auto-mode) hubs', async () => {
    chatroomResearchManualAskTimeout.ms = 30
    const p = createStubCardPlatformFull('test')
    const e = newChatroomTestEngine(p)
    const hub = manualHub(e, 'auto')

    const { pending, settled } = parkedAsk(e, p, hub, [{
      id: 'q', question: '继续吗', header: '', options: [{ label: '继续', description: '' }], multiSelect: false,
    }])
    const { armResearchManualAskTimeout } = await import('../../src/engine/chatroom.js')
    armResearchManualAskTimeout(e, p, hub, 'ctx', pending)
    await new Promise((resolve) => { setTimeout(resolve, 150) })
    expect(settled).toHaveLength(0)
  })

  it('stops the timer when the user resolves first', async () => {
    chatroomResearchManualAskTimeout.ms = 50
    const p = createStubCardPlatformFull('test')
    const e = newChatroomTestEngine(p)
    const hub = manualHub(e)

    const { pending, settled } = parkedAsk(e, p, hub, [{
      id: 'q', question: '继续吗', header: '', options: [{ label: '继续', description: '' }], multiSelect: false,
    }])

    const { armResearchManualAskTimeout } = await import('../../src/engine/chatroom.js')
    armResearchManualAskTimeout(e, p, hub, 'ctx', pending)
    // User answered before the timer fired: mirror the engine's settle, which
    // clears the parked ask and the timer.
    pending.resolve({ answers: [{ id: 'q', selected: ['继续'] }] })
    if (pending.autoTimer !== undefined) clearTimeout(pending.autoTimer)
    e.interactiveStates.get(hub)!.pendingAsk = undefined
    await new Promise((resolve) => { setTimeout(resolve, 150) })
    expect(settled).toHaveLength(1)
  })
})

// ── priming texts ─────────────────────────────────────────────────────────

const testRoles: ChatroomRole[] = [{ name: 'taleb', sessionKey: 'test:role-1', dir: '/roles/taleb' }]

describe('buildChatroomModeratorPriming', () => {
  it('carries the multi-round clarify loop', () => {
    const priming = buildChatroomModeratorPriming('topic', testRoles, '/tmp/ledger')
    for (const want of ['最多 3 轮澄清', '再次调', '回到第 2 步循环']) {
      expect(priming).toContain(want)
    }
  })

  it('never instructs an ExitPlanMode dance (moderator sessions are never in plan mode)', () => {
    const priming = buildChatroomModeratorPriming('topic', testRoles, '/tmp/ledger')
    for (const banned of ['plan mode', 'ExitPlanMode']) {
      expect(priming).not.toContain(banned)
    }
  })

  it('uses 总分结构 wording and never induces a pyramid graphic', () => {
    const cases: Array<[string, string]> = [
      ['moderator', buildChatroomModeratorPriming('topic', testRoles, '/tmp/ledger')],
      ['research', buildChatroomResearchModeratorPriming('topic', testRoles, '/tmp/ledger', 'auto', 3)],
    ]
    for (const [, priming] of cases) {
      expect(priming).toContain('总分结构')
      for (const banned of ['金字塔', '塔尖']) {
        expect(priming).not.toContain(banned)
      }
    }
  })

  it('offers the plain (Feynman) default AND the optional academic version', () => {
    const cases: Array<[string, string]> = [
      ['moderator', buildChatroomModeratorPriming('topic', testRoles, '/tmp/ledger')],
      ['research', buildChatroomResearchModeratorPriming('topic', testRoles, '/tmp/ledger', 'auto', 3)],
    ]
    for (const [, priming] of cases) {
      for (const want of ['summary.html', '费曼法通俗版', '生活类比', '最小例子', '仍有的分歧']) {
        expect(priming).toContain(want)
      }
      for (const want of ['summary-academic.html', '出一份深度学术版', '总分结构', '记住用户已选过学术版', '若用户此前选过「出一份深度学术版」']) {
        expect(priming).toContain(want)
      }
    }
  })
})

describe('buildChatroomResearchModeratorPriming', () => {
  it('instructs note (section: subproblems) to fill SUBPROBLEMS.md', () => {
    const priming = buildChatroomResearchModeratorPriming('topic', testRoles, '/tmp/ledger', 'auto', 3)
    expect(priming).toContain('section: subproblems')
  })

  it('addresses the assistant by the "assistant" sentinel, never a key the model must transcribe', () => {
    const priming = buildChatroomResearchModeratorPriming('topic', testRoles, '/tmp/ledger', 'auto', 3)
    expect(priming).toContain('child 用 "assistant"')
    // The Go-era env var no longer exists in the dsh backend; mentioning it
    // sent models hunting for a value they cannot see (2026-08-25 oc_ac5db).
    expect(priming).not.toContain('CC_RESEARCH_ASSISTANT_CHILD')
  })

  it('instructs persisting artifacts into the shared workspace', () => {
    const priming = buildChatroomResearchModeratorPriming('topic', testRoles, '/tmp/ledger', 'auto', 3)
    expect(priming).toContain('存成文件')
    expect(priming).toContain('工作区')
  })
})
