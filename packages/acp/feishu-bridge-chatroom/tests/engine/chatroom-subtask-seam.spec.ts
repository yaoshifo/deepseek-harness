/**
 * The chatroom halves of the subtask-related engine seams, exercised with
 * the production policy listeners (moved from the bridge's engine-subtask
 * spec when the chatroom moved to this package): research dispatch marking,
 * the "assistant" child-alias sentinel, takeover into a chatroom role, the
 * research-assistant start-option flag, and chatroom-shaped sessions in the
 * subtask gather expected set.
 *
 * @module dsh-feishu-bridge-chatroom/tests-chatroom-subtask-seam
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Agent, Message, Platform } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { Engine, WorktreeMode } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { chatroomState } from '../../src/chatroom-state.ts'
import { createStubAgent, createStubCardPlatformFull, createStubSpawnerPlatform, newStubMessage, type RecordedCard } from '../stubs/engine-stubs.ts'
import { chatroomPolicyFace } from '../stubs/bridge-policy.ts'
import '../stubs/messages.js'

const parentKey = 'test:parent-chat:user-1'
const childKey = 'test:child-chat'
const roleKey = 'test:role-chat:user-1'

function newSubtaskTestEngine(p: Platform, agent: Agent = createStubAgent()): Engine {
  return new Engine('test', agent, [p], '', 'en', chatroomPolicyFace())
}

async function settle(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

function msg(overrides: Partial<Message> = {}): Message {
  return { ...newStubMessage(), replyCtx: 'test-rctx', platform: 'test', userID: 'u1', ...overrides }
}

/** The markdown body of a recorded card. */
function cardBody(card: unknown): string {
  const c = card as RecordedCard
  const first = c.elements[0]
  return first?.kind === 'markdown' ? (first.content ?? '') : ''
}

describe('SendToSubtask research dispatch marking', () => {
  it('does not mark research dispatch during pre-spawn', async () => {
    // afterChatroomStarted pre-spawns assistants BEFORE any gather arms
    // ResearchAwaitingAssistant — the awaiting gate must keep that spawn from
    // tripping the flag.
    const hubKey = 'test:hub-chat:user-1'
    const p = createStubSpawnerPlatform()
    const e = newSubtaskTestEngine(p)

    const parent = e.sessions.getOrCreateActive(parentKey)
    chatroomState(parent).chatroomHubKey = hubKey
    // awaiting stays false (pre-spawn happens before the first gather)

    await expect(
      e.spawnSubtask(parentKey, await mkdtemp(join(tmpdir(), 'fb-prespawn-')), WorktreeMode.ForceOff, false, '', [], false),
    ).resolves.toBeDefined()
    expect(chatroomState(parent).researchDispatched).toBe(false)
  })

  it('resolves the "assistant" sentinel to the caller\'s pre-provisioned research assistant', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)
    const child = e.sessions.getOrCreateActive(childKey)
    child.setParentSessionKey(parentKey)
    child.setSubtaskDepth(1)
    chatroomState(e.sessions.getOrCreateActive(parentKey)).researchAssistantKey = childKey

    await expect(e.sendToSubtask(parentKey, 'assistant', 'research task')).resolves.toBeUndefined()
    await settle()
    expect(p.sentCards.length).toBe(1)
    expect(cardBody(p.sentCards[0])).toContain('research task')
  })

  it('tells an unprovisioned caller to spawn an assistant first', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)

    await expect(e.sendToSubtask(parentKey, 'assistant', 'task'))
      .rejects.toThrow('no pre-provisioned assistant')
  })

  it('marks research dispatched on a successful send', async () => {
    const hubKey = 'test:hub-chat:user-1'
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)

    const parent = e.sessions.getOrCreateActive(parentKey)
    chatroomState(parent).chatroomHubKey = hubKey
    chatroomState(parent).researchAwaitingAssistant = true
    const child = e.sessions.getOrCreateActive(childKey)
    child.setParentSessionKey(parentKey)
    child.setSubtaskDepth(1)

    // Dispatch turn: a successful send marks the role as dispatched.
    await expect(e.sendToSubtask(parentKey, childKey, 'fetch the data')).resolves.toBeUndefined()
    expect(chatroomState(parent).researchDispatched).toBe(true)

    // Outside the dispatch turn (awaiting cleared): no marking. Use a fresh
    // child — the first send's injected message started the old child's
    // turn (busy).
    chatroomState(parent).researchDispatched = false
    chatroomState(parent).researchAwaitingAssistant = false
    const child2 = e.sessions.getOrCreateActive('test:child-chat-2')
    child2.setParentSessionKey(parentKey)
    child2.setSubtaskDepth(1)
    await expect(e.sendToSubtask(parentKey, 'test:child-chat-2', 'one more dataset')).resolves.toBeUndefined()
    expect(chatroomState(parent).researchDispatched).toBe(false)
  })
})

describe('markUserInterjectedOnHumanTurn chatroom halves', () => {
  it('flips on a human message into a chatroom role', () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)
    const role = e.sessions.getOrCreateActive(roleKey)
    chatroomState(role).chatroomHubKey = 'test:hub:user-1'

    e.markUserInterjectedOnHumanTurn(msg({ sessionKey: roleKey, userID: 'u1', userName: 'human' }), role, e.sessions)

    expect(role.getUserInterjected()).toBe(true)
  })
})

describe('buildSessionStartOptions chatroom halves', () => {
  it('injects the research assistant contract only for research assistants', () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)

    const key = 'test:assistant-chat'
    const sess = e.sessions.getOrCreateActive(key)
    sess.setSubtaskDepth(1)
    chatroomState(sess).researchAssistant = true

    expect(e.buildSessionStartOptions(key, sess).subtask?.researchAssistant).toBe(true)

    chatroomState(sess).researchAssistant = false
    expect(e.buildSessionStartOptions(key, sess).subtask?.researchAssistant).toBeUndefined()
  })

  it('carries the assistant run dir beside the research assistant flag', () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)

    const key = 'test:assistant-chat'
    const sess = e.sessions.getOrCreateActive(key)
    sess.setSubtaskDepth(1)
    chatroomState(sess).researchAssistant = true
    chatroomState(sess).researchRunDir = '/ws/runs/hub-1/assistant-munger'

    expect(e.buildSessionStartOptions(key, sess).subtask?.researchRunDir).toBe('/ws/runs/hub-1/assistant-munger')

    // An assistant without a run dir (no workspace, or a pre-stamp session
    // recovered from disk) stays undefined: the adapter falls back to cwd.
    chatroomState(sess).researchRunDir = ''
    expect(e.buildSessionStartOptions(key, sess).subtask?.researchRunDir).toBeUndefined()
  })
})
