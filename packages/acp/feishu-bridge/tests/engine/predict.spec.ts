/**
 * Ported from cc-connect core/engine_predict.go + engine_predict_test.go
 * (#33 Predict Next, turn_summary, /btw): the /btw side-question fork, the
 * predict/summary generation line-picking, and the combined insight card.
 *
 * @module dsh-feishu-bridge/tests-predict
 */

import { describe, expect, it, vi } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.js'
import { ProjectStateStore } from '../../src/engine/project-state.js'
import {
  buildSummaryContext,
  defaultPredictPrompt,
  defaultSummaryPrompt,
  generatePrediction,
  generateTurnSummary,
  registerPredictCommands,
  sendInsightCard,
} from '../../src/engine/predict.js'
import type { Agent, ForkQuerierWithProvider, Message, RecentTurnsReader } from '../../src/core/types.js'
import {
  createStubAgent,
  createStubCardPlatform,
  newControllableSession,
  type StubCardPlatform,
} from '../stubs/engine-stubs.js'

function msg(overrides: Partial<Message> = {}): Message {
  return {
    sessionKey: 'test:chat-1',
    platform: 'test',
    messageID: '',
    userID: '',
    userName: '',
    chatName: '',
    chatType: '',
    content: '',
    originalContent: '',
    images: [],
    files: [],
    extraContent: '',
    replyCtx: 'ctx',
    fromVoice: false,
    isSpawnedGroup: false,
    isPermissionAction: false,
    isAskqCardAction: false,
    isCardAction: false,
    parentMessageID: '',
    quotedText: '',
    ...overrides,
  }
}

/** Agent with a recording ForkQuerier (Go stubForkQuerierAgent). */
type ForkAgent = Agent & ForkQuerierWithProvider & { gotSessionID: string; gotWorkDir: string; gotPrompt: string; calls: number }

function forkAgent(resp: string): ForkAgent {
  const rec: ForkAgent = {
    gotSessionID: '',
    gotWorkDir: '',
    gotPrompt: '',
    calls: 0,
    ...createStubAgent(),
    forkQuery: async (sessionID: string, question: string, workDir: string) => {
      rec.gotSessionID = sessionID
      rec.gotWorkDir = workDir
      rec.gotPrompt = question
      rec.calls++
      return resp
    },
    forkSessionWithProvider: async (sessionID: string, question: string) => {
      rec.gotSessionID = sessionID
      rec.gotPrompt = question
      rec.calls++
      return resp
    },
    lightweightQuery: async (prompt: string) => {
      rec.gotPrompt = prompt
      rec.calls++
      return resp
    },
  }
  return rec
}

function newEngine(agent: Agent, p: StubCardPlatform): { e: Engine; dispose: () => void } {
  const e = new Engine('test', agent, [p], '', 'en')
  const dispose = registerPredictCommands(e)
  return { e, dispose }
}

// ── /btw (engine_predict_test.go) ────────────────────────────────────────

