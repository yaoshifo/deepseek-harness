/**
 * Cron domain tests ported from cc-connect core/cron_test.go (19 cases):
 * store mute toggle/persistence, mutePlatform discard, human-readable
 * expression rendering, the /cron card (buttons + hint), card-button cron
 * actions, the /cron mute text command, store paths, execution timeout
 * semantics, session-mode normalization/validation, global defaults, MarkRun,
 * and ListByProject.
 *
 * Red phase: src/engine/cron.ts and the cron command surface do not exist
 * yet — these tests fail until the M6 implementation lands.
 *
 * @module dsh-feishu-bridge/tests-engine-cron
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CronJob,
  CronScheduler,
  CronStore,
  cronExprToHuman,
  defaultCronJobTimeoutMs,
  mutePlatform,
} from '../../src/engine/cron.ts'
import { cmdCronMute, executeCardAction, renderCronCard } from '../../src/engine/cron-commands.ts'
import { Engine } from '../../src/engine/engine.ts'
import { createStubAgent, createStubPlatform, newStubMessage } from '../stubs/engine-stubs.ts'
import { langChinese, langEnglish, langJapanese } from '../../src/i18n/index.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'fb-cron-'))
}

function newJob(overrides: Partial<CronJob> & { id: string }): CronJob {
  const j = new CronJob()
  Object.assign(j, overrides)
  return j
}

describe('CronStore_MuteToggle', () => {
  it('toggles mute on an existing job and reports misses', () => {
    const store = new CronStore(tempDir())
    store.add(newJob({
      id: 'test1', project: 'proj', sessionKey: 'test:ch1',
      cronExpr: '0 6 * * *', prompt: 'hello', enabled: true,
    }))

    expect(store.get('test1')?.mute).toBe(false)

    expect(store.setMute('test1', true)).toBe(true)
    expect(store.get('test1')?.mute).toBe(true)

    let [newState, ok] = store.toggleMute('test1')
    expect(ok).toBe(true)
    expect(newState).toBe(false)

    ;[newState, ok] = store.toggleMute('test1')
    expect(ok).toBe(true)
    expect(newState).toBe(true)

    expect(store.setMute('nonexistent', true)).toBe(false)
    ;[, ok] = store.toggleMute('nonexistent')
    expect(ok).toBe(false)
  })
})

describe('CronStore_MutePersistence', () => {
  it('persists the mute flag across store reloads', () => {
    const dir = tempDir()
    const store = new CronStore(dir)
    store.add(newJob({
      id: 'persist1', project: 'proj', sessionKey: 'test:ch1',
      cronExpr: '0 6 * * *', prompt: 'hello', enabled: true,
    }))
    expect(store.setMute('persist1', true)).toBe(true)

    const store2 = new CronStore(dir)
    const j = store2.get('persist1')
    expect(j).toBeDefined()
    expect(j?.mute).toBe(true)
  })
})

describe('CronStore_Update', () => {
  it('maps snake_case edit fields onto the camelCase job properties and persists them', () => {
    const dir = tempDir()
    const store = new CronStore(dir)
    store.add(newJob({
      id: 'upd1', project: 'proj', sessionKey: 'test:ch1',
      cronExpr: '0 6 * * *', prompt: 'hello', enabled: true,
    }))

    expect(store.update('upd1', 'session_key', 'test:ch2:u1')).toBe(true)
    expect(store.update('upd1', 'cron_expr', '30 7 * * *')).toBe(true)
    expect(store.update('upd1', 'work_dir', '/tmp/w')).toBe(true)
    expect(store.update('upd1', 'session_mode', 'new_per_run')).toBe(true)
    expect(store.update('upd1', 'description', 'desc')).toBe(true)
    expect(store.update('upd1', 'mode', 'bypassPermissions')).toBe(true)
    expect(store.update('upd1', 'enabled', false)).toBe(true)
    expect(store.update('upd1', 'timeout_mins', 15)).toBe(true)
    expect(store.update('upd1', 'id', 'other')).toBe(false)

    const j = store.get('upd1')
    expect(j?.sessionKey).toBe('test:ch2:u1')
    expect(j?.cronExpr).toBe('30 7 * * *')
    expect(j?.workDir).toBe('/tmp/w')
    expect(j?.sessionMode).toBe('new_per_run')
    expect(j?.description).toBe('desc')
    expect(j?.mode).toBe('bypassPermissions')
    expect(j?.enabled).toBe(false)
    expect(j?.timeoutMins).toBe(15)

    const store2 = new CronStore(dir)
    const persisted = store2.get('upd1')
    expect(persisted?.sessionKey).toBe('test:ch2:u1')
    expect(persisted?.sessionMode).toBe('new_per_run')
    expect(persisted?.workDir).toBe('/tmp/w')
  })
})

describe('MutePlatform_DiscardMessages', () => {
  it('discards Reply/Send but delegates Name()', async () => {
    const inner = createStubPlatform('test')
    const mp = mutePlatform(inner)

    await expect(mp.reply('ctx', 'hello')).resolves.toBeUndefined()
    await expect(mp.send('key', 'world')).resolves.toBeUndefined()

    expect(inner.getSent()).toHaveLength(0)
    expect(mp.name()).toBe('test')
  })
})

describe('CronJob_MuteField', () => {
  it('defaults to unmuted and flips', () => {
    const job = newJob({ id: 'm1' })
    expect(job.mute).toBe(false)
    job.mute = true
    expect(job.mute).toBe(true)
  })
})

describe('CronExprToHuman_BasicCases', () => {
  it.each([
    ['0 6 * * *', langEnglish, 'Daily at 06:00'],
    ['0 6 * * *', langChinese, '每天 06:00'],
    ['30 14 * * 1', langEnglish, 'Every Monday at 14:30'],
    // Step expressions
    ['*/5 * * * *', langEnglish, 'Every 5 min'],
    ['*/5 * * * *', langChinese, '每5分钟'],
    ['*/30 * * * *', langChinese, '每30分钟'],
    ['*/15 * * * *', langJapanese, '15分ごと'],
    ['0 */2 * * *', langEnglish, 'Every 2 h (:00)'],
    ['0 */2 * * *', langChinese, '每2小时 (:00)'],
    ['30 */6 * * *', langEnglish, 'Every 6 h (:30)'],
    // Regular cases still work
    ['0 0 1 * *', langEnglish, 'Monthly, day 1, 00:00'],
    ['0 0 1 * *', langChinese, '每月1日 00:00'],
  ] as const)('CronExprToHuman(%s, %s)', (expr, lang, want) => {
    expect(cronExprToHuman(expr, lang)).toBe(want)
  })
})

