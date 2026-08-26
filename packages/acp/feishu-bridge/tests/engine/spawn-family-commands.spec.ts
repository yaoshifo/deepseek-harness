/**
 * Spawn-family command tests ported from cc-connect core
 * engine_cmd_session.go: /tag /untag /undone (Go cmdTag/cmdUntag/cmdUndone),
 * /notify (Go cmdNotify), and /board (Go cmdDashboard + familyChats +
 * renderDashboardTree). The dashboard done-button/in-place-refresh machinery
 * is not ported — Go's current tree renders links only.
 *
 * @module dsh-feishu-bridge/tests-engine-spawn-family-commands
 */

import { describe, expect, it, vi } from 'vitest'
import { Engine } from '../../src/engine/engine.js'
import { registerSessionCommands } from '../../src/engine/commands.js'
import { registerSpawnFamilyCommands } from '../../src/engine/spawn-family-commands.js'
import { Msg } from '../../src/i18n/index.js'
import type { Card } from '../../src/card.js'
import {
  createStubAgent,
  createStubCardPlatformFull,
  newStubMessage,
  type StubCardPlatform,
} from '../stubs/engine-stubs.js'
import type { Message, Platform, SpawnedChatInfo } from '../../src/core/types.js'

/** Card platform with the tag/avatar/spawned-registry capabilities recorded. */
interface FamilyStubPlatform extends StubCardPlatform {
  taggedKeys: string[]
  removedTags: Array<{ sessionKey: string; tagName: string }>
  phaseCalls: Array<{ sessionKey: string; phase: string }>
  basePhase: string
  activeKeys: Set<string>
  doneKeys: Set<string>
  reactions: string[]
  spawnedChats: SpawnedChatInfo[]
  activeTagName(): string
  applyActiveTag(sessionKey: string): Promise<void>
  removeTagFromChat(sessionKey: string, tagName: string): Promise<void>
  setChatPhase(sessionKey: string, phase: import('../../src/core/types.js').ChatPhase): Promise<void>
  chatBasePhase(sessionKey: string): import('../../src/core/types.js').ChatBasePhase
  markSpawnedChatActive(sessionKey: string): Promise<void>
  markSpawnedChatDone(sessionKey: string): Promise<void>
  isSpawnedChatActive(sessionKey: string): boolean
  isSpawnedChatDone(sessionKey: string): boolean
  addReaction(replyCtx: unknown, emoji: string): void
  listActiveSpawnedChats(): Promise<SpawnedChatInfo[]>
}

function newFamilyPlatform(): FamilyStubPlatform {
  const p = createStubCardPlatformFull('test') as unknown as FamilyStubPlatform
  p.taggedKeys = []
  p.removedTags = []
  p.phaseCalls = []
  p.basePhase = 'discussing'
  p.activeKeys = new Set<string>()
  p.doneKeys = new Set<string>()
  p.reactions = []
  p.spawnedChats = []
  p.activeTagName = () => '❤️'
  p.applyActiveTag = async (sessionKey: string) => { p.taggedKeys.push(sessionKey) }
  p.removeTagFromChat = async (sessionKey: string, tagName: string) => { p.removedTags.push({ sessionKey, tagName }) }
  p.setChatPhase = async (sessionKey: string, phase: import('../../src/core/types.js').ChatPhase) => { p.phaseCalls.push({ sessionKey, phase }) }
  p.chatBasePhase = (_sessionKey: string) => p.basePhase as import('../../src/core/types.js').ChatBasePhase
  p.markSpawnedChatActive = async (sessionKey: string) => { p.activeKeys.add(sessionKey); p.doneKeys.delete(sessionKey) }
  p.markSpawnedChatDone = async (sessionKey: string) => { p.activeKeys.delete(sessionKey); p.doneKeys.add(sessionKey) }
  p.isSpawnedChatActive = (sessionKey: string) => p.activeKeys.has(sessionKey)
  p.isSpawnedChatDone = (sessionKey: string) => p.doneKeys.has(sessionKey)
  p.listActiveSpawnedChats = async () => p.spawnedChats
  p.addReaction = (_replyCtx: unknown, emoji: string) => { p.reactions.push(emoji) }
  return p
}

function newEngine(p?: Platform): {
  e: Engine
  p: FamilyStubPlatform
  disposeFamily: () => void
  disposeSession: () => void
} {
  const plat = p ?? newFamilyPlatform()
  const e = new Engine('test', createStubAgent(), [plat], '', 'en')
  const disposeSession = registerSessionCommands(e)
  const disposeFamily = registerSpawnFamilyCommands(e)
  return { e, p: plat as FamilyStubPlatform, disposeFamily, disposeSession }
}

