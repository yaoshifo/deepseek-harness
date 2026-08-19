import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ContinueSession,
  ForkSessionPrefix,
} from '../../src/core/types.js'
import {
  filterOwnedSessions,
  Session,
  SessionManager,
} from '../../src/engine/session.js'
import type { AgentSessionInfo } from '../../src/core/types.js'

// Ported from cc-connect core/session_test.go (51 Go cases incl. subtests).

async function tempSessionsPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fb-sessions-'))
  return join(dir, 'sessions.json')
}

describe('SessionManager', () => {
  it('GetOrCreateActive', () => {
    const sm = new SessionManager('')
    const s1 = sm.getOrCreateActive('user1')
    expect(s1, 'expected non-nil session').toBeDefined()
    const s2 = sm.getOrCreateActive('user1')
    expect(s1.id).toBe(s2.id)

    const s3 = sm.getOrCreateActive('user2')
    expect(s3.id).not.toBe(s1.id)
  })

  it('NewSession', () => {
    const sm = new SessionManager('')
    const s1 = sm.newSession('user1', 'chat-a')
    const s2 = sm.newSession('user1', 'chat-b')

    expect(s1.id).not.toBe(s2.id)
    expect(s1.name).toBe('chat-a')
    expect(s2.name).toBe('chat-b')

    const active = sm.getOrCreateActive('user1')
    expect(active.id).toBe(s2.id)
  })

  it('NewSideSession', () => {
    const sm = new SessionManager('')
    const main = sm.getOrCreateActive('user1')
    const side = sm.newSideSession('user1', 'cron-job')

    expect(side.id).not.toBe(main.id)
    expect(sm.activeSessionID('user1')).toBe(main.id)
    const list = sm.listSessions('user1')
    expect(list).toHaveLength(2)
  })

  it('SwitchSession', () => {
    const sm = new SessionManager('')
    const s1 = sm.newSession('user1', 'first')
    sm.newSession('user1', 'second')

    const switched = sm.switchSession('user1', s1.id)
    expect(switched.id).toBe(s1.id)
    expect(sm.activeSessionID('user1')).toBe(s1.id)
  })

  it('SwitchByName', () => {
    const sm = new SessionManager('')
    sm.newSession('user1', 'alpha')
    sm.newSession('user1', 'beta')

    const switched = sm.switchSession('user1', 'alpha')
    expect(switched.name).toBe('alpha')
  })

  it('SwitchNotFound', () => {
    const sm = new SessionManager('')
    sm.newSession('user1', 'only')
    expect(() => sm.switchSession('user1', 'nonexistent')).toThrow()
  })

  it('ListSessions', () => {
    const sm = new SessionManager('')
    sm.newSession('user1', 'a')
    sm.newSession('user1', 'b')
    sm.newSession('user2', 'c')

    expect(sm.listSessions('user1')).toHaveLength(2)
    expect(sm.listSessions('user2')).toHaveLength(1)
  })

  it('SessionNames', () => {
    const sm = new SessionManager('')
    sm.setSessionName('agent-123', 'my-chat')
    expect(sm.getSessionName('agent-123')).toBe('my-chat')

    sm.setSessionName('agent-123', '')
    expect(sm.getSessionName('agent-123')).toBe('')
  })

  it('Persistence', async () => {
    const path = await tempSessionsPath()

    const sm1 = new SessionManager(path)
    sm1.newSession('user1', 'persisted')
    sm1.setSessionName('agent-x', 'custom-name')

    const sm2 = new SessionManager(path)
    const list = sm2.listSessions('user1')
    expect(list).toHaveLength(1)
    expect(list[0]!.name).toBe('persisted')
    expect(sm2.getSessionName('agent-x')).toBe('custom-name')
  })

  // Regression: the save snapshot must persist ALL durable Session fields —
  // spawned/forked/subtask linkage previously vanished on save.
  it('PersistsParentAndWorktreeFields', async () => {
    const path = await tempSessionsPath()

    const sm1 = new SessionManager(path)
    const s = sm1.getOrCreateActive('feishu:child')
    s.setParentSessionKey('feishu:parent:ou_user')
    s.setParentChatName('Parent Chat')
    s.setSubtaskDepth(2)
    s.setSpawnUserID('ou_user')
    s.setWorktreeInfo('/wt/path', 'cc/branch', 'basesha', '/repo/root')
    s.setSubtaskReported(true)
    s.setUserInterjected(true)
    sm1.save()

    const sm2 = new SessionManager(path)
    const got = sm2.getOrCreateActive('feishu:child')
    expect(got.getSubtaskReported(), 'SubtaskReported lost on reload').toBe(true)
    expect(got.getParentSessionKey()).toBe('feishu:parent:ou_user')
    expect(got.getParentChatName()).toBe('Parent Chat')
    expect(got.getSubtaskDepth()).toBe(2)
    expect(got.getSpawnUserID()).toBe('ou_user')
    expect(got.getWorktreeInfo()).toEqual(['/wt/path', 'cc/branch', 'basesha', '/repo/root'])
    expect(got.getUserInterjected(), 'UserInterjected lost on reload').toBe(true)
  })

  it('SubtaskNoReport round-trips through persistence', async () => {
    const s = new Session()
    expect(s.getSubtaskNoReport(), 'default SubtaskNoReport should be false').toBe(false)
    s.setSubtaskNoReport(true)
    expect(s.getSubtaskNoReport()).toBe(true)

    const path = await tempSessionsPath()
    const sm1 = new SessionManager(path)
    const cs = sm1.getOrCreateActive('feishu:child')
    cs.setSubtaskNoReport(true)
    sm1.save()

    const sm2 = new SessionManager(path)
    expect(sm2.getOrCreateActive('feishu:child').getSubtaskNoReport()).toBe(true)
  })

  describe('ShouldSuppressAutoRender', () => {
    it.each([
      { name: 'top-level', setup: (_s: Session) => {}, want: false },
      { name: 'spawn-fork child', setup: (s: Session) => { s.setParentSessionKey('feishu:parent:ou_user') }, want: false },
      { name: 'chatroom role', setup: (s: Session) => { s.setChatroomHubKey('feishu:hub:ou_user') }, want: true },
      { name: 'subtask depth 1', setup: (s: Session) => { s.setSubtaskDepth(1) }, want: true },
      { name: 'subtask depth 2', setup: (s: Session) => { s.setSubtaskDepth(2) }, want: true },
      {
        name: 'subtask plus chatroom',
        setup: (s: Session) => {
          s.setSubtaskDepth(1)
          s.setChatroomHubKey('feishu:hub:ou_user')
        },
        want: true,
      },
      {
        name: 'monitor child depth 1',
        setup: (s: Session) => {
          s.setSubtaskDepth(1)
          s.setMonitorChild(true)
        },
        want: false,
      },
      {
        name: 'monitor child depth 2',
        setup: (s: Session) => {
          s.setSubtaskDepth(2)
          s.setMonitorChild(true)
        },
        want: false,
      },
      {
        name: 'monitor child + user interjected',
        setup: (s: Session) => {
          s.setSubtaskDepth(1)
          s.setMonitorChild(true)
          s.setUserInterjected(true)
        },
        want: false,
      },
      {
        name: 'subtask + user interjected',
        setup: (s: Session) => {
          s.setSubtaskDepth(1)
          s.setUserInterjected(true)
        },
        want: false,
      },
      {
        name: 'chatroom + user interjected',
        setup: (s: Session) => {
          s.setChatroomHubKey('feishu:hub:ou_user')
          s.setUserInterjected(true)
        },
        want: false,
      },
    ])('$name', ({ setup, want }) => {
      const sm = new SessionManager('')
      const s = sm.getOrCreateActive('feishu:x')
      setup(s)
      expect(s.shouldSuppressAutoRender()).toBe(want)
    })
  })

  // /new must inherit the chat-scoped SpawnUserID from the previous active
  // session — otherwise subtask spawn in a spawned group loses the caller.
  it('NewSession inherits SpawnUserID', async () => {
    const path = await tempSessionsPath()

    const sm = new SessionManager(path)
    const key = 'feishu:oc_spawned'
    const first = sm.getOrCreateActive(key)
    first.setSpawnUserID('ou_caller')

    const next = sm.newSession(key, '')
    expect(next.getSpawnUserID()).toBe('ou_caller')
    expect(next.id).not.toBe(first.id)
  })

  it('GetOrCreateActive persists', async () => {
    const path = await tempSessionsPath()

    const sm1 = new SessionManager(path)
    const s = sm1.getOrCreateActive('user1')

    const sm2 = new SessionManager(path)
    const list = sm2.listSessions('user1')
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe(s.id)
  })
})

