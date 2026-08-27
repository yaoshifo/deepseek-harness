/**
 * Chatroom restart recovery: an armed gather/end barrier persists through
 * sessions.json, and a restarted engine closes it immediately — every reply
 * the barrier awaited belonged to a role turn that died with the old
 * process — waking the moderator with a restart annotation instead of
 * stalling until a timeout that no longer exists.
 *
 * @module dsh-feishu-bridge/tests-engine-chatroom-recovery
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Engine } from '../../src/engine/engine.js'
import { ProjectStateStore } from '../../src/engine/project-state.js'
import { chatroomPolicyFace } from '../stubs/bridge-policy.js'
import { ChatroomEndBarrier, ChatroomGather } from '../../src/engine/chatroom.js'
import { chatroomFeatureStateCodec } from '../../src/engine/chatroom-feature-state.js'
import { registerFeatureStateCodec } from '../../src/engine/feature-state.js'
import type { Platform } from '../../src/core/types.js'
import { createStubAgent, createStubChatroomSpawner } from '../stubs/engine-stubs.js'

// The production composition registers the chatroom codec once per process
// (plugin apply); barrier persistence rides its encode hook.
const disposeCodec = registerFeatureStateCodec(chatroomFeatureStateCodec)
afterAll(() => { disposeCodec() })

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

function newRecoveryEngine(p: Platform, storePath: string): Engine {
  // Barrier recovery rides the platforms-ready listener (the production
  // composition).
  const e = new Engine('test', createStubAgent(), [p], storePath, 'zh', chatroomPolicyFace())
  e.setProjectStateStore(new ProjectStateStore(''))
  return e
}

/** One armed gather with two expected roles, one reply already collected. */
function armedGather(): ChatroomGather {
  const g = new ChatroomGather('针对议题，是否需要向用户追问？', 1)
  g.expected.add('taleb')
  g.expected.add('munger')
  g.collected.set('munger', '部分回复')
  g.expected.delete('munger')
  return g
}

/** The hub and one in-flight role armed on the engine's session registry. */
function armHubAndRole(e: Engine, hub: string): void {
  const h = e.sessions.getOrCreateActive(hub)
  h.setChatroomModerator(true)
  const role = e.sessions.getOrCreateActive('test:role-1:user-1')
  role.setChatroomHubKey(hub)
  role.setParentSessionKey(hub)
  role.setChatroomRoleName('taleb')
  role.setResearchAwaitingAssistant(true)
}

function readStore(store: string): { sessions: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(store, 'utf8')) as { sessions: Record<string, Record<string, unknown>> }
}

/** The v3 snapshot nests the durable chatroom fields under featureState.chatroom. */
function chatroomSection(s: Record<string, unknown>): Record<string, unknown> {
  return ((s.featureState as Record<string, unknown> | undefined)?.chatroom as Record<string, unknown> | undefined) ?? {}
}

describe('chatroom barrier persistence', () => {
  it('persists an armed gather barrier and omits a woken one', async () => {
    const store = join(await mkdtemp(join(tmpdir(), 'fb-recovery-')), 'sessions.json')
    const e = newRecoveryEngine(createStubChatroomSpawner(), store)
    const hub = 'test:hub:user-1'
    armHubAndRole(e, hub)
    const g = armedGather()
    e.sessions.getOrCreateActive(hub).setPendingGather(g)
    e.sessions.save()

    const stored = Object.values(readStore(store).sessions)
    expect(stored).toHaveLength(2)
    const hubSnap = stored.map(chatroomSection).find(s => s.pendingGatherData !== undefined)?.pendingGatherData
    expect(hubSnap).toEqual({
      question: '针对议题，是否需要向用户追问？',
      seq: 1,
      expected: ['taleb'],
      collected: { munger: '部分回复' },
    })

    // A woken barrier is cleared before the next save except inside the
    // async finalize window; a restart there must not resurrect it.
    g.timeoutFire()
    e.sessions.save()
    for (const s of Object.values(readStore(store).sessions)) {
      expect(chatroomSection(s).pendingGatherData).toBeUndefined()
    }
  })

  it('persists an armed end barrier', async () => {
    const store = join(await mkdtemp(join(tmpdir(), 'fb-recovery-')), 'sessions.json')
    const e = newRecoveryEngine(createStubChatroomSpawner(), store)
    const hub = 'test:hub:user-1'
    armHubAndRole(e, hub)
    const b = new ChatroomEndBarrier()
    b.expected.add('taleb')
    b.collected.set('munger', '末轮回复')
    e.sessions.getOrCreateActive(hub).setPendingEndBarrier(b)
    e.sessions.save()

    const hubSnap = Object.values(readStore(store).sessions).map(chatroomSection).find(s => s.pendingEndBarrierData !== undefined)
    expect(hubSnap?.pendingEndBarrierData).toEqual({
      expected: ['taleb'],
      collected: { munger: '末轮回复' },
    })
  })
})