function famMsg(content: string, sessionKey = 'test:ch1:u1'): Message {
  return { ...newStubMessage(), sessionKey, userID: 'u1', replyCtx: 'ctx', content }
}

describe('registerSpawnFamilyCommands', () => {
  it('merges into the session command table and disposes back', () => {
    const { e, p, disposeFamily, disposeSession } = newEngine()
    try {
      expect(e.commandHandlers?.get('tag')).toBeDefined()
      expect(e.commandHandlers?.get('new')).toBeDefined()
      expect(e.dispatchCommand(p, famMsg('/tag'), '/tag')).toBe(true)
    } finally {
      disposeFamily()
    }
    expect(e.commandHandlers?.get('tag')).toBeUndefined()
    expect(e.commandHandlers?.get('new')).toBeDefined()
    disposeSession()
  })

  it('resolves the /db alias and ≥2-char prefixes for /board', () => {
    const { e, disposeFamily, disposeSession } = newEngine()
    try {
      expect(e.commandResolver?.('db')).toBe('board')
      expect(e.commandResolver?.('bo')).toBe('board')
      expect(e.commandResolver?.('unt')).toBe('untag')
      expect(e.commandResolver?.('und')).toBe('undone')
    } finally {
      disposeFamily(); disposeSession()
    }
  })
})

describe('/tag', () => {
  it('applies the active tag and reacts without a text reply', async () => {
    const { e, p, disposeFamily, disposeSession } = newEngine()
    try {
      expect(e.dispatchCommand(p, famMsg('/tag'), '/tag')).toBe(true)
      await vi.waitFor(() => { expect(p.taggedKeys).toEqual(['test:ch1:u1']) })
      expect(p.reactions).toContain('Tag')
      expect(p.getSent()).toHaveLength(0)
    } finally {
      disposeFamily(); disposeSession()
    }
  })

  it('replies not-supported when the platform cannot tag', async () => {
    const plain = createStubCardPlatformFull('test')
    const { e, p, disposeFamily, disposeSession } = newEngine(plain)
    try {
      expect(e.dispatchCommand(p, famMsg('/tag'), '/tag')).toBe(true)
      await vi.waitFor(() => { expect(p.getSent()[0]).toBe(e.i18n.t(Msg.TagNotSupported)) })
    } finally {
      disposeFamily(); disposeSession()
    }
  })

  it('replies the error when tagging fails', async () => {
    const { e, p, disposeFamily, disposeSession } = newEngine()
    p.applyActiveTag = async () => { throw new Error('boom') }
    try {
      expect(e.dispatchCommand(p, famMsg('/tag'), '/tag')).toBe(true)
      await vi.waitFor(() => { expect(p.getSent()[0]).toContain('boom') })
    } finally {
      disposeFamily(); disposeSession()
    }
  })
})

describe('/untag', () => {
  it('removes the active tag by platform tag name and reacts', async () => {
    const { e, p, disposeFamily, disposeSession } = newEngine()
    try {
      expect(e.dispatchCommand(p, famMsg('/untag'), '/untag')).toBe(true)
      await vi.waitFor(() => {
        expect(p.removedTags).toEqual([{ sessionKey: 'test:ch1:u1', tagName: '❤️' }])
      })
      expect(p.reactions).toContain('Untag')
      expect(p.getSent()).toHaveLength(0)
    } finally {
      disposeFamily(); disposeSession()
    }
  })
})

describe('/undone', () => {
  it('restores the baseline phase, marks the chat active, and reacts', async () => {
    const { e, p, disposeFamily, disposeSession } = newEngine()
    p.basePhase = 'approved'
    try {
      expect(e.dispatchCommand(p, famMsg('/undone'), '/undone')).toBe(true)
      await vi.waitFor(() => {
        expect(p.phaseCalls).toEqual([{ sessionKey: 'test:ch1:u1', phase: 'approved' }])
      })
      expect(p.activeKeys.has('test:ch1:u1')).toBe(true)
      expect(p.reactions).toContain('Undone')
    } finally {
      disposeFamily(); disposeSession()
    }
  })

  it('replies the error when the phase paint fails', async () => {
    const { e, p, disposeFamily, disposeSession } = newEngine()
    p.setChatPhase = async () => { throw new Error('nope') }
    try {
      expect(e.dispatchCommand(p, famMsg('/undone'), '/undone')).toBe(true)
      await vi.waitFor(() => { expect(p.getSent()[0]).toContain('nope') })
    } finally {
      disposeFamily(); disposeSession()
    }
  })
})

