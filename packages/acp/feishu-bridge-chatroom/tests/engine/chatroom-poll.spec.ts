/**
 * Chatroom poll (lightning-round) tests: the one-shot role-statement barrier
 * that lets every configured persona contribute a cheap single-turn reply
 * without spawning a resident agent per role.
 *
 * @module dsh-feishu-bridge/tests-engine-chatroom-poll
 */

import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Engine } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { ProjectStateStore } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { registerSessionCommands } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { chatroomPolicyFace } from '../stubs/bridge-policy.ts'
import { registerChatroomCommands } from '../../src/engine/chatroom-cmd.ts'
import { ChatroomPoll } from '../../src/engine/chatroom-poll.ts'
import { chatroomLedgerDir } from '../../src/engine/chatroom-ledger.ts'
import { pollRoles } from '../../src/engine/chatroom.ts'
import type { Platform } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { createStubAgent, createStubChatroomSpawner, newStubMessage } from '../stubs/engine-stubs.ts'
import { chatroomConfig } from '../../src/chatroom-config.ts'
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

/** A poll with NO timer (mirrors the gather spec's newGather). */
function newPoll(roleNames: string[], round: 'opening' | 'closing' = 'opening'): ChatroomPoll {
  const poll = new ChatroomPoll('快答', round)
  for (const n of roleNames) poll.expected.add(n)
  return poll
}

async function scaffoldThreeRoles(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fb-poll-roles-'))
  for (const n of ['munger', 'popper', 'taleb']) {
    await mkdir(join(root, n), { recursive: true })
    await writeFile(join(root, n, 'CLAUDE.md'), `# ${n}\n`, 'utf8')
  }
  return root
}

/** One recorded pollQuery call. */
interface PollCall {
  workDir: string
  prompt: string
  resolveWith: (text: string) => void
}

/** A stub agent whose pollQuery records calls and answers on demand. */
function createPollStubAgent(): { agent: ReturnType<typeof createStubAgent>; calls: PollCall[] } {
  const calls: PollCall[] = []
  const agent = createStubAgent()
  const querier = agent as unknown as Record<string, unknown>
  // The structural ForkQuerierWithProvider check requires all four members;
  // only pollQuery is exercised here.
  querier.lightweightQuery = () => Promise.reject(new Error('not implemented'))
  querier.forkQuery = () => Promise.reject(new Error('not implemented'))
  querier.forkSessionWithProvider = () => Promise.reject(new Error('not implemented'))
  querier.pollQuery = (prompt: string, workDir: string) =>
    new Promise<string>((resolve) => { calls.push({ workDir, prompt, resolveWith: resolve }) })
  return { agent, calls }
}

function newPollTestEngine(p: Platform, agent: ReturnType<typeof createStubAgent>): Engine {
  const e = new Engine('test', agent, [p], '', 'zh', chatroomPolicyFace())
  e.setProjectStateStore(new ProjectStateStore(''))
  registerSessionCommands(e)
  registerChatroomCommands(e)
  return e
}

describe('ChatroomPoll accumulate', () => {
  it('returns done only on the last statement with the tagged summary', () => {
    const poll = newPoll(['taleb', 'munger'])
    expect(poll.accumulate('taleb', '立场A｜盲点X｜想深聊').done).toBe(false)
    const { done, wakeContent } = poll.accumulate('munger', '立场B｜盲点Y｜表态即可')
    expect(done).toBe(true)
    expect(wakeContent).toContain('【taleb】立场A｜盲点X｜想深聊')
    expect(wakeContent).toContain('【munger】立场B｜盲点Y｜表态即可')
  })

  it('a failed one-shot query counts the role out without stalling the barrier', () => {
    const poll = newPoll(['taleb', 'munger'])
    expect(poll.fail('taleb').done).toBe(false)
    const { done, wakeContent } = poll.accumulate('munger', '立场B')
    expect(done).toBe(true)
    expect(wakeContent).toContain('【taleb】（快答失败）')
    expect(wakeContent).toContain('【munger】立场B')
  })
})

describe('ChatroomPoll timeoutFire', () => {
  it('degrades once with absent roles annotated, then is a no-op', () => {
    const poll = newPoll(['taleb', 'munger', 'popper'])
    poll.accumulate('taleb', '立场A')
    const { done, wake, missing } = poll.timeoutFire()
    expect(done).toBe(true)
    expect(missing).toEqual(['munger', 'popper'])
    expect(wake).toContain('【munger】（未表态）')
    expect(wake).toContain('【popper】（未表态）')
    expect(wake).toContain('【taleb】立场A')
    expect(poll.timeoutFire().done).toBe(false)
    expect(poll.accumulate('munger', '迟到').done).toBe(false)
  })
})