describe('RenderCronCard_WithButtons', () => {
  it('renders per-job enable/disable/mute/delete buttons and the [mute] tag', () => {
    const store = new CronStore(tempDir())
    store.add(newJob({
      id: 'j1', project: 'test', sessionKey: 'test:ch1',
      cronExpr: '0 6 * * *', prompt: 'daily task', enabled: true,
    }))
    store.add(newJob({
      id: 'j2', project: 'test', sessionKey: 'test:ch1',
      cronExpr: '0 12 * * *', prompt: 'noon task', enabled: false, mute: true,
    }))

    const p = createStubPlatform('test')
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    e.cronScheduler = new CronScheduler(store)

    const card = renderCronCard(e, 'test:ch1', '')
    expect(card).toBeDefined()

    expect(card.hasButtons()).toBe(true)

    const allValues = card.collectButtons().flat().map(btn => btn.data)
    const found: Record<string, boolean> = {
      'disable j1': false,
      'enable j2': false,
      'mute j1': false,
      'unmute j2': false,
      'delete j1': false,
      'delete j2': false,
    }
    for (const v of allValues) {
      for (const key of Object.keys(found)) {
        if (v.includes(key)) found[key] = true
      }
    }
    for (const [key, ok] of Object.entries(found)) {
      expect(ok, `expected button containing "${key}" in card buttons: ${JSON.stringify(allValues)}`).toBe(true)
    }

    expect(card.renderText()).toContain('[mute]')
  })
})