describe('Session', () => {
  it('TryLockUnlock', () => {
    const s = new Session()
    expect(s.tryLock(), 'first TryLock should succeed').toBe(true)
    expect(s.tryLock(), 'second TryLock should fail').toBe(false)
    s.unlock()
    expect(s.tryLock(), 'TryLock after Unlock should succeed').toBe(true)
  })

  it('History', () => {
    const s = new Session()
    s.addHistory('user', 'hello')
    s.addHistory('assistant', 'hi there')
    s.addHistory('user', 'bye')

    expect(s.getHistory(0)).toHaveLength(3)

    const last2 = s.getHistory(2)
    expect(last2).toHaveLength(2)
    expect(last2[0]!.content).toBe('hi there')

    s.clearHistory()
    expect(s.getHistory(0)).toHaveLength(0)
  })

  it('HistoryCapped', () => {
    const s = new Session()
    const max = 100
    for (let i = 0; i < max + 50; i++) s.addHistory('user', `msg-${i}`)
    const all = s.getHistory(0)
    expect(all).toHaveLength(max)
    expect(all[all.length - 1]!.content).toBe(`msg-${max + 49}`)
    expect(all[0]!.content).toBe('msg-50')
  })

  it('ConcurrentHistory', async () => {
    const s = new Session()
    await Promise.all(Array.from({ length: 50 }, () => new Promise<void>((resolve) => { s.addHistory('user', 'msg'); resolve() })))
    expect(s.getHistory(0)).toHaveLength(50)
  })

  it('GetAgentSessionID', () => {
    const s = new Session()
    expect(s.getAgentSessionID()).toBe('')
    s.setAgentSessionID('sess-1', 'test')
    expect(s.getAgentSessionID()).toBe('sess-1')
  })

  it('SetAgentSessionID rejects ContinueSession sentinel', () => {
    const s = new Session()
    s.setAgentSessionID('real', 'ag')
    s.setAgentSessionID(ContinueSession, 'ag')
    expect(s.getAgentSessionID()).toBe('real')
    s.setAgentSessionID('', '')
    expect(s.getAgentSessionID()).toBe('')
  })

  it('CompareAndSet overrides fork sentinel', () => {
    const s = new Session()
    s.setAgentSessionID(ForkSessionPrefix + 'orig123', 'ag')
    expect(s.getAgentSessionID()).toBe(ForkSessionPrefix + 'orig123')
    expect(s.compareAndSetAgentSessionID('forkedF', 'ag')).toBe(true)
    expect(s.getAgentSessionID()).toBe('forkedF')
    expect(s.compareAndSetAgentSessionID('other', 'ag')).toBe(false)
  })

  it('CompareAndSet replaces ContinueSession sentinel', () => {
    const s = new Session()
    s.agentSessionID = ContinueSession
    expect(s.compareAndSetAgentSessionID('uuid-1', 'pi')).toBe(true)
    expect(s.getAgentSessionID()).toBe('uuid-1')
    expect(s.compareAndSetAgentSessionID('uuid-2', 'pi')).toBe(false)
  })

  it('SetAgentInfo normalizes ContinueSession sentinel', () => {
    const s = new Session()
    s.setAgentInfo(ContinueSession, 'pi', 'n')
    expect(s.getAgentSessionID()).toBe('')
  })

  it('Load sanitizes ContinueSession sentinel', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-load-'))
    const path = join(dir, 'sessions.json')
    const raw = `{
  "sessions": {
    "s1": {
      "id": "s1",
      "name": "default",
      "agent_session_id": "__continue__",
      "agent_type": "pi",
      "history": [],
      "created_at": "2020-01-01T00:00:00Z",
      "updated_at": "2020-01-01T00:00:00Z"
    }
  },
  "active_session": {"user1": "s1"},
  "user_sessions": {"user1": ["s1"]},
  "counter": 1
}`
    await writeFile(path, raw, 'utf8')
    const sm = new SessionManager(path)
    expect(sm.getOrCreateActive('user1').getAgentSessionID()).toBe('')
  })

  it('Save strips ContinueSession sentinel', async () => {
    const path = await tempSessionsPath()
    const sm = new SessionManager(path)
    sm.newSession('u1', 'x')
    const s = sm.getOrCreateActive('u1')
    s.agentSessionID = ContinueSession
    s.agentType = 'pi'
    sm.save()
    const sm2 = new SessionManager(path)
    expect(sm2.getOrCreateActive('u1').getAgentSessionID()).toBe('')
  })

  it('GetName', () => {
    const s = new Session()
    s.name = 'test-session'
    expect(s.getName()).toBe('test-session')
  })

  it('SetNameRaceFree', async () => {
    const s = new Session()
    s.name = 'initial'
    await Promise.all([
      ...Array.from({ length: 100 }, (_, i) => new Promise<void>((resolve) => { s.setName(`name-${i}`); resolve() })),
      ...Array.from({ length: 100 }, () => new Promise<string>((resolve) => { resolve(s.getName()) })),
    ])
  })

  it('ConcurrentGetSet', async () => {
    const s = new Session()
    await Promise.all(Array.from({ length: 100 }, () => new Promise<void>((resolve) => { s.setAgentSessionID('id', 'test'); resolve() })))
    expect(s.getAgentSessionID()).toBe('id')
  })
})

