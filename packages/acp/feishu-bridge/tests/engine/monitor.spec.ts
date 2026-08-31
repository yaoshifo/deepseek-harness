/**
 * Monitor domain tests ported 1:1 from cc-connect
 * core/engine_monitor_test.go (#53): triage parsing, rules, LLM triage
 * provider fallback, clarification cards, learn examples, poll fallback
 * boundary semantics, coalescing, capacity, spawn notices, and dispatch-hub
 * member copy. The Go `engine.<field>` surface becomes `engine.monitor.<field>`;
 * async tails (LLM triage, spawns, card sends) get a settle tick before
 * asserting platform output.
 *
 * @module dsh-feishu-bridge/tests-engine-monitor
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Platform } from '../../src/core/types.ts'
import { Engine } from '../../src/engine/engine.ts'
import { DirHistory } from '../../src/engine/dir-history.ts'
import {
  MonitorExampleStore,
  extractQuotedText,
  isMonitorCommand,
  matchClarifyAnswer,
  monitorClarifyMaxOptions,
  monitorSeenCap,
  parseLearnDir,
  parseTriageResponse,
  type MonitorClarification,
  type MonitorClarifyOption,
  type MonitorDirEntry,
  type MonitorRuleEntry,
} from '../../src/engine/monitor.ts'
import type { Agent, Message } from '../../src/core/types.ts'
import { Msg } from '../../src/i18n/index.ts'
import type { SpawnedChatInfo } from '../../src/core/types.ts'
import {
  createControllableAgent,
  createStubAgent,
  createStubCardPlatform,
  createStubCardPlatformFull,
  createStubPlatform,
  createGroupNameSwitcherAgent,
  createStubSpawnerPlatform,
  newResultAgentSession,
  newStubMessage,
  type RecordedCard,
  type StubCardPlatform,
  type StubPlatform,
} from '../stubs/engine-stubs.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'fb-monitor-'))
}

/** One macrotask tick: flushes the microtask chain behind fire-and-forget sends. */
async function settle(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

async function settleN(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await settle()
}

/** Go newMonitorEngine: a minimal engine on a plain feishu stub platform. */
function newMonitorEngine(agent: Agent = createStubAgent()): { e: Engine; p: StubPlatform } {
  const p = createStubPlatform('feishu')
  return { e: new Engine('test', agent, [p], '', 'en'), p }
}

/** Compact setConfig literal mirroring Go's 16-arg SetMonitorConfig calls. */
function setConfig(e: Engine, over: Partial<Parameters<Engine['monitor']['setConfig']>[0]> = {}): void {
  e.monitor.setConfig({
    enabled: true,
    chats: '',
    contextWindow: 0,
    spawnNotice: false,
    maxConcurrent: 0,
    triageProvider: '',
    triagePrompt: '',
    dirs: [],
    rules: [],
    learnEnabled: false,
    learnMax: 0,
    reactEmoji: '',
    pollIntervalMs: 0,
    fallbackUser: '',
    examples: undefined,
    mode: 'monitor',
    ...over,
  })
}

function msg(over: Partial<Message> = {}): Message {
  return { ...newStubMessage(), platform: 'feishu', ...over }
}

function equalStrings(a: string[] | undefined, b: string[] | undefined): boolean {
  const x = a ?? []
  const y = b ?? []
  return x.length === y.length && x.every((v, i) => v === y[i])
}

describe('parseTriageResponse', () => {
  const cases: Array<{ name: string; resp: string; action: boolean; dir: string; task: string; candidates?: string[] }> = [
    { name: 'plain json', resp: '{"actionable": true, "dir": "/pay", "task": "排查 500"}', action: true, dir: '/pay', task: '排查 500' },
    { name: 'camelCase keys', resp: '{"Actionable": true, "Dir": "/pay", "Task": "排查 500", "Candidates": ["/c"]}', action: true, dir: '/pay', task: '排查 500', candidates: ['/c'] },
    { name: 'json in prose', resp: '好的，判断如下：{"actionable": true, "dir": "/srv/a", "task": "查日志"} 完成', action: true, dir: '/srv/a', task: '查日志' },
    { name: 'not actionable', resp: '{"actionable": false, "dir": "", "task": ""}', action: false, dir: '', task: '' },
    { name: 'garbage', resp: '这不是 JSON', action: false, dir: '', task: '' },
    { name: 'fenced', resp: '```json\n{"actionable": true, "dir": "/d", "task": "x"}\n```', action: true, dir: '/d', task: 'x' },
    { name: 'with candidates', resp: '{"actionable": true, "dir": "", "task": "查日志", "candidates": ["/a", "/b"]}', action: true, dir: '', task: '查日志', candidates: ['/a', '/b'] },
    { name: 'candidates missing', resp: '{"actionable": true, "dir": "/a", "task": "x"}', action: true, dir: '/a', task: 'x' },
    { name: 'candidates null', resp: '{"actionable": true, "dir": "", "task": "x", "candidates": null}', action: true, dir: '', task: 'x' },
    { name: 'candidates not array', resp: '{"actionable": true, "dir": "", "task": "x", "candidates": "foo"}', action: false, dir: '', task: '' },
    { name: 'candidates mixed types', resp: '{"actionable": true, "dir": "", "task": "x", "candidates": ["/a", 42, "/c"]}', action: true, dir: '', task: 'x', candidates: ['/a', '/c'] },
    { name: 'dir and candidates both', resp: '{"actionable": true, "dir": "/a", "task": "x", "candidates": ["/b"]}', action: true, dir: '/a', task: 'x', candidates: ['/b'] },
  ]
  for (const c of cases) {
    it(c.name, () => {
      const { actionable, dir, task, candidates } = parseTriageResponse(c.resp)
      expect({ actionable, dir, task, candidates }).toEqual({
        actionable: c.action,
        dir: c.dir,
        task: c.task,
        candidates: c.candidates ?? [],
      })
    })
  }
})

describe('renderTask', () => {
  it('empty template returns the text; template substitutes {{message}}', () => {
    const { e } = newMonitorEngine()
    expect(e.monitor.renderTask('', '支付 500')).toBe('支付 500')
    expect(e.monitor.renderTask('排查：{{message}}', '支付 500')).toBe('排查：支付 500')
  })
})

describe('rulePass', () => {
  it('matches rules in order and carries noReport', () => {
    const { e } = newMonitorEngine()
    e.monitor.rules = [
      { pattern: /500|panic/i, dir: '/pay', task: '排查报错：{{message}}', noReport: false },
      { pattern: /白屏/, dir: '/web', task: '', noReport: false },
      { pattern: /\/explain/, dir: '/draw', task: '', noReport: true },
    ] satisfies MonitorRuleEntry[]
    expect(e.monitor.rulePass('支付服务一直 500')).toEqual({ dir: '/pay', task: '排查报错：支付服务一直 500', noReport: false })
    expect(e.monitor.rulePass('页面白屏了')).toEqual({ dir: '/web', task: '页面白屏了', noReport: false })
    expect(e.monitor.rulePass('/explain TCP三次握手')).toEqual({ dir: '/draw', task: '/explain TCP三次握手', noReport: true })
    expect(e.monitor.rulePass('早上好').dir).toBe('')
  })
})

describe('isMonitorChat', () => {
  it('routes only listed chats on the matching platform', () => {
    const { e } = newMonitorEngine()
    e.monitor.enabled = true
    e.monitor.setChats('oc_a,oc_b')
    expect(e.isMonitorChat(msg({ sessionKey: 'feishu:oc_a:u1' }))).toBe(true)
    expect(e.isMonitorChat(msg({ sessionKey: 'feishu:oc_b:u2' }))).toBe(true)
    expect(e.isMonitorChat(msg({ sessionKey: 'feishu:oc_x:u3' }))).toBe(false)
    expect(e.isMonitorChat(msg({ sessionKey: 'slack:oc_a:u1' }))).toBe(false)
    e.monitor.setChats('')
    expect(e.isMonitorChat(msg({ sessionKey: 'feishu:oc_a:u1' }))).toBe(false)
  })
})

describe('handleMonitorMessage', () => {
  it('skips engine-synthesized messages (empty userID) before dedup/triage', () => {
    const { e, p } = newMonitorEngine()
    e.monitor.enabled = true
    e.monitor.setChats('oc_m')

    e.monitor.handleMonitorMessage(p, msg({
      sessionKey: 'feishu:oc_m:u1',
      userID: '',
      messageID: 'om_synthetic',
      content: '⏱ 子任务超时已被终止',
    }))

    expect(e.monitor.seenHas('oc_m', 'om_synthetic')).toBe(false)
  })

  it('does not triage /monitor commands fetched back by the poll path', async () => {
    const p = createStubSpawnerPlatform('feishu')
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    e.monitor.enabled = true
    e.monitor.setChats('oc_m')
    // A catch-all rule routes ANY triaged text to a spawn.
    e.monitor.rules = [{ pattern: /.*/, dir: tempDir(), task: '', noReport: false }]

    e.monitor.handleMonitorMessage(p, msg({
      sessionKey: 'feishu:oc_m:u1',
      userID: 'u1',
      messageID: 'om_cmd',
      content: '/monitor on',
    }))
    await settleN(3)

    // Dedup-add runs before the exemption.
    expect(e.monitor.seenHas('oc_m', 'om_cmd')).toBe(true)
    expect(p.spawnCount).toBe(0)
  })
})

/** In-memory MonitorPoller for poll-path tests (Go fakeMonitorPoller). */
function fakePoller(opts: { latest?: number; latestErr?: Error; msgs: Message[]; latestTimeSec?: number }) {
  return {
    latestCalls: 0,
    listCalls: 0,
    async listMonitorMessages(): Promise<{ messages: Message[]; latestTimeSec: number }> {
      this.listCalls++
      const maxMsg = opts.msgs.reduce((acc, m) => Math.max(acc, m.createTime ?? 0), 0)
      return { messages: opts.msgs, latestTimeSec: opts.latestTimeSec ?? maxMsg }
    },
    async latestMessageTime(): Promise<number> {
      this.latestCalls++
      if (opts.latestErr !== undefined) throw opts.latestErr
      return opts.latest ?? 0
    },
  }
}

function newMonitorPollEngine(): { e: Engine; p: ReturnType<typeof createStubSpawnerPlatform> } {
  const p = createStubSpawnerPlatform('feishu')
  const e = new Engine('test', createStubAgent(), [p], '', 'en')
  e.monitor.enabled = true
  e.monitor.setChats('oc_m')
  return { e, p }
}

describe('monitorPollOnce', () => {
  it('skips the boundary refetch (CreateTime == after)', async () => {
    const { e } = newMonitorPollEngine()
    e.monitor.lastTime = { oc_m: 100 }

    const poller = fakePoller({
      latest: 100,
      msgs: [
        msg({ sessionKey: 'feishu:oc_m:u1', userID: 'u1', messageID: 'om_boundary', content: '/monitor on', createTime: 100 }),
        msg({ sessionKey: 'feishu:oc_m:u1', userID: 'u1', messageID: 'om_new', content: 'signal alert', createTime: 101 }),
      ],
    })
    await e.monitor.monitorPollOnce(poller)

    expect(e.monitor.seenHas('oc_m', 'om_boundary')).toBe(false)
    expect(e.monitor.seenHas('oc_m', 'om_new')).toBe(true)
  })

  it('skips a chat whose seed never succeeded', async () => {
    const { e } = newMonitorPollEngine()

    const poller = fakePoller({
      latestErr: new Error('message list failed code=2200'),
      msgs: [msg({ sessionKey: 'feishu:oc_m:u1', userID: 'u1', messageID: 'om_old', content: 'old alert', createTime: 5 })],
    })
    await e.monitor.monitorPollOnce(poller)

    expect(poller.latestCalls).toBeGreaterThan(0)
    expect(poller.listCalls).toBe(0)
    expect(e.monitor.seenHas('oc_m', 'om_old')).toBe(false)
  })

  it('processes the first message after seeding an empty chat (after=0)', async () => {
    const { e } = newMonitorPollEngine()

    const poller = fakePoller({
      latest: 0,
      msgs: [msg({ sessionKey: 'feishu:oc_m:u1', userID: 'u1', messageID: 'om_first', content: 'first alert', createTime: 50 })],
    })
    await e.monitor.monitorPollOnce(poller)

    expect(e.monitor.seenHas('oc_m', 'om_first')).toBe(true)
  })

  it('advances the watermark past a page of unprocessable messages', async () => {
    // An alert storm of webhook cards the platform filters out (bot's own /
    // sender-less without fallback_user / no extractable text) must still
    // advance the high-water mark — otherwise the same page refetches
    // forever and every later alert stays buried behind it.
    const { e } = newMonitorPollEngine()
    e.monitor.lastTime = { oc_m: 100 }

    const poller = fakePoller({ latest: 100, msgs: [], latestTimeSec: 105 })
    await e.monitor.monitorPollOnce(poller)

    expect(e.monitor.lastTime['oc_m']).toBe(105)
  })
})

describe('triage serialization', () => {
  it('a same-chat triage batch runs serially (capacity check TOCTOU guard)', async () => {
    const { e, p } = newMonitorPollEngine()
    const running: number[] = []
    let peak = 0
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    e.monitor.triageAndSpawn = async (_p: Platform, msg: Message) => {
      running.push(1)
      peak = Math.max(peak, running.length)
      if (msg.content === 'first') await gate
      running.pop()
    }
    const mk = (content: string): Message => msg({ sessionKey: 'feishu:oc_m:u1', userID: 'u1', messageID: `om_${content}`, content })
    e.monitor.handleMonitorMessage(p, mk('first'))
    e.monitor.handleMonitorMessage(p, mk('second'))
    await new Promise((r) => { setTimeout(r, 20) })
    expect(peak, 'the second triage waited for the first').toBe(1)
    release()
    await new Promise((r) => { setTimeout(r, 10) })
  })
})

describe('MonitorExampleStore', () => {
  it('adds distinct ids, keeps order, persists, deletes', () => {
    const path = join(tempDir(), 'examples.json')
    const s = new MonitorExampleStore(path)
    const id1 = s.add('支付 500', '/pay', '拉群后先 @值班', false, 1)
    const id2 = s.add('早上好', '', '忽略', false, 2)
    const id3 = s.add('节日问候', '', '', true, 3)
    expect(new Set([id1, id2, id3]).size).toBe(3)
    const all = s.all()
    expect(all).toHaveLength(3)
    expect(all[2]?.drop).toBe(true)
    expect(all[0]?.drop).toBe(false)
    expect(all[1]?.drop).toBe(false)
    const rec = s.recentN(1)
    expect(rec).toHaveLength(1)
    expect(rec[0]?.example).toBe('节日问候')
    expect(rec[0]?.drop).toBe(true)
    // Persist + reload.
    const s2 = new MonitorExampleStore(path)
    expect(s2.all()).toHaveLength(3)
    expect(s2.all()[2]?.drop).toBe(true)
    expect(s.delete(id1)).toBe(true)
    expect(s.delete(id1)).toBe(false)
    expect(s.all()).toHaveLength(2)
  })

  it('preserves a corrupt file aside instead of overwriting it', () => {
    const dir = tempDir()
    const path = join(dir, 'examples.json')
    const garbage = '{not valid json'
    writeFileSync(path, garbage, { mode: 0o600 })
    const s = new MonitorExampleStore(path)
    expect(s.all()).toHaveLength(0)
    s.add('示例', '/pay', '拉群 @值班', false, 123)
    expect(readFileSync(`${path}.corrupt`, 'utf8')).toBe(garbage)
    expect(readFileSync(path, 'utf8')).toContain('示例')
  })
})

describe('parseLearnDir', () => {
  const dirs: MonitorDirEntry[] = [
    { path: '/pay', description: '支付服务' },
    { path: '/web', description: '前端站点' },
  ]
  const cases: Array<{ name: string; body: string; dir: string; instruction: string; drop: boolean }> = [
    { name: 'flag path', body: '--dir /pay 拉群后先 @值班', dir: '/pay', instruction: '拉群后先 @值班', drop: false },
    { name: 'flag desc', body: '--dir 支付服务 拉群后先 @值班', dir: '/pay', instruction: '拉群后先 @值班', drop: false },
    { name: 'desc mention', body: '这种归支付服务，拉群后先 @值班', dir: '/pay', instruction: '这种归支付服务，拉群后先 @值班', drop: false },
    { name: 'no dir', body: '以后这种拉群后先 @值班', dir: '', instruction: '以后这种拉群后先 @值班', drop: false },
    { name: 'ignore bare', body: '--ignore', dir: '', instruction: '', drop: true },
    { name: 'ignore with reason', body: '--ignore 只是日常问候', dir: '', instruction: '只是日常问候', drop: true },
    { name: 'ignore overrides dir', body: '--dir /pay --ignore', dir: '', instruction: '', drop: true },
    { name: 'ignore with dir and reason', body: '--dir /pay --ignore 闲聊', dir: '', instruction: '闲聊', drop: true },
  ]
  for (const c of cases) {
    it(c.name, () => {
      expect(parseLearnDir(c.body, dirs)).toEqual({ dir: c.dir, instruction: c.instruction, drop: c.drop })
    })
  }
})

describe('extractQuotedText', () => {
  it('extracts the single-quote format and falls back to trimmed input', () => {
    expect(extractQuotedText('[Quoted message from Alice]:\n支付服务 502 了\n\n')).toBe('支付服务 502 了')
    expect(extractQuotedText('')).toBe('')
    expect(extractQuotedText('some plain text')).toBe('some plain text')
  })
})

describe('handleLearnExample', () => {
  function learnEngine(dirs: MonitorDirEntry[]): { e: Engine; p: StubPlatform } {
    const { e, p } = newMonitorEngine()
    e.monitor.learnEnabled = true
    e.monitor.dirs = dirs
    e.monitor.examples = new MonitorExampleStore(join(tempDir(), 'ex.json'))
    return { e, p }
  }

  it('adds via a quoted message, lists, deletes', async () => {
    const { e, p } = learnEngine([{ path: '/pay', description: '支付服务' }])

    e.monitor.handleMonitorMessage(p, msg({
      sessionKey: 'feishu:oc_m:u1',
      userID: 'u1',
      content: '/learn --dir /pay 拉群后先 @值班',
      extraContent: '[Quoted message from Alice]:\n支付服务 502 了\n\n',
    }))
    await settleN(2)
    const sent = p.getSent()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain(e.i18n.tf(Msg.MonitorLearnAckDir, '支付服务 502 了', '/pay', '拉群后先 @值班'))
    expect(e.monitor.examples?.all()).toHaveLength(1)

    p.clearSent()
    e.monitor.handleMonitorMessage(p, msg({ sessionKey: 'feishu:oc_m:u1', userID: 'u1', content: '/learn list' }))
    await settleN(2)
    expect(p.getSent()[0]).toContain(e.i18n.tf(Msg.MonitorLearnListCount, 1))

    const id = e.monitor.examples?.all()[0]?.id ?? ''
    p.clearSent()
    e.monitor.handleMonitorMessage(p, msg({ sessionKey: 'feishu:oc_m:u1', userID: 'u1', content: `/learn del ${id}` }))
    await settleN(2)
    expect(p.getSent()[0]).toContain(e.i18n.tf(Msg.MonitorLearnDeleted, id))
    expect(e.monitor.examples?.all()).toHaveLength(0)
  })

  it('stores --ignore examples as drop with the reason', async () => {
    const { e, p } = learnEngine([{ path: '/pay', description: '支付服务' }])

    e.monitor.handleMonitorMessage(p, msg({
      sessionKey: 'feishu:oc_m:u1',
      userID: 'u1',
      content: '/learn --ignore 只是日常问候',
      extraContent: '[Quoted message from Alice]:\n早上好\n\n',
    }))
    await settleN(2)
    const sent = p.getSent()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain(e.i18n.tf(Msg.MonitorLearnAckDrop, '早上好'))
    expect(sent[0]).toContain(e.i18n.tf(Msg.MonitorLearnReason, '只是日常问候'))
    const all = e.monitor.examples?.all() ?? []
    expect(all).toHaveLength(1)
    expect(all[0]?.drop).toBe(true)
    expect(all[0]?.dir).toBe('')
    expect(all[0]?.instruction).toBe('只是日常问候')
  })

  it('lists drop examples with the 🚫 marker', async () => {
    const { e, p } = learnEngine([{ path: '/pay', description: '支付服务' }])
    e.monitor.examples?.add('支付 502', '/pay', '拉群 @值班', false, 1)
    e.monitor.examples?.add('早上好', '', '日常问候', true, 2)

    e.monitor.handleMonitorMessage(p, msg({ sessionKey: 'feishu:oc_m:u1', userID: 'u1', content: '/learn list' }))
    await settleN(2)
    const out = p.getSent()[0] ?? ''
    expect(out).toContain('🚫')
    expect(out).toContain('📂')
    expect(out).toContain('早上好')
  })

  it('asks to quote when no quoted message is present', async () => {
    const { e, p } = learnEngine([])
    e.monitor.handleMonitorMessage(p, msg({ sessionKey: 'feishu:oc_m:u1', userID: 'u1', content: '/learn 处理一下' }))
    await settleN(2)
    expect(p.getSent()[0]).toContain(e.i18n.t(Msg.MonitorLearnUsage))
  })
})

/** stub doneReplyPlatform: records Done reactions on original messages. */
function doneReplyPlatform(): StubCardPlatform & {
  doneReactions: string[]
  addReactionToMessage(chatID: string, messageID: string, emoji: string): Promise<void>
} {
  const base = createStubCardPlatform('feishu') as StubCardPlatform & {
    reconstructReplyCtx(sessionKey: string): Promise<unknown>
  }
  const p = {
    ...base,
    reconstructReplyCtx: async (sessionKey: string) => `reconstructed-ctx:${sessionKey}`,
    doneReactions: [] as string[],
    addReactionToMessage: async (chatID: string, messageID: string, emoji: string) => {
      p.doneReactions.push(`${chatID}/${messageID}/${emoji}`)
    },
  }
  return p
}

describe('replyToParent monitor-group semantics', () => {
  async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (cond()) return
      await settle()
    }
  }

  it('sends the result but never wakes a monitor parent', async () => {
    const parentSession = newResultAgentSession('ack')
    const p = doneReplyPlatform()
    const e = new Engine('test', createControllableAgent(parentSession), [p], '', 'en')

    const child = e.sessions.getOrCreateActive('feishu:oc_child')
    child.setParentSessionKey('feishu:oc_parent')
    e.sessions.getOrCreateActive('feishu:oc_parent').setMonitorGroup(true)

    e.replyToParent(p, child, '服务A 内存泄漏在 handler.go:88')
    await settleN(4)

    expect(p.getSent().length + p.sentCards.length).toBeGreaterThan(0)
    expect(parentSession.sendCalls).toHaveLength(0)
  })

  it('adds the Done reaction to the original monitored message', async () => {
    const parentSession = newResultAgentSession('ack')
    const p = doneReplyPlatform()
    const e = new Engine('test', createControllableAgent(parentSession), [p], '', 'en')

    const child = e.sessions.getOrCreateActive('feishu:oc_child')
    child.setParentSessionKey('feishu:oc_parent')
    const parent = e.sessions.getOrCreateActive('feishu:oc_parent')
    parent.setMonitorGroup(true)
    parent.setMonitorOriginMessageID('om_orig123')

    e.replyToParent(p, child, '排查完成：内存泄漏在 handler.go')
    await settleN(4)

    expect(p.doneReactions).toEqual(['oc_parent/om_orig123/Done'])
  })

  it('wakes a normal parent with a synthetic message', async () => {
    const parentSession = newResultAgentSession('ack')
    const p = doneReplyPlatform()
    const e = new Engine('test', createControllableAgent(parentSession), [p], '', 'en')

    const child = e.sessions.getOrCreateActive('feishu:oc_child')
    child.setParentSessionKey('feishu:oc_parent')
    // A parent chat that spawned this child holds a session record —
    // deliverParentReply's non-creating lookup relies on it.
    e.sessions.getOrCreateActive('feishu:oc_parent')

    e.replyToParent(p, child, '服务A 内存泄漏在 handler.go:88')
    await waitFor(() => parentSession.sendCalls.length > 0)
    expect(parentSession.sendCalls.length).toBeGreaterThan(0)
  })
})

