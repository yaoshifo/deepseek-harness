import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Engine, InteractiveState, stripUserID } from '../../src/engine/engine.js'
import { DirHistory } from '../../src/engine/dir-history.js'
import { ProjectStateStore } from '../../src/engine/project-state.js'
import { cmdDir, cmdList, cmdNew, cmdStatus, cmdStop, matchPrefix, matchSession, registerSessionCommands } from '../../src/engine/commands.js'
import type { Agent, AgentSessionInfo, Message } from '../../src/core/types.js'
import {
  createStubAgent,
  createStubPlatform,
  newControllableSession,
  type StubPlatform,
} from '../stubs/engine-stubs.js'

// Ported from cc-connect core/engine_test.go — /new /stop /sessions /switch
// (/resume) /dir (/cd) /status plain-text surfaces.

function msg(overrides: Partial<Message> = {}): Message {
  return {
    sessionKey: 'test:user1',
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
    parentMessageID: '',
    quotedText: '',
    ...overrides,
  }
}

function newEngine(agent?: Agent): { e: Engine; p: StubPlatform; dispose: () => void } {
  const p = createStubPlatform('test')
  const e = new Engine('test', agent ?? createStubAgent(), [p], '', 'en')
  const dispose = registerSessionCommands(e)
  return { e, p, dispose }
}

/** Agent with a settable workDir (Go stubWorkDirAgent). */
function workDirAgent(workDir: string): Agent & { getWorkDir(): string; setWorkDir(d: string): void } {
  let dir = workDir
  return {
    ...createStubAgent(),
    getWorkDir: () => dir,
    setWorkDir: (d: string) => { dir = d },
  }
}

/** Agent with a fixed session list (Go switchableAgent/stubListAgent). */
function listAgent(sessions: AgentSessionInfo[]): Agent {
  return {
    ...createStubAgent(),
    listSessions: async () => sessions,
  }
}


async function waitForSent(p: StubPlatform, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (p.sent.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 5) })
  }
}

describe('matchPrefix', () => {
  it('resolves canonical names and prefixes', () => {
    expect(matchPrefix('new')).toBe('new')
    expect(matchPrefix('sessions')).toBe('list')
    expect(matchPrefix('list')).toBe('list')
    expect(matchPrefix('switch')).toBe('switch')
    expect(matchPrefix('resume')).toBe('switch')
    expect(matchPrefix('cd')).toBe('dir')
    expect(matchPrefix('sta')).toBe('status')
    expect(matchPrefix('unknowncmd')).toBe('')
  })
})

describe('matchSession', () => {
  const sessions: AgentSessionInfo[] = [
    { id: 'abc-123-def', summary: 'First session', messageCount: 5, modifiedAt: 0 },
    { id: 'sess-bbb', summary: 'Second session', messageCount: 3, modifiedAt: 0 },
  ]

  it('resolves by numeric index', () => {
    expect(matchSession(sessions, { getSessionName: () => '' }, '2')?.id).toBe('sess-bbb')
  })

  it('resolves by ID prefix', () => {
    expect(matchSession(sessions, { getSessionName: () => '' }, 'abc-123')?.id).toBe('abc-123-def')
  })

  it('resolves by summary substring', () => {
    expect(matchSession(sessions, { getSessionName: () => '' }, 'second')?.id).toBe('sess-bbb')
  })

  it('returns undefined on no match', () => {
    expect(matchSession(sessions, { getSessionName: () => '' }, 'nonexistent')).toBeUndefined()
  })
})

describe('/status', () => {
  it('uses legacy text on a platform without card support', async () => {
    const { e, p, dispose } = newEngine()
    try {
      await cmdStatus(e, p, msg())
      expect(p.sent).toHaveLength(1)
      expect(p.sent[0]).toContain('Status')
      expect(p.sent[0]).not.toContain('[← Back]')
    } finally {
      dispose()
    }
  })
})

describe('/list', () => {
  it('uses legacy text on a platform without card support', async () => {
    const sessions: AgentSessionInfo[] = [
      { id: 'session-a', summary: 'First session', messageCount: 3, modifiedAt: Date.UTC(2026, 2, 11, 2, 0, 0) },
    ]
    const { e, p, dispose } = newEngine(listAgent(sessions))
    try {
      await cmdList(e, p, msg())
      expect(p.sent).toHaveLength(1)
      expect(p.sent[0]).toContain('Sessions')
      expect(p.sent[0]).not.toContain('[← 返回]')
    } finally {
      dispose()
    }
  })
})

