/**
 * Chatroom end-barrier tests ported 1:1 from cc-connect
 * core/engine_chatroom_end_test.go.
 *
 * @module dsh-feishu-bridge/tests-engine-chatroom-end
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Engine, InteractiveState } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { ProjectStateStore } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { registerSessionCommands } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { registerChatroomCommands } from '../../src/engine/chatroom-cmd.ts'
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
  routePendingHumanReply,
  startChatroom,
} from '../../src/engine/chatroom.ts'
import { stashChatroomResearchFlags } from '../../src/engine/chatroom-cmd.ts'
import { createStubChatroomSpawner } from '../stubs/engine-stubs.ts'
import { createStubAgent } from '../stubs/engine-stubs.ts'
import type { Platform } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { chatroomState } from '../../src/chatroom-state.ts'
import { chatroomConfig } from '../../src/chatroom-config.ts'
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
    expect(chatroomConfig(e).endTimeoutDuration()).toBe(10 * 60 * 1000)
    chatroomConfig(e).applySection({ endTimeoutSec: Math.round(90_000 / 1000) })
    expect(chatroomConfig(e).endTimeoutDuration()).toBe(90_000)
  })
})

describe('EndChatroom', () => {
  it('tears down immediately when idle (no pointless barrier)', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    await startChatroom(e, hub, ['taleb', 'munger'], 'topic')
    const res = endChatroom(e, hub)
    expect(res.status).toBe('ended')
    expect(res.rolesRemoved).toBe(2)
    expect(chatroomState(e.sessions.getOrCreateActive(hub)).pendingEndBarrier).toBeUndefined()
    expect(listChatroomRoles(e, hub)).toHaveLength(0)
  })

  it('returns pending with a barrier when a role is in-flight', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb', 'munger'], 'topic')
    // Simulate "asked taleb, its turn is generating"; munger idle.
    const taleb = e.sessions.getOrCreateActive(roles[0]!.sessionKey)
    chatroomState(taleb).chatroomInFlight = true

    const res = endChatroom(e, hub)
    expect(res.status).toBe('pending')
    expect(res.inFlight).toEqual(['taleb'])
    const b = chatroomState(e.sessions.getOrCreateActive(hub)).pendingEndBarrier
    expect(b).toBeDefined()
    expect(b!.expected.has('taleb')).toBe(true)
    expect(listChatroomRoles(e, hub)).toHaveLength(2) // not yet cleaned up
    b!.clearFallbackTimer()
  })

  it('completes when the in-flight role relays (no silent drop)', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    const taleb = e.sessions.getOrCreateActive(roles[0]!.sessionKey)
    chatroomState(taleb).chatroomInFlight = true

    const res = endChatroom(e, hub)
    expect(res.status).toBe('pending')
    // taleb's turn ends → relay hits the end barrier → accumulate completes.
    const st = new InteractiveState()
    st.platform = p
    chatroomState(taleb).chatroomAsked = false // arm relay
    maybeAutoRelayRole(e, st, taleb, '我的末轮观点', false)

    await waitFor(() => listChatroomRoles(e, hub).length === 0, 'roles cleared')
    expect(chatroomState(e.sessions.getOrCreateActive(hub)).pendingEndBarrier).toBeUndefined()
  })

  it('the closing wake lands only after the final relay card', async () => {
    // Same ordering contract as the gather path: the role's last relay card
    // must be visible in the hub below the closing summary's placeholder —
    // a fire-and-forget relay lets the wake card bury it at the chat tail.
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    const taleb = e.sessions.getOrCreateActive(roles[0]!.sessionKey)
    chatroomState(taleb).chatroomInFlight = true

    const order: string[] = []
    vi.spyOn(e, 'sendAsCard').mockImplementation(async () => {
      // A slow relay-card send: a wake that does not await it provably lands first.
      await new Promise((resolve) => { setTimeout(resolve, 30) })
      order.push('relay-card')
    })
    vi.spyOn(e, 'deliverMachineMessage').mockImplementation(() => { order.push('wake') })

    const res = endChatroom(e, hub)
    expect(res.status).toBe('pending')
    const st = new InteractiveState()
    st.platform = p
    chatroomState(taleb).chatroomAsked = false
    maybeAutoRelayRole(e, st, taleb, '我的末轮观点', false)

    await waitFor(() => order.includes('wake') && order.includes('relay-card'), 'relay card and wake both landed')
    expect(order.lastIndexOf('relay-card'), 'relay card landed before the wake').toBeLessThan(order.lastIndexOf('wake'))
    await waitFor(() => listChatroomRoles(e, hub).length === 0, 'roles cleared')
  })

  it('finalizes on drain timeout when a role never relays', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    const taleb = e.sessions.getOrCreateActive(roles[0]!.sessionKey)
    chatroomState(taleb).chatroomInFlight = true
    chatroomConfig(e).applySection({ endTimeoutSec: 50 / 1000 })

    const res = endChatroom(e, hub)
    expect(res.status).toBe('pending')
    await waitFor(() => listChatroomRoles(e, hub).length === 0, 'roles cleared on timeout')
    expect(chatroomState(e.sessions.getOrCreateActive(hub)).pendingEndBarrier).toBeUndefined()
  })

  it('rejects ask/gather while ending', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    // Manually arm an end barrier (simulates end pending).
    chatroomState(e.sessions.getOrCreateActive(hub)).pendingEndBarrier = newEndBarrier()
    await expect(askRole(e, hub, roles[0]!.sessionKey, '问题')).rejects.toThrow()
    expect(() => { gatherRoles(e, hub, '问题', false) }).toThrow()
  })

  it('rejects end while a gather is in flight', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    await startChatroom(e, hub, ['taleb'], 'topic')
    const g = new ChatroomGather('q', 1)
    g.expected.add('taleb')
    chatroomState(e.sessions.getOrCreateActive(hub)).pendingGather = g
    expect(() => endChatroom(e, hub)).toThrow()
    g.stopTimer()
  })

  it('clears the in-flight flag at turn end (relay then flag)', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    const roles = await startChatroom(e, hub, ['taleb'], 'topic')
    const taleb = e.sessions.getOrCreateActive(roles[0]!.sessionKey)
    chatroomState(taleb).chatroomInFlight = true
    chatroomState(taleb).chatroomAsked = false // arm relay (serial path)

    const st = new InteractiveState()
    st.platform = p
    maybeAutoRelayRole(e, st, taleb, '回复', false)
    await settle()
    expect(chatroomState(taleb).chatroomInFlight).toBe(false)
  })
})

describe('finalizeChatroomEnd', () => {
  it('cleans research descendants but preserves hub-direct children', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    const hub = 'test:hub:user-1'
    const roleKey = 'test:role-1:user-1'
    const assistantKey = 'test:assistant-1'
    const fetcherKey = 'test:fetcher-1' // assistant's recursive child (grandchild of hub)
    const fetcher2Key = 'test:fetcher-2' // deeper still (child of a fetcher)
    const hubChildKey = 'test:hub-child:user-1' // hub's direct /spawn child (HTML render)
    const htmlHelperKey = 'test:html-helper-1' // child of the preserved HTML renderer
    const stewardKey = 'test:steward-1' // hub's pre-spawned research steward

    // Hub (moderator), pointing at its steward.
    const hubSess = e.sessions.getOrCreateActive(hub)
    chatroomState(hubSess).chatroomModerator = true
    chatroomState(hubSess).researchAssistantKey = stewardKey
    // Role (child of hub).
    const role = e.sessions.getOrCreateActive(roleKey)
    chatroomState(role).chatroomHubKey = hub
    role.setParentSessionKey(hub)
    chatroomState(role).researchAssistantKey = assistantKey
    // Pre-spawned research assistant (child of role; NOT a chatroom role).
    const assistant = e.sessions.getOrCreateActive(assistantKey)
    assistant.setParentSessionKey(roleKey)
    assistant.setSubtaskDepth(1)
    // Recursive fetcher spawned by the assistant (grandchild of the hub) — cleaned with the room.
    const fetcher = e.sessions.getOrCreateActive(fetcherKey)
    fetcher.setParentSessionKey(assistantKey)
    fetcher.setSubtaskDepth(2)
    // Deeper recursive child (child of a fetcher) — cleaned with the room.
    const fetcher2 = e.sessions.getOrCreateActive(fetcher2Key)
    fetcher2.setParentSessionKey(fetcherKey)
    fetcher2.setSubtaskDepth(3)
    // Hub's direct /spawn child — must be preserved, with its own subtree.
    const hubChild = e.sessions.getOrCreateActive(hubChildKey)
    hubChild.setParentSessionKey(hub)
    hubChild.setSubtaskDepth(1)
    const htmlHelper = e.sessions.getOrCreateActive(htmlHelperKey)
    htmlHelper.setParentSessionKey(hubChildKey)
    htmlHelper.setSubtaskDepth(2)
    // Hub's pre-spawned research steward (direct child, research-flagged) — cleaned with the room.
    const steward = e.sessions.getOrCreateActive(stewardKey)
    steward.setParentSessionKey(hub)
    steward.setSubtaskDepth(1)
    chatroomState(steward).researchAssistant = true

    const removed = finalizeChatroomEnd(e, hub)

    // Role + assistant + both fetchers + steward cleaned (5); the hub-direct
    // child and its subtree preserved.
    expect(removed).toHaveLength(5)
    expect(chatroomState(role).researchAssistantKey).toBe('')
    // The hub's steward pointer dies with the room.
    expect(chatroomState(hubSess).researchAssistantKey).toBe('')
  })

  it('clears dirty hub research flags', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    const hub = 'test:hub:user-1'
    const h = e.sessions.getOrCreateActive(hub)
    chatroomState(h).chatroomModerator = true
    chatroomState(h).chatroomResearch = true
    chatroomState(h).chatroomResearchMode = 'manual'
    chatroomState(h).researchAssistantKey = 'test:steward-1'

    finalizeChatroomEnd(e, hub)

    expect(chatroomState(h).chatroomResearch).toBe(false)
    expect(chatroomState(h).chatroomResearchMode).toBe('')
    expect(chatroomState(h).researchAssistantKey).toBe('')
  })
})

describe('stashChatroomResearchFlags', () => {
  it('scrubs stale flags when the new chatroom is not research', () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    const hub = 'test:hub:user-1'
    const h = e.sessions.getOrCreateActive(hub)
    chatroomState(h).chatroomResearch = true
    chatroomState(h).chatroomResearchMode = 'auto'
    chatroomState(h).researchAssistantKey = 'test:steward-1'

    stashChatroomResearchFlags(e, hub, false, '')

    expect(chatroomState(h).chatroomResearch).toBe(false)
    expect(chatroomState(h).chatroomResearchMode).toBe('')
    expect(chatroomState(h).researchAssistantKey).toBe('')
  })
})

describe('research workspace fallback', () => {
  it('falls back to the project data dir beside the session store, honors config, empty when neither', async () => {
    const store = join(await mkdtemp(join(tmpdir(), 'fb-ws-')), 'sessions.json')
    const p = createStubChatroomSpawner()
    const e = new Engine('test', createStubAgent(), [p], store, 'zh')

    // The default keeps the workspace off every chatroom persona's
    // cwd-ancestor chain (the old <moderatorDir>/research put the moderator
    // contract on that chain).
    chatroomConfig(e).applySection({ moderatorDir: '/data/chatroom' })
    chatroomConfig(e).applySection({ researchWorkspace: '' })
    expect(chatroomResearchWorkspace(e)).toBe(join(dirname(store), 'chatroom-research'))

    chatroomConfig(e).applySection({ researchWorkspace: '/shared/research-env' })
    expect(chatroomResearchWorkspace(e)).toBe('/shared/research-env')

    // A storeless engine (tests) has no project data dir to derive.
    const bare = newChatroomTestEngine(p)
    chatroomConfig(bare).applySection({ moderatorDir: '/data/chatroom' })
    chatroomConfig(bare).applySection({ researchWorkspace: '' })
    expect(chatroomResearchWorkspace(bare)).toBe('')
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

describe('AskHuman pending-flag lifecycle', () => {
  it('finalizeChatroomEnd clears a stale pending ask-human flag', async () => {
    // A role asked the human, the user never replied, and the chatroom
    // ends: the durable flag must not survive the teardown — a surviving
    // flag routes the hub's next normal message into a dead askRole.
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldTwoRoles() })
    const hub = 'test:hub:user-1'
    await startChatroom(e, hub, ['taleb'], 'topic')
    const hubSess = e.sessions.getOrCreateActive(hub)
    chatroomState(hubSess).pendingHumanQuestionRole = 'taleb'

    finalizeChatroomEnd(e, hub)

    expect(chatroomState(hubSess).pendingHumanQuestionRole).toBe('')
  })

  it('a stale ask-human flag falls through instead of swallowing the message', async () => {
    // Old state on disk (flag set, role session already gone): the router
    // must hand the message back to the normal agent path (false), not
    // consume it into an askRole that can only warn and drop it.
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    const hub = 'test:hub:user-1'
    const hubSess = e.sessions.getOrCreateActive(hub)
    chatroomState(hubSess).pendingHumanQuestionRole = 'ghost'

    expect(routePendingHumanReply(e, p, hub, '我的意思是……')).toBe(false)
    expect(chatroomState(hubSess).pendingHumanQuestionRole).toBe('')
  })
})