describe('llmTriage', () => {
  function triageEngine(a: Agent, dirs: MonitorDirEntry[]): Engine {
    const { e } = newMonitorEngine(a)
    e.monitor.dirs = dirs
    return e
  }

  it('falls back to the active provider when triage_provider is empty', async () => {
    const a = createGroupNameSwitcherAgent('active-prov', { resp: '{"actionable": true, "dir": "/pay", "task": "排查余额"}' })
    const e = triageEngine(a, [{ path: '/pay', description: '支付' }])
    e.monitor.triageProvider = ''

    const res = await e.monitor.llmTriage('余额算不对', 'oc_x')
    expect(res.action).toBe('spawn')
    expect(res.dir).toBe('/pay')
    expect(res.task).toBe('排查余额')
    expect(a.state.gotProvider).toBe('active-prov')
  })

  it('drops when no provider can be resolved', async () => {
    const a = createGroupNameSwitcherAgent('', { resp: '{"actionable": true, "dir": "/pay", "task": "x"}' })
    const e = triageEngine(a, [{ path: '/pay', description: '' }])
    e.monitor.triageProvider = ''

    const res = await e.monitor.llmTriage('something', 'oc_x')
    expect(res.action).toBe('drop')
  })

  it('drops non-actionable responses', async () => {
    const a = createGroupNameSwitcherAgent('p', { resp: '{"actionable": false, "dir": "", "task": ""}' })
    const e = triageEngine(a, [{ path: '/pay', description: '' }])
    expect((await e.monitor.llmTriage('早上好', 'oc_x')).action).toBe('drop')
  })

  it('clarifies when the dir is unknown but monitorDirs exist', async () => {
    const a = createGroupNameSwitcherAgent('p', { resp: '{"actionable": true, "dir": "/invented", "task": "x"}' })
    const e = triageEngine(a, [{ path: '/pay', description: '' }])
    expect((await e.monitor.llmTriage('bug', 'oc_x')).action).toBe('clarify')
  })

  it('passes allow-listed candidates through on clarify', async () => {
    const a = createGroupNameSwitcherAgent('p', { resp: '{"actionable": true, "dir": "", "task": "查日志", "candidates": ["/pay", "/auth"]}' })
    const e = triageEngine(a, [{ path: '/pay', description: '' }, { path: '/auth', description: '' }])
    const res = await e.monitor.llmTriage('登录失败', 'oc_x')
    expect(res.action).toBe('clarify')
    expect(equalStrings(res.candidates, ['/pay', '/auth'])).toBe(true)
  })

  it('clarifies with undefined candidates when all are unknown', async () => {
    const a = createGroupNameSwitcherAgent('p', { resp: '{"actionable": true, "dir": "", "task": "x", "candidates": ["/fake"]}' })
    const e = triageEngine(a, [{ path: '/pay', description: '' }])
    const res = await e.monitor.llmTriage('bug', 'oc_x')
    expect(res.action).toBe('clarify')
    expect(res.candidates).toBeUndefined()
  })

  it('drops actionable messages when no monitorDirs exist', async () => {
    const a = createGroupNameSwitcherAgent('p', { resp: '{"actionable": true, "dir": "", "task": "x"}' })
    const e = triageEngine(a, [])
    expect((await e.monitor.llmTriage('bug', 'oc_x')).action).toBe('drop')
  })

  it('spawns when dir and candidates are both given and dir is known', async () => {
    const a = createGroupNameSwitcherAgent('p', { resp: '{"actionable": true, "dir": "/pay", "task": "排查", "candidates": ["/auth"]}' })
    const e = triageEngine(a, [{ path: '/pay', description: '' }, { path: '/auth', description: '' }])
    const res = await e.monitor.llmTriage('bug', 'oc_x')
    expect(res.action).toBe('spawn')
    expect(res.dir).toBe('/pay')
  })
})