describe('pollRoles', () => {
  it('polls every non-spawned role with the persona dir and wakes the moderator on completion', async () => {
    const p = createStubChatroomSpawner()
    const { agent, calls } = createPollStubAgent()
    const e = newPollTestEngine(p, agent)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldThreeRoles() })
    const hub = 'test:hub:user-1'
    const { startChatroom } = await import('../../src/engine/chatroom.ts')
    await startChatroom(e, hub, ['taleb'], 'topic') // taleb is the spawned core cast
    const wake = vi.spyOn(e, 'deliverMachineMessage').mockImplementation(() => {})

    pollRoles(e, hub, '开场快答：一句话立场｜盲点｜参与意愿', 'opening')
    // Both remaining roles were polled in parallel under their persona dirs.
    await waitFor(() => calls.length >= 2, 'poll queries dispatched')
    const polledDirs = calls.map(c => c.workDir.split('/').pop())
    expect(polledDirs.sort()).toEqual(['munger', 'popper'])
    for (const c of calls) expect(c.prompt).toContain('开场快答')

    calls[0]!.resolveWith('【立场】分散｜【盲点】相关性｜【意愿】想深聊')
    calls[1]!.resolveWith('【立场】证伪｜【盲点】分界｜【意愿】表态即可')
    await waitFor(() => wake.mock.calls.length > 0, 'moderator wake')

    const wakeContent = wake.mock.calls[0]![1] as { content: string }
    expect(wakeContent.content).toContain('全员快答完成')
    expect(wakeContent.content).toContain('【munger】【立场】分散｜【盲点】相关性｜【意愿】想深聊')
    expect(wakeContent.content).toContain('【popper】【立场】证伪｜【盲点】分界｜【意愿】表态即可')
  })

  it('caps concurrent one-shot queries at pollMaxConcurrent and drains the queue as workers finish', async () => {
    const p = createStubChatroomSpawner()
    const { agent, calls } = createPollStubAgent()
    const e = newPollTestEngine(p, agent)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldThreeRoles(), pollMaxConcurrent: 1 })
    const hub = 'test:hub:user-1'
    const { startChatroom } = await import('../../src/engine/chatroom.ts')
    await startChatroom(e, hub, ['taleb'], 'topic')
    const wake = vi.spyOn(e, 'deliverMachineMessage').mockImplementation(() => {})

    pollRoles(e, hub, '开场快答', 'opening')
    await waitFor(() => calls.length >= 1, 'first query dispatched')
    await settle()
    expect(calls).toHaveLength(1) // cap 1: the second role waits for a worker

    calls[0]!.resolveWith('第一条')
    await waitFor(() => calls.length >= 2, 'second query after worker freed')
    calls[1]!.resolveWith('第二条')
    await waitFor(() => wake.mock.calls.length > 0, 'moderator wake')
    expect((wake.mock.calls[0]![1] as { content: string }).content).toContain('全员快答完成')
  })

  it('rejects a poll while a gather is in flight, and a repeat poll while one runs', async () => {
    const p = createStubChatroomSpawner()
    const { agent, calls } = createPollStubAgent()
    const e = newPollTestEngine(p, agent)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldThreeRoles() })
    const hub = 'test:hub:user-1'
    const { startChatroom, ChatroomGather } = await import('../../src/engine/chatroom.ts')
    await startChatroom(e, hub, ['taleb'], 'topic')
    const hubSess = e.sessions.getOrCreateActive(hub)

    const g = new ChatroomGather('并行问题', 1)
    g.expected.add('taleb')
    chatroomState(hubSess).pendingGather = g
    expect(() => { pollRoles(e, hub, '快答', 'opening') }).toThrow('并行收集进行中')

    chatroomState(hubSess).pendingGather = undefined
    pollRoles(e, hub, '快答', 'opening')
    await waitFor(() => calls.length >= 1, 'first poll query out')
    expect(() => { pollRoles(e, hub, '再来', 'opening') }).toThrow('快答仍在进行中')
  })

  it('degrades on the poll timeout: absent roles annotated, pending queries aborted', async () => {
    vi.useFakeTimers()
    try {
      const p = createStubChatroomSpawner()
      const { agent, calls } = createPollStubAgent()
      const e = newPollTestEngine(p, agent)
      chatroomConfig(e).applySection({ rolesDir: await scaffoldThreeRoles(), pollTimeoutSec: 1 })
      const hub = 'test:hub:user-1'
      const { startChatroom } = await import('../../src/engine/chatroom.ts')
      await startChatroom(e, hub, ['taleb'], 'topic')
      const wake = vi.spyOn(e, 'deliverMachineMessage').mockImplementation(() => {})
      let polled = 0
      const { calls: raw } = { calls }
      // Track aborts by wrapping the controller via the stub's signal receipt.
      const aborted: string[] = []
      const origPoll = (agent as unknown as Record<string, unknown>).pollQuery as (
        prompt: string, workDir: string, opts?: { signal?: AbortSignal },
      ) => Promise<string>
      ;(agent as unknown as Record<string, unknown>).pollQuery = (prompt: string, workDir: string, opts?: { signal?: AbortSignal }) => {
        const role = workDir.split('/').pop() ?? ''
        opts?.signal?.addEventListener('abort', () => { aborted.push(role) })
        return origPoll(prompt, workDir, opts)
      }

      pollRoles(e, hub, '快答', 'opening')
      polled = raw.length
      expect(polled).toBe(2)
      // Only one role answers before the timeout.
      calls[0]!.resolveWith('到场表态')
      await vi.advanceTimersByTimeAsync(1500)

      expect(wake.mock.calls.length).toBe(1)
      const wakeContent = wake.mock.calls[0]![1] as { content: string }
      expect(wakeContent.content).toContain('【munger】到场表态')
      expect(wakeContent.content).toContain('【popper】（未表态）')
      expect(aborted).toContain('popper') // the still-pending query was aborted
    } finally {
      vi.useRealTimers()
    }
  })

  it('the pick watchdog defers while a poll is in flight and re-arms after it settles', async () => {
    vi.useFakeTimers()
    try {
      const p = createStubChatroomSpawner()
      const { agent, calls } = createPollStubAgent()
      const e = newPollTestEngine(p, agent)
      chatroomConfig(e).applySection({ rolesDir: await scaffoldThreeRoles() })
      const hub = 'test:hub:user-1'
      const { startChatroom } = await import('../../src/engine/chatroom.ts')
      await startChatroom(e, hub, ['taleb'], 'topic')
      vi.spyOn(e, 'receiveMessage').mockImplementation(() => {})
      const { beginChatroomPick } = await import('../../src/engine/chatroom-pick.ts')
      const msg = { ...newStubMessage(), sessionKey: hub, platform: p.name() }
      beginChatroomPick(e, p, msg, '定投频率')

      // The moderator's first act per the priming is the opening poll; the
      // wake is mocked away, so simulate that call directly.
      vi.spyOn(e, 'deliverMachineMessage').mockImplementation(() => {})
      pollRoles(e, hub, '开场快答', 'opening')
      await waitFor(() => calls.length >= 2, 'opening poll dispatched')
      // The 5-minute pick watchdog fires mid-poll: no fallback card.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100)
      const { getChatroomPickState } = await import('../../src/engine/chatroom-pick.ts')
      expect(getChatroomPickState(e, hub)?.phase).toBe('picking')

      // The poll settles; the settle wake re-opens a full window for the
      // moderator's ranking leg (2026-09-08 oc_9b99f: a fallback fired one
      // second after settle, the user toggled on the no-recommendation card,
      // and the late pick-roles was dropped), so the next window expiry is
      // still protected…
      for (const c of calls) c.resolveWith('表态')
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100)
      expect(getChatroomPickState(e, hub)?.phase).toBe('picking')
      // …and without a pick-roles call the fallback card renders one window
      // past the wake.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100)
      expect(getChatroomPickState(e, hub)?.phase).toBe('select')
    } finally {
      vi.useRealTimers()
    }
  })

  it('persists every statement (absent roles included) into the ledger RECORD and posts one statement card', async () => {
    const p = createStubChatroomSpawner()
    const { agent, calls } = createPollStubAgent()
    const e = newPollTestEngine(p, agent)
    const root = await scaffoldThreeRoles()
    const modHome = await mkdtemp(join(tmpdir(), 'fb-poll-mod-'))
    chatroomConfig(e).applySection({ rolesDir: root, moderatorDir: modHome })
    const hub = 'test:hub:user-1'
    const { startChatroom, chatroomLedgerDirFor } = await import('../../src/engine/chatroom.ts')
    await startChatroom(e, hub, ['taleb'], 'topic')
    const wake = vi.spyOn(e, 'deliverMachineMessage').mockImplementation(() => {})

    pollRoles(e, hub, '开场快答', 'opening')
    await waitFor(() => calls.length >= 2, 'poll queries dispatched')
    calls[0]!.resolveWith('立场A')
    calls[1]!.resolveWith('')
    await waitFor(() => wake.mock.calls.length > 0, 'moderator wake')

    const dir = chatroomLedgerDirFor(e, hub)
    expect(dir).toBeDefined()
    const record = await readFile(join(dir!, 'RECORD.md'), 'utf8')
    expect(record).toContain('【munger】：（开场快答）立场A')
    expect(record).toContain('【popper】：（开场快答）（未表态）')

    // One merged statement card reached the hub group (after the ready cards).
    await waitFor(() => p.sentCards.some(isPollCard), 'statement card posted')
    const cardBody = (p.sentCards.find(isPollCard) as { elements: Array<{ kind?: string; content?: string }> })
      .elements.map(el => el.kind === 'markdown' ? (el.content ?? '') : '').join('')
    expect(cardBody).toContain('【munger】立场A')
    expect(cardBody).toContain('【popper】（未表态）')
    function isPollCard(card: unknown): boolean {
      const els = (card as { elements?: Array<{ kind?: string; content?: string }> }).elements ?? []
      return els.some(el => el.kind === 'markdown' && (el.content ?? '').includes('快答完成'))
    }
  })
})