describe('SessionManager agent invalidation', () => {
  it('InvalidateForAgent', () => {
    const sm = new SessionManager('')

    const s1 = sm.newSession('user1', 'sess1')
    s1.setAgentSessionID('old-id-1', 'opencode')

    const s2 = sm.newSession('user2', 'sess2')
    s2.setAgentSessionID('old-id-2', 'claudecode')

    const s3 = sm.newSession('user3', 'sess3')
    s3.setAgentSessionID('old-id-3', '')

    sm.newSession('user4', 'sess4')

    sm.invalidateForAgent('claudecode')

    expect(s1.getAgentSessionID()).toBe('')
    expect(s1.agentType).toBe('claudecode')

    expect(s2.getAgentSessionID()).toBe('old-id-2')
    expect(s2.agentType).toBe('claudecode')

    expect(s3.getAgentSessionID()).toBe('old-id-3')
    expect(s3.agentType).toBe('')

    expect(sm.newSession('user4', 'again').getAgentSessionID()).toBe('')
  })

  it('UserMeta', () => {
    const sm = new SessionManager('')
    sm.getOrCreateActive('feishu:oc_abc:ou_xyz')

    sm.updateUserMeta('feishu:oc_abc:ou_xyz', 'Zhang San', '')
    let meta = sm.getUserMeta('feishu:oc_abc:ou_xyz')
    expect(meta?.userName).toBe('Zhang San')
    expect(meta?.chatName).toBe('')

    sm.updateUserMeta('feishu:oc_abc:ou_xyz', '', 'Test Group')
    meta = sm.getUserMeta('feishu:oc_abc:ou_xyz')
    expect(meta?.userName).toBe('Zhang San')
    expect(meta?.chatName).toBe('Test Group')

    sm.updateUserMeta('feishu:oc_abc:ou_xyz', '', '')
    meta = sm.getUserMeta('feishu:oc_abc:ou_xyz')
    expect(meta?.userName).toBe('Zhang San')
    expect(meta?.chatName).toBe('Test Group')

    expect(sm.getUserMeta('nonexistent')).toBeUndefined()
  })

  it('UserMetaPersistence', async () => {
    const path = await tempSessionsPath()

    const sm1 = new SessionManager(path)
    sm1.newSession('feishu:oc_abc:ou_xyz', 'test')
    sm1.updateUserMeta('feishu:oc_abc:ou_xyz', 'Zhang San', 'Group Name')
    sm1.save()

    const sm2 = new SessionManager(path)
    const meta = sm2.getUserMeta('feishu:oc_abc:ou_xyz')
    expect(meta?.userName).toBe('Zhang San')
    expect(meta?.chatName).toBe('Group Name')
  })

  it('DeleteByAgentSessionID', () => {
    const sm = new SessionManager('')

    const s1 = sm.newSession('user1', 'one')
    s1.setAgentSessionID('agent-1', 'codex')
    const s2 = sm.newSession('user2', 'two')
    s2.setAgentSessionID('agent-2', 'codex')
    const s3 = sm.newSession('user3', 'three')
    s3.setAgentSessionID('agent-1', 'codex')

    expect(sm.deleteByAgentSessionID('agent-1')).toBe(2)
    expect(sm.findByID(s1.id)).toBeUndefined()
    expect(sm.findByID(s3.id)).toBeUndefined()
    expect(sm.findByID(s2.id)).toBeDefined()
    expect(sm.activeSessionID('user1')).toBe('')
    expect(sm.activeSessionID('user3')).toBe('')
    const list = sm.listSessions('user2')
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe(s2.id)

    expect(sm.deleteByAgentSessionID('missing')).toBe(0)
  })

  it('StorePath', () => {
    expect(new SessionManager('/var/data/sessions').storePath()).toBe('/var/data/sessions')
    expect(new SessionManager('').storePath()).toBe('')
  })

  it('KnownAgentSessionIDs', () => {
    const sm = new SessionManager('')
    const s1 = sm.newSession('user1', 'a')
    s1.setAgentSessionID('uuid-aaa', 'claude')
    const s2 = sm.newSession('user1', 'b')
    s2.setAgentSessionID('uuid-bbb', 'claude')
    sm.newSession('user1', 'c')

    const known = sm.knownAgentSessionIDs()
    expect(known).not.toBeNull()
    expect(Object.keys(known)).toHaveLength(2)
    expect('uuid-aaa' in known).toBe(true)
    expect('uuid-bbb' in known).toBe(true)
  })
})