describe('matchClarifyAnswer', () => {
  it('maps labels to dirs, skip sentinel, and misses', () => {
    const opts: MonitorClarifyOption[] = [
      { label: '支付服务', dir: '/pay' },
      { label: '认证服务', dir: '/auth' },
      { label: '❎ 跳过（误判）', dir: '' },
    ]
    expect(matchClarifyAnswer('支付服务', opts)).toEqual({ dir: '/pay', isSkip: false, matched: true })
    expect(matchClarifyAnswer('认证服务', opts)).toEqual({ dir: '/auth', isSkip: false, matched: true })
    expect(matchClarifyAnswer('❎ 跳过（误判）', opts)).toEqual({ dir: '', isSkip: true, matched: true })
    expect(matchClarifyAnswer('  支付服务  ', opts)).toEqual({ dir: '/pay', isSkip: false, matched: true })
    expect(matchClarifyAnswer('', opts).matched).toBe(false)
    expect(matchClarifyAnswer('别的目录', opts).matched).toBe(false)
  })
})

describe('askMonitorClarification', () => {
  const sk = 'feishu:oc_x:u1'

  function newEng(dirs: MonitorDirEntry[]): { e: Engine; p: StubPlatform } {
    const { e, p } = newMonitorEngine()
    e.monitor.dirs = dirs
    return { e, p }
  }

  function msgFor(text: string): Message {
    return msg({ sessionKey: sk, content: text, userID: 'u1' })
  }

  it('turns candidates into options with friendly labels', () => {
    const { e, p } = newEng([{ path: '/pay', description: '支付' }, { path: '/auth', description: '认证' }])
    e.monitor.askMonitorClarification(p, msgFor('登录失败'), 'react1', '查日志', ['/pay', '/auth'])
    const pc = e.sessions.getOrCreateActive(sk).getPendingMonitorClarification()
    expect(pc).toBeDefined()
    expect(pc?.options).toHaveLength(3)
    expect(pc?.options[0]).toEqual({ label: '支付', dir: '/pay' })
    expect(pc?.options[2]?.dir).toBe('')
    expect(pc?.options[2]?.label).toBe(e.i18n.t(Msg.MonitorClarifySkip))
    expect(pc?.origText).toBe('登录失败')
    expect(pc?.origTask).toBe('查日志')
    expect(pc?.origReactionID).toBe('react1')
    expect(pc?.origUserID).toBe('u1')
  })

  it('falls back to all monitorDirs when candidates are empty', () => {
    const { e, p } = newEng([{ path: '/a', description: '' }, { path: '/b', description: '' }])
    e.monitor.askMonitorClarification(p, msgFor('bug'), 'r', '', undefined)
    expect(e.sessions.getOrCreateActive(sk).getPendingMonitorClarification()?.options).toHaveLength(3)
  })

  it('drops without setting pending when no monitorDirs', () => {
    const { e, p } = newEng([])
    e.monitor.askMonitorClarification(p, msgFor('bug'), 'r', '', undefined)
    expect(e.sessions.getOrCreateActive(sk).getPendingMonitorClarification()).toBeUndefined()
  })

  it('wording reflects hadCandidates', async () => {
    const dirs = [{ path: '/pay', description: '支付' }]
    // No candidates (triageDrop path): the pick-a-project card.
    const { e, p } = newEng(dirs)
    e.monitor.askMonitorClarification(p, msgFor('早上好'), 'r', '', undefined)
    await settleN(2)
    const sent = p.getSent().join('\n')
    expect(sent).toContain(e.i18n.t(Msg.MonitorClarifyHeaderNone))
    expect(sent).toContain(e.i18n.t(Msg.MonitorClarifyQuestionNone))
    // With candidates (triageClarify path): the pick-a-triage-dir card.
    const { e: e2, p: p2 } = newEng(dirs)
    e2.monitor.askMonitorClarification(p2, msgFor('登录失败'), 'r', '查日志', ['/pay'])
    await settleN(2)
    const sent2 = p2.getSent().join('\n')
    expect(sent2).toContain(e.i18n.t(Msg.MonitorClarifyHeader))
    expect(sent2).toContain(e.i18n.t(Msg.MonitorClarifyQuestion))
  })

  it('caps options at the max plus skip', () => {
    const dirs: MonitorDirEntry[] = Array.from({ length: 15 }, (_, i) => ({ path: `/d${i}`, description: '' }))
    const { e, p } = newEng(dirs)
    e.monitor.askMonitorClarification(p, msgFor('bug'), 'r', '', undefined)
    expect(e.sessions.getOrCreateActive(sk).getPendingMonitorClarification()?.options).toHaveLength(monitorClarifyMaxOptions + 1)
  })

  it('dispatch mode uses the dir scan result as the pool', () => {
    const ws = tempDir()
    for (const name of ['mem0', 'cc-connect', 'riskai']) {
      mkdirSync(join(ws, name), { recursive: true })
    }
    const mem0Path = join(ws, 'mem0')
    const riskaiPath = join(ws, 'riskai')
    const { e, p } = newEng([{ path: mem0Path, description: 'mem0 记忆服务' }])
    e.monitor.setMode('dispatch')
    const dh = new DirHistory(tempDir())
    dh.setScanPaths(e.name, [ws])
    e.setDirHistory(dh)

    e.monitor.askMonitorClarification(p, msgFor('帮看看'), 'r', '', undefined)
    const pc = e.sessions.getOrCreateActive(sk).getPendingMonitorClarification()
    expect(pc).toBeDefined()
    const riskaiOpt = pc?.options.find(o => o.dir === riskaiPath)
    expect(riskaiOpt?.label).toBe('riskai')
    const mem0Opt = pc?.options.find(o => o.dir === mem0Path)
    expect(mem0Opt?.label).toBe('mem0 记忆服务')
  })

  it('dispatch mode falls back to monitorDirs when the scan is empty', () => {
    const { e, p } = newEng([{ path: '/pay', description: '' }, { path: '/auth', description: '' }])
    e.monitor.setMode('dispatch')
    e.monitor.askMonitorClarification(p, msgFor('bug'), 'r', '', undefined)
    expect(e.sessions.getOrCreateActive(sk).getPendingMonitorClarification()?.options).toHaveLength(3)
  })

  it('monitor mode ignores the dir scan and uses monitorDirs', () => {
    const ws = tempDir()
    mkdirSync(join(ws, 'riskai'), { recursive: true })
    const { e, p } = newEng([{ path: '/pay', description: '' }])
    e.monitor.setMode('monitor')
    const dh = new DirHistory(tempDir())
    dh.setScanPaths(e.name, [ws])
    e.setDirHistory(dh)
    e.monitor.askMonitorClarification(p, msgFor('bug'), 'r', '', undefined)
    expect(e.sessions.getOrCreateActive(sk).getPendingMonitorClarification()?.options).toHaveLength(2)
  })
})

