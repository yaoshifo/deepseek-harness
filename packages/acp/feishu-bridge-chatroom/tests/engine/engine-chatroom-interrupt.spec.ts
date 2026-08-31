/**
 * Chatroom interrupt tests: `/chatroom stop` and interruptChatroom hard-stop
 * a chatroom from ANY protocol state — an armed gather whose reply sources
 * died (the 2026-08-25 oc_65f8918e zombie: assistants user-stopped, end
 * refused because the gather can never complete) no longer deadlocks the
 * teardown.
 *
 * @module dsh-feishu-bridge/tests-engine-chatroom-interrupt
 */

import { describe, expect, it, vi } from 'vitest'
import { Engine } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { ProjectStateStore } from '@deepseek-ai/dsh-feishu-bridge/exports'
import {
  ChatroomEndBarrier,
  ChatroomGather,
  interruptChatroom,
  resolveChatroomHubKey,
} from '../../src/engine/chatroom.ts'
import { cmdChatroom } from '../../src/engine/chatroom-cmd.ts'
import { createStubAgent, createStubChatroomSpawner } from '../stubs/engine-stubs.ts'
import type { Platform } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { chatroomState } from '../../src/chatroom-state.ts'
import '../stubs/messages.js'

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

function newEngine(p: Platform): Engine {
  const e = new Engine('test', createStubAgent(), [p], '', 'zh')
  e.setProjectStateStore(new ProjectStateStore(''))
  return e
}

const hubKey = 'test:hub:user-1'

/** A chatroom with two bound roles, one armed gather awaiting both. */
function armedChatroom(e: Engine): ChatroomGather {
  const hub = e.sessions.getOrCreateActive(hubKey)
  chatroomState(hub).chatroomModerator = true
  const g = new ChatroomGather('研究任务', 1)
  for (const name of ['taleb', 'munger']) {
    const key = `test:role-${name}`
    const s = e.sessions.getOrCreateActive(key)
    chatroomState(s).chatroomHubKey = hubKey
    s.setParentSessionKey(hubKey)
    chatroomState(s).chatroomRoleName = name
    g.expected.add(name)
  }
  chatroomState(hub).pendingGather = g
  return g
}

function cardText(card: unknown): string {
  return JSON.stringify(card)
}

describe('interruptChatroom', () => {
  it('closes an armed gather without waking the moderator and tears the chatroom down', async () => {
    const p = createStubChatroomSpawner()
    const e = newEngine(p)
    armedChatroom(e)
    const recv = vi.spyOn(e, 'receiveMessage').mockImplementation(() => {})
    const stops = vi.spyOn(e, 'stopInteractiveSession')

    const res = interruptChatroom(e, hubKey)

    // The gather is consumed, its timer stopped, and no wake fires: the
    // interrupt card is the only terminal record.
    expect(chatroomState(e.sessions.getOrCreateActive(hubKey)).pendingGather).toBeUndefined()
    expect(recv.mock.calls).toHaveLength(0)
    // The moderator turn and every in-flight member turn are stopped.
    expect(stops).toHaveBeenCalledWith(hubKey)
    expect(stops).toHaveBeenCalledWith('test:role-taleb')
    expect(stops).toHaveBeenCalledWith('test:role-munger')
    // Teardown ran: roles unbound, hub flag down, missing roles reported.
    expect(chatroomState(e.sessions.getOrCreateActive('test:role-taleb')).chatroomHubKey).toBe('')
    expect(chatroomState(e.sessions.getOrCreateActive(hubKey)).chatroomModerator).toBe(false)
    expect(res.rolesRemoved).toBe(2)
    expect(res.missing).toEqual(['munger', 'taleb'])

    // The interrupt card lands in the hub with the missing roles.
    await waitFor(() => p.sentCards.length > 0, 'interrupt card')
    expect(cardText(p.sentCards[0])).toContain('聊天室已中断')
    expect(cardText(p.sentCards[0])).toContain('munger')
  })

  it('closes a pending end barrier the same way', async () => {
    const p = createStubChatroomSpawner()
    const e = newEngine(p)
    armedChatroom(e)
    const b = new ChatroomEndBarrier()
    b.expected.add('taleb')
    chatroomState(e.sessions.getOrCreateActive(hubKey)).pendingGather = undefined
    chatroomState(e.sessions.getOrCreateActive(hubKey)).pendingEndBarrier = b
    const recv = vi.spyOn(e, 'receiveMessage').mockImplementation(() => {})

    const res = interruptChatroom(e, hubKey)

    expect(chatroomState(e.sessions.getOrCreateActive(hubKey)).pendingEndBarrier).toBeUndefined()
    expect(recv.mock.calls).toHaveLength(0)
    expect(res.missing).toEqual(['taleb'])
  })

  it('is a no-op teardown when the chatroom already ended', () => {
    const p = createStubChatroomSpawner()
    const e = newEngine(p)
    const hub = e.sessions.getOrCreateActive(hubKey)
    chatroomState(hub).chatroomModerator = true

    const res = interruptChatroom(e, hubKey)

    expect(res.rolesRemoved).toBe(0)
    expect(res.missing).toEqual([])
    expect(chatroomState(hub).chatroomModerator).toBe(false)
  })
})

describe('resolveChatroomHubKey', () => {
  it('resolves from the hub, a role group, and an assistant group via the parent chain', () => {
    const p = createStubChatroomSpawner()
    const e = newEngine(p)
    armedChatroom(e)
    // A pre-spawned assistant: child of a role, no direct chatroom fields.
    const asst = e.sessions.getOrCreateActive('test:assistant-taleb')
    asst.setParentSessionKey('test:role-taleb')

    expect(resolveChatroomHubKey(e, hubKey)).toBe(hubKey)
    expect(resolveChatroomHubKey(e, 'test:role-taleb')).toBe(hubKey)
    expect(resolveChatroomHubKey(e, 'test:assistant-taleb')).toBe(hubKey)
    expect(resolveChatroomHubKey(e, 'test:unrelated:user-2')).toBe('')
  })
})

describe('/chatroom stop', () => {
  it('interrupts from a role group and reports nothing into the dying group', async () => {
    const p = createStubChatroomSpawner()
    const e = newEngine(p)
    armedChatroom(e)
    const recv = vi.spyOn(e, 'receiveMessage').mockImplementation(() => {})

    await cmdChatroom(e, p, { sessionKey: 'test:role-taleb', replyCtx: 'ctx' } as never, ['stop'])

    expect(chatroomState(e.sessions.getOrCreateActive(hubKey)).pendingGather).toBeUndefined()
    expect(recv.mock.calls).toHaveLength(0)
    await waitFor(() => p.sentCards.length > 0, 'interrupt card')
  })

  it('answers not-in-room for an unrelated chat', async () => {
    const p = createStubChatroomSpawner()
    const e = newEngine(p)
    const replies: string[] = []
    const replySpy = vi.spyOn(e, 'reply').mockImplementation(async (_p, _ctx, text) => { replies.push(text) })

    await cmdChatroom(e, p, { sessionKey: 'test:unrelated:user-2', replyCtx: 'ctx' } as never, ['stop'])

    expect(replies.join()).toContain('不属于任何聊天室')
    void replySpy
  })
})