describe('/switch', () => {
  it('no args shows usage', () => {
    const { e, p, dispose } = newEngine()
    try {
      e.receiveMessage(p, msg({ content: '/switch' }))
      expect(p.sent.some(s => s.includes('Usage') || s.includes('/switch'))).toBe(true)
    } finally {
      dispose()
    }
  })

  it('by index sets the session and cleans up state', async () => {
    const agent = listAgent([
      { id: 'sess-aaa', summary: 'First session', messageCount: 5, modifiedAt: 0 },
      { id: 'sess-bbb', summary: 'Second session', messageCount: 3, modifiedAt: 0 },
    ])
    const { e, p, dispose } = newEngine(agent)
    try {
      const key = 'test:ch:user1'
      const state = new InteractiveState()
      state.agentSession = newControllableSession('old')
      e.interactiveStates.set(key, state)

      e.receiveMessage(p, msg({ sessionKey: key, content: '/switch 2' }))
      await waitForSent(p)

      expect(p.sent.some(s => s.includes('Second session') || s.includes('sess-bbb'))).toBe(true)
      expect(e.interactiveStates.has(key)).toBe(false)
      expect(e.sessions.getOrCreateActive(key).getAgentSessionID()).toBe('sess-bbb')
    } finally {
      dispose()
    }
  })

  it('by ID prefix', async () => {
    const { e, p, dispose } = newEngine(listAgent([
      { id: 'abc-123-def', summary: 'Target session', messageCount: 1, modifiedAt: 0 },
    ]))
    try {
      e.receiveMessage(p, msg({ content: '/switch abc-123' }))
      await waitForSent(p)
      expect(p.sent.some(s => s.includes('Target session') || s.includes('abc-123'))).toBe(true)
    } finally {
      dispose()
    }
  })

  it('no match replies with the query', async () => {
    const { e, p, dispose } = newEngine(listAgent([
      { id: 'sess-111', summary: 'Only session', messageCount: 1, modifiedAt: 0 },
    ]))
    try {
      e.receiveMessage(p, msg({ content: '/switch nonexistent' }))
      await waitForSent(p)
      expect(p.sent.some(s => s.includes('nonexistent'))).toBe(true)
    } finally {
      dispose()
    }
  })

  it('by custom name', async () => {
    const { e, p, dispose } = newEngine(listAgent([
      { id: 'sess-named-1', summary: 'Unnamed', messageCount: 1, modifiedAt: 0 },
      { id: 'sess-named-2', summary: 'My Feature', messageCount: 1, modifiedAt: 0 },
    ]))
    try {
      e.sessions.setSessionName('sess-named-2', 'feature-branch')
      e.receiveMessage(p, msg({ content: '/switch feature-branch' }))
      await waitForSent(p)
      expect(p.sent.some(s => s.includes('My Feature') || s.includes('feature-branch') || s.includes('sess-named-2'))).toBe(true)
    } finally {
      dispose()
    }
  })
})

describe('/new', () => {
  it('clears the agent session ID and history, then creates a session', async () => {
    const { e, p, dispose } = newEngine()
    try {
      const key = 'test:user1'
      const s = e.sessions.getOrCreateActive(key)
      s.setAgentSessionID('existing', 'stub')
      s.addHistory('user', 'hello')
      const state = new InteractiveState()
      state.agentSession = newControllableSession('old')
      e.interactiveStates.set(key, state)

      await cmdNew(e, p, msg({ sessionKey: key }), [])

      expect(s.getAgentSessionID()).toBe('')
      expect(s.getHistory(0)).toHaveLength(0)
      expect(e.interactiveStates.has(key)).toBe(false)
      expect(p.sent).toHaveLength(1)
    } finally {
      dispose()
    }
  })
})

describe('/stop', () => {
  it('returns while close is blocked and stops the event loop', async () => {
    const { e, p, dispose } = newEngine()
    try {
      const key = 'test:user1'
      const session = e.sessions.getOrCreateActive(key)
      const sess = newControllableSession('stop-blocked')
      // Close blocks until released, mirroring Go blockingCloseAgentSession.
      let releaseClose: (() => void) | undefined
      let closeStartedResolve: (() => void) | undefined
      const closeStarted = new Promise<void>((resolve) => { closeStartedResolve = resolve })
      const origClose = sess.close.bind(sess)
      sess.close = async () => {
        closeStartedResolve?.()
        await new Promise<void>((resolve) => { releaseClose = resolve })
        await origClose()
      }

      const state = new InteractiveState()
      state.agentSession = sess
      state.platform = p
      state.replyCtx = 'ctx'
      e.interactiveStates.set(key, state)

      const done = e.processInteractiveEvents(state, session, e.sessions, key, 'msg-1', undefined, 'ctx')

      const stopDone = (async () => {
        if (cmdStop(e, p, msg({ sessionKey: key }))) {
          await e.reply(p, 'ctx', e.i18n.t('execution_stopped'))
        }
      })()

      await Promise.race([closeStarted, new Promise((_, reject) => { setTimeout(() => { reject(new Error('close never started')) }, 2000) })])

      await Promise.race([
        stopDone,
        new Promise((_, reject) => { setTimeout(() => { reject(new Error('cmdStop blocked on Close')) }, 500) }),
      ])

      await Promise.race([
        done,
        new Promise((_, reject) => { setTimeout(() => { reject(new Error('event loop did not stop')) }, 2000) }),
      ])

      expect(e.interactiveStates.has(key)).toBe(false)

      // Stale output after the stop must not reach the platform.
      sess.channel.push({ type: 'text', content: 'stale output', done: false })
      sess.channel.push({ type: 'result', content: 'stale result', done: true })
      await new Promise((resolve) => { setTimeout(resolve, 50) })

      expect(p.sent).toEqual([e.i18n.t('execution_stopped')])

      releaseClose?.()
      await origClose()
    } finally {
      dispose()
    }
  })
})

