/**
 * Registration and dispatch tests for registerPlanCommands (/plan): the
 * command merges into the session-command table under the session group,
 * switches a live session's plan mode through the AgentSession
 * PlanModeSwitcher capability, acknowledges each native outcome, falls
 * through as a normal message when a task text follows (arming the one-shot
 * mode override when the chat has no live session yet), and disposes
 * cleanly.
 *
 * @module dsh-feishu-bridge/tests-engine-plan-commands
 */

import { describe, expect, it, vi } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.ts'
import { registerSessionCommands } from '../../src/engine/commands.ts'
import { registerPlanCommands } from '../../src/engine/plan-commands.ts'
import { Msg } from '../../src/i18n/index.ts'
import {
  createStubAgent,
  createStubAgentSession,
  createStubPlatform,
  newControllableSession,
  newStubMessage,
  type ControllableAgentSession,
  type StubPlatform,
} from '../stubs/engine-stubs.ts'
import type { AgentSession, Message } from '../../src/core/types.ts'

function newEngine(): { e: Engine; p: StubPlatform; disposeAll: () => void } {
  const plat = createStubPlatform('test')
  const e = new Engine('test', createStubAgent(), [plat], '', 'en')
  const disposeSession = registerSessionCommands(e)
  const disposePlan = registerPlanCommands(e)
  return {
    e,
    p: plat,
    disposeAll: () => {
      disposePlan()
      disposeSession()
    },
  }
}

/** Park a live agent session on the engine's interactive slot. */
function armedState(e: Engine, session: AgentSession, key = 'test:ch1:u1'): InteractiveState {
  const state = new InteractiveState()
  state.agentSession = session
  state.platform = e.platforms[0]
  state.replyCtx = 'ctx'
  e.interactiveStates.set(key, state)
  return state
}

function planMsg(content: string, sessionKey = 'test:ch1:u1'): Message {
  return { ...newStubMessage(), sessionKey, userID: 'u1', replyCtx: 'ctx', content }
}