describe('/btw', () => {
  it('passes the session workdir to the fork query (workspace override)', async () => {
    const p = createStubCardPlatform('feishu')
    const agent = forkAgent('btw-ok')
    const { e, dispose } = newEngine(agent, p)
    const sessionKey = 'feishu:oc_books'
    const state = new InteractiveState()
    state.agentSession = newControllableSession('live-sid')
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set(sessionKey, state)
    // The workspace-dir override the session runs under (Go state.workspaceDir
    // comes from /spawn --dir; here the per-chat override store carries it).
    e.setProjectStateStore(new ProjectStateStore(''))
    e.projectState?.setWorkspaceDirOverride('feishu:oc_books', '/home/hm/workspace/books')

    expect(e.dispatchCommand(p, msg({ sessionKey }), '/btw 这本书读完了吗？')).toBe(true)
    await vi.waitFor(() => { expect(agent.calls).toBe(1) })

    expect(agent.gotWorkDir).toBe('/home/hm/workspace/books')
    expect(agent.gotSessionID).toBe('live-sid')
    dispose()
  })

  it('forks the persisted session when no live state exists', async () => {
    const p = createStubCardPlatform('feishu')
    const agent = forkAgent('btw-ok')
    const { e, dispose } = newEngine(agent, p)
    const sessionKey = 'feishu:oc_books'
    // No interactiveState at all — the first /btw after a restart.
    e.sessions.getOrCreateActive(sessionKey).setAgentSessionID('persisted-sid', 'dsh')

    expect(e.dispatchCommand(p, msg({ sessionKey }), '/btw 还剩多少')).toBe(true)
    await vi.waitFor(() => { expect(agent.calls).toBe(1) })

    expect(agent.gotSessionID).toBe('persisted-sid')
    dispose()
  })

  it('replies with an error instead of polluting the main conversation', () => {
    const p = createStubCardPlatform('feishu')
    const agent = forkAgent('btw-ok')
    const { e, dispose } = newEngine(agent, p)
    // No interactiveState and no persisted session.

    expect(e.dispatchCommand(p, msg({ sessionKey: 'feishu:oc_books' }), '/btw 还剩多少')).toBe(true)

    expect(agent.calls).toBe(0)
    const sent = p.getSent()
    expect(sent.length).toBe(1)
    expect(sent[0]).toContain(e.i18n.t('btw_no_session'))
    dispose()
  })

  it('replies empty for a bare /btw', () => {
    const p = createStubCardPlatform('feishu')
    const { e, dispose } = newEngine(forkAgent(''), p)

    expect(e.dispatchCommand(p, msg(), '/btw')).toBe(true)
    expect(p.getSent()).toEqual([e.i18n.t('btw_empty')])
    dispose()
  })

  it('runs the fork in the session worktree dir when the session has one', async () => {
    const p = createStubCardPlatform('feishu')
    const agent = forkAgent('btw-ok')
    const { e, dispose } = newEngine(agent, p)
    const sessionKey = 'feishu:oc_wt'
    const s = e.sessions.getOrCreateActive(sessionKey)
    s.setAgentSessionID('wt-sid', 'dsh')
    s.setWorktreeInfo('/wt/path', 'branch', 'base', 'root', '')

    expect(e.dispatchCommand(p, msg({ sessionKey }), '/btw 状态')).toBe(true)
    await vi.waitFor(() => { expect(agent.calls).toBe(1) })

    expect(agent.gotWorkDir).toBe('/wt/path')
    dispose()
  })
})

// ── generation (engine_predict.go) ───────────────────────────────────────

describe('generatePrediction', () => {
  it('uses lightweightQuery with the compact context in lightweight mode', async () => {
    const p = createStubCardPlatform('test')
    const agent = forkAgent('line1\nline2')
    const { e, dispose } = newEngine(agent, p)
    e.setPredictNextConfig(true, 'mimo', 'mimo-xl', 1000, '', 'lightweight')

    const out = await generatePrediction(e, 'User: hi\n', 'sid-1', '/w')
    expect(out).toBe('line1')
    expect(agent.gotPrompt).toContain('User: hi')
    expect(agent.gotPrompt).toContain(defaultPredictPrompt)
    expect(agent.gotPrompt).not.toContain('sid-1')
    dispose()
  })

  it('uses forkSessionWithProvider in resume mode', async () => {
    const p = createStubCardPlatform('test')
    let forked: string[] = []
    const agent: Agent & ForkQuerierWithProvider = {
      ...createStubAgent(),
      forkQuery: async () => '',
      forkSessionWithProvider: async (sessionID: string, question: string, provider: string) => {
        forked = [sessionID, question, provider]
        return '预测结果'
      },
      lightweightQuery: async () => '',
    }
    const { e, dispose } = newEngine(agent, p)
    e.setPredictNextConfig(true, 'mimo', '', 1000, '', 'resume')

    const out = await generatePrediction(e, 'ignored', 'sid-9', '/w')
    expect(out).toBe('预测结果')
    expect(forked).toEqual(['sid-9', defaultPredictPrompt, 'mimo'])
    dispose()
  })

  it('skips blank and oversized lines', async () => {
    const p = createStubCardPlatform('test')
    const agent = forkAgent('\n' + 'x'.repeat(201) + '\nshort')
    const { e, dispose } = newEngine(agent, p)
    e.setPredictNextConfig(true, 'mimo', '', 1000, '', 'lightweight')

    expect(await generatePrediction(e, '', 's', '')).toBe('short')
    dispose()
  })

  it('honors a custom prompt', async () => {
    const p = createStubCardPlatform('test')
    const agent = forkAgent('ok')
    const { e, dispose } = newEngine(agent, p)
    e.setPredictNextConfig(true, 'mimo', '', 1000, 'CUSTOM PROMPT', 'lightweight')

    await generatePrediction(e, 'User: q\n', 's', '')
    expect(agent.gotPrompt).toContain('CUSTOM PROMPT')
    expect(agent.gotPrompt).not.toContain(defaultPredictPrompt)
    dispose()
  })
})

