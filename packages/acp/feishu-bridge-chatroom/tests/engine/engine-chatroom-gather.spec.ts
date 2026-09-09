/**
 * Chatroom gather tests ported 1:1 from cc-connect
 * core/engine_chatroom_gather_test.go: the fan-in barrier, GatherRoles
 * broadcast, stale-turn handling, research round caps, the progress card,
 * the research-manual ask_user_question auto-default, and the priming texts.
 *
 * @module dsh-feishu-bridge/tests-engine-chatroom-gather
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, InteractiveState } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { ProjectStateStore } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { chatroomPolicyFace } from '../stubs/bridge-policy.ts'
import { registerSessionCommands } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { registerChatroomCommands } from '../../src/engine/chatroom-cmd.ts'
import {
  ChatroomGather,
  askHuman,
  gatherRoles,
  maybeAutoRelayRole,
  buildGatherTimeoutWake,
  routePendingHumanReply,
} from '../../src/engine/chatroom.ts'
import { chatroomResearchManualAskTimeout, uvHooks } from '../../src/engine/chatroom.ts'
import {
  buildChatroomModeratorPriming,
  buildChatroomResearchModeratorPriming,
} from '../../src/engine/chatroom-priming.ts'
import type { ChatroomRole } from '../../src/engine/chatroom.ts'
import {
  clearCards,
  createStubAgent,
  createStubCardPlatformFull,
  createStubChatroomSpawner,
  createStubProgressCardPlatform,
} from '../stubs/engine-stubs.ts'
import type { AskDecision, PendingAsk, Platform, UserQuestion } from '@deepseek-ai/dsh-feishu-bridge/exports'
import type { RecordedCard } from '../stubs/engine-stubs.ts'
import { chatroomState } from '../../src/chatroom-state.ts'
import { chatroomConfig } from '../../src/chatroom-config.ts'
import '../stubs/messages.js'

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
  // The chatroom policy face (the production composition): start-options
  // decoration, turn-start stamping, and relay ride the event listeners.
  const e = new Engine('test', createStubAgent(), [p], '', 'zh', chatroomPolicyFace())
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
    expect(chatroomConfig(e).gatherTimeoutDuration()).toBe(20 * 60 * 1000)
    chatroomConfig(e).applySection({ gatherTimeoutSec: Math.round(90_000 / 1000) })
    expect(chatroomConfig(e).gatherTimeoutDuration()).toBe(90_000)
  })

  it('re-arm window defaults to 20m and is overridable via gatherRearmSec', () => {
    const e = new Engine('test', createStubAgent(), [], '', 'zh')
    expect(chatroomConfig(e).gatherRearmDuration()).toBe(20 * 60 * 1000)
    chatroomConfig(e).applySection({ gatherRearmSec: Math.round(90_000 / 1000) })
    expect(chatroomConfig(e).gatherRearmDuration()).toBe(90_000)
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

  it('trims an overlong reply to 200 runes with an ellipsis annotation', () => {
    // Same per-reply ceiling as the end barrier's closing summary: a 60m
    // research round × N roles must not grow the wake text without bound
    // into the moderator's context.
    const g = newGather('q', ['a', 'b'])
    g.accumulate('a', '字'.repeat(250))
    const { wakeContent } = g.accumulate('b', '短回复')
    expect(wakeContent).toContain(`【a】${'字'.repeat(200)}…`)
    expect(wakeContent).not.toContain('字'.repeat(201))
    expect(wakeContent).toContain('【b】短回复')
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
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
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
    chatroomState(role).chatroomHubKey = 'test:ghost-hub:user-1'
    const before = e.sessions.allSessions().length

    const options = e.buildSessionStartOptions('test:role-9:user-1', role)
    // Non-creating hub lookup: the role still gets its persona, with the
    // research contract absent (the phantom hub's empty flags strip it).
    expect(options.persona?.bypassPermissions).toBe(true)
    expect(options.persona?.prompt).not.toContain('用预配的助手子群干活')
    expect(e.sessions.allSessions().length).toBe(before)
  })

  it('sets the barrier, arms the timer, broadcasts to every role', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const { startChatroom } = await import('../../src/engine/chatroom.ts')
    const roles = await startChatroom(e, hub, ['taleb', 'munger'], 'topic')
    clearCards(p)
    await settle()
    clearCards(p)

    gatherRoles(e, hub, '针对议题，是否需要向用户追问？', false)
    await settle()
    await settle()

    const g = chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather
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
      expect(chatroomState(e.sessions.getOrCreateActive(r.sessionKey)).chatroomAsked).toBe(false)
    }
  })

  it('research mode uses the research prefix and longer timeout', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    chatroomConfig(e).applySection({ researchTimeoutSec: Math.round(90 * 60 * 1000 / 1000) })
    const hub = 'test:hub:user-1'
    const { startChatroom } = await import('../../src/engine/chatroom.ts')
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
    // The research prefix relays data-reliability requirements so roles
    // demand authoritative sources from their assistants.
    for (const c of researchCards) {
      expect(cardBody(c)).toContain('数据可靠性要求：让助手只用权威一手源')
      // Verified recipes first (macro/valuation via the playbook speed
      // table); aggregators only as fallback, ledger-registered.
      expect(cardBody(c)).toContain('playbook 的已验证配方')
    }
    expect(collectCards.length).toBe(0)
    const g = chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather
    g?.stopTimer()
  })

  it('auto-mode research rounds are uncapped — rounds proceed past any count', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const { startChatroom } = await import('../../src/engine/chatroom.ts')
    await startChatroom(e, hub, ['taleb', 'munger'], 'topic')
    const hubSess = e.sessions.getOrCreateActive(hub)
    chatroomState(hubSess).chatroomResearch = true
    chatroomState(hubSess).chatroomResearchMode = 'auto'

    // Well past the old default cap of 3: no engine-side round limit
    // remains; the moderator alone decides when to wrap up.
    for (let round = 1; round <= 6; round++) {
      expect(() => { gatherRoles(e, hub, `r${round}`, true) }, `round ${round}`).not.toThrow()
      chatroomState(hubSess).pendingGather?.stopTimer()
      chatroomState(hubSess).pendingGather = undefined // round completed and woke the moderator
    }
  })

  it('errors when the hub has no roles', () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    expect(() => { gatherRoles(e, 'test:hub:user-1', 'q', false) }).toThrow()
  })

  it('stamps a monotonic per-hub seq on the barrier', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const { startChatroom } = await import('../../src/engine/chatroom.ts')
    await startChatroom(e, hub, ['taleb', 'munger'], 'topic')

    gatherRoles(e, hub, '第一轮问题', false)
    const h = e.sessions.getOrCreateActive(hub)
    const g1 = chatroomState(h).pendingGather
    expect(g1?.seq).toBe(1)
    g1?.stopTimer()
    chatroomState(h).pendingGather = undefined

    gatherRoles(e, hub, '第二轮问题', false)
    const g2 = chatroomState(h).pendingGather
    expect(g2?.seq).toBe(2)
    g2?.stopTimer()
  })
})

describe('gather fan-in via maybeAutoRelayRole', () => {
  it('N-1 replies keep the barrier; the Nth clears it', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const { startChatroom } = await import('../../src/engine/chatroom.ts')
    const roles = await startChatroom(e, hub, ['taleb', 'munger'], 'topic')
    const g = newGather('需要追问吗？', ['taleb', 'munger'])
    chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather = g

    const relay = (roleKey: string, reply: string): void => {
      const role = e.sessions.getOrCreateActive(roleKey)
      chatroomState(role).chatroomAsked = false
      const st = new InteractiveState()
      st.platform = p
      maybeAutoRelayRole(e, st, role, reply, false)
    }

    // First reply: relayed as a card but the barrier is NOT cleared.
    clearCards(p)
    relay(roles[0]!.sessionKey, '需要问预算范围')
    await settle()
    expect(chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather).toBeDefined()
    expect(p.sentCards).toHaveLength(1)

    // Second reply: completes the barrier — pendingGather cleared.
    relay(roles[1]!.sessionKey, '无需追问')
    expect(chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather).toBeUndefined()
  })

  it('a stale turn falls through as a free reply without consuming gates', async () => {
    const hub = 'test:hub:user-1'
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)

    // Live barrier is round 2; the role's turn belongs to round 1.
    const hubSess = e.sessions.getOrCreateActive(hub)
    const g = new ChatroomGather('q', 2)
    g.expected.add('Taleb')
    chatroomState(hubSess).pendingGather = g

    const role = e.sessions.getOrCreateActive('test:role-chat')
    chatroomState(role).chatroomHubKey = hub
    chatroomState(role).chatroomRoleName = 'Taleb'
    chatroomState(role).chatroomAsked = false
    chatroomState(role).chatroomAskSeq = 1
    chatroomState(role).chatroomInFlight = true
    chatroomState(role).researchAwaitingAssistant = true // must NOT be consumed by the stale turn

    const st = new InteractiveState()
    st.platform = p
    maybeAutoRelayRole(e, st, role, '上轮迟到的结论', false)
    await settle()

    expect(chatroomState(role).chatroomAsked).toBe(false)
    expect(chatroomState(role).researchAwaitingAssistant).toBe(true)
    expect(chatroomState(hubSess).pendingGather?.collected.size).toBe(0)
    // The superseded turn must NOT clear the in-flight flag: the newer
    // round's broadcast re-armed it and owns it until its own turn relays.
    expect(chatroomState(role).chatroomInFlight).toBe(true)
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
    chatroomState(hubSess).pendingGather = g

    const role = e.sessions.getOrCreateActive('test:role-chat')
    chatroomState(role).chatroomHubKey = hub
    chatroomState(role).chatroomRoleName = 'Taleb'
    chatroomState(role).chatroomAsked = false
    chatroomState(role).chatroomAskSeq = 2 // current round
    chatroomState(role).chatroomInFlight = true

    const st = new InteractiveState()
    st.platform = p
    maybeAutoRelayRole(e, st, role, '本轮结论', false)

    expect(chatroomState(hubSess).pendingGather?.collected.get('Taleb')).toBe('本轮结论')
    expect(chatroomState(role).chatroomAsked).toBe(true)
  })

  it('an error-reasoned turn is absorbed as an explicit failure, never as a reply', async () => {
    const hub = 'test:hub:user-1'
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    const hubSess = e.sessions.getOrCreateActive(hub)
    const g = new ChatroomGather('q', 2)
    g.expected.add('Taleb')
    g.expected.add('Munger')
    chatroomState(hubSess).pendingGather = g

    const role = e.sessions.getOrCreateActive('test:role-chat')
    chatroomState(role).chatroomHubKey = hub
    chatroomState(role).chatroomRoleName = 'Taleb'
    chatroomState(role).chatroomAsked = false
    chatroomState(role).chatroomAskSeq = 2 // current round
    chatroomState(role).chatroomInFlight = true

    const st = new InteractiveState()
    st.platform = p
    maybeAutoRelayRole(e, st, role, '被打断前的半段输出', false, true, '1301 sensitive content rejected')
    await settle()

    // The round still counts the role as answered, but with an explicit
    // failure record — the turn's own partial must not pose as the round
    // answer (and an earlier turn's lastResult never reaches this path).
    const recorded = g.collected.get('Taleb') ?? ''
    expect(recorded).toContain('本轮发言失败')
    expect(recorded).toContain('1301 sensitive content rejected')
    expect(recorded).not.toContain('半段输出')
    expect(g.expected.has('Taleb')).toBe(false)
    // A failed turn is not a reply: no relay card.
    expect(p.sentCards).toHaveLength(0)
    expect(chatroomState(role).chatroomAsked).toBe(true)
    expect(chatroomState(role).chatroomInFlight).toBe(false)
  })
})

describe('turn-start ask metadata stamp (feishuBridge/turn-start)', () => {
  it('stamps round + awaiting on ask turns; zero metadata is a no-op; non-roles untouched', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    const hub = 'test:hub-chat:user-1'
    const role = e.sessions.getOrCreateActive('test:role-chat')
    chatroomState(role).chatroomHubKey = hub

    // Ask turn: stamps round + arms awaiting.
    await e.bridge.serial('feishuBridge/turn-start', {
      engine: e, session: role, metadata: { chatroomAskSeq: 3, chatroomAwaitAssistant: true },
    })
    expect(chatroomState(role).chatroomAskSeq).toBe(3)
    expect(chatroomState(role).researchAwaitingAssistant).toBe(true)

    // Conclusion wake (report injection): zero metadata keeps the round.
    await e.bridge.serial('feishuBridge/turn-start', { engine: e, session: role, metadata: undefined })
    expect(chatroomState(role).chatroomAskSeq).toBe(3)
    expect(chatroomState(role).researchAwaitingAssistant).toBe(true)

    // Non-role session: no-op.
    const plain = e.sessions.getOrCreateActive('test:plain-chat')
    await e.bridge.serial('feishuBridge/turn-start', {
      engine: e, session: plain, metadata: { chatroomAskSeq: 5, chatroomAwaitAssistant: true },
    })
    expect(chatroomState(plain).chatroomAskSeq).toBe(0)
  })
})

describe('AskHuman vs gather', () => {
  it('is rejected while a gather is in flight', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const { startChatroom } = await import('../../src/engine/chatroom.ts')
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather = newGather('q', ['taleb'])
    await expect(askHuman(e, roles[0]!.sessionKey, '预算多少？')).rejects.toThrow()
  })

  it('is allowed outside a gather', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const { startChatroom } = await import('../../src/engine/chatroom.ts')
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    await expect(askHuman(e, roles[0]!.sessionKey, '预算多少？')).resolves.toBeUndefined()
  })
})

describe('GatherRoles vs pending human question', () => {
  it('is rejected while an ask-human question is pending, consuming no state', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const { startChatroom } = await import('../../src/engine/chatroom.ts')
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    const hubSess = e.sessions.getOrCreateActive(hub)
    chatroomState(hubSess).pendingHumanQuestionRole = 'taleb'

    expect(() => { gatherRoles(e, hub, '并行问题', false) }).toThrow('已暂停')

    // A rejected gather must not install an orphan barrier or consume the seq.
    expect(chatroomState(hubSess).pendingGather).toBeUndefined()
    expect(chatroomState(hubSess).chatroomGatherSeq).toBe(0)
    expect(chatroomState(e.sessions.getOrCreateActive(roles[0]!.sessionKey)).chatroomAsked).toBe(false)
  })

  it('a human reply during an armed gather falls through to the hub, not a second ask', async () => {
    // Backstop for interleavings armed before the gather guard existed
    // (pending flag + live gather): routing the reply now would inject a
    // SECOND in-flight ask into the gathering role — its first turn-end
    // consumes the one-shot relay gate and the second turn-end is dropped.
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const { startChatroom } = await import('../../src/engine/chatroom.ts')
    await startChatroom(e, hub, ['taleb'], 'topic')
    const hubSess = e.sessions.getOrCreateActive(hub)
    chatroomState(hubSess).pendingHumanQuestionRole = 'taleb'
    const g = newGather('并行问题', ['taleb'])
    chatroomState(hubSess).pendingGather = g
    const recv = vi.spyOn(e, 'receiveMessage').mockImplementation(() => {})

    const consumed = routePendingHumanReply(e, p, hub, '人类的回答')
    await settle()

    // The reply hands back to the hub's normal agent path (the moderator
    // relays it after the round); the flag retires with the answer.
    expect(consumed).toBe(false)
    expect(chatroomState(hubSess).pendingHumanQuestionRole).toBe('')
    expect(recv.mock.calls).toHaveLength(0)
    // The armed gather round is untouched.
    expect(chatroomState(hubSess).pendingGather).toBe(g)
    expect(g.expected.has('taleb')).toBe(true)
  })
})

describe('GatherRoles vs an armed gather', () => {
  it('is rejected while a gather is in flight, preserving the armed barrier', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const { startChatroom } = await import('../../src/engine/chatroom.ts')
    await startChatroom(e, hub, ['taleb'], 'topic')
    const hubSess = e.sessions.getOrCreateActive(hub)

    const armed = newGather('第一轮', ['taleb'])
    chatroomState(hubSess).pendingGather = armed

    expect(() => { gatherRoles(e, hub, '第二轮', false) }).toThrow('仍在进行中')

    // A rejected repeat must not overwrite the armed barrier or consume the seq.
    expect(chatroomState(hubSess).pendingGather).toBe(armed)
    expect(chatroomState(hubSess).chatroomGatherSeq).toBe(0)
  })
})

describe('askRole vs an armed gather', () => {
  it('is rejected while a gather is in flight — the reply would be swallowed or lost', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const { startChatroom, askRole } = await import('../../src/engine/chatroom.ts')
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    const hubSess = e.sessions.getOrCreateActive(hub)
    chatroomState(hubSess).pendingGather = newGather('并行问题', ['taleb'])

    await expect(askRole(e, hub, 'taleb', '追问')).rejects.toThrow('并行收集进行中')

    // The role was not re-armed: no in-flight mark, no question injected.
    const roleSess = e.sessions.getOrCreateActive(roles[0]!.sessionKey)
    expect(chatroomState(roleSess).chatroomInFlight).toBe(false)
    expect(chatroomState(roleSess).chatroomAsked).toBe(false)
  })
})

describe('role-turn persona anchor', () => {
  // Long sessions pull the role's register toward ops-report language while
  // the one-shot persona injection decays into a distant prefix (2026-09
  // oc_e51a session-log evidence: zero catchphrases, zero historical
  // analogies, half the turns bare ops status). Every moderator→role turn
  // message therefore re-anchors the persona.
  it('serial ask injects the persona re-anchor line into the role turn', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const { startChatroom, askRole } = await import('../../src/engine/chatroom.ts')
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    const recv = vi.spyOn(e, 'receiveMessage').mockImplementation(() => {})

    await askRole(e, hub, roles[0]!.sessionKey, '你的判断是什么')

    const turns = recv.mock.calls.map(c => c[1] as { sessionKey: string; content: string })
    const turn = turns.find(m => m.content.startsWith('[主持]'))
    expect(turn).toBeDefined()
    expect(turn!.content).toContain('（以你的人设作答')
  })

  it('gather broadcast carries the same anchor on every role turn', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const { startChatroom } = await import('../../src/engine/chatroom.ts')
    const roles = await startChatroom(e, hub, ['taleb', 'munger'], 'topic')
    const recv = vi.spyOn(e, 'receiveMessage').mockImplementation(() => {})

    gatherRoles(e, hub, '并行问题', false)
    await waitFor(() => recv.mock.calls.length >= roles.length, `${roles.length} gather broadcasts`)

    const turns = recv.mock.calls
      .map(c => c[1] as { sessionKey: string; content: string })
      .filter(m => m.content.includes('[并行收集]'))
    expect(turns).toHaveLength(roles.length)
    for (const m of turns) {
      expect(m.content).toContain('（以你的人设作答')
    }
  })
})

describe('gather broadcast failure', () => {
  /** A spawner whose ctx reconstruction fails for the second spawned role. */
  function spawnerFailingSecondRole() {
    const p = createStubChatroomSpawner()
    const orig = p.reconstructReplyCtx.bind(p)
    p.reconstructReplyCtx = async (sessionKey: string) => {
      if (sessionKey.includes('role-2')) throw new Error('ctx boom')
      return orig(sessionKey)
    }
    return p
  }

  it('a failed broadcast drops the role from expected; the last reply still wakes', async () => {
    const p = spawnerFailingSecondRole()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const { startChatroom } = await import('../../src/engine/chatroom.ts')
    const roles = await startChatroom(e, hub, ['taleb', 'munger'], 'topic')
    const wake = vi.spyOn(e, 'deliverMachineMessage')

    gatherRoles(e, hub, '并行问题', false)
    await settle()
    await settle()
    // munger's broadcast failed before the role ever saw the question — it
    // must leave the expected set instead of stranding the barrier.
    const g = chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather
    expect(g?.expected.has('munger')).toBe(false)

    // taleb's reply completes the round: no idle wait for a reply that can
    // never arrive.
    const taleb = e.sessions.getOrCreateActive(roles[0]!.sessionKey)
    chatroomState(taleb).chatroomAsked = false
    const st = new InteractiveState()
    st.platform = p
    maybeAutoRelayRole(e, st, taleb, '我的回复', false)

    expect(chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather).toBeUndefined()
    // Ask injections ride deliverMachineMessage too — wait for the wake that
    // actually carries the reply, not merely the first channel call.
    await waitFor(() => wake.mock.calls.some(([, m]) => m.content.includes('我的回复')), 'moderator woken')
    expect(wake.mock.calls.some(([, m]) => m.content.includes('我的回复'))).toBe(true)
  })

  it('every broadcast failing closes the round immediately instead of idling to the timeout', async () => {
    const p = spawnerFailingSecondRole()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const { startChatroom } = await import('../../src/engine/chatroom.ts')
    // Both spawned roles hit the failing ctx path (role-1 via the shared
    // stub counter collides only after two spawns, so fail both explicitly).
    const orig = p.reconstructReplyCtx.bind(p)
    p.reconstructReplyCtx = async (sessionKey: string) => {
      if (sessionKey.includes('role-')) throw new Error('ctx boom')
      return orig(sessionKey)
    }
    await startChatroom(e, hub, ['taleb', 'munger'], 'topic')
    const wake = vi.spyOn(e, 'deliverMachineMessage')

    gatherRoles(e, hub, '并行问题', false)

    await waitFor(() => chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather === undefined, 'gather closed')
    await waitFor(() => wake.mock.calls.length > 0, 'moderator woken')
    expect(String(wake.mock.calls[0]?.[1]?.content)).toContain('并行收集完成')
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
    chatroomState(taleb).chatroomHubKey = hub
    chatroomState(taleb).chatroomRoleName = 'taleb'
    taleb.setParentSessionKey(hub)
    const munger = e.sessions.getOrCreateActive('test:role-munger')
    chatroomState(munger).chatroomHubKey = hub
    chatroomState(munger).chatroomRoleName = 'munger'
    munger.setParentSessionKey(hub)
    chatroomState(munger).researchDispatched = true
    const ghost = e.sessions.getOrCreateActive('test:role-ghost')
    chatroomState(ghost).chatroomHubKey = hub
    chatroomState(ghost).chatroomRoleName = 'ghost'
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
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const { startChatroom } = await import('../../src/engine/chatroom.ts')
    await startChatroom(e, hub, ['taleb', 'munger'], 'topic')
    chatroomState(e.sessions.getOrCreateActive(hub)).chatroomResearch = true
    clearCards(p)
    await settle()
    clearCards(p)

    gatherRoles(e, hub, '研究中国股市', true)
    const g = chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather
    expect(g).toBeDefined()
    g!.stopTimer()
    await waitFor(() => g!.progressHandle !== undefined, 'progress card handle stored')

    // Plain gather: no progress card.
    chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather = undefined
    gatherRoles(e, hub, '普通收集', false)
    const g2 = chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather
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
    chatroomState(hubSess).pendingGather = g

    for (const name of ['Taleb', 'Munger']) {
      const role = e.sessions.getOrCreateActive(`test:role-${name}`)
      chatroomState(role).chatroomHubKey = hub
      chatroomState(role).chatroomRoleName = name
      chatroomState(role).chatroomAsked = false
      chatroomState(role).chatroomAskSeq = 1
      chatroomState(role).chatroomInFlight = true
      const st = new InteractiveState()
      st.platform = p
      maybeAutoRelayRole(e, st, role, `结论${name}`, false)
      await settle()
    }

    const titles = p.patchedTitles()
    expect(titles).toHaveLength(2)
    expect(titles[titles.length - 1]).toContain('全部角色已回复')
  })

  it('carries the interjection hint on the live body, not on terminal states', async () => {
    const { buildResearchProgressCard } = await import('../../src/engine/chatroom.ts')
    const e = new Engine('test', createStubAgent(), [], '', 'zh')
    const live = JSON.stringify(buildResearchProgressCard(e, 1, 2, ''))
    expect(live).toContain('1/2')
    expect(live).toContain('💡 随时在本群发消息即可插话、追问或调整方向，主持人会处理。')
    const done = JSON.stringify(buildResearchProgressCard(e, 2, 2, 'done'))
    expect(done).toContain('全部角色已回复')
    expect(done).not.toContain('插话')
  })

  it('stops the heartbeat after the final timeout: no live PATCH follows the timedout terminal', async () => {
    // 2026-09-07: the second-timeout destroy path left tickTimer running, so
    // the heartbeat kept PATCHing the just-timedout card back to a live X/N
    // view every minute. The final timeout must stop the heartbeat with the
    // barrier.
    const p = createStubProgressCardPlatform()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const { startChatroom } = await import('../../src/engine/chatroom.ts')
    await startChatroom(e, hub, ['taleb', 'munger'], 'topic')
    chatroomState(e.sessions.getOrCreateActive(hub)).chatroomResearch = true
    clearCards(p)
    await settle()
    clearCards(p)
    const wake = vi.spyOn(e, 'deliverMachineMessage').mockImplementation(() => {})

    vi.useFakeTimers()
    try {
      gatherRoles(e, hub, '研究中国股市', true)
      for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0)
      const g = chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather
      expect(g).toBeDefined()
      await waitFor(() => g!.progressHandle !== undefined, 'progress card handle stored')

      // Nobody replies: the research window (60m) re-arms the barrier, the
      // re-arm window (20m) degrades it — the card lands on the timedout
      // terminal and the moderator is woken twice.
      await vi.advanceTimersByTimeAsync(80 * 60 * 1000)
      for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0)
      expect(chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather).toBeUndefined()
      expect(wake.mock.calls.filter(c => (c[1] as { sessionKey: string }).sessionKey === hub)).toHaveLength(2)
      const titles = p.patchedTitles()
      expect(titles.length).toBeGreaterThan(0)
      expect(titles[titles.length - 1]).toContain('研究已超时')

      // Five more heartbeat minutes: the dead barrier must not PATCH the
      // card back to a live view.
      const patchCount = p.updateCards.length
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
      for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0)
      expect(p.updateCards).toHaveLength(patchCount)
      expect(p.patchedTitles()[p.patchedTitles().length - 1]).toContain('研究已超时')
    } finally {
      wake.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('research config range clamping', () => {
  it('clamps the timeout to [1m, 24h]', () => {
    const e = new Engine('test', createStubAgent(), [], '', 'zh')
    chatroomConfig(e).applySection({ researchTimeoutSec: Math.round(1_000 / 1000) })
    expect(chatroomConfig(e).researchTimeoutDuration()).toBe(60_000)
    chatroomConfig(e).applySection({ researchTimeoutSec: Math.round(48 * 60 * 60 * 1000 / 1000) })
    expect(chatroomConfig(e).researchTimeoutDuration()).toBe(24 * 60 * 60 * 1000)
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
    chatroomState(sess).chatroomModerator = true
    chatroomState(sess).chatroomResearch = true
    chatroomState(sess).chatroomResearchMode = mode
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

    const { armResearchManualAskTimeout } = await import('../../src/engine/chatroom.ts')
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

    const { armResearchManualAskTimeout } = await import('../../src/engine/chatroom.ts')
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
    const { armResearchManualAskTimeout } = await import('../../src/engine/chatroom.ts')
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

    const { armResearchManualAskTimeout } = await import('../../src/engine/chatroom.ts')
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

  it('research priming opens with a bounded clarify stage before the data-needs stage', () => {
    const priming = buildChatroomResearchModeratorPriming('topic', testRoles, '/tmp/ledger', 'auto', '/tmp/ws')
    for (const want of ['澄清研究背景', '最多 2 轮', 'ask_user_question', '用户背景与约束', '无需追问']) {
      expect(priming).toContain(want)
    }
    // The clarify stage precedes the data-needs stage, and both precede
    // round 1.
    expect(priming.indexOf('澄清研究背景')).toBeLessThan(priming.indexOf('数据需求清单'))
    expect(priming.indexOf('数据需求清单')).toBeLessThan(priming.indexOf('### 第 1 轮'))
  })

  it('the plain chatroom priming keeps its own 3-round clarify loop', () => {
    const priming = buildChatroomModeratorPriming('topic', testRoles, '/tmp/ledger')
    expect(priming).toContain('最多 3 轮澄清')
    expect(priming).not.toContain('澄清研究背景')
  })

  it('documents the poll action and the closing blind-spot sweep', () => {
    const priming = buildChatroomModeratorPriming('topic', testRoles, '/tmp/ledger')
    // The tool list names the lightning round...
    expect(priming).toContain('action: poll')
    // ...and the closing flow sweeps the sidelined roles before the summary.
    expect(priming).toContain('round: closing')
    expect(priming).toContain('补盲')
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
      ['research', buildChatroomResearchModeratorPriming('topic', testRoles, '/tmp/ledger', 'auto', '/tmp/ws')],
    ]
    for (const [, priming] of cases) {
      expect(priming).toContain('总分结构')
      for (const banned of ['金字塔', '塔尖']) {
        expect(priming).not.toContain(banned)
      }
    }
  })

  it('offers the plain plain-talk default AND the optional academic version', () => {
    const cases: Array<[string, string]> = [
      ['moderator', buildChatroomModeratorPriming('topic', testRoles, '/tmp/ledger')],
      ['research', buildChatroomResearchModeratorPriming('topic', testRoles, '/tmp/ledger', 'auto', '/tmp/ws')],
    ]
    for (const [, priming] of cases) {
      for (const want of ['summary.html', '白话直讲版', '直接讲事情本身', '最小实例', '仍有的分歧']) {
        expect(priming).toContain(want)
      }
      for (const banned of ['费曼', '生活类比']) {
        expect(priming).not.toContain(banned)
      }
      for (const want of ['summary-academic.html', '出一份深度学术版', '总分结构', '记住用户已选过学术版', '若用户此前选过「出一份深度学术版」']) {
        expect(priming).toContain(want)
      }
    }
  })

  it('carries the prior screening flow only when a prior is given', () => {
    const prior = { topic: '旧议题', dir: '/tmp/prior' }
    const plain = buildChatroomModeratorPriming('topic', testRoles, '/tmp/ledger')
    const withPrior = buildChatroomModeratorPriming('topic', testRoles, '/tmp/ledger', { prior })
    for (const want of ['前情（继承自 旧议题，未经本次讨论验证）', '/tmp/prior', '采信', '修正：', '循环印证']) {
      expect(withPrior).toContain(want)
    }
    expect(plain).not.toContain('前情（继承自')
    const research = buildChatroomResearchModeratorPriming('topic', testRoles, '/tmp/ledger', 'auto', '/tmp/ws', prior)
    expect(research).toContain('前情（继承自 旧议题，未经本次讨论验证）')
    expect(research).toContain('采信')
    expect(buildChatroomResearchModeratorPriming('topic', testRoles, '/tmp/ledger', 'auto', '/tmp/ws')).not.toContain('前情（继承自')
  })

  it('mentions the shared research data in the plain priming only when a workspace is passed', () => {
    const withWs = buildChatroomModeratorPriming('topic', testRoles, '/tmp/ledger', { researchWs: '/tmp/ws' })
    expect(withWs).toContain('/tmp/ws')
    expect(withWs).toContain('DATA_LEDGER.md')
    expect(withWs).toContain('三列')
    expect(withWs).toContain('spot-check')
    expect(buildChatroomModeratorPriming('topic', testRoles, '/tmp/ledger')).not.toContain('DATA_LEDGER.md')
  })

  it('instructs writing the closing summary to REPORT.md via note section report', () => {
    const cases: Array<[string, string]> = [
      ['moderator', buildChatroomModeratorPriming('topic', testRoles, '/tmp/ledger')],
      ['research', buildChatroomResearchModeratorPriming('topic', testRoles, '/tmp/ledger', 'auto', '/tmp/ws')],
    ]
    for (const [, priming] of cases) {
      expect(priming).toContain('section: report')
      expect(priming).toContain('REPORT.md')
    }
  })
})

describe('buildChatroomResearchModeratorPriming', () => {
  it('instructs note (section: subproblems) to fill SUBPROBLEMS.md', () => {
    const priming = buildChatroomResearchModeratorPriming('topic', testRoles, '/tmp/ledger', 'auto', '/tmp/ws')
    expect(priming).toContain('section: subproblems')
  })

  it('addresses the assistant by the "assistant" sentinel, never a key the model must transcribe', () => {
    const priming = buildChatroomResearchModeratorPriming('topic', testRoles, '/tmp/ledger', 'auto', '/tmp/ws')
    expect(priming).toContain('child 用 "assistant"')
    // The Go-era env var no longer exists in the dsh backend; mentioning it
    // sent models hunting for a value they cannot see (2026-08-25 oc_ac5db).
    expect(priming).not.toContain('CC_RESEARCH_ASSISTANT_CHILD')
  })

  it('instructs persisting artifacts into the shared workspace', () => {
    const priming = buildChatroomResearchModeratorPriming('topic', testRoles, '/tmp/ledger', 'auto', '/tmp/ws')
    expect(priming).toContain('存成文件')
    expect(priming).toContain('工作区')
  })

  it('relays data-reliability requirements to assistants in the round-1 task template', () => {
    const priming = buildChatroomResearchModeratorPriming('topic', testRoles, '/tmp/ledger', 'auto', '/tmp/ws')
    for (const want of ['数据必须可靠', '权威一手源', '两个独立源交叉验证或加总闭合', '不编造']) {
      expect(priming).toContain(want)
    }
  })

  it('instructs a plain per-round progress sync and an uncapped iterate-as-needed loop in auto mode only', () => {
    const auto = buildChatroomResearchModeratorPriming('topic', testRoles, '/tmp/ledger', 'auto', '/tmp/ws')
    expect(auto).toContain('无轮数上限')
    expect(auto).toContain('用一条普通回复向用户同步进展')
    expect(auto).toContain('不用卡片、不等回复、不暂停研究')
    const manual = buildChatroomResearchModeratorPriming('topic', testRoles, '/tmp/ledger', 'manual', '/tmp/ws')
    expect(manual).not.toContain('同步进展')
  })

  it('instructs handling mid-run user messages in both modes', () => {
    for (const mode of ['auto', 'manual']) {
      const priming = buildChatroomResearchModeratorPriming('topic', testRoles, '/tmp/ledger', mode, '/tmp/ws')
      expect(priming).toContain('用户中途发言')
      expect(priming).toContain('追问用 action: ask 转给相关角色')
      // The ask-during-gather interlock rejects askRole mid-round; the
      // priming must pre-announce that instead of letting the model hit it.
      expect(priming).toContain('gather 在途时 ask 会被拒')
      expect(priming).toContain('并入下一轮 gather 任务')
      expect(priming).toContain('不要无视')
    }
  })

  it('stages a needs gather then a steward prefetch before round 1', () => {
    const priming = buildChatroomResearchModeratorPriming('topic', testRoles, '/tmp/ledger', 'auto', '/tmp/ws')
    for (const want of [
      '只列清单，不派助手、不下数据',
      '数据管家',
      'data/core/',
      'DATA_LEDGER',
      '按数据源/序列拆成 3-6 个并行子任务',
      '点名分配',
      '独立双源即止',
      '不复用台账已有文件',
      '预计 30-60 分钟',
      // The replacement-steward path must address the spawned child by its
      // returned session key — the "assistant" alias still resolves to the
      // empty pre-provision and errors.
      '新建替补管家',
      '"assistant" 别名仍解析不到替补',
    ]) {
      expect(priming).toContain(want)
    }
  })

  it('gates the closing numeric reconciliation leg on the research workspace', () => {
    const withWs = buildChatroomResearchModeratorPriming('topic', testRoles, '/tmp/ledger', 'auto', '/tmp/ws')
    for (const want of ['数字对账', 'RECON.md', '禁止联网重抓、禁止装包', '对账存疑']) {
      expect(withWs).toContain(want)
    }
    // Reconciliation maps report numbers against DATA_LEDGER/data artifacts;
    // without a shared workspace there is nothing to map against, and the
    // default (non-research) chatroom closing never reconciles either.
    expect(buildChatroomResearchModeratorPriming('topic', testRoles, '/tmp/ledger', 'auto', '')).not.toContain('RECON.md')
    expect(buildChatroomModeratorPriming('topic', testRoles, '/tmp/ledger')).not.toContain('RECON.md')
  })

  it('binds round-1 fetch tasks to the research playbook recipes with and without a workspace', () => {
    // The playbook rides the research-assistant persona (chatroom-policy),
    // not the shared workspace — the binding phrase reaches assistants in
    // both shapes of research room.
    for (const ws of ['/tmp/ws', '']) {
      const priming = buildChatroomResearchModeratorPriming('topic', testRoles, '/tmp/ledger', 'auto', ws)
      expect(priming).toContain('playbook 的已验证配方')
    }
    // The steward prefetch brief carries its own binding (workspace-gated).
    const withWs = buildChatroomResearchModeratorPriming('topic', testRoles, '/tmp/ledger', 'auto', '/tmp/ws')
    expect(withWs).toContain('抓取优先按研究 playbook 已验证配方')
    expect(withWs).toContain('新抓取同样优先 playbook 已验证配方')
  })

  it('omits the steward and ledger sections without a shared research workspace', () => {
    const priming = buildChatroomResearchModeratorPriming('topic', testRoles, '/tmp/ledger', 'auto', '')
    // The needs gather still runs — it costs minutes and shapes round 1.
    expect(priming).toContain('只列清单，不派助手、不下数据')
    expect(priming).toContain('跳过公共预取')
    // The claim partition is workspace-independent.
    expect(priming).toContain('点名分配')
    for (const banned of ['数据管家', 'data/core/', 'DATA_LEDGER']) {
      expect(priming).not.toContain(banned)
    }
  })
})

describe('research progress card projection (heartbeat + merge)', () => {
  it('the live body names waiting roles and elapsed minutes; terminal states omit them', async () => {
    const { buildResearchProgressCard } = await import('../../src/engine/chatroom.ts')
    const e = new Engine('test', createStubAgent(), [], '', 'zh')
    const live = JSON.stringify(buildResearchProgressCard(e, 3, 5, '', ['dalio', 'marks'], 37))
    expect(live).toContain('3/5')
    expect(live).toContain('等待中：dalio、marks（已进行 37 分钟）')
    expect(live).toContain('插话')
    const done = JSON.stringify(buildResearchProgressCard(e, 5, 5, 'done', [], 0))
    expect(done).not.toContain('等待中')
    expect(done).not.toContain('已进行')
  })

  it('heartbeats the live card with waiting roles while a research round waits on the slow role', async () => {
    const p = createStubProgressCardPlatform()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const { startChatroom } = await import('../../src/engine/chatroom.ts')
    await startChatroom(e, hub, ['taleb', 'munger'], 'topic')
    chatroomState(e.sessions.getOrCreateActive(hub)).chatroomResearch = true
    clearCards(p)
    await settle()
    clearCards(p)
    // Setup done under real timers; the heartbeat interval and its clock
    // are exercised under fake timers.
    vi.useFakeTimers()
    try {
      gatherRoles(e, hub, '研究中国股市', true)
      const g = chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather
      expect(g).toBeDefined()
      // No stopTimer here: it is a terminal-transition helper and also stops
      // the heartbeat; the 20m fallback never fires under the faked clock.
      // Flush the async card-send chain (microtasks only; timers are faked).
      for (let i = 0; i < 10 && g!.progressHandle === undefined; i++) await vi.advanceTimersByTimeAsync(0)
      expect(g!.progressHandle).toBeDefined()
      const before = p.updateCards.length

      // One minute in: the heartbeat PATCHes the live card with waiting info.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(p.updateCards.length).toBe(before + 1)
      const body = JSON.stringify(p.updateCards[p.updateCards.length - 1])
      expect(body).toContain('等待中：taleb、munger')
      expect(body).toContain('已进行 1 分钟')

      // A later tick PATCHes again with the rolled elapsed clock.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(p.updateCards.length).toBe(before + 2)
      expect(JSON.stringify(p.updateCards[p.updateCards.length - 1])).toContain('已进行 2 分钟')
    } finally {
      vi.useRealTimers()
    }
  })

  it('merges bursty live PATCHes and lands terminal states immediately', async () => {
    vi.useFakeTimers()
    try {
      const hub = 'test:hub:user-1'
      const p = createStubProgressCardPlatform()
      const e = newChatroomTestEngine(p)
      const { updateResearchProgressCard } = await import('../../src/engine/chatroom.ts')
      const hubSess = e.sessions.getOrCreateActive(hub)
      const g = new ChatroomGather('q', 1)
      g.expected.add('Taleb')
      g.expected.add('Munger')
      g.expected.add('Graham')
      g.progressHandle = 'h'
      g.startedAt = Date.now() - 90_000
      chatroomState(hubSess).pendingGather = g

      // Three replies land within the merge window: one immediate live
      // PATCH plus one trailing coalesced PATCH — never three.
      updateResearchProgressCard(e, p, g, '')
      g.accumulate('Taleb', 'r1')
      updateResearchProgressCard(e, p, g, '')
      g.accumulate('Munger', 'r2')
      updateResearchProgressCard(e, p, g, '')
      expect(p.updateCards.length).toBe(1)
      await vi.advanceTimersByTimeAsync(2_100)
      expect(p.updateCards.length).toBe(2)
      expect(JSON.stringify(p.updateCards[1])).toContain('2/3')

      // The terminal state bypasses the merge window entirely.
      g.accumulate('Graham', 'r3')
      updateResearchProgressCard(e, p, g, 'done')
      expect(p.updateCards.length).toBe(3)
      expect(p.patchedTitles()[2]).toContain('全部角色已回复')
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── gather timeout re-arm barrier (G-A) ────────────────────────────────────
//
// 2026-09-06 incident: the hub's 5-role research gather collected 1/5 at the
// 1200s timeout and partially woke the moderator, which reasonably assumed
// "the remaining reports will wake me when they land" — but the 4 late
// deliveries (all on disk 5-10 minutes past the timeout) hit the ask-identity
// router as superseded asks and relayed as free replies: group-visible, never
// injected, never waking. The supervision net dragged the room back 30-60
// minutes later. A timed-out gather now re-arms the barrier ONCE for the
// still-missing roles instead of destroying it: late replies keep funneling
// through the gather path, and only a second timeout degrades to free relay.

describe('gather timeout re-arm barrier', () => {
  /** Flush the async broadcast/relay/wake chains under faked timers. */
  async function flush(times = 10): Promise<void> {
    for (let i = 0; i < times; i++) await vi.advanceTimersByTimeAsync(0)
  }

  /** End a role's turn with a stamped reply through the production relay path. */
  function relayStamped(e: Engine, p: Platform, roleKey: string, roleName: string, hub: string, seq: number, reply: string): void {
    const role = e.sessions.getOrCreateActive(roleKey)
    chatroomState(role).chatroomHubKey = hub
    chatroomState(role).chatroomRoleName = roleName
    chatroomState(role).chatroomAsked = false
    chatroomState(role).chatroomAskSeq = seq
    const st = new InteractiveState()
    st.platform = p
    maybeAutoRelayRole(e, st, role, reply, false)
  }

  it('times out once and re-arms the barrier instead of destroying it, waking the moderator with the re-arm notice', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const { startChatroom } = await import('../../src/engine/chatroom.ts')
    const roles = await startChatroom(e, hub, ['taleb', 'munger'], 'topic')
    clearCards(p)
    await settle()
    clearCards(p)
    const wake = vi.spyOn(e, 'deliverMachineMessage')

    vi.useFakeTimers()
    try {
      gatherRoles(e, hub, '并行问题', false)
      await flush()
      const g = chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather
      expect(g).toBeDefined()

      // taleb replies in time; munger is the late one.
      relayStamped(e, p, roles[0]!.sessionKey, 'taleb', hub, g!.seq, '按时回复')
      await flush()

      // The gather timeout fires (default 20m): the barrier is NOT destroyed.
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000)
      await flush()

      const hubGather = chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather
      expect(hubGather).toBe(g)
      expect(hubGather!.expected.has('munger')).toBe(true)
      expect((hubGather as unknown as { rearmed?: boolean }).rearmed).toBe(true)
      // The re-armed fallback timer is live again.
      expect(hubGather!.timer).toBeDefined()
      hubGather!.stopTimer()

      // The moderator got the partial wake: the collected reply plus the
      // re-arm notice naming the still-missing role.
      const wakes = wake.mock.calls.map(c => c[1]).filter(m => m.sessionKey === hub)
      expect(wakes).toHaveLength(1)
      expect(String(wakes[0]?.content)).toContain('按时回复')
      expect(String(wakes[0]?.content)).toContain('重挂')
      expect(String(wakes[0]?.content)).toContain('munger')
    } finally {
      vi.useRealTimers()
    }
  })

  it('late deliveries inside the re-arm window funnel through the gather path and wake the moderator with ALL replies', async () => {
    // The incident shape: one role on time, two late by minutes past the
    // timeout. Their relays must take the gather fan-in path (not the
    // superseded-ask free relay) and the final wake carries every reply.
    const root = await mkdtemp(join(tmpdir(), 'fb-gather-roles-'))
    for (const n of ['taleb', 'munger', 'dalio']) {
      await mkdir(join(root, n), { recursive: true })
      await writeFile(join(root, n, 'CLAUDE.md'), `# ${n}\n`, 'utf8')
    }
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: root })
    const hub = 'test:hub:user-1'
    const { startChatroom } = await import('../../src/engine/chatroom.ts')
    const roles = await startChatroom(e, hub, ['taleb', 'munger', 'dalio'], 'topic')
    clearCards(p)
    await settle()
    clearCards(p)
    const wake = vi.spyOn(e, 'deliverMachineMessage')
    const journal = vi.spyOn(console, 'info').mockImplementation(() => {})

    vi.useFakeTimers()
    try {
      gatherRoles(e, hub, '并行问题', false)
      await flush()
      const g = chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather
      expect(g).toBeDefined()

      relayStamped(e, p, roles[0]!.sessionKey, 'taleb', hub, g!.seq, '按时回复')
      await flush()
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000)
      await flush()
      expect(wake.mock.calls.filter(c => (c[1] as { sessionKey: string }).sessionKey === hub)).toHaveLength(1)

      // munger lands 5 minutes into the re-arm window: the gather fan-in
      // path keeps the barrier and logs the waiting-for-more fingerprint.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
      relayStamped(e, p, roles[1]!.sessionKey, 'munger', hub, g!.seq, '迟到回复一')
      await flush()
      const hubGather = chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather
      expect(hubGather).toBe(g)
      expect(hubGather!.collected.get('munger')).toBe('迟到回复一')
      expect(journal.mock.calls.some(c => String(c[0]).includes('gathered role reply (waiting for more)'))).toBe(true)
      // No extra wake for a partial late reply.
      expect(wake.mock.calls.filter(c => (c[1] as { sessionKey: string }).sessionKey === hub)).toHaveLength(1)

      // dalio lands 3 minutes later: the barrier completes —
      // destroyed, and ONE wake carries all three replies (batch injection).
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000)
      relayStamped(e, p, roles[2]!.sessionKey, 'dalio', hub, g!.seq, '迟到回复二')
      await flush()
      expect(chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather).toBeUndefined()
      const wakes = wake.mock.calls.map(c => c[1]).filter(m => m.sessionKey === hub)
      expect(wakes).toHaveLength(2)
      const finalWake = String(wakes[1]?.content)
      expect(finalWake).toContain('按时回复')
      expect(finalWake).toContain('迟到回复一')
      expect(finalWake).toContain('迟到回复二')
    } finally {
      journal.mockRestore()
      vi.useRealTimers()
    }
  })

  it('a second timeout degrades to free relay and never re-arms again', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const { startChatroom } = await import('../../src/engine/chatroom.ts')
    const roles = await startChatroom(e, hub, ['taleb', 'munger'], 'topic')
    clearCards(p)
    await settle()
    clearCards(p)
    const wake = vi.spyOn(e, 'deliverMachineMessage')

    vi.useFakeTimers()
    try {
      gatherRoles(e, hub, '并行问题', false)
      await flush()
      const g = chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather
      expect(g).toBeDefined()

      relayStamped(e, p, roles[0]!.sessionKey, 'taleb', hub, g!.seq, '按时回复')
      await flush()
      // First window elapses (re-arm), then the whole re-arm window too —
      // the late reply never comes.
      await vi.advanceTimersByTimeAsync(40 * 60 * 1000)
      await flush()

      // The barrier is destroyed; the moderator got the final partial wake
      // naming the missing role.
      expect(chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather).toBeUndefined()
      const wakes = wake.mock.calls.map(c => c[1]).filter(m => m.sessionKey === hub)
      expect(wakes).toHaveLength(2)
      expect(String(wakes[1]?.content)).toContain('超时未回复')
      expect(String(wakes[1]?.content)).toContain('munger')

      // munger finally lands AFTER the round closed: the superseded-ask
      // path relays it as a free reply (group-visible card, no barrier, no
      // wake) — the pre-re-arm behavior is the final degradation.
      const cardsBefore = p.sentCards.length
      relayStamped(e, p, roles[1]!.sessionKey, 'munger', hub, g!.seq, '彻底迟到的回复')
      await flush()
      expect(chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather).toBeUndefined()
      expect(p.sentCards.length).toBe(cardsBefore + 1)
      expect(p.sentCards[p.sentCards.length - 1] ? cardBody(p.sentCards[p.sentCards.length - 1]) : '').toContain('彻底迟到的回复')
      expect(wake.mock.calls.map(c => c[1]).filter(m => m.sessionKey === hub)).toHaveLength(2)

      // No third window ever exists: advancing past a whole extra window
      // wakes nobody and mints no barrier.
      await vi.advanceTimersByTimeAsync(40 * 60 * 1000)
      await flush()
      expect(wake.mock.calls.map(c => c[1]).filter(m => m.sessionKey === hub)).toHaveLength(2)
      expect(chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('honors a configured gatherRearmSec for the re-armed window', async () => {
    // A 1-second re-arm window proves the config drives the armed timer,
    // not just the getter: the second timeout fires at +1s, not +20m.
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    chatroomConfig(e).applySection({ gatherRearmSec: 1 })
    const hub = 'test:hub:user-1'
    const { startChatroom } = await import('../../src/engine/chatroom.ts')
    await startChatroom(e, hub, ['taleb', 'munger'], 'topic')
    clearCards(p)
    await settle()
    clearCards(p)
    const wake = vi.spyOn(e, 'deliverMachineMessage')

    vi.useFakeTimers()
    try {
      gatherRoles(e, hub, '并行问题', false)
      await flush()
      expect(chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather).toBeDefined()

      await vi.advanceTimersByTimeAsync(20 * 60 * 1000)
      await flush()
      expect(chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather).toBeDefined() // re-armed

      await vi.advanceTimersByTimeAsync(1000)
      await flush()
      expect(chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather).toBeUndefined() // 1s window burned
      expect(wake.mock.calls.map(c => c[1]).filter(m => m.sessionKey === hub)).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