describe('filterOwnedSessions', () => {
  it('ReturnsOwnedOnly', () => {
    const all: AgentSessionInfo[] = [
      { id: 'owned-1', summary: '', messageCount: 0, modifiedAt: 0 },
      { id: 'external-1', summary: '', messageCount: 0, modifiedAt: 0 },
      { id: 'owned-2', summary: '', messageCount: 0, modifiedAt: 0 },
      { id: 'external-2', summary: '', messageCount: 0, modifiedAt: 0 },
    ]
    const known: Record<string, true> = { 'owned-1': true, 'owned-2': true }
    const filtered = filterOwnedSessions(all, known)
    expect(filtered).toHaveLength(2)
    for (const s of filtered) expect(s.id in known).toBe(true)
  })

  it('EmptyKnownReturnsAll', () => {
    const all: AgentSessionInfo[] = [
      { id: 'session-1', summary: '', messageCount: 0, modifiedAt: 0 },
      { id: 'session-2', summary: '', messageCount: 0, modifiedAt: 0 },
    ]
    expect(filterOwnedSessions(all, {})).toHaveLength(2)
  })
})

describe('SwitchToAgentSession', () => {
  it('PreservesOldSession', () => {
    const sm = new SessionManager('')
    const userKey = 'user:alice'

    const s1 = sm.getOrCreateActive(userKey)
    s1.setAgentInfo('agent-A', 'claude', 'session A')

    expect('agent-A' in (sm.knownAgentSessionIDs() ?? {})).toBe(true)

    const s2 = sm.switchToAgentSession(userKey, 'agent-B', 'claude', 'session B')
    expect(s2.getAgentSessionID()).toBe('agent-B')

    const known = sm.knownAgentSessionIDs() ?? {}
    expect('agent-A' in known).toBe(true)
    expect('agent-B' in known).toBe(true)
  })

  it('ReusesExisting', () => {
    const sm = new SessionManager('')
    const userKey = 'user:bob'

    const s1 = sm.getOrCreateActive(userKey)
    s1.setAgentInfo('agent-A', 'claude', 'session A')

    sm.switchToAgentSession(userKey, 'agent-B', 'claude', 'session B')

    const s3 = sm.switchToAgentSession(userKey, 'agent-A', 'claude', 'session A')
    expect(s3.id).toBe(s1.id)
  })
})

