/**
 * Chatroom end-barrier tests ported 1:1 from cc-connect
 * core/engine_chatroom_end_test.go.
 *
 * @module dsh-feishu-bridge/tests-engine-chatroom-end
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.js'
import { ProjectStateStore } from '../../src/engine/project-state.js'
import { registerSessionCommands } from '../../src/engine/commands.js'
import { registerChatroomCommands } from '../../src/engine/chatroom-cmd.js'
import {
  ChatroomEndBarrier,
  ChatroomGather,
  chatroomAssistantGroupName,
  chatroomResearchWorkspace,
  endChatroom,
  finalizeChatroomEnd,
  gatherRoles,
  listChatroomRoles,
  maybeAutoRelayRole,
  askRole,
  startChatroom,
} from '../../src/engine/chatroom.js'
import { stashChatroomResearchFlags } from '../../src/engine/chatroom-cmd.js'
import { createStubChatroomSpawner } from '../stubs/engine-stubs.js'
import { createStubAgent } from '../stubs/engine-stubs.js'
import type { Platform } from '../../src/core/types.js'

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

function newChatroomTestEngine(p: Platform): Engine {
  const e = new Engine('test', createStubAgent(), [p], '', 'zh')
  e.setProjectStateStore(new ProjectStateStore(''))
  registerSessionCommands(e)
  registerChatroomCommands(e)
  return e
}

async function scaffoldTwoRoles(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fb-end-roles-'))
  for (const n of ['taleb', 'munger']) {
    await mkdir(join(root, n), { recursive: true })
    await writeFile(join(root, n, 'CLAUDE.md'), `# ${n}\n`, 'utf8')
  }
  return root
}

/** A barrier expecting the given roles with NO timer (Go newEndBarrier). */
function newEndBarrier(roleNames: string[] = []): ChatroomEndBarrier {
  const b = new ChatroomEndBarrier()
  for (const n of roleNames) b.expected.add(n)
  return b
}

describe('ChatroomEndBarrier accumulate', () => {
  it('completes only on the last reply', () => {
    const b = newEndBarrier(['taleb', 'munger'])
    expect(b.accumulate('taleb', '观点A').done).toBe(false)
    const { done, summary } = b.accumulate('munger', '观点B')
    expect(done).toBe(true)
    expect(summary).toContain('收尾完成')
    expect(summary).toContain('【taleb】观点A')
    expect(summary).toContain('【munger】观点B')
  })

  it('wakes exactly once (one-shot)', () => {
    const b = newEndBarrier(['a', 'b'])
    b.accumulate('a', '1')
    expect(b.accumulate('b', '2').done).toBe(true)
    expect(b.accumulate('a', 'late').done).toBe(false)
  })

  it('trims a long reply to 200 runes with an ellipsis', () => {
    const long = '字'.repeat(250)
    const { summary } = newEndBarrier(['a']).accumulate('a', long)
    expect(summary).toContain('…')
  })
})

describe('ChatroomEndBarrier timeoutFire', () => {
  it('reports genuinely in-flight roles as timed out', () => {
    const b = newEndBarrier(['a', 'b', 'c'])
    b.accumulate('a', '1') // b, c still outstanding
    const { done, summary } = b.timeoutFire()
    expect(done).toBe(true)
    expect(summary).toContain('超时未回复')
    expect(summary).toContain('b')
    expect(summary).toContain('c')
  })

  it('does not report reconciled roles', () => {
    // taleb relayed via the normal path (reconcile forgot it); munger still
    // genuinely in-flight.
    const b = newEndBarrier(['taleb', 'munger'])
    b.forgetExpected('taleb')
    const { summary } = b.timeoutFire()
    expect(summary).toContain('munger')
    expect(summary).not.toContain('taleb')
  })

  it('is a no-op after completion', () => {
    const b = newEndBarrier(['a', 'b'])
    b.accumulate('a', '1')
    b.accumulate('b', '2')
    expect(b.timeoutFire().done).toBe(false)
  })
})

describe('chatroom end timeout duration', () => {
  it('defaults to half the gather timeout (10m); overridable', () => {
    const e = new Engine('test', createStubAgent(), [], '', 'zh')
    expect(e.chatroomEndTimeoutDuration()).toBe(10 * 60 * 1000)
    e.setChatroomEndTimeout(90_000)
    expect(e.chatroomEndTimeoutDuration()).toBe(90_000)
  })
})

