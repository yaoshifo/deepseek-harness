/**
 * Ask-identity routing tests: a role turn's reply is routed by the identity
 * of the ask that opened it, not by one-shot gate inference. Covers the
 * 2026-09-06 oc_97be4a1c loss — a gather times out, the moderator serially
 * re-asks the slow role, the stale round turn's end consumed the re-armed
 * gate, and the serial ask's own answer turn hit the consumed-gate early
 * return and was dropped wholesale.
 *
 * @module dsh-feishu-bridge-chatroom/tests-engine-chatroom-ask-routing
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Engine, InteractiveState, ProjectStateStore, registerSessionCommands } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { registerChatroomCommands } from '../../src/engine/chatroom-cmd.ts'
import { askRole, gatherRoles, maybeAutoRelayRole, startChatroom } from '../../src/engine/chatroom.ts'
import { chatroomState } from '../../src/chatroom-state.ts'
import { chatroomConfig } from '../../src/chatroom-config.ts'
import { chatroomPolicyFace } from '../stubs/bridge-policy.ts'
import { clearCards, createStubAgent, createStubChatroomSpawner, newControllableSession } from '../stubs/engine-stubs.ts'
import type { Platform } from '@deepseek-ai/dsh-feishu-bridge/exports'
import type { RecordedCard } from '../stubs/engine-stubs.ts'
import '../stubs/messages.js'

async function settle(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

function newChatroomTestEngine(p: Platform): Engine {
  const e = new Engine('test', createStubAgent(), [p], '', 'zh', chatroomPolicyFace())
  e.setProjectStateStore(new ProjectStateStore(''))
  registerSessionCommands(e)
  registerChatroomCommands(e)
  return e
}

async function scaffoldOneRole(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fb-ask-routing-'))
  await mkdir(join(root, 'taleb'), { recursive: true })
  await writeFile(join(root, 'taleb', 'CLAUDE.md'), '# taleb\n', 'utf8')
  return root
}

function cardBody(card: unknown): string {
  const c = card as RecordedCard
  const first = c.elements[0]
  return first?.kind === 'markdown' ? (first.content ?? '') : ''
}

describe('ask-identity routing: gather timeout then serial re-ask', () => {
  it('a serial re-ask of the busy role steers into its stale round turn — that reply routes as the serial answer', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldOneRole() })
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    const roleKey = roles[0]!.sessionKey
    const role = e.sessions.getOrCreateActive(roleKey)
    const hubSess = e.sessions.getOrCreateActive(hub)
    const wakeSpy = vi.spyOn(e, 'deliverMachineMessage')

    // Round 1 is armed; the role's round turn has STARTED (identity 1) and
    // is still generating when the barrier times out — the role is busy
    // (lock held, live agent session mid-turn).
    gatherRoles(e, hub, '第一轮问题', false)
    const g = chatroomState(hubSess).pendingGather
    expect(g).toBeDefined()
    g!.stopTimer()
    await e.bridge.serial('feishuBridge/turn-start', {
      engine: e, session: role, metadata: { chatroomAskSeq: g!.seq },
    })
    expect(role.tryLock()).toBe(true)
    const st = new InteractiveState()
    st.platform = p
    const cs = newControllableSession('role-turn')
    st.agentSession = cs
    e.interactiveStates.set(roleKey, st)

    // Timeout: the barrier retires; the moderator serially re-asks the slow
    // role while its round turn still runs. The re-ask rides the machine
    // channel: the question is steered into the running turn, and the new
    // identity is pre-stamped (no new turn starts for a steer).
    chatroomState(hubSess).pendingGather = undefined
    await askRole(e, hub, 'taleb', '请给出终版结论')
    expect(cs.steerCalls.some(t => t.includes('请给出终版结论'))).toBe(true)
    const minted = chatroomState(hubSess).chatroomGatherSeq
    expect(chatroomState(role).chatroomAskSeq).toBe(minted)
    clearCards(p)

    // The stale round turn finally ends carrying the steered question: its
    // reply routes as the serial ask's answer — relayed AND woken, never
    // dropped to the consumed-gate early return (2026-09-06 oc_97be4a1c).
    maybeAutoRelayRole(e, st, role, '迟到的第一轮结论', false)
    await settle()
    expect(p.sentCards).toHaveLength(1)
    expect(cardBody(p.sentCards[0])).toContain('迟到的第一轮结论')
    expect(chatroomState(hubSess).pendingSerialAsks.size).toBe(0)
    const wokeWithAnswer = wakeSpy.mock.calls.some(([, m]) => m.content.includes('迟到的第一轮结论'))
    expect(wokeWithAnswer).toBe(true)
  })
})

describe('ask-identity routing: supersede and completion', () => {
  it('a mid-gather steer belongs to the armed round — the reply counts as the round answer and no entry leaks', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldOneRole() })
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    const roleKey = roles[0]!.sessionKey
    const role = e.sessions.getOrCreateActive(roleKey)
    const hubSess = e.sessions.getOrCreateActive(hub)

    gatherRoles(e, hub, '第一轮问题', false)
    const g = chatroomState(hubSess).pendingGather
    expect(g).toBeDefined()
    g!.stopTimer()

    // Course correction steered into the busy role's running turn.
    await askRole(e, hub, 'taleb', '口径改为 A+H', 'steer')

    const st = new InteractiveState()
    st.platform = p
    maybeAutoRelayRole(e, st, role, '收到纠偏后的本轮作答', false)
    await settle()

    expect(g!.collected.get('taleb')).toBe('收到纠偏后的本轮作答')
    expect(chatroomState(hubSess).pendingGather).toBeUndefined()
    expect(chatroomState(hubSess).pendingSerialAsks.size).toBe(0)
  })

  it('a new gather round supersedes an outstanding serial ask — the late serial turn relays free and never enters the barrier', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldOneRole() })
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    const role = e.sessions.getOrCreateActive(roles[0]!.sessionKey)
    const hubSess = e.sessions.getOrCreateActive(hub)

    // Outstanding serial ask (identity 1), then a new round supersedes it.
    // Deliveries are stubbed so the asks open no turn; the late serial turn
    // carries identity 1 — it ended in the narrow window before the steered
    // round question was claimed at a step boundary.
    vi.spyOn(e, 'deliverMachineMessage').mockImplementation(() => {})
    await askRole(e, hub, 'taleb', '单独追问')
    expect(chatroomState(hubSess).pendingSerialAsks.size).toBe(1)
    gatherRoles(e, hub, '新一轮问题', false)
    const g = chatroomState(hubSess).pendingGather
    expect(g).toBeDefined()
    g!.stopTimer()
    expect(chatroomState(hubSess).pendingSerialAsks.size).toBe(0)
    await settle()
    await settle()
    chatroomState(role).chatroomAskSeq = 1

    // The serial ask's turn ends late: free relay, barrier untouched.
    clearCards(p)
    const st = new InteractiveState()
    st.platform = p
    maybeAutoRelayRole(e, st, role, '迟到的单独追问作答', false)
    await settle()
    expect(p.sentCards).toHaveLength(1)
    expect(cardBody(p.sentCards[0])).toContain('迟到的单独追问作答')
    expect(chatroomState(hubSess).pendingGather?.collected.size ?? 0).toBe(0)
    expect(chatroomState(role).chatroomAsked).toBe(false)
    expect(chatroomState(role).chatroomInFlight).toBe(true)
  })

  it('the serial answer completes the entry — a later turn-end on the same role stays silent', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldOneRole() })
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    const role = e.sessions.getOrCreateActive(roles[0]!.sessionKey)
    const hubSess = e.sessions.getOrCreateActive(hub)
    const wakeSpy = vi.spyOn(e, 'deliverMachineMessage').mockImplementation(() => {})

    await askRole(e, hub, 'taleb', '请作答')
    expect(chatroomState(hubSess).pendingSerialAsks.size).toBe(1)
    const minted = chatroomState(hubSess).chatroomGatherSeq
    chatroomState(role).chatroomAskSeq = minted

    clearCards(p)
    const st = new InteractiveState()
    st.platform = p
    maybeAutoRelayRole(e, st, role, '本次作答', false)
    await settle()
    expect(p.sentCards).toHaveLength(1)
    expect(cardBody(p.sentCards[0])).toContain('本次作答')
    expect(chatroomState(hubSess).pendingSerialAsks.size).toBe(0)

    // The answered-latch holds: a spontaneous later turn relays nothing.
    // (Ask injections ride deliverMachineMessage too — count only wakes.)
    maybeAutoRelayRole(e, st, role, '自言自语', false)
    await settle()
    expect(p.sentCards).toHaveLength(1)
    const wakes = wakeSpy.mock.calls.filter(([, m]) => !m.content.startsWith('[主持]'))
    expect(wakes).toHaveLength(1)
  })
})

describe('ask-identity routing: error-reasoned turn', () => {
  it('a failed stamped turn wakes the moderator with the failure and its own partial, never a reply relay', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldOneRole() })
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    const role = e.sessions.getOrCreateActive(roles[0]!.sessionKey)
    const hubSess = e.sessions.getOrCreateActive(hub)
    const wakeSpy = vi.spyOn(e, 'deliverMachineMessage').mockImplementation(() => {})

    await askRole(e, hub, 'taleb', '请作答')
    expect(chatroomState(hubSess).pendingSerialAsks.size).toBe(1)
    const minted = chatroomState(hubSess).chatroomGatherSeq
    chatroomState(role).chatroomAskSeq = minted

    clearCards(p)
    const st = new InteractiveState()
    st.platform = p
    // The turn failed mid-generation: baseResponse is this turn's own
    // partial (the engine contract never hands an errored turn a stale
    // earlier reply).
    maybeAutoRelayRole(e, st, role, '被打断前刚写出的半段。', false, true, '1301 sensitive content rejected')
    await settle()
    await settle()

    // A failed turn is not a reply: no green 【Role】 relay card, no ledger row.
    expect(p.sentCards).toHaveLength(0)
    // Entry completion semantics are unchanged by the failure.
    expect(chatroomState(hubSess).pendingSerialAsks.size).toBe(0)
    expect(chatroomState(role).chatroomAsked).toBe(true)
    expect(chatroomState(role).chatroomInFlight).toBe(false)
    // The wake carries the failure line as the fixed brief — the raw error
    // text and the partial no longer enter the moderator's context
    // (2026-09-09/10 Zhipu 1301 cascade).
    const wake = wakeSpy.mock.calls.at(-1)?.[1]?.content ?? ''
    expect(wake).toContain('本轮发言失败')
    expect(wake).toContain('[failure code=未分类]')
    expect(wake).not.toContain('1301 sensitive content rejected')
    expect(wake).not.toContain('被打断前刚写出的半段。')
  })
})

describe('ask-identity routing: moderation-safe failure wake', () => {
  const zhipu1301 = '{"type":"error","error":{"type":"invalid_request_error","code":"1301","message":"[1301][系统检测到输入或生成内容可能包含不安全或敏感内容，请您避免输入易产生敏感内容的提示语，感谢您的配合。][202609100805161ffc25f1025c4f2a]"}}'

  it('a failed turn wakes the moderator with the fixed brief, not the provider wording or the partial', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldOneRole() })
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    const role = e.sessions.getOrCreateActive(roles[0]!.sessionKey)
    const hubSess = e.sessions.getOrCreateActive(hub)
    const wakeSpy = vi.spyOn(e, 'deliverMachineMessage').mockImplementation(() => {})

    await askRole(e, hub, 'taleb', '请作答')
    const minted = chatroomState(hubSess).chatroomGatherSeq
    chatroomState(role).chatroomAskSeq = minted

    clearCards(p)
    const st = new InteractiveState()
    st.platform = p
    maybeAutoRelayRole(e, st, role, '被打断前刚写出的半段。', false, true, zhipu1301)
    await settle()
    await settle()

    const wake = wakeSpy.mock.calls.at(-1)?.[1]?.content ?? ''
    expect(wake).toContain('本轮发言失败')
    expect(wake).toContain('[failure code=1301]')
    expect(wake).toContain('202609100805161ffc25f1025c4f2a')
    expect(wake).not.toContain('系统检测到')
    expect(wake).not.toContain('敏感内容')
    expect(wake).not.toContain('invalid_request_error')
    // The partial streamed text no longer rides along on an errored turn.
    expect(wake).not.toContain('被打断前刚写出的半段。')
  })
})
