/**
 * The /rename command (Go cmdRename): with a name argument it renames the
 * spawned group directly and marks the manual rename so the async first-message
 * LLM rename will not clobber it; with no argument it regenerates a name from
 * the full conversation history via LightweightQuery and refreshes the icon
 * avatar. No-op outside spawned groups.
 */

import { describe, expect, it } from 'vitest'
import { cmdRename } from '../../src/engine/commands.js'
import { Engine } from '../../src/engine/engine.js'
import { buildCompactContext } from '../../src/engine/groupname.js'
import {
  createGroupNameAgent,
  createStubTitleRenamePlatform,
  newStubMessage,
  type StubTitleRenamePlatform,
} from '../stubs/engine-stubs.js'
import type { Message } from '../../src/core/types.js'

function msg(overrides: Partial<Message> = {}): Message {
  return { ...newStubMessage(), sessionKey: 'test:chat', platform: 'test', userID: 'u1', replyCtx: 'ctx', ...overrides }
}

function newEngineWith(p: StubTitleRenamePlatform, agent = createGroupNameAgent({ resp: '调试 500 错误\nbug' })): Engine {
  const e = new Engine('test', agent, [p], '', 'en')
  e.setGroupNameConfig(true, 'p', 1000, '')
  e.setGroupNameAvatarEnabled(true)
  return e
}

describe('cmdRename direct path', () => {
  it('rejects non-spawned chats', async () => {
    const p = createStubTitleRenamePlatform()
    const e = newEngineWith(p)

    await cmdRename(e, p, msg({ isSpawnedGroup: false }), ['新名'])

    expect(p.renamedKeys).toEqual([])
    expect(p.getSent()[0]).toContain('/rename')
  })

  it('renames directly, marks the manual rename, and confirms', async () => {
    const p = createStubTitleRenamePlatform()
    const e = newEngineWith(p)

    await cmdRename(e, p, msg({ isSpawnedGroup: true }), ['新', '名', '字'])

    expect(p.renamedKeys).toEqual(['test:chat'])
    expect(p.renamedNames).toEqual(['新 名 字'])
    // The manual-rename mark keeps the async LLM rename from clobbering it.
    expect(e.hasPendingRename('test:chat')).toBe(true)
    expect(p.getSent()[0]).toContain('新 名 字')
  })

  it('sanitizes the requested name', async () => {
    const p = createStubTitleRenamePlatform()
    const e = newEngineWith(p)

    await cmdRename(e, p, msg({ isSpawnedGroup: true }), ['  新名  '])

    expect(p.renamedNames).toEqual(['新名'])
  })

  it('reports a rename failure and does not mark the manual rename', async () => {
    const p = createStubTitleRenamePlatform()
    const e = newEngineWith(p)
    const failing: StubTitleRenamePlatform = {
      ...p,
      renameGroup: async () => { throw new Error('boom') },
    }

    await cmdRename(e, failing, msg({ isSpawnedGroup: true }), ['新名'])

    expect(e.hasPendingRename('test:chat')).toBe(false)
    expect(failing.getSent()[0]).toContain('boom')
  })
})

describe('cmdRename LLM path', () => {
  it('regenerates from the conversation history and refreshes the icon avatar', async () => {
    const p = createStubTitleRenamePlatform()
    const e = newEngineWith(p)
    const sess = e.sessions.getOrCreateActive('test:chat')
    sess.addHistory('user', '帮我修 500 错误')

    await cmdRename(e, p, msg({ isSpawnedGroup: true }), [])

    await waitFor(() => p.renamedKeys.length === 1, 'rename was not called')
    expect(p.renamedNames).toEqual(['调试 500 错误'])
    expect(p.avatarIcons).toEqual(['bug'])
    expect(p.getSent()[0]).toContain('调试 500 错误')
  })

  it('replies no-history when the session is empty', async () => {
    const p = createStubTitleRenamePlatform()
    const e = newEngineWith(p)

    await cmdRename(e, p, msg({ isSpawnedGroup: true }), [])

    expect(p.renamedKeys).toEqual([])
    expect(p.getSent()[0]).toContain('conversation')
  })

  it('reports an unsupported backend when the LLM query fails', async () => {
    const p = createStubTitleRenamePlatform()
    const e = newEngineWith(p, createGroupNameAgent({ err: new Error('no provider') }))
    const sess = e.sessions.getOrCreateActive('test:chat')
    sess.addHistory('user', '帮我修 500 错误')

    await cmdRename(e, p, msg({ isSpawnedGroup: true }), [])
    await waitFor(() => p.getSent().length > 0, 'no reply')

    expect(p.renamedKeys).toEqual([])
  })
})

describe('buildCompactContext', () => {
  it('joins user messages and the last assistant reply', () => {
    const out = buildCompactContext([
      { role: 'user', content: '第一个问题', timestamp: '' },
      { role: 'assistant', content: '回答一', timestamp: '' },
      { role: 'user', content: '第二个问题', timestamp: '' },
      { role: 'assistant', content: '回答二', timestamp: '' },
    ])
    expect(out).toBe('User: 第一个问题\nUser: 第二个问题\n\nAssistant: 回答二\n')
  })

  it('truncates long user messages and drops old ones past the cap', () => {
    const long = 'x'.repeat(250)
    const entries = Array.from({ length: 30 }, (_, i) => ({
      role: 'user' as const,
      content: `${String(i)}${long}`,
      timestamp: '',
    }))
    const out = buildCompactContext(entries)
    expect(out.length).toBeLessThanOrEqual(3000 + '\nAssistant: '.length + 500 + 4)
    // Only the tail survived: the first index must not appear.
    expect(out).not.toContain('User: 0')
    expect(out).toContain('User: 29')
  })
})

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
  throw new Error(`timeout waiting for ${what}`)
}