describe('EndChatroom', () => {
  it('tears down immediately when idle (no pointless barrier)', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    e.setChatroomRolesDir(await scaffoldTwoRoles())
    const hub = 'test:hub:user-1'
    await startChatroom(e, hub, ['taleb', 'munger'], 'topic')
    const res = endChatroom(e, hub)
    expect(res.status).toBe('ended')
    expect(res.rolesRemoved).toBe(2)
    expect(e.sessions.getOrCreateActive(hub).getPendingEndBarrier()).toBeUndefined()
    expect(listChatroomRoles(e, hub)).toHaveLength(0)
  })

  it('returns pending with a barrier when a role is in-flight', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    e.setChatroomRolesDir(await scaffoldTwoRoles())
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb', 'munger'], 'topic')
    // Simulate "asked taleb, its turn is generating"; munger idle.
    const taleb = e.sessions.getOrCreateActive(roles[0]!.sessionKey)
    taleb.setChatroomInFlight(true)

    const res = endChatroom(e, hub)
    expect(res.status).toBe('pending')
    expect(res.inFlight).toEqual(['taleb'])
    const b = e.sessions.getOrCreateActive(hub).getPendingEndBarrier()
    expect(b).toBeDefined()
    expect(b!.expected.has('taleb')).toBe(true)
    expect(listChatroomRoles(e, hub)).toHaveLength(2) // not yet cleaned up
    b!.clearFallbackTimer()
  })

  it('completes when the in-flight role relays (no silent drop)', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    e.setChatroomRolesDir(await scaffoldTwoRoles())
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    const taleb = e.sessions.getOrCreateActive(roles[0]!.sessionKey)
    taleb.setChatroomInFlight(true)

    const res = endChatroom(e, hub)
    expect(res.status).toBe('pending')
    // taleb's turn ends → relay hits the end barrier → accumulate completes.
    const st = new InteractiveState()
    st.platform = p
    taleb.setChatroomAsked(false) // arm relay
    maybeAutoRelayRole(e, st, taleb, '我的末轮观点', false)

    await waitFor(() => listChatroomRoles(e, hub).length === 0, 'roles cleared')
    expect(e.sessions.getOrCreateActive(hub).getPendingEndBarrier()).toBeUndefined()
  })

  it('finalizes on drain timeout when a role never relays', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    e.setChatroomRolesDir(await scaffoldTwoRoles())
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    const taleb = e.sessions.getOrCreateActive(roles[0]!.sessionKey)
    taleb.setChatroomInFlight(true)
    e.setChatroomEndTimeout(50)

    const res = endChatroom(e, hub)
    expect(res.status).toBe('pending')
    await waitFor(() => listChatroomRoles(e, hub).length === 0, 'roles cleared on timeout')
    expect(e.sessions.getOrCreateActive(hub).getPendingEndBarrier()).toBeUndefined()
  })

  it('rejects ask/gather while ending', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    e.setChatroomRolesDir(await scaffoldTwoRoles())
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    // Manually arm an end barrier (simulates end pending).
    e.sessions.getOrCreateActive(hub).setPendingEndBarrier(newEndBarrier())
    await expect(askRole(e, hub, roles[0]!.sessionKey, '问题')).rejects.toThrow()
    expect(() => { gatherRoles(e, hub, '问题', false) }).toThrow()
  })

  it('rejects end while a gather is in flight', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    e.setChatroomRolesDir(await scaffoldTwoRoles())
    const hub = 'test:hub:user-1'
    await startChatroom(e, hub, ['taleb'], 'topic')
    const g = new ChatroomGather('q', 1)
    g.expected.add('taleb')
    e.sessions.getOrCreateActive(hub).setPendingGather(g)
    expect(() => endChatroom(e, hub)).toThrow()
    g.stopTimer()
  })

  it('clears the in-flight flag at turn end (relay then flag)', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    e.setChatroomRolesDir(await scaffoldTwoRoles())
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    const taleb = e.sessions.getOrCreateActive(roles[0]!.sessionKey)
    taleb.setChatroomInFlight(true)
    taleb.setChatroomAsked(false) // arm relay (serial path)

    const st = new InteractiveState()
    st.platform = p
    maybeAutoRelayRole(e, st, taleb, '回复', false)
    await settle()
    expect(taleb.getChatroomInFlight()).toBe(false)
  })
})