describe('resolveMonitorClarification', () => {
  const sk = 'feishu:oc_x:u1'
  const dirOpts: MonitorClarifyOption[] = [
    { label: '支付', dir: '/pay' },
    { label: '❎ 跳过（误判）', dir: '' },
  ]

  function newEng(): { e: Engine; p: StubPlatform } {
    return newMonitorEngine()
  }

  function setPending(e: Engine, ageMs: number): void {
    e.sessions.getOrCreateActive(sk).setPendingMonitorClarification({
      origText: '原始告警',
      origTask: '查日志',
      origMessageID: '',
      origReactionID: '',
      origUserID: 'u1',
      images: [],
      origReplyCtx: undefined,
      options: dirOpts,
      askedAt: Date.now() - ageMs,
    } satisfies MonitorClarification)
    e.sessions.save()
  }

  it('returns false with no pending', () => {
    const { e, p } = newEng()
    expect(e.monitor.resolveMonitorClarification(p, msg({ sessionKey: sk, content: 'x' }))).toBe(false)
  })

  it('clears and returns false on timeout', () => {
    const { e, p } = newEng()
    setPending(e, 10 * 60_000)
    expect(e.monitor.resolveMonitorClarification(p, msg({ sessionKey: sk, content: '支付' }))).toBe(false)
    expect(e.sessions.getOrCreateActive(sk).getPendingMonitorClarification()).toBeUndefined()
  })

  it('clears and returns false on an unmatched message', () => {
    const { e, p } = newEng()
    setPending(e, 1000)
    expect(e.monitor.resolveMonitorClarification(p, msg({ sessionKey: sk, content: '别的消息' }))).toBe(false)
    expect(e.sessions.getOrCreateActive(sk).getPendingMonitorClarification()).toBeUndefined()
  })

  it('clears and returns true on skip, sending the cancel notice', async () => {
    const { e, p } = newEng()
    setPending(e, 1000)
    expect(e.monitor.resolveMonitorClarification(p, msg({ sessionKey: sk, content: '❎ 跳过（误判）' }))).toBe(true)
    expect(e.sessions.getOrCreateActive(sk).getPendingMonitorClarification()).toBeUndefined()
    await settleN(2)
    expect(p.getSent().some(s => s.includes('Cancelled') || s.includes('误判'))).toBe(true)
  })

  it('clears and returns true on a matched dir', async () => {
    const { e, p } = newEng()
    setPending(e, 1000)
    expect(e.monitor.resolveMonitorClarification(p, msg({ sessionKey: sk, content: '支付' }))).toBe(true)
    await settleN(3)
    expect(e.sessions.getOrCreateActive(sk).getPendingMonitorClarification()).toBeUndefined()
  })

  it('is race-safe against a double resolve', () => {
    const { e, p } = newEng()
    setPending(e, 1000)
    expect(e.monitor.resolveMonitorClarification(p, msg({ sessionKey: sk, content: '支付' }))).toBe(true)
    expect(e.monitor.resolveMonitorClarification(p, msg({ sessionKey: sk, content: '支付' }))).toBe(false)
  })
})