describe('generateTurnSummary', () => {
  it('builds the summary context and returns the first short line', async () => {
    const p = createStubCardPlatform('test')
    const agent = forkAgent('重构了 provider.ts\n多余行')
    const { e, dispose } = newEngine(agent, p)
    e.setTurnSummaryConfig(true, 'mimo', 1000, '')

    const history = [
      { role: 'user' as const, content: '修一下 provider 切换的 bug', timestamp: '1' },
      { role: 'assistant' as const, content: '改了三处', timestamp: '2' },
    ]
    const out = await generateTurnSummary(e, history)
    expect(out).toBe('重构了 provider.ts')
    expect(agent.gotPrompt).toContain('User asked: 修一下 provider 切换的 bug')
    expect(agent.gotPrompt).toContain('Assistant replied: 改了三处')
    expect(agent.gotPrompt).toContain(defaultSummaryPrompt)
    dispose()
  })

  it('skips lines over 120 runes', async () => {
    const p = createStubCardPlatform('test')
    const agent = forkAgent('好'.repeat(121) + '\nok')
    const { e, dispose } = newEngine(agent, p)
    e.setTurnSummaryConfig(true, 'mimo', 1000, '')

    expect(await generateTurnSummary(e, [])).toBe('ok')
    dispose()
  })
})

describe('buildSummaryContext', () => {
  it('extracts the last user and assistant entries with caps', () => {
    const ctx = buildSummaryContext([
      { role: 'user' as const, content: 'first question', timestamp: '1' },
      { role: 'assistant' as const, content: 'first answer', timestamp: '2' },
      { role: 'user' as const, content: 'last question', timestamp: '3' },
      { role: 'assistant' as const, content: 'last answer', timestamp: '4' },
    ])
    expect(ctx).toBe('User asked: last question\nAssistant replied: last answer\n')
  })

  it('truncates long entries', () => {
    const long = 'x'.repeat(600)
    const ctx = buildSummaryContext([{ role: 'user' as const, content: long, timestamp: '1' }])
    expect(ctx.length).toBeLessThan(long.length)
    expect(ctx).toContain('...')
  })
})

// ── insight card ─────────────────────────────────────────────────────────

describe('sendInsightCard', () => {
  it('sends incrementally: summary-only first, then the combined card with buttons', async () => {
    const p = createStubCardPlatform('feishu')
    const { e, dispose } = newEngine(forkAgent(''), p)
    e.setPredictNextConfig(true, 'mimo', 'mimo-xl', 100, '', 'lightweight')
    const state = new InteractiveState()
    state.turnSeq = 3
    e.interactiveStates.set('test:chat-1', state)

    await sendInsightCard(e, Promise.resolve('总结一行'), Promise.resolve('预测一行'), p, 'ctx', 'test:chat-1', 3, 'mimo-xl')

    // Go parity: each fork arrival sends with what has landed so far.
    expect(p.sentCards.length).toBe(2)
    const first = JSON.stringify(p.sentCards[0])
    expect(first).toContain('总结一行')
    expect(first).not.toContain('预测一行')
    const combined = p.sentCards[1] as { header?: { title?: string }; elements?: Array<Record<string, unknown>> }
    expect(combined.header?.title).toContain('mimo-xl')
    const md = JSON.stringify(combined.elements)
    expect(md).toContain('总结一行')
    expect(md).toContain('预测一行')
    expect(md).toContain('发送')
    expect(md).toContain('屏蔽')
    dispose()
  })

  it('sends a summary-only card without action buttons', async () => {
    const p = createStubCardPlatform('feishu')
    const { e, dispose } = newEngine(forkAgent(''), p)
    e.setTurnSummaryConfig(true, 'mimo', 100, '')
    const state = new InteractiveState()
    state.turnSeq = 1
    e.interactiveStates.set('test:chat-1', state)

    await sendInsightCard(e, Promise.resolve('只有总结'), undefined, p, 'ctx', 'test:chat-1', 1, 'mimo')

    expect(p.sentCards.length).toBe(1)
    const md = JSON.stringify(p.sentCards[0])
    expect(md).toContain('只有总结')
    expect(md).not.toContain('发送')
    dispose()
  })

  it('discards a stale result from an older turn', async () => {
    const p = createStubCardPlatform('feishu')
    const { e, dispose } = newEngine(forkAgent(''), p)
    const state = new InteractiveState()
    state.turnSeq = 5 // newer than the trigger's seq
    e.interactiveStates.set('test:chat-1', state)

    await sendInsightCard(e, Promise.resolve('过期'), Promise.resolve('过期'), p, 'ctx', 'test:chat-1', 3, 'x')

    expect(p.sentCards.length).toBe(0)
    dispose()
  })

  it('sends nothing when neither fork resolves with content', async () => {
    const p = createStubCardPlatform('feishu')
    const { e, dispose } = newEngine(forkAgent(''), p)
    const state = new InteractiveState()
    state.turnSeq = 1
    e.interactiveStates.set('test:chat-1', state)

    const never = new Promise<string>(() => {})
    const timer = setTimeout(() => {}, 10_000) // keep the loop alive; aborted by the card deadline
    await sendInsightCard(e, never, never, p, 'ctx', 'test:chat-1', 1, 'x', 20)
    clearTimeout(timer)

    expect(p.sentCards.length).toBe(0)
    expect(p.getSent().length).toBe(0)
    dispose()
  })
})