describe('chatroom restart recovery', () => {
  it('closes a restored gather with the collected replies and wakes the moderator', async () => {
    const store = join(await mkdtemp(join(tmpdir(), 'fb-recovery-')), 'sessions.json')
    const hub = 'test:hub:user-1'
    {
      const e = newRecoveryEngine(createStubChatroomSpawner(), store)
      armHubAndRole(e, hub)
      e.sessions.getOrCreateActive(hub).setPendingGather(armedGather())
      e.sessions.save()
    }

    const e2 = newRecoveryEngine(createStubChatroomSpawner(), store)
    const recv = vi.spyOn(e2, 'receiveMessage').mockImplementation(() => {})
    await e2.start()
    await waitFor(() => recv.mock.calls.some(([, m]) => m.sessionKey === hub), 'moderator wake')

    const wake = recv.mock.calls.map(([, m]) => m).find(m => m.sessionKey === hub)
    expect(wake?.content).toContain('检测到进程重启')
    expect(wake?.content).toContain('1 个角色的回复已丢失（taleb）')
    expect(wake?.content).toContain('部分回复')
    // The wake rides the per-round reminder; no chatroom protocol text may
    // point the moderator back at the global coding instructions.
    expect(wake?.content).not.toContain('~/.claude')

    // The stale research-awaiting marker died with the old process.
    expect(e2.sessions.getOrCreateActive('test:role-1:user-1').getResearchAwaitingAssistant()).toBe(false)

    // The restored data is consumed: a later save carries no barrier.
    e2.sessions.save()
    for (const s of Object.values(readStore(store).sessions)) {
      expect(chatroomSection(s).pendingGatherData).toBeUndefined()
    }
  })

  it('recovers a barrier from a version-2 flat-field store through the v2→v3 migration', async () => {
    const store = join(await mkdtemp(join(tmpdir(), 'fb-recovery-')), 'sessions.json')
    const hub = 'test:hub:user-1'
    await writeFile(store, JSON.stringify({
      version: 2,
      sessions: {
        s1: {
          id: 's1', name: 'hub', agentSessionID: '',
          chatroomModerator: true,
          pendingGatherData: { question: '针对议题，是否需要向用户追问？', seq: 1, expected: ['taleb'], collected: { munger: '部分回复' } },
          createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        },
        s2: {
          id: 's2', name: 'role', agentSessionID: '',
          chatroomHubKey: hub, chatroomRoleName: 'taleb', parentSessionKey: hub,
          createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        },
      },
      activeSession: { [hub]: 's1', 'test:role-1:user-1': 's2' },
      userSessions: { [hub]: ['s1'], 'test:role-1:user-1': ['s2'] },
      counter: 2,
    }), 'utf8')

    const e2 = newRecoveryEngine(createStubChatroomSpawner(), store)
    const recv = vi.spyOn(e2, 'receiveMessage').mockImplementation(() => {})
    await e2.start()
    await waitFor(() => recv.mock.calls.some(([, m]) => m.sessionKey === hub), 'moderator wake')

    const wake = recv.mock.calls.map(([, m]) => m).find(m => m.sessionKey === hub)
    expect(wake?.content).toContain('检测到进程重启')
    expect(wake?.content).toContain('1 个角色的回复已丢失（taleb）')
    expect(wake?.content).toContain('部分回复')
    // The flat v2 identity fields lifted into the featureState section.
    expect(e2.sessions.getOrCreateActive('test:role-1:user-1').getChatroomHubKey()).toBe(hub)
    expect(e2.sessions.getOrCreateActive(hub).getChatroomModerator()).toBe(true)
    // The one-way rewrite kept the pre-v3 original beside the store.
    expect(readFileSync(`${store}.v2.bak`, 'utf8')).toContain('"version":2')
  })

  it('finalizes a restored end barrier with the collected final replies', async () => {
    const store = join(await mkdtemp(join(tmpdir(), 'fb-recovery-')), 'sessions.json')
    const hub = 'test:hub:user-1'
    {
      const e = newRecoveryEngine(createStubChatroomSpawner(), store)
      armHubAndRole(e, hub)
      const b = new ChatroomEndBarrier()
      b.expected.add('taleb')
      b.collected.set('munger', '末轮回复')
      e.sessions.getOrCreateActive(hub).setPendingEndBarrier(b)
      e.sessions.save()
    }

    const e2 = newRecoveryEngine(createStubChatroomSpawner(), store)
    const recv = vi.spyOn(e2, 'receiveMessage').mockImplementation(() => {})
    await e2.start()
    await waitFor(() => recv.mock.calls.some(([, m]) => m.sessionKey === hub), 'closing-summary wake')

    const wake = recv.mock.calls.map(([, m]) => m).find(m => m.sessionKey === hub)
    expect(wake?.content).toContain('检测到进程重启')
    expect(wake?.content).toContain('末轮回复')

    // Teardown ran: the role lost its chatroom marking and the hub its
    // moderator flag, exactly like an end barrier that timed out.
    await waitFor(() => e2.sessions.getOrCreateActive('test:role-1:user-1').getChatroomHubKey() === '', 'role cleaned')
    expect(e2.sessions.getOrCreateActive(hub).getChatroomModerator()).toBe(false)
  })

  it('drops malformed restored barriers without crashing or waking', async () => {
    const store = join(await mkdtemp(join(tmpdir(), 'fb-recovery-')), 'sessions.json')
    const hub = 'test:hub:user-1'
    {
      const e = newRecoveryEngine(createStubChatroomSpawner(), store)
      armHubAndRole(e, hub)
      e.sessions.getOrCreateActive(hub).setPendingGather(armedGather())
      e.sessions.save()
    }
    // Corrupt the snapshot after the fact (hand-edited sessions.json).
    const raw = JSON.parse(await readFile(store, 'utf8')) as Record<string, unknown>
    const sessions = raw.sessions as Record<string, Record<string, unknown>>
    for (const s of Object.values(sessions)) {
      const section = chatroomSection(s)
      if (section.pendingGatherData !== undefined) (section.pendingGatherData as Record<string, unknown>).question = 42
    }
    await writeFile(store, JSON.stringify(raw), 'utf8')

    const e2 = newRecoveryEngine(createStubChatroomSpawner(), store)
    const recv = vi.spyOn(e2, 'receiveMessage').mockImplementation(() => {})
    await expect(e2.start()).resolves.toBeUndefined()
    await settle()
    expect(recv.mock.calls.filter(([, m]) => m.sessionKey === hub)).toHaveLength(0)

    e2.sessions.save()
    for (const s of Object.values(readStore(store).sessions)) {
      expect(chatroomSection(s).pendingGatherData).toBeUndefined()
    }
  })

  it('posts a restart terminal card for a restored research gather', async () => {
    const store = join(await mkdtemp(join(tmpdir(), 'fb-recovery-')), 'sessions.json')
    const hub = 'test:hub:user-1'
    {
      const e = newRecoveryEngine(createStubChatroomSpawner(), store)
      armHubAndRole(e, hub)
      e.sessions.getOrCreateActive(hub).setChatroomResearch(true)
      e.sessions.getOrCreateActive(hub).setPendingGather(armedGather())
      e.sessions.save()
    }

    const p = createStubChatroomSpawner()
    const e2 = newRecoveryEngine(p, store)
    const recv = vi.spyOn(e2, 'receiveMessage').mockImplementation(() => {})
    await e2.start()
    await waitFor(() => recv.mock.calls.some(([, m]) => m.sessionKey === hub), 'moderator wake')
    // The old progress card's handle died with the process; a fresh terminal
    // card replaces it so the group does not freeze on 「进行中」.
    await waitFor(() => p.sentCards.some(card => JSON.stringify(card).includes('重启后收束')), 'terminal progress card')
  })
})
