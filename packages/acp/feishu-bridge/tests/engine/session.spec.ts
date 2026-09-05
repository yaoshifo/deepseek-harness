import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ctxBridgeDispatch } from '../../src/bridge-service.ts'
import {
  ContinueSession,
  ForkSessionPrefix,
} from '../../src/core/types.ts'
import {
  Session,
  SessionManager,
} from '../../src/engine/session.ts'

// Ported from cc-connect core/session_test.go (51 Go cases incl. subtests).

/** The raw chatroom section of a session (opaque bag; written directly here). */
function chatroomSection(session: Session): Record<string, unknown> {
  let section = session.featureState.chatroom
  if (typeof section !== 'object' || section === null) {
    section = {}
    session.featureState.chatroom = section
  }
  return section as Record<string, unknown>
}

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

  it('SessionCleanup prunes expired sessions on save; active and fresh ones survive', async () => {
    // Go session_cleanup_days: cron new-per-run side sessions accumulate
    // forever otherwise — every full rewrite drops records idle beyond the
    // configured window while the chat's active session always survives.
    const sm = new SessionManager(await tempSessionsPath())
    sm.setCleanupDays(30)
    const main = sm.getOrCreateActive('user1')
    const side = sm.newSideSession('user1', 'cron-job')
    side.updatedAt = new Date(Date.now() - 40 * 24 * 3_600_000).toISOString()
    const other = sm.getOrCreateActive('user2')
    other.updatedAt = new Date(Date.now() - 3 * 24 * 3_600_000).toISOString()

    sm.save()

    expect(sm.listSessions('user1'), 'expired side session pruned, active survives').toHaveLength(1)
    expect(sm.listSessions('user2'), 'within the window survives').toHaveLength(1)
    expect(sm.activeSessionID('user1')).toBe(main.id)
  })

  it('SessionCleanup is off by default (0 days keeps everything)', async () => {
    const sm = new SessionManager(await tempSessionsPath())
    const main = sm.getOrCreateActive('user1')
    const side = sm.newSideSession('user1', 'cron-job')
    side.updatedAt = new Date(Date.now() - 400 * 24 * 3_600_000).toISOString()

    sm.save()

    expect(sm.listSessions('user1')).toHaveLength(2)
    expect(main).toBeDefined()
  })

  it('deleting a chat\'s last session leaves no empty array or orphaned names/meta in the snapshot', async () => {
    const path = await tempSessionsPath()
    const sm = new SessionManager(path)
    const s = sm.getOrCreateActive('feishu:chat1')
    s.setAgentSessionID('agent-1', 'stub')
    sm.setSessionName('agent-1', 'named')
    sm.updateUserMeta('feishu:chat1', 'User One', 'Chat One')

    expect(sm.deleteByID(s.id)).toBe(true)

    const snap = JSON.parse(await readFile(path, 'utf8')) as {
      userSessions: Record<string, string[]>
      sessionNames: Record<string, string>
      userMeta: Record<string, unknown>
    }
    expect(snap.userSessions, 'no empty array keys').toEqual({})
    expect(snap.sessionNames, 'the deleted session\'s name is unreachable').toEqual({})
    expect(snap.userMeta, 'the emptied chat\'s cached display meta is stale').toEqual({})
  })

  it('SessionCleanup drops a pruned session\'s name while the surviving chat keeps its satellites', async () => {
    const path = await tempSessionsPath()
    const sm = new SessionManager(path)
    sm.setCleanupDays(30)
    const main = sm.getOrCreateActive('feishu:chat1')
    main.setAgentSessionID('agent-main', 'stub')
    const side = sm.newSideSession('feishu:chat1', 'cron-job')
    side.setAgentSessionID('agent-side', 'stub')
    // Names are set while both sessions live; the side session ages out after.
    sm.setSessionName('agent-main', 'main name')
    sm.setSessionName('agent-side', 'side name')
    sm.updateUserMeta('feishu:chat1', 'User One', 'Chat One')
    side.updatedAt = new Date(Date.now() - 40 * 24 * 3_600_000).toISOString()

    sm.save()

    expect(sm.listSessions('feishu:chat1'), 'expired side session pruned, active survives').toHaveLength(1)
    const snap = JSON.parse(await readFile(path, 'utf8')) as {
      userSessions: Record<string, string[]>
      sessionNames: Record<string, string>
      userMeta: Record<string, unknown>
    }
    expect(snap.sessionNames, 'only the surviving session\'s name stays').toEqual({ 'agent-main': 'main name' })
    expect(snap.userSessions['feishu:chat1'], 'the surviving chat keeps its session list').toEqual([main.id])
    expect(snap.userMeta['feishu:chat1']).toBeDefined()
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
    s.setWorktreeInfo('/wt/path', 'cc/branch', 'basesha', '/repo/root', '')
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
    expect(got.getWorktreeInfo()).toEqual(['/wt/path', 'cc/branch', 'basesha', '/repo/root', ''])
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
      { name: 'chatroom role', setup: (s: Session) => { chatroomSection(s).chatroomHubKey = 'feishu:hub:ou_user' }, want: true },
      { name: 'subtask depth 1', setup: (s: Session) => { s.setSubtaskDepth(1) }, want: true },
      { name: 'subtask depth 2', setup: (s: Session) => { s.setSubtaskDepth(2) }, want: true },
      {
        name: 'subtask plus chatroom',
        setup: (s: Session) => {
          s.setSubtaskDepth(1)
          chatroomSection(s).chatroomHubKey = 'feishu:hub:ou_user'
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
          chatroomSection(s).chatroomHubKey = 'feishu:hub:ou_user'
          s.setUserInterjected(true)
        },
        want: false,
      },
    ])('$name', ({ setup, want }) => {
      const sm = new SessionManager('')
      const s = sm.getOrCreateActive('feishu:x')
      setup(s)
      // The chatroom rows ride an auto-render-policy listener shaped like the
      // chatroom package's production half (covered in its own package); the
      // subtask rows are the built-in base.
      const ctx = new Context()
      ctx.on('feishuBridge/auto-render-policy', (payload: { session: Session }, next: () => boolean) =>
        next() || chatroomSection(payload.session).chatroomHubKey !== undefined && chatroomSection(payload.session).chatroomHubKey !== '')
      expect(s.shouldSuppressAutoRender(ctxBridgeDispatch(ctx))).toBe(want)
      void Promise.allSettled([ctx.fiber.dispose()])
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
})

