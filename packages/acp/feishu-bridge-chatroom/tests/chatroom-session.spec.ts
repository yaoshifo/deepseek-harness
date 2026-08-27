/**
 * Chatroom session-field persistence tests ported 1:1 from cc-connect
 * core/session_chatroom_test.go: every chatroom field must round-trip
 * through save/load.
 *
 * @module dsh-feishu-bridge/tests-engine-chatroom-session
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SessionManager } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { ChatroomEndBarrier, ChatroomGather } from '../src/engine/chatroom.js'
import { chatroomFeatureStateCodec } from '../src/chatroom-state.js'
import { registerFeatureStateCodec } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { chatroomState } from '../src/chatroom-state.js'
import './stubs/messages.js'

// The production composition registers the chatroom codec once per process
// (plugin apply); these specs exercise carry and persistence through it.
const disposeCodec = registerFeatureStateCodec(chatroomFeatureStateCodec)
afterAll(() => { disposeCodec() })

describe('chatroom session fields persist', () => {
  it('chatroom hub/role/asked round-trip through save/load', async () => {
    const store = join(await mkdtemp(join(tmpdir(), 'fb-chatroom-session-')), 'sessions.json')

    const sm1 = new SessionManager(store)
    const role = sm1.getOrCreateActive('test:role-chat')
    role.setParentSessionKey('test:hub:user-1')
    chatroomState(role).chatroomHubKey = 'test:hub:user-1'
    chatroomState(role).chatroomRoleName = 'Taleb'
    chatroomState(role).chatroomAsked = false
    sm1.save()

    const sm2 = new SessionManager(store)
    const got = sm2.getOrCreateActive('test:role-chat')
    expect(chatroomState(got).chatroomHubKey).toBe('test:hub:user-1')
    expect(chatroomState(got).chatroomRoleName).toBe('Taleb')

    // Flip the bool, save, reload — proves chatroomAsked is in the snapshot
    // (a bool zero-value would mask a missing field on the first reload).
    chatroomState(got).chatroomAsked = true
    sm2.save()
    const sm3 = new SessionManager(store)
    expect(chatroomState(sm3.getOrCreateActive('test:role-chat')).chatroomAsked).toBe(true)

    // ChatroomDirectRole (Feature 2) round-trips the same way.
    const direct = sm1.getOrCreateActive('test:direct:user-1')
    chatroomState(direct).chatroomDirectRole = true
    sm1.save()
    const smDir = new SessionManager(store)
    expect(chatroomState(smDir.getOrCreateActive('test:direct:user-1')).chatroomDirectRole).toBe(true)

    // PendingHumanQuestionRole lives on the HUB session; prove it round-trips.
    const hub = sm1.getOrCreateActive('test:hub:user-1')
    chatroomState(hub).pendingHumanQuestionRole = 'Munger'
    sm1.save()

    const sm4 = new SessionManager(store)
    expect(chatroomState(sm4.getOrCreateActive('test:hub:user-1')).pendingHumanQuestionRole).toBe('Munger')
  })

  it('moderator/research-mode/round/gather-seq/venv round-trip through save/load', async () => {
    const store = join(await mkdtemp(join(tmpdir(), 'fb-chatroom-session-')), 'sessions.json')
    const sm1 = new SessionManager(store)
    const hub = sm1.getOrCreateActive('test:hub:user-1')
    chatroomState(hub).chatroomModerator = true
    chatroomState(hub).chatroomResearch = true
    chatroomState(hub).chatroomResearchMode = 'manual'
    chatroomState(hub).chatroomResearchRound = 2
    chatroomState(hub).chatroomResearchMaxRounds = 5
    chatroomState(hub).chatroomGatherSeq = 7
    chatroomState(hub).researchVenv = '/tmp/research/.venv'
    sm1.save()

    const sm2 = new SessionManager(store)
    const got = sm2.getOrCreateActive('test:hub:user-1')
    expect(chatroomState(got).chatroomModerator).toBe(true)
    expect(chatroomState(got).chatroomResearch).toBe(true)
    expect(chatroomState(got).chatroomResearchMode).toBe('manual')
    expect(chatroomState(got).chatroomResearchRound).toBe(2)
    expect(chatroomState(got).chatroomResearchMaxRounds).toBe(5)
    expect(chatroomState(got).chatroomGatherSeq).toBe(7)
    expect(chatroomState(got).researchVenv).toBe('/tmp/research/.venv')
  })

  it('in-memory-only fields drop on reload (barriers and in-flight flags)', async () => {
    // Mirrors the Go json:"-" reflection guard: PendingGather,
    // PendingEndBarrier, and ChatroomInFlight are process-local.
    const store = join(await mkdtemp(join(tmpdir(), 'fb-chatroom-session-')), 'sessions.json')
    const sm1 = new SessionManager(store)
    const role = sm1.getOrCreateActive('test:role-chat')
    chatroomState(role).chatroomHubKey = 'test:hub:user-1'
    chatroomState(role).chatroomInFlight = true
    const gather = new ChatroomGather('q', 1)
    chatroomState(role).pendingGather = gather
    const barrier = new ChatroomEndBarrier()
    barrier.expected.add('taleb')
    chatroomState(role).pendingEndBarrier = barrier
    sm1.save()

    const sm2 = new SessionManager(store)
    const got = sm2.getOrCreateActive('test:role-chat')
    expect(chatroomState(got).chatroomInFlight).toBe(false)
    expect(chatroomState(got).pendingGather).toBeUndefined()
    expect(chatroomState(got).pendingEndBarrier).toBeUndefined()
  })
})

describe('chat-scoped state survives a conversation reset', () => {
  it('newSession carries chatroom identity, lineage, and the provisioned assistant', () => {
    const sm = new SessionManager('')
    const role = sm.getOrCreateActive('test:role-chat')
    role.setParentSessionKey('test:hub:user-1')
    role.setParentChatName('重大决策')
    role.setSubtaskDepth(1)
    chatroomState(role).chatroomHubKey = 'test:hub:user-1'
    chatroomState(role).chatroomRoleName = 'marks'
    chatroomState(role).researchAssistantKey = 'test:assistant-1'
    chatroomState(role).researchVenv = '/ws/chatroom-research/.venv'
    // Conversation-scoped one-shot gates: the fresh record starts them over.
    chatroomState(role).chatroomAsked = true

    const fresh = sm.newSession('test:role-chat', 'fresh')

    expect(chatroomState(fresh).chatroomHubKey).toBe('test:hub:user-1')
    expect(chatroomState(fresh).chatroomRoleName).toBe('marks')
    expect(fresh.getParentSessionKey()).toBe('test:hub:user-1')
    expect(fresh.getParentChatName()).toBe('重大决策')
    expect(fresh.getSubtaskDepth()).toBe(1)
    expect(chatroomState(fresh).researchAssistantKey).toBe('test:assistant-1')
    expect(chatroomState(fresh).researchVenv).toBe('/ws/chatroom-research/.venv')
    // The relay gate re-arms on the fresh conversation.
    expect(chatroomState(fresh).chatroomAsked).toBe(false)
  })

  it('newSession carries hub orchestration flags and the armed gather barrier', () => {
    const sm = new SessionManager('')
    const hub = sm.getOrCreateActive('test:hub:user-1')
    chatroomState(hub).chatroomModerator = true
    chatroomState(hub).chatroomResearch = true
    chatroomState(hub).chatroomResearchMode = 'manual'
    chatroomState(hub).chatroomResearchRound = 2
    const g = new ChatroomGather('研究问题', 3)
    g.expected.add('taleb')
    chatroomState(hub).pendingGather = g

    const fresh = sm.newSession('test:hub:user-1', '')

    expect(chatroomState(fresh).chatroomModerator).toBe(true)
    expect(chatroomState(fresh).chatroomResearch).toBe(true)
    expect(chatroomState(fresh).chatroomResearchMode).toBe('manual')
    expect(chatroomState(fresh).chatroomResearchRound).toBe(2)
    // The in-flight round survives the reset — its replies still fan in.
    expect(chatroomState(fresh).pendingGather).toBe(g)

    const b = new ChatroomEndBarrier()
    chatroomState(fresh).pendingEndBarrier = b
    const fresh2 = sm.newSession('test:hub:user-1', '')
    expect(chatroomState(fresh2).pendingEndBarrier).toBe(b)
  })

  it('switchToAgentSession carries chat-scoped state onto its fresh record', () => {
    const sm = new SessionManager('')
    const role = sm.getOrCreateActive('test:role-chat')
    chatroomState(role).chatroomHubKey = 'test:hub:user-1'
    chatroomState(role).chatroomRoleName = 'munger'
    chatroomState(role).researchAssistantKey = 'test:assistant-2'

    const adopted = sm.switchToAgentSession('test:role-chat', 'cc-adopted-1', 'dsh', 'adopted')

    expect(chatroomState(adopted).chatroomHubKey).toBe('test:hub:user-1')
    expect(chatroomState(adopted).chatroomRoleName).toBe('munger')
    expect(chatroomState(adopted).researchAssistantKey).toBe('test:assistant-2')
  })
})
