/**
 * Ported from cc-connect core/engine_predict.go + engine_predict_test.go
 * (Go cmdBtw): the /btw side-question fork.
 *
 * @module dsh-feishu-bridge/tests-btw
 */

import { describe, expect, it, vi } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.ts'
import { ProjectStateStore } from '../../src/engine/project-state.ts'
import { registerBtwCommands } from '../../src/engine/btw.ts'
import type { Agent, ForkQuerierWithProvider, Message } from '../../src/core/types.ts'
import {
  createStubAgent,
  createStubCardPlatform,
  newControllableSession,
  type StubCardPlatform,
} from '../stubs/engine-stubs.ts'

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
type ForkAgent = Agent & ForkQuerierWithProvider & {
  gotSessionID: string
  gotWorkDir: string
  gotQueryWorkDir: string
  gotPrompt: string
  calls: number
}

function forkAgent(resp: string): ForkAgent {
  const rec: ForkAgent = {
    gotSessionID: '',
    gotWorkDir: '',
    gotQueryWorkDir: '',
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
    pollQuery: async () => '',
    lightweightQuery: async (prompt: string, _provider: string, _signal?: AbortSignal, workDir?: string) => {
      rec.gotPrompt = prompt
      rec.gotQueryWorkDir = workDir ?? ''
      rec.calls++
      return resp
    },
  }
  return rec
}

function newEngine(agent: Agent, p: StubCardPlatform): { e: Engine; dispose: () => void } {
  const e = new Engine('test', agent, [p], '', 'en')
  const dispose = registerBtwCommands(e)
  return { e, dispose }
}

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
