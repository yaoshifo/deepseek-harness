/**
 * Feature-state codec registry behavior, plus the chatroom codec's
 * projection and reset-carry semantics: the codec owns the `chatroom`
 * section of Session.featureState (snapshot version 3).
 *
 * @module dsh-feishu-bridge/tests-engine-feature-state
 */

import { describe, expect, it } from 'vitest'
import { Session } from '../../src/engine/session.js'
import { ChatroomEndBarrier, ChatroomGather } from '../../src/engine/chatroom.js'
import {
  chatroomFeatureState,
  chatroomFeatureStateCodec,
} from '../../src/engine/chatroom-feature-state.js'
import {
  featureStateCodecs,
  registerFeatureStateCodec,
  type FeatureStateCodec,
} from '../../src/engine/feature-state.js'

const noopCodec = (key: string): FeatureStateCodec => ({
  key,
  encode: () => undefined,
  carry: () => {},
})

describe('feature-state codec registry', () => {
  it('registers, lists, and unregisters a codec', () => {
    const codec = noopCodec('spec-probe')
    const dispose = registerFeatureStateCodec(codec)
    expect(featureStateCodecs().some(registered => registered.key === 'spec-probe')).toBe(true)
    dispose()
    expect(featureStateCodecs().some(registered => registered.key === 'spec-probe')).toBe(false)
  })

  it('holds codecs for several keys side by side', () => {
    const disposeA = registerFeatureStateCodec(noopCodec('spec-a'))
    const disposeB = registerFeatureStateCodec(noopCodec('spec-b'))
    expect(featureStateCodecs().map(codec => codec.key)).toEqual(['spec-a', 'spec-b'])
    disposeA()
    expect(featureStateCodecs().map(codec => codec.key)).toEqual(['spec-b'])
    disposeB()
    expect(featureStateCodecs()).toHaveLength(0)
  })

  it('rejects a duplicate key', () => {
    const dispose = registerFeatureStateCodec(noopCodec('spec-dup'))
    expect(() => registerFeatureStateCodec(noopCodec('spec-dup'))).toThrow(/already registered/)
    dispose()
  })

  it('reference-counts re-registrations of the same codec object (HMR reload, multi-app mounts)', () => {
    const codec = noopCodec('spec-shared')
    const disposeOne = registerFeatureStateCodec(codec)
    const disposeTwo = registerFeatureStateCodec(codec)
    expect(featureStateCodecs().filter(registered => registered.key === 'spec-shared')).toHaveLength(1)
    disposeOne()
    expect(featureStateCodecs().some(registered => registered.key === 'spec-shared')).toBe(true)
    disposeTwo()
    expect(featureStateCodecs().some(registered => registered.key === 'spec-shared')).toBe(false)
  })

  it('tolerates a double dispose', () => {
    const dispose = registerFeatureStateCodec(noopCodec('spec-twice'))
    dispose()
    dispose()
    expect(featureStateCodecs().some(registered => registered.key === 'spec-twice')).toBe(false)
  })
})

