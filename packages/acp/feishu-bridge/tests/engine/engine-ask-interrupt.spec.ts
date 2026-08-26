/**
 * Ask-interrupt and blind-stall regressions from the 2026-08-25 oc_29bb
 * incident. A plugin reload stopped the platform while a plan review's cards
 * were still being delivered: the parked ask never settled, the agent's
 * dispose waited on it forever, the session leaked live in the persistence
 * coordinator, and the degraded follow-up turn was then killed by a stall
 * watchdog that mistook a blind pump (it received no events) for a silent
 * agent. These specs pin both guards:
 *
 * - askUser must settle cancelled when the stop signal or abort fires while
 *   card delivery is still awaiting a (hung) platform send.
 * - stallConfirmed must refuse to confirm a stall while the agent session's
 *   own event stream advanced past the pump's last receive.
 *
 * @module dsh-feishu-bridge/tests-engine-ask-interrupt
 */

import { describe, expect, it, vi } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.js'
import { createStubAgent, createStubPlatform, newControllableSession } from '../stubs/engine-stubs.js'
import type { AskRequest, Platform } from '../../src/core/types.js'

/** A platform whose sends never settle — a platform mid teardown. */
function hangingPlatform(name = 'hang'): Platform {
  const base = createStubPlatform(name)
  return Object.assign(base, {
    reply: (): Promise<void> => new Promise(() => {}),
    send: (): Promise<void> => new Promise(() => {}),
  })
}

function newEngine(platforms: Platform[]): Engine {
  return new Engine('test', createStubAgent(), platforms, '', 'en')
}

/** Park an interactive state on a given platform (the ask's owner). */
function parkedState(engine: Engine, key: string, platform: Platform): InteractiveState {
  const state = new InteractiveState()
  state.platform = platform
  state.replyCtx = 'ctx'
  engine.interactiveStates.set(key, state)
  return state
}

const permRequest: AskRequest = { kind: 'permission', toolName: 'Bash', preview: 'ls' }

describe('askUser interrupted mid card delivery', () => {
  it('settles cancelled when the session stop fires while the prompt send hangs', async () => {
    const p = hangingPlatform()
    const e = newEngine([p])
    const state = parkedState(e, 'test:chat:user1', p)

    const decision = e.askUser('test:chat:user1', permRequest)
    // Let the delivery reach the hung send.
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    state.markStopped()

    await expect(
      Promise.race([decision, new Promise((_, reject) => { setTimeout(() => { reject(new Error('askUser did not settle')) }, 1_000) })]),
    ).resolves.toEqual({ outcome: 'cancelled' })
    expect(state.pendingAsk).toBeUndefined()
  })

  it('settles cancelled when the abort signal fires while the prompt send hangs', async () => {
    const p = hangingPlatform()
    const e = newEngine([p])
    parkedState(e, 'test:chat:user1', p)

    const controller = new AbortController()
    const decision = e.askUser('test:chat:user1', permRequest, controller.signal)
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    controller.abort()

    await expect(
      Promise.race([decision, new Promise((_, reject) => { setTimeout(() => { reject(new Error('askUser did not settle')) }, 1_000) })]),
    ).resolves.toEqual({ outcome: 'cancelled' })
  })

  it('engine.stop() settles a mid-delivery ask and fires the state stop signal', async () => {
    const p = hangingPlatform()
    const e = newEngine([p])
    const state = parkedState(e, 'test:chat:user1', p)
    state.beginTurn()

    const decision = e.askUser('test:chat:user1', permRequest)
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    void e.stop()

    await expect(
      Promise.race([decision, new Promise((_, reject) => { setTimeout(() => { reject(new Error('askUser did not settle')) }, 1_000) })]),
    ).resolves.toEqual({ outcome: 'cancelled' })
  })
})

describe('stallConfirmed blind-pump guard', () => {
  const sessionKey = 'test:chat:user1'

  it('refuses the stall while the agent session stream is newer than the pump receive', () => {
    const e = newEngine([createStubPlatform()])
    const state = new InteractiveState()
    // The pump last received 300s ago; the agent projected an event 5s ago.
    const agentSession = Object.assign(newControllableSession('cc-1'), {
      lastStreamActivity: (): number => Date.now() - 5_000,
    })
    state.lastEventAt = Date.now() - 300_000
    state.agentSession = agentSession
    e.interactiveStates.set(sessionKey, state)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const confirmed = e.stallConfirmed(state, Date.now(), 200_000)
      expect(confirmed).toBe(false)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]![0])).toContain('blind pump')
    } finally {
      warn.mockRestore()
    }
  })

  it('confirms the stall when the agent session stream is silent too', () => {
    const e = newEngine([createStubPlatform()])
    const state = new InteractiveState()
    const agentSession = Object.assign(newControllableSession('cc-1'), {
      lastStreamActivity: (): number => Date.now() - 300_000,
    })
    state.lastEventAt = Date.now() - 300_000
    state.agentSession = agentSession
    e.interactiveStates.set(sessionKey, state)

    expect(e.stallConfirmed(state, Date.now(), 200_000)).toBe(true)
  })

  it('confirms the stall when the stream is newer than the pump but both are long stale (2026-08-26 oc_b46 frozen clocks)', () => {
    const e = newEngine([createStubPlatform()])
    const state = new InteractiveState()
    // The runtime projected one frame the pump never consumed: the stream
    // clock froze 8s newer than the pump's last receive, then both stopped.
    const agentSession = Object.assign(newControllableSession('cc-1'), {
      lastStreamActivity: (): number => Date.now() - 352_000,
    })
    state.lastEventAt = Date.now() - 360_000
    state.agentSession = agentSession
    e.interactiveStates.set(sessionKey, state)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      // 352s of silence against a 200s budget: the frozen pair must not
      // shield the pump forever.
      expect(e.stallConfirmed(state, Date.now(), 200_000)).toBe(true)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
