/**
 * The research-assistant stall supervisor: a level-triggered sweep that turns
 * a silently frozen hub↔steward relation (2026-09-06 oc_97be4a1c — the
 * moderator ended its turn "waiting for the steward", the steward's own wake
 * chain died, and the room froze in `discussing` forever) into a visible
 * decision point. Derived from durable state every tick: no armed timers,
 * nothing to clear on interrupt, restart-safe by construction.
 *
 * @module dsh-feishu-bridge-chatroom/tests-engine-chatroom-supervise
 */

import { describe, expect, it, vi } from 'vitest'
import { Engine, InteractiveState, ProjectStateStore } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { ChatroomGather } from '../../src/engine/chatroom.ts'
import {
  chatroomSupervisorWakeMetadata,
  superviseChatroomAssistants,
  touchChatroomSupervisionActivity,
} from '../../src/engine/chatroom-supervise.ts'
import { chatroomState } from '../../src/chatroom-state.ts'
import { chatroomConfig } from '../../src/chatroom-config.ts'
import { createStubAgent, createStubChatroomSpawner } from '../stubs/engine-stubs.ts'
import { chatroomPolicyFace } from '../stubs/bridge-policy.ts'
import type { Platform } from '@deepseek-ai/dsh-feishu-bridge/exports'
import '../stubs/messages.js'

const hubKey = 'test:hub:user-1'
const stewardKey = 'test:role-1'

function newEngine(p: Platform): Engine {
  const e = new Engine('test', createStubAgent(), [p], '', 'zh', chatroomPolicyFace())
  e.setProjectStateStore(new ProjectStateStore(''))
  return e
}

