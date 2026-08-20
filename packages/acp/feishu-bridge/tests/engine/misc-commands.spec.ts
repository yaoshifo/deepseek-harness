/**
 * Misc command tests ported from cc-connect core: /help (Go cmdHelp; the
 * command list is generated from the registered handlers instead of Go's
 * hand-maintained message_help blob) and /ps (Go handleCommand "ps" case:
 * append text to a running task, queue when blocked, fall through when idle).
 *
 * @module dsh-feishu-bridge/tests-engine-misc-commands
 */

import { describe, expect, it, vi } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.js'
import { registerSessionCommands } from '../../src/engine/commands.js'
import { registerShellCommands } from '../../src/engine/shell-commands.js'
import { registerMiscCommands } from '../../src/engine/misc-commands.js'
import { Msg } from '../../src/i18n/index.js'
import type { Card } from '../../src/card.js'
import {
  createStubAgent,
  createStubCardPlatformFull,
  newControllableSession,
  newPendingPermission,
  newStubMessage,
  type StubCardPlatform,
} from '../stubs/engine-stubs.js'
import type { AgentSession, Message } from '../../src/core/types.js'

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
      // Registered commands are listed with their one-line description.
      expect(sent).toContain('**/new**')
      expect(sent).toContain('**/shell**')
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

  it('replies usage when empty', async () => {
    const { e, p, disposeAll } = newEngine()
    try {
      expect(e.dispatchCommand(p, miscMsg('/ps'), '/ps')).toBe(true)
      await vi.waitFor(() => { expect(p.getSent()[0]).toBe(e.i18n.t(Msg.PsEmpty)) })
    } finally {
      disposeAll()
    }
  })

  it('sends into the running session mid-turn and reacts Done', async () => {
    const { e, p, disposeAll } = newEngine()
    const session = newControllableSession('s1')
    const sent: string[] = []
    session.send = async (prompt: string) => { sent.push(prompt) }
    try {
      const state = armedState(e, session)
      state.activeTurns = 1
      expect(e.dispatchCommand(p, miscMsg('/ps extra context'), '/ps extra context')).toBe(true)
      await vi.waitFor(() => { expect(sent).toEqual(['extra context']) })
      expect(p.getSent()).toHaveLength(0)
    } finally {
      disposeAll()
    }
  })

  it('queues instead of sending when the turn is blocked on a permission', async () => {
    const { e, p, disposeAll } = newEngine()
    const session = newControllableSession('s1')
    const sent: string[] = []
    session.send = async (prompt: string) => { sent.push(prompt) }
    try {
      const state = armedState(e, session)
      state.activeTurns = 1
      state.pending = newPendingPermission({ requestID: 'req-1', toolName: 'Bash', toolInput: {} })
      expect(e.dispatchCommand(p, miscMsg('/ps held back'), '/ps held back')).toBe(true)
      await vi.waitFor(() => { expect(state.pendingMessages.length).toBe(1) })
      expect(sent).toEqual([])
      expect(p.getSent()[0]).toBe(e.i18n.t(Msg.MessageQueued))
    } finally {
      disposeAll()
    }
  })

  it('falls through as a normal message when the agent is idle', () => {
    const { e, p, disposeAll } = newEngine()
    const session = newControllableSession('s1')
    const sent: string[] = []
    session.send = async (prompt: string) => { sent.push(prompt) }
    try {
      armedState(e, session) // live session, zero active turns
      const msg = miscMsg('/ps just a note')
      expect(e.dispatchCommand(p, msg, '/ps just a note')).toBe(false)
      // The /ps prefix is stripped so the text reaches the agent verbatim.
      expect(msg.content).toBe('just a note')
      expect(sent).toEqual([])
    } finally {
      disposeAll()
    }
  })
})