describe('RenderCronCard_HasHint', () => {
  it('contains the /cron add and /cron mute command hints', () => {
    const store = new CronStore(tempDir())
    store.add(newJob({
      id: 'h1', project: 'test', sessionKey: 'test:ch1',
      cronExpr: '0 6 * * *', prompt: 'task', enabled: true,
    }))

    const p = createStubPlatform('test')
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    e.cronScheduler = new CronScheduler(store)

    const text = renderCronCard(e, 'test:ch1', '').renderText()
    expect(text).toContain('/cron add')
    expect(text).toContain('/cron mute')
  })
})

describe('ExecuteCardAction_CronActions', () => {
  it('disable/enable/mute/unmute/delete act on the store', async () => {
    const store = new CronStore(tempDir())
    store.add(newJob({
      id: 'act1', project: 'test', sessionKey: 'test:ch1',
      cronExpr: '0 6 * * *', prompt: 'task', enabled: true,
    }))

    const p = createStubPlatform('test')
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    const scheduler = new CronScheduler(store)
    e.cronScheduler = scheduler
    scheduler.registerEngine('test', e)
    scheduler.start()
    try {
      executeCardAction(e, '/cron', 'disable act1', 'test:ch1', '')
      expect(store.get('act1')?.enabled).toBe(false)

      executeCardAction(e, '/cron', 'enable act1', 'test:ch1', '')
      expect(store.get('act1')?.enabled).toBe(true)

      executeCardAction(e, '/cron', 'mute act1', 'test:ch1', '')
      expect(store.get('act1')?.mute).toBe(true)

      executeCardAction(e, '/cron', 'unmute act1', 'test:ch1', '')
      expect(store.get('act1')?.mute).toBe(false)

      executeCardAction(e, '/cron', 'delete act1', 'test:ch1', '')
      expect(store.get('act1')).toBeUndefined()
    } finally {
      scheduler.stop()
    }
  })

  it('card actions for another chat\'s job are denied (no user identity → owner-only)', () => {
    const store = new CronStore(tempDir())
    store.add(newJob({
      id: 'frgn1', project: 'test', sessionKey: 'test:ch1',
      cronExpr: '0 6 * * *', prompt: 'task', enabled: true,
    }))
    store.add(newJob({
      id: 'frgn2', project: 'test', sessionKey: 'test:ch1',
      cronExpr: '0 6 * * *', prompt: 'task', enabled: true,
    }))

    const e = new Engine('test', createStubAgent(), [createStubPlatform('test')], '', 'en')
    const scheduler = new CronScheduler(store)
    e.cronScheduler = scheduler

    // A crafted/replayed card action from another chat must not mutate the job.
    executeCardAction(e, '/cron', 'delete frgn1', 'test:ch2', '')
    expect(store.get('frgn1')).toBeDefined()
    executeCardAction(e, '/cron', 'disable frgn2', 'test:ch2', '')
    expect(store.get('frgn2')?.enabled).toBe(true)
  })

  it('a card action carrying an admin userID may act on another chat\'s job; a non-admin still may not', () => {
    const store = new CronStore(tempDir())
    store.add(newJob({
      id: 'adm1', project: 'test', sessionKey: 'test:ch1',
      cronExpr: '0 6 * * *', prompt: 'task', enabled: true,
    }))
    store.add(newJob({
      id: 'adm2', project: 'test', sessionKey: 'test:ch1',
      cronExpr: '0 6 * * *', prompt: 'task', enabled: true,
    }))

    const e = new Engine('test', createStubAgent(), [createStubPlatform('test')], '', 'en')
    const scheduler = new CronScheduler(store)
    e.cronScheduler = scheduler
    e.adminFrom = 'boss'

    executeCardAction(e, '/cron', 'disable adm1', 'test:ch2', 'boss')
    expect(store.get('adm1')?.enabled).toBe(false)

    executeCardAction(e, '/cron', 'disable adm2', 'test:ch2', 'someone')
    expect(store.get('adm2')?.enabled).toBe(true)
  })

  it('handleCardAction forwards the pressing user\'s ID: admin cross-chat passes, non-admin does not', async () => {
    const store = new CronStore(tempDir())
    store.add(newJob({
      id: 'hca1', project: 'test', sessionKey: 'test:ch1',
      cronExpr: '0 6 * * *', prompt: 'task', enabled: true,
    }))
    store.add(newJob({
      id: 'hca2', project: 'test', sessionKey: 'test:ch1',
      cronExpr: '0 6 * * *', prompt: 'task', enabled: true,
    }))

    const p = createStubPlatform('test')
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    e.cronScheduler = new CronScheduler(store)
    e.adminFrom = 'boss'

    const adminMsg = {
      ...newStubMessage(),
      sessionKey: 'test:ch2', platform: 'test', userID: 'boss',
      content: 'act:/cron disable hca1', isCardAction: true,
    }
    await e.handleCardAction(p, adminMsg, 'act:/cron disable hca1')
    expect(store.get('hca1')?.enabled).toBe(false)

    const plainMsg = {
      ...newStubMessage(),
      sessionKey: 'test:ch2', platform: 'test', userID: 'someone',
      content: 'act:/cron disable hca2', isCardAction: true,
    }
    await e.handleCardAction(p, plainMsg, 'act:/cron disable hca2')
    expect(store.get('hca2')?.enabled).toBe(true)
  })
})