describe('monitorSeen FIFO', () => {
  it('evicts the oldest, keeps the window, isolates chats', () => {
    const { e } = newMonitorEngine()
    const chat = 'oc_test'
    const total = monitorSeenCap + 150
    for (let i = 0; i < total; i++) e.monitor.seenAdd(chat, `msg_${i}`)

    expect(e.monitor.seenHas(chat, `msg_${total - 1}`)).toBe(true)
    // msg_250 lives inside the last-cap window: a FIFO retains it.
    expect(e.monitor.seenHas(chat, `msg_${monitorSeenCap / 2}`)).toBe(true)
    expect(e.monitor.seenHas(chat, 'msg_0')).toBe(false)

    // Re-adding an existing id is a no-op.
    e.monitor.seenAdd(chat, `msg_${total - 1}`)
    expect(e.monitor.seenHas(chat, `msg_${total - 1}`)).toBe(true)

    // Cross-chat isolation.
    e.monitor.seenAdd('oc_other', 'msg_x')
    expect(e.monitor.seenHas('oc_other', 'msg_x')).toBe(true)
    expect(e.monitor.seenHas('oc_other', `msg_${total - 1}`)).toBe(false)
  })
})

describe('runtime field churn', () => {
  it('mode/chats writers and readers interleave without corruption', () => {
    const { e } = newMonitorEngine()
    setConfig(e, { chats: 'oc_a' })
    for (let i = 0; i < 100; i++) {
      e.monitor.setMode('dispatch')
      e.monitor.setChats('oc_a,oc_b')
      expect(['dispatch', 'monitor']).toContain(e.monitor.modeVal())
      expect(e.monitor.chatsVal()).toBeTruthy()
      e.monitor.setMode('monitor')
      e.monitor.setChats('oc_a')
    }
  })
})