describe('/notify', () => {
  it('re-sends the ready card in a child group with the parent jump breadcrumb', async () => {
    const { e, p, disposeFamily, disposeSession } = newEngine()
    try {
      e.sessions.getOrCreateActive('test:parent-chat:u1')
      const grand = e.sessions.getOrCreateActive('test:grand-chat:u1')
      grand.setParentSessionKey('test:parent-chat:u1')
      grand.setName('父群')
      const child = e.sessions.getOrCreateActive('test:ch1:u1')
      child.setParentSessionKey('test:grand-chat:u1')

      expect(e.dispatchCommand(p, famMsg('/notify', 'test:ch1:u1'), '/notify')).toBe(true)
      await vi.waitFor(() => { expect(p.sentCards.length).toBeGreaterThanOrEqual(1) })
      const card = p.sentCards[p.sentCards.length - 1] as Card
      // The breadcrumb folds into the collapsible panel, which has no text
      // degradation — assert on the element tree instead.
      expect(JSON.stringify(card.elements)).toContain('父群')
    } finally {
      disposeFamily(); disposeSession()
    }
  })

  it('falls back to the no-children note in a parent group without children', async () => {
    const { e, p, disposeFamily, disposeSession } = newEngine()
    try {
      expect(e.dispatchCommand(p, famMsg('/notify', 'test:ch1:u1'), '/notify')).toBe(true)
      await vi.waitFor(() => { expect(p.sentCards.length).toBeGreaterThanOrEqual(1) })
      const card = p.sentCards[p.sentCards.length - 1] as Card
      expect(card.renderText()).toContain(e.i18n.t(Msg.NotifyNoChildren))
    } finally {
      disposeFamily(); disposeSession()
    }
  })

  it('sends plain text on a platform without card support', async () => {
    const { e, p, disposeFamily, disposeSession } = newEngine()
    // Strip the card path: replyWithCard falls back to send() when sendCard throws.
    p.sendCard = async () => { throw new Error('no cards') }
    try {
      expect(e.dispatchCommand(p, famMsg('/notify', 'test:ch1:u1'), '/notify')).toBe(true)
      await vi.waitFor(() => { expect(p.getSent().length).toBeGreaterThanOrEqual(1) })
      expect(p.getSent()[0]).toContain(e.i18n.t(Msg.NotifyNoChildren))
    } finally {
      disposeFamily(); disposeSession()
    }
  })
})

describe('/board', () => {
  it('renders the current chat family tree with links and the current marker', async () => {
    const { e, p, disposeFamily, disposeSession } = newEngine()
    try {
      e.sessions.getOrCreateActive('test:c1:u1')
      const child = e.sessions.getOrCreateActive('test:c2:u1')
      child.setParentSessionKey('test:c1:u1')
      p.spawnedChats = [
        { chatID: 'c1', chatName: '任务A', botName: 'test' },
        { chatID: 'c2', chatName: '子任务B', botName: 'test' },
      ]

      expect(e.dispatchCommand(p, famMsg('/board', 'test:c1:u1'), '/board')).toBe(true)
      await vi.waitFor(() => { expect(p.sentCards.length).toBeGreaterThanOrEqual(1) })
      const card = p.sentCards[p.sentCards.length - 1] as Card
      expect(card.header?.title).toBe('Dashboard')
      // The tree renders collapsible panels (no text degradation) — assert
      // on the element tree instead of renderText.
      const tree = JSON.stringify(card.elements)
      expect(tree).toContain('任务A')
      expect(tree).toContain('子任务B')
      expect(tree).toContain('←')
      expect(card.renderText()).toContain('当前任务树 2 个群')
    } finally {
      disposeFamily(); disposeSession()
    }
  })

  it('replies the empty hint when no spawned chats exist', async () => {
    const { e, p, disposeFamily, disposeSession } = newEngine()
    try {
      expect(e.dispatchCommand(p, famMsg('/board'), '/board')).toBe(true)
      await vi.waitFor(() => { expect(p.sentCards.length).toBeGreaterThanOrEqual(1) })
      const card = p.sentCards[p.sentCards.length - 1] as Card
      expect(card.renderText()).toContain('暂无活跃任务群')
    } finally {
      disposeFamily(); disposeSession()
    }
  })

  it('replies the not-in-tree hint when the current chat has no family', async () => {
    const { e, p, disposeFamily, disposeSession } = newEngine()
    try {
      p.spawnedChats = [{ chatID: 'c1', chatName: '任务A', botName: 'test' }]
      expect(e.dispatchCommand(p, famMsg('/board', 'test:other:u1'), '/board')).toBe(true)
      await vi.waitFor(() => { expect(p.sentCards.length).toBeGreaterThanOrEqual(1) })
      const card = p.sentCards[p.sentCards.length - 1] as Card
      expect(card.renderText()).toContain('当前群不在任何任务树中')
    } finally {
      disposeFamily(); disposeSession()
    }
  })
})
