/**
 * Ask-delivery channel tests: a moderator ask (serial or gather broadcast)
 * rides the machine message channel — never the human message pipeline,
 * whose busy-queue cap and rate-limit drops would lose the question with
 * the outstanding entry none the wiser.
 *
 * @module dsh-feishu-bridge-chatroom/tests-engine-chatroom-ask-delivery
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Engine, InteractiveState, ProjectStateStore, registerSessionCommands } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { registerChatroomCommands } from '../../src/engine/chatroom-cmd.ts'
import { askRole, gatherRoles, startChatroom } from '../../src/engine/chatroom.ts'
import { chatroomState } from '../../src/chatroom-state.ts'
import { chatroomConfig } from '../../src/chatroom-config.ts'
import { chatroomPolicyFace } from '../stubs/bridge-policy.ts'
import { clearCards, createStubAgent, createStubChatroomSpawner, newControllableSession } from '../stubs/engine-stubs.ts'
import type { Platform } from '@deepseek-ai/dsh-feishu-bridge/exports'

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

async function scaffoldRoles(names: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fb-ask-delivery-'))
  for (const name of names) {
    await mkdir(join(root, name), { recursive: true })
    await writeFile(join(root, name, 'CLAUDE.md'), `# ${name}\n`, 'utf8')
  }
  return root
}

/** A busy role: the session lock is held and a live agent session is mid-turn. */
function busyRole(e: Engine, p: Platform, roleKey: string) {
  const role = e.sessions.getOrCreateActive(roleKey)
  expect(role.tryLock()).toBe(true)
  const st = new InteractiveState()
  st.platform = p
  const cs = newControllableSession('role-turn')
  st.agentSession = cs
  e.interactiveStates.set(roleKey, st)
  return cs
}

describe('ask delivery channel', () => {
  it('a serial ask rides deliverMachineMessage with the identity metadata in tow', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldRoles(['taleb']) })
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    const roleKey = roles[0]!.sessionKey
    const hubSess = e.sessions.getOrCreateActive(hub)
    const deliverSpy = vi.spyOn(e, 'deliverMachineMessage').mockImplementation(() => {})

    await askRole(e, hub, 'taleb', '请作答')
    expect(deliverSpy).toHaveBeenCalledTimes(1)
    const msg = deliverSpy.mock.calls[0]![1]
    expect(msg.sessionKey).toBe(roleKey)
    expect(msg.content).toContain('[主持] 请作答')
    expect(msg.metadata).toMatchObject({ chatroomAskSeq: chatroomState(hubSess).chatroomGatherSeq })
  })

  it('an idle role receives the ask through the machine-flagged pipeline, never a bare human-channel call', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldRoles(['taleb']) })
    const hub = 'test:hub:user-1'
    await startChatroom(e, hub, ['taleb'], 'topic')
    const deliverSpy = vi.spyOn(e, 'deliverMachineMessage')
    const recv = vi.spyOn(e, 'receiveMessage').mockImplementation(() => {})

    await askRole(e, hub, 'taleb', '请作答')
    await settle()

    expect(deliverSpy).toHaveBeenCalledTimes(1)
    // The idle leg runs the synthetic-message pipeline machine-flagged: a
    // bare human-channel delivery (direct receiveMessage, no machine flag)
    // is what must not happen anymore.
    expect(recv).toHaveBeenCalledTimes(1)
    expect(recv.mock.calls[0]![1].machine).toBe(true)
  })

  it('a gather broadcast rides deliverMachineMessage for every role with the round identity', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldRoles(['taleb', 'munger']) })
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb', 'munger'], 'topic')
    clearCards(p)
    const deliverSpy = vi.spyOn(e, 'deliverMachineMessage').mockImplementation(() => {})

    gatherRoles(e, hub, '并行问题', false)
    const g = chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather
    expect(g).toBeDefined()
    g!.stopTimer()
    await settle()

    const asked = deliverSpy.mock.calls.filter(([, m]) => m.content.includes('[并行收集]'))
    expect(asked).toHaveLength(roles.length)
    for (const [, m] of asked) {
      expect(m.metadata).toMatchObject({ chatroomAskSeq: g!.seq })
    }
  })

  it('a busy role receives the ask as a mid-turn steer — the content never enters the human queue', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldRoles(['taleb']) })
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    const roleKey = roles[0]!.sessionKey
    const role = e.sessions.getOrCreateActive(roleKey)
    const hubSess = e.sessions.getOrCreateActive(hub)
    const cs = busyRole(e, p, roleKey)
    const recv = vi.spyOn(e, 'receiveMessage').mockImplementation(() => {})

    await askRole(e, hub, 'taleb', '请作答')

    // The question is claimed at the busy turn's next step boundary.
    expect(cs.steerCalls.some(t => t.includes('[主持]') && t.includes('请作答'))).toBe(true)
    // The human pipeline (queue cap, rate-limit drops) is never entered.
    expect(recv).not.toHaveBeenCalled()
    // No new turn starts for a steer, so turn-start stamping cannot fire:
    // the identity must already be stamped for the running turn's relay.
    expect(chatroomState(role).chatroomAskSeq).toBe(chatroomState(hubSess).chatroomGatherSeq)
  })

  it('a busy role under a gather broadcast gets the round question steered and pre-stamped', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldRoles(['taleb', 'munger']) })
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb', 'munger'], 'topic')
    const busyKey = roles[0]!.sessionKey
    const idleKey = roles[1]!.sessionKey
    const cs = busyRole(e, p, busyKey)
    const recv = vi.spyOn(e, 'receiveMessage').mockImplementation(() => {})

    gatherRoles(e, hub, '并行问题', false)
    const g = chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather
    expect(g).toBeDefined()
    g!.stopTimer()
    await settle()

    // The busy role's question landed mid-turn, identity pre-stamped so its
    // running turn's relay routes as the round answer.
    expect(cs.steerCalls.some(t => t.includes('[并行收集]'))).toBe(true)
    expect(chatroomState(e.sessions.getOrCreateActive(busyKey)).chatroomAskSeq).toBe(g!.seq)
    // The idle role still rides the machine-flagged pipeline with its metadata.
    const idleAsk = recv.mock.calls.map(([, m]) => m).find(m => m.sessionKey === idleKey)
    expect(idleAsk).toBeDefined()
    expect(idleAsk!.machine).toBe(true)
    expect(idleAsk!.metadata).toMatchObject({ chatroomAskSeq: g!.seq })
  })
})