/** One macrotask tick: flushes the microtask chain behind fire-and-forget wakes. */
async function settle(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

/**
 * A research hub with a provisioned steward whose relation went quiet
 * `quietMs` ago (the steward already reported once — the incident shape).
 */
function stalledRelation(e: Engine, quietMs: number): void {
  const hub = e.sessions.getOrCreateActive(hubKey)
  chatroomState(hub).chatroomModerator = true
  chatroomState(hub).researchAssistantKey = stewardKey
  chatroomState(hub).supervisionActivityAt = Date.now() - quietMs
  const steward = e.sessions.getOrCreateActive(stewardKey)
  steward.setParentSessionKey(hubKey)
  chatroomState(steward).researchAssistant = true
  steward.setSubtaskReported(true)
  steward.lastResult = '还在等子任务 E 回报'
  e.sessions.save()
}

describe('superviseChatroomAssistants', () => {
  it('wakes a stalled moderator once per stall window with facts and options', async () => {
    const p = createStubChatroomSpawner()
    const e = newEngine(p)
    chatroomConfig(e).applySection({ assistantStallSec: 600 })
    stalledRelation(e, 700_000)
    const wake = vi.spyOn(e, 'deliverMachineMessage').mockImplementation(() => {})

    superviseChatroomAssistants(e)
    await settle()

    expect(wake).toHaveBeenCalledTimes(1)
    const msg = wake.mock.calls[0]![1]
    expect(msg.sessionKey).toBe(hubKey)
    // Facts (who, how long, last reply) and options (nudge / wrap up / stop).
    expect(msg.content).toContain('数据管家')
    expect(msg.content).toContain('还在等子任务 E 回报')
    expect(msg.content).toContain('催办')
    // The wake carries the supervisor tag so activity tracking skips it.
    expect(msg.metadata?.[chatroomSupervisorWakeMetadata]).toBe(true)
    // Durable bookkeeping advanced synchronously: a second sweep in the same
    // window is deduped.
    expect(chatroomState(e.sessions.getOrCreateActive(hubKey)).supervisionWakeCount).toBe(1)
    superviseChatroomAssistants(e)
    await settle()
    expect(wake).toHaveBeenCalledTimes(1)
  })

  it('does not count declared waits as stalls: open turns, pending asks, pending background tasks, and armed barriers gate the clock', async () => {
    const cases: Array<(e: Engine) => void> = [
      (e) => { const st = new InteractiveState(); st.activeTurns = 1; e.interactiveStates.set(hubKey, st) },
      (e) => { const st = new InteractiveState(); st.activeTurns = 1; e.interactiveStates.set(stewardKey, st) },
      (e) => { const st = new InteractiveState(); st.backgroundTasksPending = 2; e.interactiveStates.set(hubKey, st) },
      (e) => { const st = new InteractiveState(); st.backgroundTasksPending = 1; e.interactiveStates.set(stewardKey, st) },
      (e) => { const st = new InteractiveState(); st.pendingAsk = { request: { kind: 'questions', questions: [] }, answers: new Map(), resolve: () => {} }; e.interactiveStates.set(hubKey, st) },
      (e) => { chatroomState(e.sessions.getOrCreateActive(hubKey)).pendingGather = new ChatroomGather('研究任务', 1) },
    ]
    for (const setup of cases) {
      const p = createStubChatroomSpawner()
      const e = newEngine(p)
      chatroomConfig(e).applySection({ assistantStallSec: 600 })
      stalledRelation(e, 700_000)
      setup(e)
      const wake = vi.spyOn(e, 'deliverMachineMessage').mockImplementation(() => {})
      superviseChatroomAssistants(e)
      await settle()
      expect(wake.mock.calls.some(([, msg]) => msg.sessionKey === hubKey)).toBe(false)
    }
  })

  it('tracks organic relation activity on hub and steward turns but skips its own tagged wakes', () => {
    const p = createStubChatroomSpawner()
    const e = newEngine(p)
    stalledRelation(e, 700_000)
    const hub = e.sessions.getOrCreateActive(hubKey)
    const steward = e.sessions.getOrCreateActive(stewardKey)

    // A hub turn (user message, role relay, steward report) is activity.
    touchChatroomSupervisionActivity(e, hub)
    expect(chatroomState(hub).supervisionActivityAt).toBeGreaterThan(Date.now() - 5_000)

    // A steward turn is activity on the hub's relation.
    chatroomState(hub).supervisionActivityAt = 1
    touchChatroomSupervisionActivity(e, steward)
    expect(chatroomState(hub).supervisionActivityAt).toBeGreaterThan(Date.now() - 5_000)

    // The supervisor's own wake turn must not feed the loop it closes.
    chatroomState(hub).supervisionActivityAt = 1
    touchChatroomSupervisionActivity(e, hub, { [chatroomSupervisorWakeMetadata]: true })
    expect(chatroomState(hub).supervisionActivityAt).toBe(1)
  })

  it('stops waking after three unanswered reminders and posts one visible breaker notice per window', async () => {
    const p = createStubChatroomSpawner()
    const e = newEngine(p)
    chatroomConfig(e).applySection({ assistantStallSec: 600 })
    stalledRelation(e, 700_000)
    const wake = vi.spyOn(e, 'deliverMachineMessage').mockImplementation(() => {})
    const card = vi.spyOn(e, 'sendAsCard').mockImplementation(async () => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hub = () => e.sessions.getOrCreateActive(hubKey)

    // Three windows, three wakes.
    for (let i = 0; i < 3; i++) {
      superviseChatroomAssistants(e, Date.now() + (i + 1) * 601_000)
      await settle()
    }
    expect(wake).toHaveBeenCalledTimes(3)
    expect(card).not.toHaveBeenCalled()

    // Fourth window: the breaker trips — no wake, one visible notice.
    superviseChatroomAssistants(e, Date.now() + 4 * 601_000)
    await settle()
    expect(wake).toHaveBeenCalledTimes(3)
    expect(card).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(card.mock.calls[0])).toContain('/chatroom stop')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('breaker'))

    // The wake budget stays spent until organic activity reopens it.
    superviseChatroomAssistants(e, Date.now() + 5 * 601_000)
    await settle()
    expect(wake).toHaveBeenCalledTimes(3)
    expect(card).toHaveBeenCalledTimes(2)
    expect(chatroomState(hub()).supervisionWakeCount).toBe(3)
  })

  it('organic steward activity between wakes reopens the wake budget', async () => {
    const p = createStubChatroomSpawner()
    const e = newEngine(p)
    chatroomConfig(e).applySection({ assistantStallSec: 600 })
    stalledRelation(e, 700_000)
    const wake = vi.spyOn(e, 'deliverMachineMessage').mockImplementation(() => {})
    const hub = e.sessions.getOrCreateActive(hubKey)
    const t0 = Date.now()

    superviseChatroomAssistants(e, t0)
    await settle()
    expect(wake).toHaveBeenCalledTimes(1)
    expect(chatroomState(hub).supervisionWakeCount).toBe(1)

    // The steward turns (reports) after the first wake: the budget reopens,
    // so the next stall window wakes with a fresh budget instead of counting
    // toward the breaker.
    chatroomState(hub).supervisionActivityAt = t0 + 5_000
    superviseChatroomAssistants(e, t0 + 5_000 + 601_000)
    await settle()
    expect(wake).toHaveBeenCalledTimes(2)
    expect(chatroomState(hub).supervisionWakeCount).toBe(1)
  })

  it('supervises nothing once the moderator flag is down (interrupt/end is the stop)', async () => {
    const p = createStubChatroomSpawner()
    const e = newEngine(p)
    chatroomConfig(e).applySection({ assistantStallSec: 600 })
    stalledRelation(e, 700_000)
    chatroomState(e.sessions.getOrCreateActive(hubKey)).chatroomModerator = false
    const wake = vi.spyOn(e, 'deliverMachineMessage').mockImplementation(() => {})

    superviseChatroomAssistants(e)
    await settle()
    expect(wake).not.toHaveBeenCalled()
  })

  it('validates the stall deadline: floor rejection at apply, zero disables, default 30 minutes', async () => {
    const p = createStubChatroomSpawner()
    const e = newEngine(p)
    expect(() => { chatroomConfig(e).applySection({ assistantStallSec: 300 }) }).toThrow('assistantStallSec')

    const off = newEngine(createStubChatroomSpawner())
    chatroomConfig(off).applySection({ assistantStallSec: 0 })
    stalledRelation(off, 10 * 60_000_000)
    const wakeOff = vi.spyOn(off, 'deliverMachineMessage').mockImplementation(() => { })
    superviseChatroomAssistants(off)
    await settle()
    expect(wakeOff).not.toHaveBeenCalled()
    expect(chatroomConfig(off).assistantStallDuration()).toBe(0)

    const def = newEngine(createStubChatroomSpawner())
    expect(chatroomConfig(def).assistantStallDuration()).toBe(1_800_000)
  })
})