describe('buildTriagePrompt', () => {
  it('selects the mode default or the custom override', () => {
    const cases: Array<{ name: string; mode: string; custom: string; wantSub: string }> = [
      { name: 'dispatch_default', mode: 'dispatch', custom: '', wantSub: '任务分发' },
      { name: 'monitor_default', mode: 'monitor', custom: '', wantSub: '工程分诊' },
      { name: 'empty_mode_is_monitor', mode: '', custom: '', wantSub: '工程分诊' },
      { name: 'custom_overrides_mode', mode: 'dispatch', custom: 'CUSTOM_PROMPT_MARKER_XYZ', wantSub: 'CUSTOM_PROMPT_MARKER_XYZ' },
    ]
    for (const c of cases) {
      const { e } = newMonitorEngine()
      setConfig(e, { dirs: [{ path: '/p/riskai', description: 'riskai 风控' }], triagePrompt: c.custom, mode: c.mode })
      expect(e.monitor.buildTriagePrompt('hello', 'chat1')).toContain(c.wantSub)
    }
  })

  it('splits learned examples into spawn and drop sections', () => {
    const { e } = newMonitorEngine()
    setConfig(e, { dirs: [{ path: '/pay', description: '支付服务' }] })
    e.monitor.learnEnabled = true
    e.monitor.learnMax = 20
    e.monitor.examples = new MonitorExampleStore(join(tempDir(), 'ex.json'))
    e.monitor.examples.add('支付 502', '/pay', '拉群后 @值班', false, 1)
    e.monitor.examples.add('早上好', '', '日常问候', true, 2)

    const got = e.monitor.buildTriagePrompt('早上好呀', 'chat1')
    expect(got).toContain('人类标记为无需响应的示例')
    expect(got).toContain('早上好')
    expect(got).toContain('人类教过的示例')
    expect(got).toContain('支付 502')
  })
})

describe('triageAndSpawn mode semantics', () => {
  it('dispatch miss sends the pick-a-project clarify card', async () => {
    const { e, p } = newMonitorEngine()
    setConfig(e, { dirs: [{ path: '/p/riskai', description: 'riskai 风控' }], mode: 'dispatch' })
    await e.monitor.triageAndSpawn(p, msg({ content: '一条模糊消息', sessionKey: 'feishu:c:u', replyCtx: 'rc' }))
    await settleN(3)
    const sent = p.getSent()
    expect(sent[sent.length - 1]).toContain(e.i18n.t(Msg.MonitorClarifyQuestionNone))
  })

  it('monitor miss stays silent', async () => {
    const { e, p } = newMonitorEngine()
    setConfig(e, { dirs: [{ path: '/p/riskai', description: 'riskai 风控' }], mode: 'monitor' })
    await e.monitor.triageAndSpawn(p, msg({ content: '一条模糊消息', sessionKey: 'feishu:c:u', replyCtx: 'rc' }))
    await settleN(3)
    expect(p.getSent()).toHaveLength(0)
  })
})

