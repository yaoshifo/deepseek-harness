/**
 * Misc command tests ported from cc-connect core: /help (Go cmdHelp; the
 * command list is generated from the registered handlers instead of Go's
 * hand-maintained message_help blob) and /ps (Go handleCommand "ps" case:
 * append text to a running task, fall through when idle). The mid-turn
 * append steers the running turn's next-step inbox instead of Go's stdin
 * write, so the text reaches the model inside the current turn — including
 * while the turn is blocked on a permission.
 *
 * @module dsh-feishu-bridge/tests-engine-misc-commands
 */

import { describe, expect, it, vi } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.ts'
import { registerSessionCommands } from '../../src/engine/commands.ts'
import { registerShellCommands } from '../../src/engine/shell-commands.ts'
import { registerMiscCommands, renderHelpGroupCard } from '../../src/engine/misc-commands.ts'
import { Msg } from '../../src/i18n/index.ts'
import type { Card } from '../../src/card.ts'
import {
  createStubAgent,
  createStubCardPlatformFull,
  newControllableSession,
  newPendingAsk,
  newStubMessage,
  type StubCardPlatform,
} from '../stubs/engine-stubs.ts'
import type { AgentSession, Message } from '../../src/core/types.ts'

function newEngine(p?: StubCardPlatform): {
  e: Engine
  p: StubCardPlatform
  disposeMisc: () => void
  disposeAll: () => void
} {
  const plat = p ?? createStubCardPlatformFull('test')
  const e = new Engine('test', createStubAgent(), [plat], '', 'en')
  const disposeSession = registerSessionCommands(e)
  const disposeShell = registerShellCommands(e)
  const disposeMisc = registerMiscCommands(e)
  return {
    e,
    p: plat,
    disposeMisc,
    disposeAll: () => {
      disposeMisc()
      disposeShell()
      disposeSession()
    },
  }
}

function miscMsg(content: string, sessionKey = 'test:ch1:u1'): Message {
  return { ...newStubMessage(), sessionKey, userID: 'u1', replyCtx: 'ctx', content }
}

describe('registerMiscCommands', () => {
  it('merges into the session command table and disposes back', () => {
    const { e, p, disposeMisc, disposeAll } = newEngine()
    try {
      expect(e.commandHandlers?.get('help')).toBeDefined()
      expect(e.commandHandlers?.get('ps')).toBeDefined()
      expect(e.commandHandlers?.get('new')).toBeDefined()
      expect(e.dispatchCommand(p, miscMsg('/help'), '/help')).toBe(true)
    } finally {
      disposeMisc()
    }
    expect(e.commandHandlers?.get('help')).toBeUndefined()
    expect(e.commandHandlers?.get('new')).toBeDefined()
    disposeAll()
  })

  it('resolves ≥2-char prefixes (/he → help, /ps exact)', () => {
    const { e, disposeAll } = newEngine()
    try {
      expect(e.commandResolver?.('he')).toBe('help')
      expect(e.commandResolver?.('ps')).toBe('ps')
    } finally {
      disposeAll()
    }
  })
})

describe('/help', () => {
  it('lists the registered commands only', async () => {
    const { e, p, disposeAll } = newEngine()
    try {
      expect(e.dispatchCommand(p, miscMsg('/help'), '/help')).toBe(true)
      await vi.waitFor(() => { expect(p.sentCards.length).toBeGreaterThanOrEqual(1) })
      const sent = (p.sentCards[p.sentCards.length - 1] as Card).renderText()
      // Registered commands are listed with their one-line description; the
      // default card shows the session group, the other groups ride tabs.
      expect(sent).toContain('**/new**')
      expect(sent).toContain('[Tools & Automation]')
      expect(renderHelpGroupCard(e, 'tools').renderText()).toContain('**/shell**')
      // Unregistered Go commands must not be advertised.
      expect(sent).not.toContain('/upgrade')
      expect(sent).not.toContain('/show')
      expect(sent).not.toContain('/whoami')
    } finally {
      disposeAll()
    }
  })

  it('/help <cmd> shows the usage text for a command that has one', async () => {
    const { e, p, disposeAll } = newEngine()
    try {
      expect(e.dispatchCommand(p, miscMsg('/help shell'), '/help shell')).toBe(true)
      await vi.waitFor(() => { expect(p.getSent().length).toBeGreaterThanOrEqual(1) })
      expect(p.getSent()[0]).toBe(e.i18n.t(Msg.ShellUsage))
    } finally {
      disposeAll()
    }
  })

  it('/help <cmd> falls back to the one-liner plus no-usage note', async () => {
    const { e, p, disposeAll } = newEngine()
    try {
      expect(e.dispatchCommand(p, miscMsg('/help status'), '/help status')).toBe(true)
      await vi.waitFor(() => { expect(p.getSent().length).toBeGreaterThanOrEqual(1) })
      const sent = p.getSent()[0] ?? ''
      expect(sent).toContain('**/status**')
      expect(sent).toContain(e.i18n.t(Msg.HelpNoUsage))
    } finally {
      disposeAll()
    }
  })

  it('/help <unknown> hints then shows the full list', async () => {
    const { e, p, disposeAll } = newEngine()
    try {
      expect(e.dispatchCommand(p, miscMsg('/help nosuch'), '/help nosuch')).toBe(true)
      await vi.waitFor(() => { expect(p.sentCards.length).toBeGreaterThanOrEqual(1) })
      expect(p.getSent()[0]).toBe(e.i18n.tf(Msg.HelpUnknownCmd, 'nosuch'))
      const list = (p.sentCards[p.sentCards.length - 1] as Card).renderText()
      expect(list).toContain('**/new**')
    } finally {
      disposeAll()
    }
  })
})