describe('CmdCronMute_TextCommand', () => {
  it('mutes/unmutes via text and reports unknown ids', async () => {
    const store = new CronStore(tempDir())
    store.add(newJob({
      id: 'txt1', project: 'test', sessionKey: 'test:ch1',
      cronExpr: '0 6 * * *', prompt: 'task', enabled: true,
    }))

    const p = createStubPlatform('test')
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    e.cronScheduler = new CronScheduler(store)

    const msg = { ...newStubMessage(), sessionKey: 'test:ch1', userID: 'u1', replyCtx: 'ctx' }

    await cmdCronMute(e, p, msg, ['txt1'], true)
    expect(store.get('txt1')?.mute).toBe(true)
    const sent = p.getSent()
    expect(sent.length).toBeGreaterThan(0)
    expect(sent[sent.length - 1]).toContain('🔇')

    await cmdCronMute(e, p, msg, ['txt1'], false)
    expect(store.get('txt1')?.mute).toBe(false)
    const sent2 = p.getSent()
    expect(sent2.length).toBeGreaterThan(0)
    expect(sent2[sent2.length - 1]).toContain('🔔')

    await cmdCronMute(e, p, msg, ['nonexistent'], true)
    const sent3 = p.getSent()
    expect(sent3.length).toBeGreaterThan(0)
    expect(sent3[sent3.length - 1]).toContain('not found')
  })
})

describe('CronStore_JobsPath', () => {
  it('stores jobs under <dataDir>/crons/jobs.json', () => {
    const dir = tempDir()
    const store = new CronStore(dir)
    expect(store.path).toBe(join(dir, 'crons', 'jobs.json'))
  })
})

describe('CronJob_ExecutionTimeout', () => {
  it('nil TimeoutMins uses the 30m default; 0 waits without limit; >0 uses minutes', () => {
    const j = new CronJob()
    expect(j.executionTimeoutMs()).toBe(defaultCronJobTimeoutMs)
    j.timeoutMins = 0
    expect(j.executionTimeoutMs()).toBe(0)
    j.timeoutMins = 5
    expect(j.executionTimeoutMs()).toBe(5 * 60_000)
  })
})

describe('CronScheduler_AddJob_InvalidSessionMode', () => {
  it('rejects an unrecognized session_mode', () => {
    const store = new CronStore(tempDir())
    const cs = new CronScheduler(store)
    expect(() => {
      cs.addJob(newJob({
        id: 'x1', project: 'p', sessionKey: 'test:1:1',
        cronExpr: '0 6 * * *', prompt: 'hi', sessionMode: 'bogus',
      }))
    }).toThrow()
  })
})

describe('CronJob_UsesNewSessionPerRun', () => {
  it('accepts the aliases and rejects reuse', () => {
    for (const mode of ['new_per_run', 'new-per-run', 'NEW_PER_RUN']) {
      const j = newJob({ id: 'x', sessionMode: mode })
      expect(j.usesNewSessionPerRun(), mode).toBe(true)
    }
    const j = newJob({ id: 'x', sessionMode: 'reuse' })
    expect(j.usesNewSessionPerRun()).toBe(false)
  })
})

