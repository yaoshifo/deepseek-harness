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
import { describe, expect, it } from 'vitest'
import { SessionManager } from '../../src/engine/session.js'

describe('chatroom session fields persist', () => {
  it('chatroom hub/role/asked round-trip through save/load', async () => {
    const store = join(await mkdtemp(join(tmpdir(), 'fb-chatroom-session-')), 'sessions.json')

    const sm1 = new SessionManager(store)
    const role = sm1.getOrCreateActive('test:role-chat')
    role.setParentSessionKey('test:hub:user-1')
    role.setChatroomHubKey('test:hub:user-1')
    role.setChatroomRoleName('Taleb')
    role.setChatroomAsked(false)
    sm1.save()

    const sm2 = new SessionManager(store)
    const got = sm2.getOrCreateActive('test:role-chat')
    expect(got.getChatroomHubKey()).toBe('test:hub:user-1')
    expect(got.getChatroomRoleName()).toBe('Taleb')

    // Flip the bool, save, reload — proves chatroomAsked is in the snapshot
    // (a bool zero-value would mask a missing field on the first reload).
    got.setChatroomAsked(true)
    sm2.save()
    const sm3 = new SessionManager(store)
    expect(sm3.getOrCreateActive('test:role-chat').getChatroomAsked()).toBe(true)

    // ChatroomDirectRole (Feature 2) round-trips the same way.
    const direct = sm1.getOrCreateActive('test:direct:user-1')
    direct.setChatroomDirectRole(true)
    sm1.save()
    const smDir = new SessionManager(store)
    expect(smDir.getOrCreateActive('test:direct:user-1').getChatroomDirectRole()).toBe(true)

    // PendingHumanQuestionRole lives on the HUB session; prove it round-trips.
    const hub = sm1.getOrCreateActive('test:hub:user-1')
    hub.setPendingHumanQuestionRole('Munger')
    sm1.save()

    const sm4 = new SessionManager(store)
    expect(sm4.getOrCreateActive('test:hub:user-1').getPendingHumanQuestionRole()).toBe('Munger')
  })

  it('moderator/research-mode/round/gather-seq/venv round-trip through save/load', async () => {
    const store = join(await mkdtemp(join(tmpdir(), 'fb-chatroom-session-')), 'sessions.json')
    const sm1 = new SessionManager(store)
    const hub = sm1.getOrCreateActive('test:hub:user-1')
    hub.setChatroomModerator(true)
    hub.setChatroomResearch(true)
    hub.setChatroomResearchMode('manual')
    hub.setChatroomResearchRound(2)
    hub.setChatroomResearchMaxRounds(5)
    hub.setChatroomGatherSeq(7)
    hub.setResearchVenv('/tmp/research/.venv')
    sm1.save()

    const sm2 = new SessionManager(store)
    const got = sm2.getOrCreateActive('test:hub:user-1')
    expect(got.getChatroomModerator()).toBe(true)
    expect(got.getChatroomResearch()).toBe(true)
    expect(got.getChatroomResearchMode()).toBe('manual')
    expect(got.getChatroomResearchRound()).toBe(2)
    expect(got.getChatroomResearchMaxRounds()).toBe(5)
    expect(got.getChatroomGatherSeq()).toBe(7)
    expect(got.getResearchVenv()).toBe('/tmp/research/.venv')
  })

  it('in-memory-only fields drop on reload (barriers and in-flight flags)', async () => {
    // Mirrors the Go json:"-" reflection guard: PendingGather,
    // PendingEndBarrier, and ChatroomInFlight are process-local.
    const store = join(await mkdtemp(join(tmpdir(), 'fb-chatroom-session-')), 'sessions.json')
    const sm1 = new SessionManager(store)
    const role = sm1.getOrCreateActive('test:role-chat')
    role.setChatroomHubKey('test:hub:user-1')
    role.setChatroomInFlight(true)
    role.setPendingGather({ seq: 1, question: 'q', expected: new Set(), collected: new Map() })
    role.setPendingEndBarrier({ expected: new Set(['taleb']), collected: new Map() })
    sm1.save()

    const sm2 = new SessionManager(store)
    const got = sm2.getOrCreateActive('test:role-chat')
    expect(got.getChatroomInFlight()).toBe(false)
    expect(got.getPendingGather()).toBeUndefined()
    expect(got.getPendingEndBarrier()).toBeUndefined()
  })
})