describe('/dir', () => {
  let temp: string

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'fb-dir-'))
  })

  afterEach(() => {
    // temp dirs are OS-cleaned; nothing to remove explicitly
  })

  it('shows the current directory', async () => {
    const { e, p, dispose } = newEngine(workDirAgent('/tmp/project-a'))
    try {
      await cmdDir(e, p, msg(), [])
      expect(p.sent).toHaveLength(1)
      expect(p.sent[0]).toContain('/tmp/project-a')
    } finally {
      dispose()
    }
  })

  it('switches the directory and resets the session', async () => {
    const nextDir = join(temp, 'next')
    await mkdir(nextDir)
    const statePath = join(temp, 'state', 'test.state.json')
    const store = new ProjectStateStore(statePath)

    const agent = workDirAgent(temp)
    const { e, p, dispose } = newEngine(agent)
    try {
      e.setProjectStateStore(store)
      const m = msg()
      const s = e.sessions.getOrCreateActive(m.sessionKey)
      s.setAgentSessionID('existing-session', 'test')
      s.addHistory('user', 'hello')

      await cmdDir(e, p, m, [nextDir])

      expect(store.workspaceDirOverride(stripUserID(m.sessionKey))).toBe(nextDir)
      expect(s.getAgentSessionID()).toBe('')
      expect(s.getHistory(0)).toHaveLength(0)
      expect(p.sent[0]).toContain(nextDir)
    } finally {
      dispose()
    }
  })

  it('rejects a missing directory', async () => {
    const missingDir = join(temp, 'missing')
    const agent = workDirAgent(temp)
    const { e, p, dispose } = newEngine(agent)
    try {
      await cmdDir(e, p, msg(), [missingDir])
      expect(agent.getWorkDir()).toBe(temp)
      expect(p.sent).toHaveLength(1)
      expect(p.sent[0]).toContain(missingDir)
    } finally {
      dispose()
    }
  })

  it('alias /cd still works via admin', async () => {
    const nextDir = join(temp, 'next')
    await mkdir(nextDir)
    const store = new ProjectStateStore(join(temp, 'state', 'test.state.json'))
    const { e, p, dispose } = newEngine(workDirAgent(temp))
    try {
      e.setProjectStateStore(store)
      e.setAdminFrom('admin1')
      const sk = 'test:user1'
      e.receiveMessage(p, msg({ sessionKey: sk, userID: 'admin1', content: `/cd ${nextDir}` }))
      await waitForSent(p)
      expect(store.workspaceDirOverride(stripUserID(sk))).toBe(nextDir)
    } finally {
      dispose()
    }
  })

  it('help shows usage', async () => {
    const { e, p, dispose } = newEngine(workDirAgent('/tmp/project-a'))
    try {
      await cmdDir(e, p, msg(), ['help'])
      expect(p.sent).toHaveLength(1)
      expect(p.sent[0]).toContain('/dir <path>')
    } finally {
      dispose()
    }
  })

  it('persists the absolute override', async () => {
    const baseDir = temp
    const nextDir = join(baseDir, 'next')
    await mkdir(nextDir)
    const statePath = join(temp, 'state', 'test.state.json')
    const store = new ProjectStateStore(statePath)

    const { e, p, dispose } = newEngine(workDirAgent(baseDir))
    try {
      e.setBaseWorkDir(baseDir)
      e.setProjectStateStore(store)
      const sk = 'test:user1'
      await cmdDir(e, p, msg({ sessionKey: sk }), [nextDir])

      const reloaded = new ProjectStateStore(statePath)
      expect(reloaded.workspaceDirOverride(stripUserID(sk))).toBe(nextDir)
    } finally {
      dispose()
    }
  })

  it('reset restores the base work dir and clears state', async () => {
    const baseDir = temp
    const overrideDir = join(baseDir, 'override')
    await mkdir(overrideDir)
    const statePath = join(temp, 'state', 'test.state.json')
    const store = new ProjectStateStore(statePath)

    const agent = workDirAgent(overrideDir)
    const { e, p, dispose } = newEngine(agent)
    try {
      e.setBaseWorkDir(baseDir)
      e.setProjectStateStore(store)
      const m = msg()
      const s = e.sessions.getOrCreateActive(m.sessionKey)
      s.setAgentSessionID('existing-session', 'test')
      s.setName('old')
      s.addHistory('user', 'hello')

      await cmdDir(e, p, m, ['reset'])

      expect(agent.getWorkDir()).toBe(overrideDir)
      const reloaded = new ProjectStateStore(statePath)
      expect(reloaded.workDirOverride()).toBe('')
      expect(reloaded.workspaceDirOverride(stripUserID(m.sessionKey))).toBe('')
      expect(s.getAgentSessionID()).toBe('')
      expect(s.getName()).toBe('old')
      expect(s.getHistory(0)).toHaveLength(0)
      expect(p.sent[0]?.toLowerCase()).toContain('default')
    } finally {
      dispose()
    }
  })

  it('switches by history index', async () => {
    const dir1 = join(temp, 'dir1')
    const dir2 = join(temp, 'dir2')
    const dir3 = join(temp, 'dir3')
    for (const d of [dir1, dir2, dir3]) await mkdir(d)

    const dataDir = join(temp, 'data')
    await mkdir(dataDir)
    const store = new ProjectStateStore(join(temp, 'state', 'test.state.json'))

    const { e, p, dispose } = newEngine(workDirAgent(dir1))
    try {
      e.setDirHistory(new DirHistory(dataDir))
      e.setProjectStateStore(store)
      const m = msg()
      const sk = m.sessionKey

      await cmdDir(e, p, m, [dir2])
      expect(store.workspaceDirOverride(stripUserID(sk))).toBe(dir2)
      await cmdDir(e, p, m, [dir3])
      expect(store.workspaceDirOverride(stripUserID(sk))).toBe(dir3)

      p.clearSent()
      await cmdDir(e, p, m, ['2'])
      expect(store.workspaceDirOverride(stripUserID(sk))).toBe(dir2)
      expect(p.sent[0]).toContain(dir2)
    } finally {
      dispose()
    }
  })

  it('displays correct indices', async () => {
    const dir1 = join(temp, 'dir1')
    const dir2 = join(temp, 'dir2')
    const dir3 = join(temp, 'dir3')
    for (const d of [dir1, dir2, dir3]) await mkdir(d)

    const dataDir = join(temp, 'data')
    await mkdir(dataDir)
    const { e, p, dispose } = newEngine(workDirAgent(dir1))
    try {
      e.setDirHistory(new DirHistory(dataDir))
      e.setProjectStateStore(new ProjectStateStore(join(temp, 'state', 'test.state.json')))
      const m = msg()

      await cmdDir(e, p, m, [dir2])
      await cmdDir(e, p, m, [dir3])

      p.clearSent()
      await cmdDir(e, p, m, [])
      expect(p.sent).toHaveLength(1)
      expect(p.sent[0]).toContain(`▶ 1. ${dir3}`)
      expect(p.sent[0]).toContain(`◻ 2. ${dir2}`)
    } finally {
      dispose()
    }
  })

  it('expands tilde', async () => {
    const homeDir = process.env.HOME ?? ''
    if (homeDir === '') return
    const store = new ProjectStateStore(join(temp, 'state', 'test.state.json'))
    const { e, dispose } = newEngine(workDirAgent(homeDir))
    try {
      e.setProjectStateStore(store)
      const sk = 'test:user1'
      const m = msg({ sessionKey: sk })
      for (const input of ['~', '~/']) {
        await cmdDir(e, createStubPlatform('test'), m, [input])
        expect(store.workspaceDirOverride(stripUserID(sk))).toBe(homeDir)
      }
    } finally {
      dispose()
    }
  })

  it('is gated behind admin', async () => {
    const { e, p, dispose } = newEngine(workDirAgent(temp))
    try {
      e.receiveMessage(p, msg({ sessionKey: 'test:u1', userID: 'user1', content: '/dir .' }))
      await waitForSent(p)
      expect(p.sent).toHaveLength(1)
      expect(p.sent[0]?.toLowerCase()).toContain('admin')
    } finally {
      dispose()
    }
  })
})