describe('sendMonitorSpawnNotice', () => {
  const modes: Array<{ mode: string; wantSub: string }> = [
    { mode: 'dispatch', wantSub: 'Dispatched to project' },
    { mode: 'monitor', wantSub: 'Spawned a triage group' },
    { mode: '', wantSub: 'Spawned a triage group' },
  ]
  for (const c of modes) {
    it(`header and body by mode=${c.mode || '(empty)'}`, async () => {
      const p = createStubCardPlatform('feishu')
      const e = new Engine('test', createStubAgent(), [p], '', 'en')
      setConfig(e, { spawnNotice: true, mode: c.mode })
      await e.monitor.sendMonitorSpawnNotice(p, 'rc', 'oc_child123', '/p/riskai', '原始消息')
      expect(p.sentCards.length).toBeGreaterThan(0)
      const card = p.sentCards[p.sentCards.length - 1] as RecordedCard
      const title = card.header?.title ?? ''
      expect(title).toContain(c.wantSub)
      expect(title).toContain('riskai')
      const body = card.elements[0]?.kind === 'markdown' ? (card.elements[0].content ?? '') : ''
      expect(body).not.toContain('/p/riskai')
      expect(body).not.toContain('目录')
      expect(body).toContain('原始消息')
    })
  }

  it('never leaks a hardcoded feishu applink URL to a plain platform', async () => {
    const { e, p } = newMonitorEngine()
    setConfig(e, { spawnNotice: true })
    await e.monitor.sendMonitorSpawnNotice(p, 'rc', 'oc_child123', '/p/riskai', '原始消息')
    for (const s of p.getSent()) {
      expect(s).not.toContain('applink.feishu.cn')
    }
  })
})

describe('cap and coalesce notices (i18n)', () => {
  /** The private notice senders, reached structurally for the spec. */
  function notices(e: Engine): {
    sendMonitorCapNotice(p: Platform, msg: Message, parentKey: string): Promise<void>
    sendMonitorCoalesceNotice(p: Platform, replyCtx: unknown, childChat: string, origText: string): Promise<void>
  } {
    return e.monitor as unknown as ReturnType<typeof notices>
  }

  it('renders the cap card title and body from the catalog', async () => {
    const p = createStubCardPlatformFull('feishu') as unknown as StubCardPlatform & {
      spawnedChats: SpawnedChatInfo[]
      listActiveSpawnedChats(): Promise<SpawnedChatInfo[]>
    }
    p.spawnedChats = [{ chatID: 'oc_c1', chatName: 'child', botName: 'feishu' }]
    p.listActiveSpawnedChats = async () => p.spawnedChats
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    setConfig(e, { maxConcurrent: 2 })
    const child = e.sessions.getOrCreateActive('feishu:oc_c1')
    child.setParentSessionKey('feishu:oc_x:u1')

    await notices(e).sendMonitorCapNotice(p, msg({ sessionKey: 'feishu:oc_x:u1', replyCtx: 'rc', content: 'x' }), 'feishu:oc_x:u1')

    expect(p.sentCards.length).toBeGreaterThan(0)
    const card = p.sentCards[p.sentCards.length - 1] as RecordedCard
    expect(card.header?.title).toContain(e.i18n.t(Msg.MonitorCapTitle))
    const body = card.elements[0]?.kind === 'markdown' ? (card.elements[0].content ?? '') : ''
    expect(body).toContain(e.i18n.tf(Msg.MonitorCapBody, 1, 2))
  })

  it('renders the coalesce card title from the catalog', async () => {
    const p = createStubCardPlatformFull('feishu')
    const e = new Engine('test', createStubAgent(), [p], '', 'en')

    await notices(e).sendMonitorCoalesceNotice(p, 'rc', 'oc_child9', '补充告警内容')

    expect(p.sentCards.length).toBeGreaterThan(0)
    const card = p.sentCards[p.sentCards.length - 1] as RecordedCard
    expect(card.header?.title).toContain(e.i18n.t(Msg.MonitorCoalesceTitle))
  })
})

/** stub spawnReactPlatform: a spawner that records Done reactions (Go spawnReactPlatform). */
function spawnReactPlatform(): ReturnType<typeof createStubSpawnerPlatform> & {
  reactions: string[]
  addReactionToMessage(chatID: string, messageID: string, emoji: string): Promise<void>
} {
  const base = createStubSpawnerPlatform('feishu')
  const reactions: string[] = []
  // Getters delegate to the base: spawnGroup's closure writes the base's
  // fields, so a spread copy would freeze the primitives at wrap time.
  const p = {
    ...base,
    get spawnCount() { return base.spawnCount },
    get lastFirst() { return base.lastFirst },
    get lastUserID() { return base.lastUserID },
    reactions,
    addReactionToMessage: async (chatID: string, messageID: string, emoji: string) => {
      reactions.push(`${chatID}/${messageID}/${emoji}`)
    },
  }
  return p
}

/** stub memberCopyPlatform: spawnReact + ChatMemberManager (Go memberCopyPlatform). */
function memberCopyPlatform(opts: { listMembers: string[]; listErr?: Error; addErr?: Error }): ReturnType<typeof spawnReactPlatform> & {
  listedKey: string
  addedKey: string
  addedMembers: string[]
  listChatMembers(sessionKey: string): Promise<string[]>
  addChatMembers(sessionKey: string, userIDs: string[]): Promise<void>
} {
  const base = spawnReactPlatform()
  const p = {
    ...base,
    get spawnCount() { return base.spawnCount },
    get lastFirst() { return base.lastFirst },
    get lastUserID() { return base.lastUserID },
    reactions: base.reactions,
    addReactionToMessage: base.addReactionToMessage.bind(base),
    listedKey: '',
    addedKey: '',
    addedMembers: [] as string[],
    listChatMembers: async (sessionKey: string) => {
      p.listedKey = sessionKey
      if (opts.listErr !== undefined) {
        // Go's ListChatMembers returns a partial roster together with the
        // error; the TS contract carries the partial on the thrown error.
        throw Object.assign(new Error(opts.listErr.message), { partial: opts.listMembers })
      }
      return opts.listMembers
    },
    addChatMembers: async (sessionKey: string, userIDs: string[]) => {
      p.addedKey = sessionKey
      p.addedMembers = [...userIDs]
      if (opts.addErr !== undefined) throw opts.addErr
    },
  }
  return p
}