describe('PastAgentSessionIDs', () => {
  it('ClearPreservesHistory', () => {
    const s = new Session()
    s.setAgentSessionID('thread-1', 'codex')
    s.setAgentSessionID('', '')
    expect(s.pastAgentSessionIDs).toEqual(['thread-1'])
  })

  it('ReplacePreservesHistory', () => {
    const s = new Session()
    s.setAgentSessionID('thread-1', 'codex')
    s.setAgentSessionID('thread-2', 'codex')
    expect(s.pastAgentSessionIDs).toEqual(['thread-1'])
    expect(s.agentSessionID).toBe('thread-2')
  })

  it('NoDuplicates', () => {
    const s = new Session()
    s.setAgentSessionID('thread-1', 'codex')
    s.setAgentSessionID('', '')
    s.setAgentSessionID('thread-1', 'codex')
    s.setAgentSessionID('', '')
    expect(s.pastAgentSessionIDs).toHaveLength(1)
  })

  it('ContinueSentinelNotRecorded', () => {
    const s = new Session()
    s.setAgentSessionID(ContinueSession, 'codex')
    s.setAgentSessionID('real-id', 'codex')
    s.setAgentSessionID('', '')
    expect(s.pastAgentSessionIDs.includes(ContinueSession)).toBe(false)
    expect(s.pastAgentSessionIDs).toEqual(['real-id'])
  })

  it('SetAgentInfoPreservesHistory', () => {
    const s = new Session()
    s.setAgentInfo('thread-1', 'codex', 'session 1')
    s.setAgentInfo('thread-2', 'codex', 'session 2')
    expect(s.pastAgentSessionIDs).toEqual(['thread-1'])
  })

  it('KnownAgentSessionIDsIncludesPast', () => {
    const sm = new SessionManager('')
    const s1 = sm.newSession('user1', 'a')
    s1.setAgentSessionID('thread-aaa', 'codex')
    s1.setAgentSessionID('', '')

    const s2 = sm.newSession('user1', 'b')
    s2.setAgentSessionID('thread-bbb', 'codex')

    const known = sm.knownAgentSessionIDs() ?? {}
    expect('thread-aaa' in known).toBe(true)
    expect('thread-bbb' in known).toBe(true)
  })

  it('ReproducesNewCommandBug', () => {
    const sm = new SessionManager('')
    const userKey = 'user:test'
    const agentSessions: AgentSessionInfo[] = [
      { id: 'codex-thread-1', summary: '', messageCount: 0, modifiedAt: 0 },
      { id: 'codex-thread-2', summary: '', messageCount: 0, modifiedAt: 0 },
      { id: 'codex-thread-3', summary: '', messageCount: 0, modifiedAt: 0 },
    ]

    const s1 = sm.getOrCreateActive(userKey)
    s1.setAgentSessionID('codex-thread-1', 'codex')

    s1.setAgentSessionID('', '')
    const s2 = sm.newSession(userKey, 'session 2')
    s2.setAgentSessionID('codex-thread-2', 'codex')

    s2.setAgentSessionID('', '')
    const s3 = sm.newSession(userKey, 'session 3')
    s3.setAgentSessionID('codex-thread-3', 'codex')

    const known = sm.knownAgentSessionIDs() ?? {}
    expect(filterOwnedSessions(agentSessions, known)).toHaveLength(3)
  })

  it('ResetAllSessionsBug', () => {
    const sm = new SessionManager('')
    const userKey = 'user:test'

    const s1 = sm.newSession(userKey, 'a')
    s1.setAgentSessionID('thread-1', 'codex')
    const s2 = sm.newSession(userKey, 'b')
    s2.setAgentSessionID('thread-2', 'codex')
    const s3 = sm.newSession(userKey, 'c')
    s3.setAgentSessionID('thread-3', 'codex')

    for (const s of sm.allSessions()) s.setAgentSessionID('', '')

    const known = sm.knownAgentSessionIDs() ?? {}
    for (const id of ['thread-1', 'thread-2', 'thread-3']) expect(id in known).toBe(true)

    const agentSessions: AgentSessionInfo[] = [
      { id: 'thread-1', summary: '', messageCount: 0, modifiedAt: 0 },
      { id: 'thread-2', summary: '', messageCount: 0, modifiedAt: 0 },
      { id: 'thread-3', summary: '', messageCount: 0, modifiedAt: 0 },
    ]
    expect(filterOwnedSessions(agentSessions, known)).toHaveLength(3)
  })

  it('Persistence', async () => {
    const path = await tempSessionsPath()

    const sm1 = new SessionManager(path)
    const s = sm1.newSession('user1', 'test')
    s.setAgentSessionID('thread-old', 'codex')
    s.setAgentSessionID('thread-new', 'codex')
    sm1.save()

    const sm2 = new SessionManager(path)
    const known = sm2.knownAgentSessionIDs() ?? {}
    expect('thread-old' in known).toBe(true)
    expect('thread-new' in known).toBe(true)
  })
})