describe('SwitchToAgentSession', () => {
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

  it('Persistence', async () => {
    const path = await tempSessionsPath()

    const sm1 = new SessionManager(path)
    const s = sm1.newSession('user1', 'test')
    s.setAgentSessionID('thread-old', 'codex')
    s.setAgentSessionID('thread-new', 'codex')
    sm1.save()

    const sm2 = new SessionManager(path)
    // The replaced mapping stays resolvable after a reload.
    expect(sm2.findByAgentSessionID('thread-old')).toBeDefined()
    expect(sm2.findByAgentSessionID('thread-new')).toBeDefined()
  })
})

describe('Snapshot v3', () => {
  it('writes the camelCase v3 schema', async () => {
    const path = await tempSessionsPath()

    const sm1 = new SessionManager(path)
    const s = sm1.getOrCreateActive('feishu:child')
    s.setAgentSessionID('thread-1', 'codex')
    s.setParentSessionKey('feishu:parent:ou_user')
    s.setSubtaskDepth(2)
    s.setLastResult('done')
    sm1.save()

    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(raw.version).toBe(3)
    expect(raw.activeSession).toEqual({ 'feishu:child': s.id })
    expect(raw.userSessions).toEqual({ 'feishu:child': [s.id] })
    const serialized = (raw.sessions as Record<string, Record<string, unknown>>)[s.id] ?? {}
    expect(serialized.agentSessionID).toBe('thread-1')
    expect(serialized.agentType).toBe('codex')
    expect(serialized.parentSessionKey).toBe('feishu:parent:ou_user')
    expect(serialized.subtaskDepth).toBe(2)
    expect(serialized.lastResult).toBe('done')
    // The retired Go field names and the history copy stay gone.
    expect(serialized.agent_session_id).toBeUndefined()
    expect(serialized.history).toBeUndefined()
    expect(raw.active_session).toBeUndefined()
    expect(raw.legacy_data).toBeUndefined()

    const sm2 = new SessionManager(path)
    const got = sm2.getOrCreateActive('feishu:child')
    expect(got.getAgentSessionID()).toBe('thread-1')
    expect(got.getParentSessionKey()).toBe('feishu:parent:ou_user')
    expect(got.getSubtaskDepth()).toBe(2)
    expect(got.getLastResult()).toBe('done')
  })

  it('migrates a v1 (Go field names) file in memory and rewrites it as v3 on save', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-v1-'))
    const path = join(dir, 'sessions.json')
    const v1JSON = `{
  "sessions": {
    "s1": {"id":"s1","name":"old","agent_session_id":"","history":[{"role":"user","content":"hi","timestamp":"2026-01-01T00:00:00Z"}],"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"},
    "s2": {"id":"s2","name":"child","agent_session_id":"thread-2","agent_type":"codex","parent_session_key":"feishu:parent","subtask_depth":2,"subtask_reported":true,"worktree_path":"/wt","worktree_branch":"cc/b","worktree_base":"sha","worktree_repo_root":"/repo","past_agent_session_ids":["thread-old"],"last_result":"done","history":null,"created_at":"2026-01-02T00:00:00Z","updated_at":"2026-01-02T00:00:00Z"}
  },
  "active_session": {"user1":"s2"},
  "user_sessions": {"user1":["s1","s2"]},
  "counter": 2,
  "session_names": {"thread-2":"named"},
  "user_meta": {"user1":{"userName":"Zhang San","chatName":"Group"}},
  "past_id_tracking": true,
  "version": 1
}`
    await mkdir(dir, { recursive: true })
    await writeFile(path, v1JSON, 'utf8')

    const sm = new SessionManager(path)
    const s2 = sm.getOrCreateActive('user1')
    expect(s2.id).toBe('s2')
    expect(s2.getAgentSessionID()).toBe('thread-2')
    expect(s2.agentType).toBe('codex')
    expect(s2.getParentSessionKey()).toBe('feishu:parent')
    expect(s2.getSubtaskDepth()).toBe(2)
    expect(s2.getSubtaskReported()).toBe(true)
    expect(s2.getWorktreeInfo()).toEqual(['/wt', 'cc/b', 'sha', '/repo', ''])
    expect(s2.pastAgentSessionIDs).toEqual(['thread-old'])
    expect(s2.getLastResult()).toBe('done')
    expect(sm.getSessionName('thread-2')).toBe('named')
    expect(sm.getUserMeta('user1')?.userName).toBe('Zhang San')
    expect(sm.findByAgentSessionID('thread-old')).toBeDefined()

    sm.save()
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(raw.version).toBe(3)
    expect(raw.active_session).toBeUndefined()
    const serialized = (raw.sessions as Record<string, Record<string, unknown>>).s2 ?? {}
    expect(serialized.agentSessionID).toBe('thread-2')
    expect(serialized.subtaskDepth).toBe(2)
    expect(serialized.worktreePath).toBe('/wt')
    expect(serialized.pastAgentSessionIDs).toEqual(['thread-old'])
    expect(serialized.history).toBeUndefined()

    const sm2 = new SessionManager(path)
    expect(sm2.getOrCreateActive('user1').getAgentSessionID()).toBe('thread-2')
  })

  it('migrates a versionless Go-era file (history dropped, sessions intact)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-v0-'))
    const path = join(dir, 'sessions.json')
    await mkdir(dir, { recursive: true })
    await writeFile(path, `{
  "sessions": {"s1": {"id":"s1","name":"old","agent_session_id":"thread-1","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}},
  "active_session": {"user1":"s1"},
  "user_sessions": {"user1":["s1"]},
  "counter": 1
}`, 'utf8')

    const sm = new SessionManager(path)
    expect(sm.getOrCreateActive('user1').getAgentSessionID()).toBe('thread-1')
    sm.save()
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(raw.version).toBe(3)
  })
})