describe('ChatroomPoll attendance persistence', () => {
  it('an opening poll that settles before start lands its lines in RECORD.md and start keeps them', async () => {
    // The guided flow's opening lightning round settles BEFORE start
    // initializes the ledger (2026-09-07 oc_94b41a: 13 ENOENT warns, every
    // attendance line lost, the moderator re-summarized by hand).
    const p = createStubChatroomSpawner()
    const { agent, calls } = createPollStubAgent()
    const e = newPollTestEngine(p, agent)
    const mod = await mkdtemp(join(tmpdir(), 'fb-poll-mod-'))
    chatroomConfig(e).applySection({ rolesDir: await scaffoldThreeRoles(), moderatorDir: mod })
    const hub = 'test:hub:user-1'
    e.sessions.getOrCreateActive(hub) // the spawned hub group's session
    const wake = vi.spyOn(e, 'deliverMachineMessage').mockImplementation(() => {})

    pollRoles(e, hub, '开场快答：一句话立场', 'opening')
    await waitFor(() => calls.length >= 3, 'poll queries dispatched')
    calls[0]!.resolveWith('想深聊')
    calls[1]!.resolveWith('表态即可')
    calls[2]!.resolveWith('不相关')
    await waitFor(() => wake.mock.calls.length > 0, 'moderator wake')

    const { chatroomLedgerDirFor, startChatroom } = await import('../../src/engine/chatroom.ts')
    const dir = chatroomLedgerDirFor(e, hub)!
    const rec = await readFile(join(dir, 'RECORD.md'), 'utf8')
    expect(rec).toContain('## 讨论记录')
    for (const n of ['munger', 'popper', 'taleb']) expect(rec).toContain(`【${n}】`)
    expect(rec).toContain('想深聊')

    // start initializes the ledger afterwards and must keep the lines.
    await startChatroom(e, hub, ['taleb'], 'topic')
    await settle() // init rides the serialized ledger write chain
    const rec2 = await readFile(join(dir, 'RECORD.md'), 'utf8')
    expect(rec2).toContain('想深聊')
  })
})