describe('/ps', () => {
  function armedState(e: Engine, session: AgentSession): InteractiveState {
    const state = new InteractiveState()
    state.agentSession = session
    state.platform = e.platforms[0]
    state.replyCtx = 'ctx'
    e.interactiveStates.set('test:ch1:u1', state)
    return state
  }

  /**
   * Card platform recording the additive /ps marks (Get at enqueue, then DONE
   * or the configured stop emoji on settlement). The id-based retraction pair
   * stays wired so the assertions can prove the /ps path never touches it;
   * withoutCancelled drops the stop capability.
   */
  interface ReactionRecorder extends StubCardPlatform {
    added: string[]
    withIDs: string[]
    removes: string[]
    cancelledCount: number
  }

  function reactionPlatform(opts: { withoutCancelled?: boolean } = {}): ReactionRecorder {
    const base = createStubCardPlatformFull('feishu')
    const p: ReactionRecorder = Object.assign(base, {
      added: [] as string[],
      withIDs: [] as string[],
      removes: [] as string[],
      cancelledCount: 0,
      addReaction(_rc: unknown, emoji: string): void { p.added.push(emoji) },
      async addReactionWithID(_rc: unknown, emoji: string): Promise<string> {
        p.withIDs.push(emoji)
        return `react-${emoji}`
      },
      async removeReaction(_rc: unknown, reactionID: string): Promise<void> { p.removes.push(reactionID) },
      ...(opts.withoutCancelled === true ? {} : {
        addCancelledReaction(_rc: unknown): void { p.cancelledCount++; p.added.push('CrossMark') },
      }),
    })
    return p
  }

  it('replies usage when empty', async () => {
    const { e, p, disposeAll } = newEngine()
    try {
      expect(e.dispatchCommand(p, miscMsg('/ps'), '/ps')).toBe(true)
      await vi.waitFor(() => { expect(p.getSent()[0]).toBe(e.i18n.t(Msg.PsEmpty)) })
    } finally {
      disposeAll()
    }
  })

  it('marks the picked-up message Get (queued) and never DONE up front', async () => {
    const p = reactionPlatform()
    const { e, disposeAll } = newEngine(p)
    const session = newControllableSession('s1')
    try {
      const state = armedState(e, session)
      state.activeTurns = 1
      expect(e.dispatchCommand(p, miscMsg('/ps extra context'), '/ps extra context')).toBe(true)
      // Mid-turn the text steers the running turn's next-step inbox; a
      // followup-level send would only queue the next turn.
      expect(session.steerCalls).toEqual(['extra context'])
      expect(session.sendCalls).toEqual([])
      // The pickup mark says "queued", not "processed": DONE waits for the
      // claim, and the queued mark needs no reaction id (it is never retracted).
      expect(p.added).toEqual(['Get'])
      expect(p.withIDs).toEqual([])
      expect(p.getSent()).toHaveLength(0)
    } finally {
      disposeAll()
    }
  })

  it('adds DONE next to the kept Get when the steered text reaches a model request', async () => {
    const p = reactionPlatform()
    const { e, disposeAll } = newEngine(p)
    const session = newControllableSession('s1')
    const sessionKey = 'test:ch1:u1'
    try {
      const state = armedState(e, session)
      state.activeTurns = 1
      e.dispatchCommand(p, miscMsg('/ps extra context'), '/ps extra context')
      expect(p.added).toEqual(['Get'])

      session.channel.push({ type: 'steer_claimed', content: '', done: false, steerMessageID: 'steer-1' })
      session.channel.push({ type: 'result', content: 'turn output', done: true })
      const bookSession = e.sessions.getOrCreateActive(sessionKey)
      await e.processInteractiveEvents(state, bookSession, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)

      await vi.waitFor(() => { expect(p.added).toEqual(['Get', 'DONE']) })
      // Additive marks: the pickup stays on the message, nothing is retracted.
      expect(p.removes).toEqual([])
      expect(p.withIDs).toEqual([])
      expect(p.cancelledCount).toBe(0)
    } finally {
      disposeAll()
    }
  })

  it('adds the stop emoji next to the kept Get when the turn is stopped before the claim', async () => {
    const p = reactionPlatform()
    const { e, disposeAll } = newEngine(p)
    const session = newControllableSession('s1')
    try {
      const state = armedState(e, session)
      state.activeTurns = 1
      e.dispatchCommand(p, miscMsg('/ps held back'), '/ps held back')
      expect(p.added).toEqual(['Get'])

      e.stopInteractiveSession('test:ch1:u1')

      await vi.waitFor(() => { expect(p.added).toEqual(['Get', 'CrossMark']) })
      expect(p.removes).toEqual([])
    } finally {
      disposeAll()
    }
  })

  it('settles pending pickups as stopped on interactive-state cleanup', async () => {
    const p = reactionPlatform()
    const { e, disposeAll } = newEngine(p)
    const session = newControllableSession('s1')
    try {
      const state = armedState(e, session)
      state.activeTurns = 1
      e.dispatchCommand(p, miscMsg('/ps held back'), '/ps held back')
      expect(p.added).toEqual(['Get'])

      await e.cleanupInteractiveState('test:ch1:u1', state)

      await vi.waitFor(() => { expect(p.added).toEqual(['Get', 'CrossMark']) })
      expect(p.removes).toEqual([])
    } finally {
      disposeAll()
    }
  })

  it('adds no stop emoji when the platform has no cancelled-reaction capability', async () => {
    const p = reactionPlatform({ withoutCancelled: true })
    const { e, disposeAll } = newEngine(p)
    const session = newControllableSession('s1')
    try {
      const state = armedState(e, session)
      state.activeTurns = 1
      e.dispatchCommand(p, miscMsg('/ps held back'), '/ps held back')
      expect(p.added).toEqual(['Get'])

      e.stopInteractiveSession('test:ch1:u1')

      // The stop path settles synchronously; without the capability nothing
      // joins the kept Get mark.
      expect(p.added).toEqual(['Get'])
      expect(p.cancelledCount).toBe(0)
      expect(p.removes).toEqual([])
    } finally {
      disposeAll()
    }
  })

  it('marks the same additive Get → DONE pair on a platform without id-based retraction', async () => {
    const p = reactionPlatform()
    delete (p as { addReactionWithID?: unknown }).addReactionWithID
    delete (p as { removeReaction?: unknown }).removeReaction
    const { e, disposeAll } = newEngine(p)
    const session = newControllableSession('s1')
    const sessionKey = 'test:ch1:u1'
    try {
      const state = armedState(e, session)
      state.activeTurns = 1
      expect(e.dispatchCommand(p, miscMsg('/ps extra context'), '/ps extra context')).toBe(true)
      expect(session.steerCalls).toEqual(['extra context'])
      // Retraction is gone from the /ps path, so a platform that cannot
      // retract behaves exactly like one that can.
      expect(p.added).toEqual(['Get'])

      session.channel.push({ type: 'steer_claimed', content: '', done: false, steerMessageID: 'steer-1' })
      session.channel.push({ type: 'result', content: 'turn output', done: true })
      const bookSession = e.sessions.getOrCreateActive(sessionKey)
      await e.processInteractiveEvents(state, bookSession, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)

      await vi.waitFor(() => { expect(p.added).toEqual(['Get', 'DONE']) })
    } finally {
      disposeAll()
    }
  })

  it('steers even when the turn is blocked on a permission', () => {
    const { e, p, disposeAll } = newEngine()
    const session = newControllableSession('s1')
    try {
      const state = armedState(e, session)
      state.activeTurns = 1
      state.pendingAsk = newPendingAsk({ request: { kind: 'permission', toolName: 'Bash', preview: '' } })
      expect(e.dispatchCommand(p, miscMsg('/ps held back'), '/ps held back')).toBe(true)
      // The in-process next-step inbox needs no stdin workaround: the text
      // stays queued until the permission resolves, then lands in the same
      // turn — never on the engine's busy-queue.
      expect(session.steerCalls).toEqual(['held back'])
      expect(state.pendingMessages).toHaveLength(0)
      expect(p.getSent()).toHaveLength(0)
    } finally {
      disposeAll()
    }
  })

  it('falls through as a normal message when the agent is idle', () => {
    const { e, p, disposeAll } = newEngine()
    const session = newControllableSession('s1')
    try {
      armedState(e, session) // live session, zero active turns
      const msg = miscMsg('/ps just a note')
      expect(e.dispatchCommand(p, msg, '/ps just a note')).toBe(false)
      // The /ps prefix is stripped so the text reaches the agent verbatim.
      expect(msg.content).toBe('just a note')
      expect(session.steerCalls).toEqual([])
      expect(session.sendCalls).toEqual([])
    } finally {
      disposeAll()
    }
  })
})
