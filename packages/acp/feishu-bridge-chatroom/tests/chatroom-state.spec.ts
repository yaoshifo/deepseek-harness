/**
 * The chatroom feature-state codec: projection of every durable field and
 * the armed barrier snapshots into the `chatroom` section of
 * Session.featureState (snapshot version 3), and the survive-reset carry
 * subset. Moved with the chatroom from the bridge's feature-state spec.
 *
 * @module dsh-feishu-bridge-chatroom/tests-chatroom-state
 */

import { describe, expect, it } from 'vitest'
import { Session } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { ChatroomEndBarrier, ChatroomGather } from '../src/engine/chatroom.ts'
import { chatroomFeatureStateCodec, chatroomState } from '../src/chatroom-state.ts'

describe('chatroom feature-state codec', () => {
  it('writes the section through the live state and replaces a non-object one', () => {
    const s = new Session()
    expect(s.featureState.chatroom).toBeUndefined()
    chatroomState(s).chatroomHubKey = 'test:hub:user-1'
    expect(s.featureState.chatroom).toEqual({ chatroomHubKey: 'test:hub:user-1' })

    // A hand-corrupted file can put a non-object under the key: reads and
    // writes through the live state must not throw, and the corrupt value is
    // replaced on the next materialization (a fresh state reads defaults).
    s.featureState.chatroom = 42
    const fresh = new Session()
    fresh.featureState.chatroom = 42
    expect(chatroomState(fresh).chatroomHubKey).toBe('')
    fresh.featureState.chatroom = null
    expect(chatroomState(fresh).chatroomHubKey).toBe('')
  })

  it('projects every durable field and the armed barrier snapshots, omitting defaults', () => {
    const s = new Session()
    // All defaults: nothing to persist under the key.
    expect(chatroomFeatureStateCodec.encode(s)).toBeUndefined()

    chatroomState(s).chatroomHubKey = 'test:hub:user-1'
    chatroomState(s).chatroomRoleName = 'munger'
    chatroomState(s).chatroomAsked = true
    chatroomState(s).chatroomResearch = true
    chatroomState(s).chatroomDirectRole = true
    chatroomState(s).researchAssistantKey = 'test:assistant-1'
    chatroomState(s).researchAssistant = true
    chatroomState(s).researchAwaitingAssistant = true
    chatroomState(s).chatroomModerator = true
    chatroomState(s).chatroomResearchMode = 'manual'
    chatroomState(s).chatroomGatherSeq = 7
    chatroomState(s).researchVenv = '/ws/.venv'
    chatroomState(s).researchRunDir = '/ws/runs/hub-1/munger'
    chatroomState(s).pendingHumanQuestionRole = 'taleb'
    const gather = new ChatroomGather('研究问题', 3)
    gather.expected.add('taleb')
    chatroomState(s).pendingGather = gather
    const barrier = new ChatroomEndBarrier()
    barrier.expected.add('taleb')
    chatroomState(s).pendingEndBarrier = barrier

    expect(chatroomFeatureStateCodec.encode(s)).toEqual({
      chatroomHubKey: 'test:hub:user-1',
      chatroomRoleName: 'munger',
      chatroomAsked: true,
      chatroomResearch: true,
      chatroomDirectRole: true,
      researchAssistantKey: 'test:assistant-1',
      researchAssistant: true,
      researchAwaitingAssistant: true,
      chatroomModerator: true,
      chatroomResearchMode: 'manual',
      chatroomGatherSeq: 7,
      researchVenv: '/ws/.venv',
      researchRunDir: '/ws/runs/hub-1/munger',
      pendingHumanQuestionRole: 'taleb',
      pendingGatherData: { question: '研究问题', seq: 3, expected: ['taleb'], collected: {} },
      pendingEndBarrierData: { expected: ['taleb'], collected: {} },
    })

    // A woken barrier carries no snapshot.
    gather.timeoutFire()
    chatroomState(s).pendingEndBarrier = undefined
    expect(chatroomFeatureStateCodec.encode(s)).not.toHaveProperty('pendingGatherData')
    expect(chatroomFeatureStateCodec.encode(s)).not.toHaveProperty('pendingEndBarrierData')
  })

  it('carries the survive-reset subset across a conversation reset', () => {
    const from = new Session()
    chatroomState(from).chatroomHubKey = 'test:hub:user-1'
    chatroomState(from).chatroomRoleName = 'munger'
    chatroomState(from).chatroomModerator = true
    chatroomState(from).chatroomDirectRole = true
    chatroomState(from).chatroomResearch = true
    chatroomState(from).chatroomResearchMode = 'manual'
    chatroomState(from).chatroomGatherSeq = 7
    chatroomState(from).researchAssistantKey = 'test:assistant-1'
    chatroomState(from).researchAssistant = true
    chatroomState(from).researchVenv = '/ws/.venv'
    chatroomState(from).pendingHumanQuestionRole = 'taleb'
    chatroomState(from).chatroomAsked = true
    chatroomState(from).researchAwaitingAssistant = true
    const gather = new ChatroomGather('研究问题', 3)
    chatroomState(from).pendingGather = gather
    const barrier = new ChatroomEndBarrier()
    chatroomState(from).pendingEndBarrier = barrier

    const to = new Session()
    chatroomFeatureStateCodec.carry(from, to)

    expect(chatroomState(to).chatroomHubKey).toBe('test:hub:user-1')
    expect(chatroomState(to).chatroomRoleName).toBe('munger')
    expect(chatroomState(to).chatroomModerator).toBe(true)
    expect(chatroomState(to).chatroomDirectRole).toBe(true)
    expect(chatroomState(to).chatroomResearch).toBe(true)
    expect(chatroomState(to).chatroomResearchMode).toBe('manual')
    expect(chatroomState(to).chatroomGatherSeq).toBe(7)
    expect(chatroomState(to).researchAssistantKey).toBe('test:assistant-1')
    expect(chatroomState(to).researchAssistant).toBe(true)
    expect(chatroomState(to).researchVenv).toBe('/ws/.venv')
    expect(chatroomState(to).pendingHumanQuestionRole).toBe('taleb')
    // Armed barriers move by reference: the in-flight round keeps fanning in.
    expect(chatroomState(to).pendingGather).toBe(gather)
    expect(chatroomState(to).pendingEndBarrier).toBe(barrier)
    // Conversation-scoped gates reset with the conversation.
    expect(chatroomState(to).chatroomAsked).toBe(false)
    expect(chatroomState(to).researchAwaitingAssistant).toBe(false)
  })
})