describe('ChatroomPoll attendance persistence (multi-run)', () => {
  it("a second chatroom's pre-start poll lands in the NEXT run dir, not the previous run's ledger", async () => {
    const p = createStubChatroomSpawner()
    const { agent, calls } = createPollStubAgent()
    const e = newPollTestEngine(p, agent)
    const mod = await mkdtemp(join(tmpdir(), 'fb-poll-mod2-'))
    chatroomConfig(e).applySection({ rolesDir: await scaffoldThreeRoles(), moderatorDir: mod })
    const hub = 'test:hub:user-1'
    e.sessions.getOrCreateActive(hub)

    // Run 1: a full start + end leaves chatroomLedgerRun at 1.
    const { startChatroom, endChatroom, chatroomLedgerDirFor } = await import('../../src/engine/chatroom.ts')
    await startChatroom(e, hub, ['taleb'], 'topic-1')
    expect(endChatroom(e, hub).status).toBe('ended')
    await settle()
    const run1Dir = chatroomLedgerDirFor(e, hub)!
    const run1Before = await readFile(join(run1Dir, 'RECORD.md'), 'utf8')

    // Run 2's guided flow: opening poll settles BEFORE start.
    const wake = vi.spyOn(e, 'deliverMachineMessage').mockImplementation(() => {})
    pollRoles(e, hub, '开场快答：一句话立场', 'opening')
    await waitFor(() => calls.length >= 3, 'poll queries dispatched')
    for (const c of calls) c.resolveWith('想深聊')
    await waitFor(() => wake.mock.calls.length > 0, 'moderator wake')

    const run2Dir = chatroomLedgerDir(mod, hub, 2)
    const rec2 = await readFile(join(run2Dir, 'RECORD.md'), 'utf8')
    expect(rec2).toContain('想深聊')
    // The previous run's ledger is untouched.
    const run1After = await readFile(join(run1Dir, 'RECORD.md'), 'utf8')
    expect(run1After).toBe(run1Before)
  })
})