describe('chatroom feature-state codec', () => {
  it('creates the section on first access and replaces a non-object one', () => {
    const s = new Session()
    expect(s.featureState.chatroom).toBeUndefined()
    chatroomFeatureState(s).chatroomHubKey = 'test:hub:user-1'
    expect(s.featureState.chatroom).toEqual({ chatroomHubKey: 'test:hub:user-1' })

    // A hand-corrupted file can put a non-object under the key: reads and
    // writes through the section must not throw.
    s.featureState.chatroom = 42
    expect(chatroomFeatureState(s)).toEqual({})
    s.featureState.chatroom = null
    expect(chatroomFeatureState(s).chatroomHubKey).toBeUndefined()
  })

  it('projects every durable field and the armed barrier snapshots, omitting defaults', () => {
    const s = new Session()
    // All defaults: nothing to persist under the key.
    expect(chatroomFeatureStateCodec.encode(s)).toBeUndefined()

    s.chatroomHubKey = 'test:hub:user-1'
    s.chatroomRoleName = 'munger'
    s.chatroomAsked = true
    s.chatroomResearch = true
    s.chatroomDirectRole = true
    s.researchAssistantKey = 'test:assistant-1'
    s.researchAssistant = true
    s.researchAwaitingAssistant = true
    s.chatroomModerator = true
    s.chatroomResearchMode = 'manual'
    s.chatroomResearchRound = 2
    s.chatroomResearchMaxRounds = 5
    s.chatroomGatherSeq = 7
    s.researchVenv = '/ws/.venv'
    s.pendingHumanQuestionRole = 'taleb'
    const gather = new ChatroomGather('研究问题', 3)
    gather.expected.add('taleb')
    s.pendingGather = gather
    const barrier = new ChatroomEndBarrier()
    barrier.expected.add('taleb')
    s.pendingEndBarrier = barrier

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
      chatroomResearchRound: 2,
      chatroomResearchMaxRounds: 5,
      chatroomGatherSeq: 7,
      researchVenv: '/ws/.venv',
      pendingHumanQuestionRole: 'taleb',
      pendingGatherData: { question: '研究问题', seq: 3, expected: ['taleb'], collected: {} },
      pendingEndBarrierData: { expected: ['taleb'], collected: {} },
    })

    // A woken barrier carries no snapshot.
    gather.timeoutFire()
    s.pendingEndBarrier = undefined
    expect(chatroomFeatureStateCodec.encode(s)).not.toHaveProperty('pendingGatherData')
    expect(chatroomFeatureStateCodec.encode(s)).not.toHaveProperty('pendingEndBarrierData')
  })

  it('carries the survive-reset subset across a conversation reset', () => {
    const from = new Session()
    from.chatroomHubKey = 'test:hub:user-1'
    from.chatroomRoleName = 'munger'
    from.chatroomModerator = true
    from.chatroomDirectRole = true
    from.chatroomResearch = true
    from.chatroomResearchMode = 'manual'
    from.chatroomResearchRound = 2
    from.chatroomResearchMaxRounds = 5
    from.chatroomGatherSeq = 7
    from.researchAssistantKey = 'test:assistant-1'
    from.researchAssistant = true
    from.researchVenv = '/ws/.venv'
    from.pendingHumanQuestionRole = 'taleb'
    from.chatroomAsked = true
    from.researchAwaitingAssistant = true
    const gather = new ChatroomGather('研究问题', 3)
    from.pendingGather = gather
    const barrier = new ChatroomEndBarrier()
    from.pendingEndBarrier = barrier

    const to = new Session()
    chatroomFeatureStateCodec.carry(from, to)

    expect(to.chatroomHubKey).toBe('test:hub:user-1')
    expect(to.chatroomRoleName).toBe('munger')
    expect(to.chatroomModerator).toBe(true)
    expect(to.chatroomDirectRole).toBe(true)
    expect(to.chatroomResearch).toBe(true)
    expect(to.chatroomResearchMode).toBe('manual')
    expect(to.chatroomResearchRound).toBe(2)
    expect(to.chatroomResearchMaxRounds).toBe(5)
    expect(to.chatroomGatherSeq).toBe(7)
    expect(to.researchAssistantKey).toBe('test:assistant-1')
    expect(to.researchAssistant).toBe(true)
    expect(to.researchVenv).toBe('/ws/.venv')
    expect(to.pendingHumanQuestionRole).toBe('taleb')
    // Armed barriers move by reference: the in-flight round keeps fanning in.
    expect(to.pendingGather).toBe(gather)
    expect(to.pendingEndBarrier).toBe(barrier)
    // Conversation-scoped gates reset with the conversation.
    expect(to.chatroomAsked).toBe(false)
    expect(to.researchAwaitingAssistant).toBe(false)
  })
})