describe('LegacyData', () => {
  it('DisablesFilter', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-legacy-'))
    const path = join(dir, 'sessions.json')
    const legacyJSON = `{
\t\t"sessions": {
\t\t\t"s1": {"id":"s1","name":"old","agent_session_id":"","history":null,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"},
\t\t\t"s2": {"id":"s2","name":"","agent_session_id":"","history":null,"created_at":"2026-01-02T00:00:00Z","updated_at":"2026-01-02T00:00:00Z"},
\t\t\t"s3": {"id":"s3","name":"active","agent_session_id":"thread-3","agent_type":"codex","history":null,"created_at":"2026-01-03T00:00:00Z","updated_at":"2026-01-03T00:00:00Z"}
\t\t},
\t\t"active_session": {"user1":"s3"},
\t\t"user_sessions": {"user1":["s1","s2","s3"]},
\t\t"counter": 3
\t}`
    await mkdir(dir, { recursive: true })
    await writeFile(path, legacyJSON, 'utf8')

    const sm = new SessionManager(path)
    const known = sm.knownAgentSessionIDs()
    expect(known, 'legacy data should return null to disable filter').toBeNull()

    const agentSessions: AgentSessionInfo[] = [
      { id: 'thread-1', summary: '', messageCount: 0, modifiedAt: 0 },
      { id: 'thread-2', summary: '', messageCount: 0, modifiedAt: 0 },
      { id: 'thread-3', summary: '', messageCount: 0, modifiedAt: 0 },
    ]
    expect(filterOwnedSessions(agentSessions, known)).toHaveLength(3)
  })

  it('NewDataEnablesFilter', async () => {
    const path = await tempSessionsPath()

    const sm1 = new SessionManager(path)
    const s1 = sm1.newSession('user1', 'a')
    s1.setAgentSessionID('thread-1', 'codex')
    sm1.newSession('user1', 'b')
    sm1.save()

    const sm2 = new SessionManager(path)
    const known = sm2.knownAgentSessionIDs()
    expect(known).not.toBeNull()
    expect('thread-1' in (known ?? {})).toBe(true)

    const agentSessions: AgentSessionInfo[] = [
      { id: 'thread-1', summary: '', messageCount: 0, modifiedAt: 0 },
      { id: 'external-1', summary: '', messageCount: 0, modifiedAt: 0 },
    ]
    const filtered = filterOwnedSessions(agentSessions, known)
    expect(filtered).toHaveLength(1)
    expect(filtered[0]!.id).toBe('thread-1')
  })

  it('PartiallyMigratedData', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-partial-'))
    const path = join(dir, 'sessions.json')
    const partialJSON = `{
\t\t"sessions": {
\t\t\t"s1": {"id":"s1","name":"default","agent_session_id":"","history":null,"created_at":"2026-03-26T22:25:56Z","updated_at":"2026-03-26T22:25:56Z"},
\t\t\t"s2": {"id":"s2","name":"","agent_session_id":"","history":null,"created_at":"2026-04-18T09:02:57Z","updated_at":"2026-04-18T09:02:57Z"},
\t\t\t"s3": {"id":"s3","name":"active","agent_session_id":"thread-active","agent_type":"codex","past_agent_session_ids":["thread-old"],"history":null,"created_at":"2026-04-20T21:50:14Z","updated_at":"2026-04-20T21:50:14Z"}
\t\t},
\t\t"active_session": {"user1":"s3"},
\t\t"user_sessions":  {"user1":["s1","s2","s3"]},
\t\t"counter": 3,
\t\t"past_id_tracking": true
\t}`
    await writeFile(path, partialJSON, 'utf8')

    const sm = new SessionManager(path)
    const known = sm.knownAgentSessionIDs()
    expect(known, 'partially migrated data should disable filter').toBeNull()

    const agentSessions: AgentSessionInfo[] = [
      { id: 'thread-active', summary: '', messageCount: 0, modifiedAt: 0 },
      { id: 'thread-old', summary: '', messageCount: 0, modifiedAt: 0 },
      { id: 'other-1', summary: '', messageCount: 0, modifiedAt: 0 },
      { id: 'other-2', summary: '', messageCount: 0, modifiedAt: 0 },
    ]
    expect(filterOwnedSessions(agentSessions, known)).toHaveLength(4)
  })

  it('ClearsAfterFirstNewCommand', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-clear-'))
    const path = join(dir, 'sessions.json')
    const legacyJSON = `{
\t\t"sessions": {
\t\t\t"s1": {"id":"s1","name":"","agent_session_id":"thread-old","agent_type":"codex","history":null,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}
\t\t},
\t\t"active_session": {"user1":"s1"},
\t\t"user_sessions": {"user1":["s1"]},
\t\t"counter": 1
\t}`
    await writeFile(path, legacyJSON, 'utf8')

    const sm = new SessionManager(path)
    // Go: legacy mode tolerantly logs when the filter is disabled here.

    const s1 = sm.getOrCreateActive('user1')
    s1.setAgentSessionID('', '')
    const s2 = sm.newSession('user1', 'new')
    s2.setAgentSessionID('thread-new', 'codex')
    sm.save()

    const sm2 = new SessionManager(path)
    const known2 = sm2.knownAgentSessionIDs()
    expect(known2).not.toBeNull()
    expect('thread-old' in (known2 ?? {})).toBe(true)
    expect('thread-new' in (known2 ?? {})).toBe(true)
  })
})