// ── engine trigger ───────────────────────────────────────────────────────

describe('insight trigger on turn completion', () => {
  it('forks a prediction after a completed turn and sends the insight card', async () => {
    const p = createStubCardPlatform('feishu')
    // The turn context rides the agent's recent-turn window for the live session.
    const agent: Agent & RecentTurnsReader = {
      ...forkAgent('下一句预测'),
      recentTurns: async (id: string) => id === 's1'
        ? [{ role: 'user', content: '帮我修个 bug', timestamp: '2026-01-01T00:00:00Z' }]
        : [],
    }
    const { e, dispose } = newEngine(agent, p)
    e.setPredictNextConfig(true, 'mimo', '', 500, '', 'lightweight')
    const sessionKey = 'feishu:oc_1'
    const session = e.sessions.getOrCreateActive(sessionKey)
    const agentSession = newControllableSession('s1')
    const state = new InteractiveState()
    state.agentSession = agentSession
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set(sessionKey, state)

    agentSession.channel.push({ type: 'result', content: '修好了，改了三个文件，测试全绿。这个回复足够长以触发摘要跳过条件检查。', done: true })
    await e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)

    await vi.waitFor(() => { expect(p.sentCards.length).toBeGreaterThan(0) })
    const md = JSON.stringify(p.sentCards[0])
    expect(md).toContain('下一句预测')
    dispose()
  })

  it('skips the turn summary when the reply is already short', async () => {
    const p = createStubCardPlatform('feishu')
    const agent = forkAgent('预测')
    const { e, dispose } = newEngine(agent, p)
    e.setTurnSummaryConfig(true, 'mimo', 500, '')
    e.setPredictNextConfig(false, '', '', 0, '', 'lightweight')
    const sessionKey = 'feishu:oc_1'
    const session = e.sessions.getOrCreateActive(sessionKey)
    const agentSession = newControllableSession('s1')
    const state = new InteractiveState()
    state.agentSession = agentSession
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set(sessionKey, state)

    agentSession.channel.push({ type: 'result', content: '短的回复', done: true })
    await e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)
    await new Promise(resolve => setTimeout(resolve, 30))

    // The turn summary never forked: no card, and the fork agent was not asked.
    expect(p.sentCards.length).toBe(0)
    dispose()
  })

  it('does not run for silent (NO_REPLY) turns', async () => {
    const p = createStubCardPlatform('feishu')
    const agent = forkAgent('预测')
    const { e, dispose } = newEngine(agent, p)
    e.setPredictNextConfig(true, 'mimo', '', 500, '', 'lightweight')
    const sessionKey = 'feishu:oc_1'
    const session = e.sessions.getOrCreateActive(sessionKey)
    const agentSession = newControllableSession('s1')
    const state = new InteractiveState()
    state.agentSession = agentSession
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set(sessionKey, state)

    agentSession.channel.push({ type: 'result', content: 'NO_REPLY', done: true })
    await e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(agent.calls).toBe(0)
    dispose()
  })
})

describe('setPredictNextDisabled', () => {
  it('marks the session so predictions stop until /new', () => {
    const p = createStubCardPlatform('feishu')
    const { e, dispose } = newEngine(forkAgent(''), p)
    const state = new InteractiveState()
    e.interactiveStates.set('test:chat-1', state)

    e.setPredictNextDisabled('test:chat-1')

    expect(state.predictNextDisabled).toBe(true)
    dispose()
  })

  it('the act:/nopred card action disables predictions and confirms on the card', async () => {
    const p = createStubCardPlatform('feishu')
    const { e, dispose } = newEngine(forkAgent(''), p)
    const state = new InteractiveState()
    e.interactiveStates.set('test:chat-1', state)

    await e.handleCardAction(p, msg({ sessionKey: 'test:chat-1', isCardAction: true }), 'act:/nopred')

    expect(state.predictNextDisabled).toBe(true)
    expect(JSON.stringify(p.sentCards[0])).toContain('已屏蔽')
    dispose()
  })
})
