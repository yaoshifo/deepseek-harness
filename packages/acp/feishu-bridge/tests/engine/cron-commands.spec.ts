/**
 * Registration and dispatch tests for registerCronCommands /
 * registerRelayCommands (M6): the `/cron` and `/bind` families merge into
 * an existing session-command table without clobbering it, resolve ≥2-char
 * prefixes, dispatch through the engine's command path, route `act:/cron`
 * card actions through handleCardAction, and dispose cleanly.
 *
 * @module dsh-feishu-bridge/tests-engine-cron-commands
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { registerCronCommands } from '../../src/engine/cron-commands.js'
import { CronJob, CronScheduler, CronStore } from '../../src/engine/cron.js'
import { registerRelayCommands } from '../../src/engine/relay-commands.js'
import { RelayManager } from '../../src/engine/relay.js'
import { Engine } from '../../src/engine/engine.js'
import { registerSessionCommands } from '../../src/engine/commands.js'
import { createStubAgent, createStubCardPlatform, newStubMessage } from '../stubs/engine-stubs.js'
import { Msg } from '../../src/i18n/index.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'fb-croncmd-'))
}

function newEngine(): { e: Engine; disposeSession: () => void } {
  const e = new Engine('test', createStubAgent(), [createStubCardPlatform('test')], '', 'en')
  const disposeSession = registerSessionCommands(e)
  return { e, disposeSession }
}

function cronMsg(content: string) {
  return { ...newStubMessage(), sessionKey: 'test:ch1', userID: 'u1', replyCtx: 'ctx', content }
}

describe('registerCronCommands', () => {
  it('merges into the session command table and keeps /new dispatchable', async () => {
    const { e, disposeSession } = newEngine()
    const p = e.platforms[0] as ReturnType<typeof createStubCardPlatform>
    e.cronScheduler = new CronScheduler(new CronStore(tempDir()))
    const disposeCron = registerCronCommands(e)
    try {
      expect(e.commandHandlers?.get('cron')).toBeDefined()
      expect(e.commandHandlers?.get('new')).toBeDefined()

      expect(e.dispatchCommand(p, cronMsg('/cron list'), '/cron list')).toBe(true)
      // /cron list on an empty store replies the empty message.
      const sent = p.getSent()
      expect(sent[sent.length - 1]).toBe(e.i18n.t(Msg.CronEmpty))

      expect(e.dispatchCommand(p, cronMsg('/cr list'), '/cr list')).toBe(true)
      expect(e.dispatchCommand(p, cronMsg('/new'), '/new')).toBe(true)
      // M7: /new now sends the purple status-footer card (Go cmdNew) — an
      // async build — so drain the command's promise before probing the card
      // and the session reset instead of the old synchronous text reply.
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(p.sentCards).toHaveLength(1)
    } finally {
      disposeCron()
      disposeSession()
    }
  })

  it('dispatches /cron add end to end and persists the job', () => {
    const { e, disposeSession } = newEngine()
    const p = e.platforms[0] as ReturnType<typeof createStubCardPlatform>
    const store = new CronStore(tempDir())
    const scheduler = new CronScheduler(store)
    e.cronScheduler = scheduler
    const disposeCron = registerCronCommands(e)
    try {
      expect(e.dispatchCommand(p, cronMsg('/cron add 0 6 * * * daily report'), '/cron add 0 6 * * * daily report')).toBe(true)
      const jobs = store.listByProject('test')
      expect(jobs).toHaveLength(1)
      expect(jobs[0]?.cronExpr).toBe('0 6 * * *')
      expect(jobs[0]?.prompt).toBe('daily report')
      expect(jobs[0]?.sessionKey).toBe('test:ch1')
      expect(jobs[0]?.enabled).toBe(true)
      const sent = p.getSent()
      expect(sent[sent.length - 1]).toContain(jobs[0]?.id ?? '')
    } finally {
      disposeCron()
      disposeSession()
    }
  })

  it('disposes back to the session-only table', () => {
    const { e, disposeSession } = newEngine()
    const p = e.platforms[0] as ReturnType<typeof createStubCardPlatform>
    const disposeCron = registerCronCommands(e)
    disposeCron()
    try {
      expect(e.commandHandlers?.get('cron')).toBeUndefined()
      expect(e.commandHandlers?.get('new')).toBeDefined()
      expect(e.dispatchCommand(p, cronMsg('/cron list'), '/cron list')).toBe(false)
    } finally {
      disposeSession()
    }
  })

  it('routes act:/cron card actions through handleCardAction', async () => {
    const { e, disposeSession } = newEngine()
    const p = e.platforms[0] as ReturnType<typeof createStubCardPlatform>
    const store = new CronStore(tempDir())
    const scheduler = new CronScheduler(store)
    e.cronScheduler = scheduler
    const job = new CronJob()
    job.id = 'act1'
    job.project = 'test'
    job.sessionKey = 'test:ch1'
    job.cronExpr = '0 6 * * *'
    job.prompt = 'task'
    job.enabled = true
    store.add(job)
    const disposeCron = registerCronCommands(e)
    try {
      await e.handleCardAction(p, cronMsg(''), 'act:/cron disable act1')
      expect(store.get('act1')?.enabled).toBe(false)
    } finally {
      disposeCron()
      disposeSession()
    }
  })
})

describe('registerRelayCommands', () => {
  it('dispatches /bind status and bind against the relay manager', async () => {
    const { e, disposeSession } = newEngine()
    const p = e.platforms[0] as ReturnType<typeof createStubCardPlatform>
    const rm = new RelayManager('')
    e.relayManager = rm
    const disposeRelay = registerRelayCommands(e)
    try {
      expect(e.commandHandlers?.get('bind')).toBeDefined()
      expect(e.commandHandlers?.get('new')).toBeDefined()

      // No binding yet → status replies "no binding".
      expect(e.dispatchCommand(p, cronMsg('/bind'), '/bind')).toBe(true)
      let sent = p.getSent()
      expect(sent[sent.length - 1]).toContain('No relay binding')

      // Binding an unknown project reports it with available targets.
      expect(e.dispatchCommand(p, cronMsg('/bind other'), '/bind other')).toBe(true)
      sent = p.getSent()
      expect(sent[sent.length - 1]).toContain('other')

      // Register the target engine and bind for real.
      rm.registerEngine('other', e)
      expect(e.dispatchCommand(p, cronMsg('/bind other'), '/bind other')).toBe(true)
      expect(Object.keys(rm.getBinding('ch1')?.bots ?? {}).sort()).toEqual(['other', 'test'])
    } finally {
      disposeRelay()
      disposeSession()
    }
  })

  it('disposes back to the session-only table', () => {
    const { e, disposeSession } = newEngine()
    const p = e.platforms[0] as ReturnType<typeof createStubCardPlatform>
    const disposeRelay = registerRelayCommands(e)
    disposeRelay()
    try {
      expect(e.commandHandlers?.get('bind')).toBeUndefined()
      expect(e.dispatchCommand(p, cronMsg('/bind'), '/bind')).toBe(false)
    } finally {
      disposeSession()
    }
  })
})
