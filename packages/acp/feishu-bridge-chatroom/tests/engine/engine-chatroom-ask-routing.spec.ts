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
import { clearCards, createStubAgent, createStubChatroomSpawner } from '../stubs/engine-stubs.ts'
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
  it('the stale round turn relays free AND the serial ask still gets its own answer relayed', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldOneRole() })
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    const roleKey = roles[0]!.sessionKey
    const role = e.sessions.getOrCreateActive(roleKey)
    const hubSess = e.sessions.getOrCreateActive(hub)
    const wakeSpy = vi.spyOn(e, 'deliverMachineMessage').mockImplementation(() => {})

    // Round 1 is armed; the role's round turn has STARTED (identity 1) and
    // is still generating when the barrier times out.
    gatherRoles(e, hub, '第一轮问题', false)
    const g = chatroomState(hubSess).pendingGather
    expect(g).toBeDefined()
    g!.stopTimer()
    await e.bridge.serial('feishuBridge/turn-start', {
      engine: e, session: role, metadata: { chatroomAskSeq: g!.seq },
    })

    // Timeout: the barrier retires; the moderator is woken with partials and
    // serially re-asks the slow role while its round turn still runs.
    chatroomState(hubSess).pendingGather = undefined
    await askRole(e, hub, 'taleb', '请给出终版结论')
    clearCards(p)

    // The stale round turn finally ends: its reply must still reach the hub.
    const st = new InteractiveState()
    st.platform = p
    maybeAutoRelayRole(e, st, role, '迟到的第一轮结论', false)
    await settle()
    expect(p.sentCards).toHaveLength(1)
    expect(cardBody(p.sentCards[0])).toContain('迟到的第一轮结论')

    // The serial ask's own turn (the next identity, minted by the re-ask)
    // starts and ends: its answer must ALSO reach the moderator.
    clearCards(p)
    const minted = chatroomState(hubSess).chatroomGatherSeq
    await e.bridge.serial('feishuBridge/turn-start', {
      engine: e, session: role, metadata: { chatroomAskSeq: minted },
    })
    maybeAutoRelayRole(e, st, role, '终版结论作答', false)
    await settle()
    expect(p.sentCards).toHaveLength(1)
    expect(cardBody(p.sentCards[0])).toContain('终版结论作答')
    const wokeWithAnswer = wakeSpy.mock.calls.some(([, m]) => m.content.includes('终版结论作答'))
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
    await askRole(e, hub, 'taleb', '单独追问')
    expect(chatroomState(hubSess).pendingSerialAsks.size).toBe(1)
    chatroomState(role).chatroomAskSeq = 1
    gatherRoles(e, hub, '新一轮问题', false)
    const g = chatroomState(hubSess).pendingGather
    expect(g).toBeDefined()
    g!.stopTimer()
    expect(chatroomState(hubSess).pendingSerialAsks.size).toBe(0)
    await settle()
    await settle()

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
    maybeAutoRelayRole(e, st, role, '自言自语', false)
    await settle()
    expect(p.sentCards).toHaveLength(1)
    expect(wakeSpy).toHaveBeenCalledTimes(1)
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
    // The wake carries the failure line and the turn's own partial.
    const wake = wakeSpy.mock.calls.at(-1)?.[1]?.content ?? ''
    expect(wake).toContain('本轮发言失败')
    expect(wake).toContain('1301 sensitive content rejected')
    expect(wake).toContain('被打断前刚写出的半段。')
  })
})