describe('finalizeChatroomEnd', () => {
  it('cleans research assistants but preserves hub-direct children', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    const hub = 'test:hub:user-1'
    const roleKey = 'test:role-1:user-1'
    const assistantKey = 'test:assistant-1'
    const hubChildKey = 'test:hub-child:user-1' // hub's direct /spawn child (HTML render)

    // Hub (moderator).
    e.sessions.getOrCreateActive(hub).setChatroomModerator(true)
    // Role (child of hub).
    const role = e.sessions.getOrCreateActive(roleKey)
    role.setChatroomHubKey(hub)
    role.setParentSessionKey(hub)
    role.setResearchAssistantKey(assistantKey)
    // Pre-spawned research assistant (child of role; NOT a chatroom role).
    const assistant = e.sessions.getOrCreateActive(assistantKey)
    assistant.setParentSessionKey(roleKey)
    assistant.setSubtaskDepth(1)
    // Hub's direct /spawn child — must be preserved.
    const hubChild = e.sessions.getOrCreateActive(hubChildKey)
    hubChild.setParentSessionKey(hub)
    hubChild.setSubtaskDepth(1)

    const removed = finalizeChatroomEnd(e, hub)

    // Role + research assistant cleaned (2); hub-direct child preserved.
    expect(removed).toBe(2)
    expect(role.getResearchAssistantKey()).toBe('')
  })

  it('clears dirty hub research flags', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    const hub = 'test:hub:user-1'
    const h = e.sessions.getOrCreateActive(hub)
    h.setChatroomModerator(true)
    h.setChatroomResearch(true)
    h.setChatroomResearchMode('manual')
    h.setChatroomResearchRound(3)
    h.setChatroomResearchMaxRounds(3)

    finalizeChatroomEnd(e, hub)

    expect(h.getChatroomResearch()).toBe(false)
    expect(h.getChatroomResearchMode()).toBe('')
    expect(h.getChatroomResearchRound()).toBe(0)
    expect(h.getChatroomResearchMaxRounds()).toBe(0)
  })
})

describe('stashChatroomResearchFlags', () => {
  it('scrubs stale flags when the new chatroom is not research', () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    const hub = 'test:hub:user-1'
    const h = e.sessions.getOrCreateActive(hub)
    h.setChatroomResearch(true)
    h.setChatroomResearchMode('auto')
    h.setChatroomResearchRound(2)
    h.setChatroomResearchMaxRounds(5)

    stashChatroomResearchFlags(e, hub, false, '', 0)

    expect(h.getChatroomResearch()).toBe(false)
    expect(h.getChatroomResearchMode()).toBe('')
    expect(h.getChatroomResearchRound()).toBe(0)
    expect(h.getChatroomResearchMaxRounds()).toBe(0)
  })
})

describe('research workspace fallback', () => {
  it('falls back to moderatorDir/research, honors config, empty when neither', () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)

    e.setChatroomModeratorDir('/data/chatroom')
    e.setChatroomResearchWorkspace('')
    expect(chatroomResearchWorkspace(e)).toBe(join('/data/chatroom', 'research'))

    e.setChatroomResearchWorkspace('/shared/research-env')
    expect(chatroomResearchWorkspace(e)).toBe('/shared/research-env')

    e.setChatroomModeratorDir('')
    e.setChatroomResearchWorkspace('')
    expect(chatroomResearchWorkspace(e)).toBe('')
  })
})

describe('chatroomAssistantGroupName', () => {
  it('prefixes with 聊天室·助手· and truncates overlong names', () => {
    expect(chatroomAssistantGroupName('taleb')).toBe('聊天室·助手·taleb')
    const long = '角'.repeat(70)
    const got = chatroomAssistantGroupName(long)
    expect(Array.from(got).length).toBeLessThanOrEqual(60)
    expect(got.startsWith('聊天室·助手·')).toBe(true)
  })
})