describe('spawnMonitorSubgroup', () => {
  it('adds the Done reaction to the original message', async () => {
    const p = spawnReactPlatform()
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    setConfig(e, { spawnNotice: true, mode: 'dispatch' })

    await e.monitor.spawnMonitorSubgroup(
      p,
      msg({ content: 'mem0 报错', sessionKey: 'feishu:oc_hub:user-1', messageID: 'om_orig', replyCtx: 'rc' }),
      tempDir(),
      '处理 mem0 报错',
      false,
      '',
    )
    await settleN(3)

    expect(p.reactions).toContain('oc_hub/om_orig/Done')
  })

  it('no-report marks the child and reworks the injected message', async () => {
    const p = spawnReactPlatform()
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    setConfig(e, { mode: 'monitor' })

    await e.monitor.spawnMonitorSubgroup(
      p,
      msg({ content: '/explain TCP三次握手', sessionKey: 'feishu:oc_hub:user-1' }),
      tempDir(),
      '用 /explain 渲染概念图',
      true,
      '',
    )
    await settleN(3)

    const child = e.sessions.getOrCreateActive('test:child-chat')
    expect(child.getSubtaskNoReport()).toBe(true)
    expect(p.lastFirst).not.toContain('监控群')
    expect(p.lastFirst).toContain('请处理以下消息')
  })

  it('dispatch mode copies hub members, excluding the trigger user', async () => {
    const p = memberCopyPlatform({ listMembers: ['user-1', 'owner', 'collab-A'] })
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    setConfig(e, { spawnNotice: true, mode: 'dispatch' })

    await e.monitor.spawnMonitorSubgroup(
      p,
      msg({ content: 'mem0 报错', sessionKey: 'feishu:oc_hub:user-1', messageID: 'om_orig', replyCtx: 'rc', userID: 'user-1' }),
      tempDir(),
      '处理 mem0 报错',
      false,
      '',
    )
    await settleN(3)

    expect(p.listedKey).toBe('feishu:oc_hub:user-1')
    expect(p.addedKey).toBe('test:child-chat')
    expect(p.addedMembers).toEqual(['owner', 'collab-A'])
  })

  it('dispatch mode copies a partial roster when listing errors', async () => {
    const p = memberCopyPlatform({
      listMembers: ['owner', 'collab-A'],
      listErr: new Error('list chat members page: context deadline exceeded'),
    })
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    setConfig(e, { spawnNotice: true, mode: 'dispatch' })

    await e.monitor.spawnMonitorSubgroup(
      p,
      msg({ content: 'mem0 报错', sessionKey: 'feishu:oc_hub:user-1', messageID: 'om_orig', replyCtx: 'rc', userID: 'user-1' }),
      tempDir(),
      '处理 mem0 报错',
      false,
      '',
    )
    await settleN(3)

    expect(p.addedKey).toBe('test:child-chat')
    expect(p.addedMembers).toEqual(['owner', 'collab-A'])
  })

  it('monitor mode does not copy members', async () => {
    const p = memberCopyPlatform({ listMembers: ['owner'] })
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    setConfig(e, { spawnNotice: true, mode: 'monitor' })

    await e.monitor.spawnMonitorSubgroup(
      p,
      msg({ content: '告警 X', sessionKey: 'feishu:oc_hub:user-1', messageID: 'om_orig', replyCtx: 'rc', userID: 'user-1' }),
      tempDir(),
      '处理告警',
      false,
      '',
    )
    await settleN(3)

    expect(p.addedKey).toBe('')
  })
})

describe('coalesce bookkeeping', () => {
  it('recordMonitorChild stores dir and spawn time', () => {
    const { e } = newMonitorEngine()
    const before = Date.now()
    e.monitor.recordMonitorChild('feishu:oc_c1:u', '/pay')
    const after = Date.now()
    const meta = e.monitor.childMeta['feishu:oc_c1:u']
    expect(meta?.dir).toBe('/pay')
    expect(meta?.spawnedAt).toBeGreaterThanOrEqual(before)
    expect(meta?.spawnedAt).toBeLessThanOrEqual(after)
  })

  it('pickCoalesceChild selects the newest same-dir child within the window', () => {
    const { e } = newMonitorEngine()
    e.monitor.coalesceWindowMs = 5 * 60_000
    const now = Date.now()
    const set = (key: string, dir: string, ageMs: number): void => {
      e.monitor.childMeta[key] = { dir, spawnedAt: now - ageMs }
    }

    set('c1', '/pay', 3 * 60_000)
    set('c2', '/pay', 60_000)
    expect(e.monitor.pickCoalesceChild(['c1', 'c2'], '/pay', now)).toBe('c2')

    expect(e.monitor.pickCoalesceChild(['c1', 'c2'], '/web', now)).toBe('')

    set('c3', '/pay', 10 * 60_000)
    expect(e.monitor.pickCoalesceChild(['c3'], '/pay', now)).toBe('')

    expect(e.monitor.pickCoalesceChild([], '/pay', now)).toBe('')
    expect(Object.keys(e.monitor.childMeta)).toHaveLength(0)

    expect(e.monitor.pickCoalesceChild(['c9'], '/pay', now)).toBe('')

    e.monitor.coalesceWindowMs = 0
    set('c4', '/pay', 99 * 3_600_000)
    expect(e.monitor.pickCoalesceChild(['c4'], '/pay', now)).toBe('c4')
  })
})

/** stub reactRemoverPlatform: ReactionManager recording removes (Go reactRemoverPlatform). */
function reactRemoverPlatform(): StubPlatform & {
  removes: string[]
  addReactionWithID(replyCtx: unknown, emoji: string): Promise<string>
  removeReaction(replyCtx: unknown, reactionID: string): Promise<void>
} {
  const base = createStubPlatform('feishu')
  const p = {
    ...base,
    removes: [] as string[],
    addReactionWithID: async (_rc: unknown, emoji: string) => `react-${emoji}`,
    removeReaction: async (_rc: unknown, reactionID: string) => {
      p.removes.push(reactionID)
    },
  }
  return p
}

describe('reaction cleanup regressions', () => {
  it('removes the picked-up reaction when the spawn fails', async () => {
    const p = reactRemoverPlatform()
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    setConfig(e, { chats: 'oc_x', maxConcurrent: 5 })

    await e.monitor.spawnMonitorSubgroup(
      p,
      msg({ content: '报错', sessionKey: 'feishu:oc_x:u1', messageID: 'om_1', replyCtx: 'rc' }),
      '/any',
      'task',
      false,
      'react-OnIt',
    )
    await settleN(3)

    expect(p.removes).toContain('react-OnIt')
  })

  it('removes the reaction when a stale clarification is dismissed', () => {
    const p = reactRemoverPlatform()
    const { e } = newMonitorEngine()
    const sk = 'feishu:oc_x:u1'
    e.sessions.getOrCreateActive(sk).setPendingMonitorClarification({
      origText: '原始告警',
      origTask: '',
      origMessageID: 'om_1',
      origReactionID: 'react-OnIt',
      origUserID: 'u1',
      images: [],
      origReplyCtx: 'rc',
      options: [{ label: '支付', dir: '/pay' }],
      askedAt: Date.now(),
    } satisfies MonitorClarification)
    e.sessions.save()

    expect(e.monitor.resolveMonitorClarification(p, msg({ sessionKey: sk, content: '新告警来了' }))).toBe(false)
    expect(p.removes).toContain('react-OnIt')
  })
})

describe('isMonitorCommand', () => {
  it('matches the exact command word only', () => {
    const cases: Array<[string, boolean]> = [
      ['/monitor', true],
      ['/monitor off', true],
      [' /monitor ', true],
      ['/monitoring', false],
      ['/mon', false],
      ['hello', false],
      ['', false],
    ]
    for (const [input, want] of cases) {
      expect(isMonitorCommand(input)).toBe(want)
    }
  })
})