describe('Snapshot v2 → v3 migration', () => {
  const v2JSON = `{
  "version": 2,
  "sessions": {
    "s1": {
      "id": "s1",
      "name": "hub",
      "agentSessionID": "",
      "chatroomModerator": true,
      "chatroomResearch": true,
      "chatroomResearchMode": "manual",
      "pendingGatherData": {"question": "研究问题", "seq": 3, "expected": ["taleb"], "collected": {"munger": "部分回复"}},
      "createdAt": "2026-01-01T00:00:00Z",
      "updatedAt": "2026-01-01T00:00:00Z"
    }
  },
  "activeSession": {"user1": "s1"},
  "userSessions": {"user1": ["s1"]},
  "counter": 1
}`

  async function v2Store(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'fb-v2m-'))
    const path = join(dir, 'sessions.json')
    await writeFile(path, v2JSON, 'utf8')
    return path
  }

  it('lifts the flat v2 chatroom fields raw into featureState.chatroom and rewrites as v3', async () => {
    const path = await v2Store()

    const sm = new SessionManager(path)
    const hub = sm.getOrCreateActive('user1')
    const section = hub.featureState.chatroom as Record<string, unknown>
    expect(section.chatroomModerator).toBe(true)
    expect(section.chatroomResearch).toBe(true)
    expect(section.chatroomResearchMode).toBe('manual')
    expect(section.pendingGatherData).toEqual({ question: '研究问题', seq: 3, expected: ['taleb'], collected: { munger: '部分回复' } })

    // The one-way rewrite backs the pre-v3 original up once, byte for byte.
    expect(await readFile(`${path}.v2.bak`, 'utf8')).toBe(v2JSON)

    sm.save()
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(raw.version).toBe(3)
    const serialized = (raw.sessions as Record<string, Record<string, unknown>>).s1 ?? {}
    // The flat v2 names are gone; the values live in the section verbatim.
    expect(serialized.chatroomModerator).toBeUndefined()
    expect(serialized.pendingGatherData).toBeUndefined()
    expect(serialized.featureState).toEqual({
      chatroom: {
        chatroomModerator: true,
        chatroomResearch: true,
        chatroomResearchMode: 'manual',
        pendingGatherData: { question: '研究问题', seq: 3, expected: ['taleb'], collected: { munger: '部分回复' } },
      },
    })

    const sm2 = new SessionManager(path)
    const reloadedSection = sm2.getOrCreateActive('user1').featureState.chatroom as Record<string, unknown>
    expect(reloadedSection.chatroomModerator).toBe(true)
    expect(reloadedSection.pendingGatherData).toEqual({ question: '研究问题', seq: 3, expected: ['taleb'], collected: { munger: '部分回复' } })
  })

  it('keeps the earliest backup when one already exists', async () => {
    const path = await v2Store()
    const backup = `${path}.v2.bak`
    // An older backup (say, from a previous migration attempt) must win.
    await writeFile(backup, '{"version":1,"sessions":{}}', 'utf8')

    new SessionManager(path)

    expect(await readFile(backup, 'utf8')).toBe('{"version":1,"sessions":{}}')
  })

  it('fails loud on a snapshot newer than the supported version', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-v4-'))
    const path = join(dir, 'sessions.json')
    await writeFile(path, JSON.stringify({ version: 4, sessions: {} }), 'utf8')
    expect(() => new SessionManager(path)).toThrow(/newer than supported/)
  })

  it('round-trips codec-less featureState keys verbatim', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-v3op-'))
    const path = join(dir, 'sessions.json')
    await writeFile(path, JSON.stringify({
      version: 3,
      sessions: {
        s1: {
          id: 's1', name: 'default', agentSessionID: '',
          featureState: { other: { payload: [1, 2] } },
          createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        },
      },
      activeSession: { user1: 's1' }, userSessions: { user1: ['s1'] }, counter: 1,
    }), 'utf8')

    const sm = new SessionManager(path)
    sm.save()
    const raw = JSON.parse(await readFile(path, 'utf8')) as { sessions: Record<string, { featureState?: Record<string, unknown> }> }
    expect(raw.sessions.s1?.featureState).toEqual({ other: { payload: [1, 2] } })

    const sm2 = new SessionManager(path)
    expect(sm2.getOrCreateActive('user1').featureState.other).toEqual({ payload: [1, 2] })
  })

  it('drops a non-object featureState bag from a hand-corrupted file and keeps lifting flat fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-v3bad-'))
    const path = join(dir, 'sessions.json')
    await writeFile(path, JSON.stringify({
      version: 3,
      sessions: {
        s1: {
          id: 's1', name: 'hub', agentSessionID: '', featureState: 42, chatroomModerator: true,
          createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        },
      },
      activeSession: { user1: 's1' }, userSessions: { user1: ['s1'] }, counter: 1,
    }), 'utf8')

    const sm = new SessionManager(path)
    const hub = sm.getOrCreateActive('user1')
    // The corrupt bag is dropped; the flat v2 field still lifted (the section
    // is opaque to the bridge — raw reads here).
    const section = hub.featureState.chatroom as Record<string, unknown>
    expect(section.chatroomHubKey).toBeUndefined()
    expect(section.chatroomModerator).toBe(true)
  })

})
