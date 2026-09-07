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
import { Engine } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { ProjectStateStore } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { chatroomPolicyFace } from '../stubs/bridge-policy.ts'
import { ChatroomEndBarrier, ChatroomGather } from '../../src/engine/chatroom.ts'
import { chatroomFeatureStateCodec } from '../../src/chatroom-state.ts'
import { registerFeatureStateCodec } from '@deepseek-ai/dsh-feishu-bridge/exports'
import type { Platform } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { createStubAgent, createStubChatroomSpawner } from '../stubs/engine-stubs.ts'
import { chatroomState } from '../../src/chatroom-state.ts'
import '../stubs/messages.js'

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
  chatroomState(h).chatroomModerator = true
  const role = e.sessions.getOrCreateActive('test:role-1:user-1')
  chatroomState(role).chatroomHubKey = hub
  role.setParentSessionKey(hub)
  chatroomState(role).chatroomRoleName = 'taleb'
  chatroomState(role).researchAwaitingAssistant = true
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
    chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather = g
    e.sessions.save()

    const stored = Object.values(readStore(store).sessions)
    expect(stored).toHaveLength(2)
    const hubSnap = stored.map(chatroomSection).find(s => s.pendingGatherData !== undefined)?.pendingGatherData
    expect(hubSnap).toEqual({
      question: '针对议题，是否需要向用户追问？',
      seq: 1,
      expected: ['taleb'],
      collected: { munger: '部分回复' },
      startedAt: 0,
      rearmed: false,
    })

    // A barrier already re-armed once persists that count: a restart
    // mid-window must not restart the re-arm budget.
    g.rearmed = true
    e.sessions.save()
    const rearmedSnap = Object.values(readStore(store).sessions)
      .map(chatroomSection).find(s => s.pendingGatherData !== undefined)?.pendingGatherData
    expect((rearmedSnap as { rearmed?: boolean } | undefined)?.rearmed).toBe(true)

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
    chatroomState(e.sessions.getOrCreateActive(hub)).pendingEndBarrier = b
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
      chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather = armedGather()
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
    expect(chatroomState(e2.sessions.getOrCreateActive('test:role-1:user-1')).researchAwaitingAssistant).toBe(false)

    // The restored data is consumed: a later save carries no barrier.
    e2.sessions.save()
    for (const s of Object.values(readStore(store).sessions)) {
      expect(chatroomSection(s).pendingGatherData).toBeUndefined()
    }
  })

  it('a restart inside the re-arm window closes the round with the collected replies and never re-arms again', async () => {
    // The window that matters for the 2026-09-06 incident: the timeout had
    // already re-armed the barrier (late replies expected within minutes)
    // when the daemon restarted. No role turn survives a restart, so the
    // recovered round must close once with what it holds — the collected
    // replies survive, and the restored barrier must not arm a new window
    // (not the gather timeout, not the re-arm one).
    const store = join(await mkdtemp(join(tmpdir(), 'fb-recovery-')), 'sessions.json')
    const hub = 'test:hub:user-1'
    {
      const e = newRecoveryEngine(createStubChatroomSpawner(), store)
      armHubAndRole(e, hub)
      const g = armedGather()
      g.rearmed = true // the timeout had re-armed before the restart
      chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather = g
      e.sessions.save()
    }

    vi.useFakeTimers()
    try {
      const e2 = newRecoveryEngine(createStubChatroomSpawner(), store)
      const recv = vi.spyOn(e2, 'receiveMessage').mockImplementation(() => {})
      await e2.start()
      for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0)
      await waitFor(() => recv.mock.calls.some(([, m]) => m.sessionKey === hub), 'moderator wake')

      const wake = recv.mock.calls.map(([, m]) => m).find(m => m.sessionKey === hub)
      expect(wake?.content).toContain('检测到进程重启')
      expect(wake?.content).toContain('部分回复')
      // The round closed; the barrier neither survives in memory nor arms a
      // new re-arm window (advancing past both windows wakes nobody).
      expect(chatroomState(e2.sessions.getOrCreateActive(hub)).pendingGather).toBeUndefined()
      const hubWakes = () => recv.mock.calls.filter(([, m]) => m.sessionKey === hub).length
      const atClose = hubWakes()
      await vi.advanceTimersByTimeAsync(40 * 60 * 1000)
      for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0)
      expect(hubWakes()).toBe(atClose)
      expect(chatroomState(e2.sessions.getOrCreateActive(hub)).pendingGather).toBeUndefined()

      e2.sessions.save()
      for (const s of Object.values(readStore(store).sessions)) {
        expect(chatroomSection(s).pendingGatherData).toBeUndefined()
      }
    } finally {
      vi.useRealTimers()
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
    expect(chatroomState(e2.sessions.getOrCreateActive('test:role-1:user-1')).chatroomHubKey).toBe(hub)
    expect(chatroomState(e2.sessions.getOrCreateActive(hub)).chatroomModerator).toBe(true)
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
      chatroomState(e.sessions.getOrCreateActive(hub)).pendingEndBarrier = b
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
    await waitFor(() => chatroomState(e2.sessions.getOrCreateActive('test:role-1:user-1')).chatroomHubKey === '', 'role cleaned')
    expect(chatroomState(e2.sessions.getOrCreateActive(hub)).chatroomModerator).toBe(false)
  })

  it('drops malformed restored barriers without crashing or waking', async () => {
    const store = join(await mkdtemp(join(tmpdir(), 'fb-recovery-')), 'sessions.json')
    const hub = 'test:hub:user-1'
    {
      const e = newRecoveryEngine(createStubChatroomSpawner(), store)
      armHubAndRole(e, hub)
      chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather = armedGather()
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
      chatroomState(e.sessions.getOrCreateActive(hub)).chatroomResearch = true
      chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather = armedGather()
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

describe('serial-ask persistence and restart recovery', () => {
  it('persists an outstanding serial ask and drops it once completed', async () => {
    const store = join(await mkdtemp(join(tmpdir(), 'fb-recovery-')), 'sessions.json')
    const e = newRecoveryEngine(createStubChatroomSpawner(), store)
    const hub = 'test:hub:user-1'
    armHubAndRole(e, hub)
    const hubSess = chatroomState(e.sessions.getOrCreateActive(hub))
    hubSess.chatroomGatherSeq = 1
    hubSess.pendingSerialAsks.set('taleb', { id: 1, question: '请给出终版结论', armedAt: Date.now(), lastWakeAt: 0, wakeCount: 0 })
    e.sessions.save()

    const sections = Object.values(readStore(store).sessions).map(chatroomSection)
    const snap = sections.find(s => s.pendingSerialAsksData !== undefined)?.pendingSerialAsksData
    const armedAt = (snap as Array<{ armedAt: number }>)[0]?.armedAt
    expect(typeof armedAt).toBe('number')
    expect(snap).toEqual([{
      roleName: 'taleb', id: 1, question: '请给出终版结论',
      armedAt, lastWakeAt: 0, wakeCount: 0,
    }])

    hubSess.pendingSerialAsks.delete('taleb')
    e.sessions.save()
    for (const s of Object.values(readStore(store).sessions)) {
      expect(chatroomSection(s).pendingSerialAsksData).toBeUndefined()
    }
  })

  it('a restart retires the restored serial ask with a bounded wake — it never re-arms as an in-flight ask', async () => {
    const store = join(await mkdtemp(join(tmpdir(), 'fb-recovery-')), 'sessions.json')
    const hub = 'test:hub:user-1'
    {
      const e = newRecoveryEngine(createStubChatroomSpawner(), store)
      armHubAndRole(e, hub)
      const hubSess = chatroomState(e.sessions.getOrCreateActive(hub))
      hubSess.chatroomGatherSeq = 1
      hubSess.pendingSerialAsks.set('taleb', { id: 1, question: '请给出终版结论', armedAt: Date.now(), lastWakeAt: 0, wakeCount: 0 })
      e.sessions.save()
    }

    const e2 = newRecoveryEngine(createStubChatroomSpawner(), store)
    const recv = vi.spyOn(e2, 'receiveMessage').mockImplementation(() => {})
    await e2.start()
    await waitFor(() => recv.mock.calls.some(([, m]) => m.sessionKey === hub), 'moderator wake')

    const wake = recv.mock.calls.map(([, m]) => m).find(m => m.sessionKey === hub)
    expect(wake?.content).toContain('检测到进程重启')
    expect(wake?.content).toContain('taleb')
    expect(wake?.content).toContain('请给出终版结论')

    // Retired, not re-armed: the entry is gone and a later save carries none.
    const hub2 = e2.sessions.getOrCreateActive(hub)
    expect(chatroomState(hub2).pendingSerialAsks.size).toBe(0)
    e2.sessions.save()
    for (const s of Object.values(readStore(store).sessions)) {
      expect(chatroomSection(s).pendingSerialAsksData).toBeUndefined()
    }
  })
})