describe('CronJob_JSONLegacyUnmarshal', () => {
  it('fromJSON leaves session_mode and timeout_mins unset on legacy rows', () => {
    const raw = '{"id":"1","project":"p","session_key":"t:1:1","cron_expr":"0 6 * * *","prompt":"x","enabled":true}'
    const j = CronJob.fromJSON(JSON.parse(raw) as Record<string, unknown>)
    expect(j.sessionMode).toBe('')
    expect(j.timeoutMins).toBeUndefined()
  })
})

describe('CronScheduler_AddJob_NegativeTimeoutMins', () => {
  it('rejects a negative timeout_mins', () => {
    const store = new CronStore(tempDir())
    const cs = new CronScheduler(store)
    expect(() => {
      cs.addJob(newJob({
        id: 't1', project: 'p', sessionKey: 'test:1:1',
        cronExpr: '0 6 * * *', prompt: 'hi', timeoutMins: -1,
      }))
    }).toThrow()
  })
})

describe('CronScheduler_AddJob_NormalizesSessionMode', () => {
  it('rewrites new-per-run to the canonical new_per_run', () => {
    const store = new CronStore(tempDir())
    const cs = new CronScheduler(store)
    const job = newJob({
      id: 'n1', project: 'p', sessionKey: 'test:1:1',
      cronExpr: '0 6 * * *', prompt: 'hi', sessionMode: 'new-per-run',
    })
    cs.addJob(job)
    expect(job.sessionMode).toBe('new_per_run')
  })
})

describe('CronScheduler_UsesNewSession_GlobalDefault', () => {
  it('job-level mode overrides the global default in both directions', () => {
    const store = new CronStore(tempDir())
    const cs = new CronScheduler(store)

    // Test 1: global default is "new_per_run", job has no session_mode set
    cs.setDefaultSessionMode('new_per_run')
    const job = newJob({ id: 'g', sessionMode: '' })
    expect(cs.usesNewSession(job)).toBe(true)

    // Test 2: per-job "reuse" overrides global "new_per_run"
    job.sessionMode = 'reuse'
    expect(cs.usesNewSession(job)).toBe(false)

    // Test 3: per-job "new_per_run" overrides global default (reuse)
    cs.setDefaultSessionMode('')
    job.sessionMode = 'new_per_run'
    expect(cs.usesNewSession(job)).toBe(true)

    // Test 4: both global and job are default (reuse)
    job.sessionMode = ''
    expect(cs.usesNewSession(job)).toBe(false)
  })
})

describe('CronStore_MarkRun', () => {
  it('updates LastRun within the call window', () => {
    const store = new CronStore(tempDir())
    store.add(newJob({
      id: 'markrun-test', project: 'proj', sessionKey: 'test:ch1',
      cronExpr: '0 6 * * *', prompt: 'hello', enabled: true,
    }))

    const before = Date.now()
    store.markRun('markrun-test')
    const after = Date.now()

    const updated = store.get('markrun-test')
    expect(updated?.lastRun).not.toBe('')
    const lastRun = new Date(updated?.lastRun ?? '').getTime()
    expect(lastRun).toBeGreaterThanOrEqual(before)
    expect(lastRun).toBeLessThanOrEqual(after)
  })
})

describe('CronStore_ListByProject', () => {
  it('filters jobs by project', () => {
    const store = new CronStore(tempDir())
    const jobs = [
      newJob({ id: 'j1', project: 'proj1', sessionKey: 's1', cronExpr: '0 6 * * *', prompt: 'p1' }),
      newJob({ id: 'j2', project: 'proj1', sessionKey: 's2', cronExpr: '0 7 * * *', prompt: 'p2' }),
      newJob({ id: 'j3', project: 'proj2', sessionKey: 's3', cronExpr: '0 8 * * *', prompt: 'p3' }),
    ]
    for (const j of jobs) {
      j.enabled = true
      store.add(j)
    }

    expect(store.listByProject('proj1')).toHaveLength(2)
    expect(store.listByProject('proj2')).toHaveLength(1)
    expect(store.listByProject('nonexistent')).toHaveLength(0)
  })
})