describe('/plan', () => {
  it('switches a live session into plan mode and acknowledges', async () => {
    const { e, p, disposeAll } = newEngine()
    const session: ControllableAgentSession = newControllableSession('s1')
    try {
      armedState(e, session)
      expect(e.dispatchCommand(p, planMsg('/plan'), '/plan')).toBe(true)
      expect(session.planModeCalls).toEqual([true])
      await vi.waitFor(() => { expect(p.getSent()).toEqual([e.i18n.t(Msg.PlanEntered)]) })
    } finally {
      disposeAll()
    }
  })

  it('leaves plan mode on /plan off', async () => {
    const { e, p, disposeAll } = newEngine()
    const session: ControllableAgentSession = newControllableSession('s1')
    try {
      armedState(e, session)
      expect(e.dispatchCommand(p, planMsg('/plan off'), '/plan off')).toBe(true)
      expect(session.planModeCalls).toEqual([false])
      await vi.waitFor(() => { expect(p.getSent()).toEqual([e.i18n.t(Msg.PlanExited)]) })
    } finally {
      disposeAll()
    }
  })

  it('switches plan mode and falls through with the task text when an argument follows', () => {
    const { e, p, disposeAll } = newEngine()
    const session: ControllableAgentSession = newControllableSession('s1')
    try {
      armedState(e, session)
      const msg = planMsg('/plan 梳理登录模块的失败用例')
      expect(e.dispatchCommand(p, msg, msg.content)).toBe(false)
      expect(session.planModeCalls).toEqual([true])
      // The message proceeds as the task itself: the command line is gone.
      expect(msg.content).toBe('梳理登录模块的失败用例')
      expect(p.getSent()).toEqual([])
    } finally {
      disposeAll()
    }
  })

  it.each([
    ['committed', Msg.PlanEntered, 'plan'],
    ['cancelled', Msg.PlanEntered, 'plan'],
    ['queued', Msg.PlanEnteredPending, 'plan'],
    ['noop', Msg.PlanAlready, 'plan'],
    ['committed', Msg.PlanExited, 'plan off'],
    ['queued', Msg.PlanExitedPending, 'plan off'],
    ['noop', Msg.PlanAlready, 'plan off'],
  ])('acknowledges outcome %s for /%s', async (result, key, line) => {
    const { e, p, disposeAll } = newEngine()
    const session: ControllableAgentSession = newControllableSession('s1')
    session.planModeResult = result
    try {
      armedState(e, session)
      expect(e.dispatchCommand(p, planMsg(`/${line}`), `/${line}`)).toBe(true)
      await vi.waitFor(() => { expect(p.getSent()).toEqual([e.i18n.t(key)]) })
    } finally {
      disposeAll()
    }
  })

  it('reports a session without the switcher capability as unavailable', async () => {
    const { e, p, disposeAll } = newEngine()
    try {
      armedState(e, createStubAgentSession())
      expect(e.dispatchCommand(p, planMsg('/plan'), '/plan')).toBe(true)
      await vi.waitFor(() => { expect(p.getSent()).toEqual([e.i18n.t(Msg.PlanUnavailable)]) })
    } finally {
      disposeAll()
    }
  })

  it('resolves the /pl prefix to the plan command', () => {
    const { e, p, disposeAll } = newEngine()
    const session: ControllableAgentSession = newControllableSession('s1')
    try {
      armedState(e, session)
      expect(e.dispatchCommand(p, planMsg('/pl'), '/pl')).toBe(true)
      expect(session.planModeCalls).toEqual([true])
    } finally {
      disposeAll()
    }
  })

  it('hints to start a session when /plan runs with no live session', async () => {
    const { e, p, disposeAll } = newEngine()
    try {
      expect(e.dispatchCommand(p, planMsg('/plan'), '/plan')).toBe(true)
      await vi.waitFor(() => { expect(p.getSent()).toEqual([e.i18n.t(Msg.PlanColdHint)]) })
    } finally {
      disposeAll()
    }
  })

  it('treats a dead session as cold', async () => {
    const { e, p, disposeAll } = newEngine()
    const session: ControllableAgentSession = newControllableSession('s1')
    session.aliveFlag = false
    try {
      armedState(e, session)
      expect(e.dispatchCommand(p, planMsg('/plan'), '/plan')).toBe(true)
      expect(session.planModeCalls).toEqual([])
      await vi.waitFor(() => { expect(p.getSent()).toEqual([e.i18n.t(Msg.PlanColdHint)]) })
    } finally {
      disposeAll()
    }
  })

  it('reports nothing to leave when /plan off runs with no live session', async () => {
    const { e, p, disposeAll } = newEngine()
    try {
      expect(e.dispatchCommand(p, planMsg('/plan off'), '/plan off')).toBe(true)
      await vi.waitFor(() => { expect(p.getSent()).toEqual([e.i18n.t(Msg.PlanColdOff)]) })
    } finally {
      disposeAll()
    }
  })

  it('arms plan mode for the next session start when a task accompanies /plan on a cold chat', () => {
    const { e, p, disposeAll } = newEngine()
    try {
      const msg = planMsg('/plan 梳理登录模块')
      expect(e.dispatchCommand(p, msg, msg.content)).toBe(false)
      // The one-shot override rides the message that will start the session.
      expect(msg.modeOverride).toBe('plan')
      expect(msg.content).toBe('梳理登录模块')
      expect(p.getSent()).toEqual([])
    } finally {
      disposeAll()
    }
  })

  it('unregisters the handler and resolver on dispose', () => {
    const p = createStubPlatform('test')
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    const disposeSession = registerSessionCommands(e)
    const disposePlan = registerPlanCommands(e)
    try {
      const session: ControllableAgentSession = newControllableSession('s1')
      armedState(e, session)
      expect(e.dispatchCommand(p, planMsg('/plan'), '/plan')).toBe(true)
      disposePlan()
      expect(e.commandHandlers?.has('plan')).toBe(false)
      // Unregistered again: the text falls through to the agent.
      expect(e.dispatchCommand(p, planMsg('/plan'), '/plan')).toBe(false)
    } finally {
      disposeSession()
    }
  })
})
