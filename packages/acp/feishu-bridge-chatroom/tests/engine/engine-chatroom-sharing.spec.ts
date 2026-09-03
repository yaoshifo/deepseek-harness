/**
 * Cross-chatroom sharing hooks: per-run ledger directories, the ended line
 * on finalize/interrupt, the note report section, prior-context seeding on
 * start, and the inherit resolver's error surface.
 *
 * @module dsh-feishu-bridge/tests-engine-chatroom-sharing
 */

import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Engine } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { ProjectStateStore } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { registerSessionCommands } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { registerChatroomCommands } from '../../src/engine/chatroom-cmd.ts'
import {
  chatroomLedgerDirFor,
  endChatroom,
  interruptChatroom,
  noteChatroom,
  resolveChatroomInheritPrior,
  startChatroom,
} from '../../src/engine/chatroom.ts'
import {
  chatroomLedgerDir,
  initChatroomLedger,
  readChatroomLedgerHeader,
} from '../../src/engine/chatroom-ledger.ts'
import { chatroomConfig } from '../../src/chatroom-config.ts'
import { createStubAgent, createStubChatroomSpawner } from '../stubs/engine-stubs.ts'
import type { Message, Platform } from '@deepseek-ai/dsh-feishu-bridge/exports'
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

/** One scaffolded role per name, under a temp roles dir. */
async function scaffoldRoles(names: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fb-share-roles-'))
  for (const n of names) {
    await mkdir(join(root, n), { recursive: true })
    await writeFile(join(root, n, 'CLAUDE.md'), `# ${n}\n`, 'utf8')
  }
  return root
}

/** A temp moderator home; ledgers live under <home>/ledgers/. */
async function scaffoldModeratorHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'fb-share-mod-'))
}

describe('per-run ledger directories', () => {
  it('a second chatroom on the same hub gets its own dir; the first ledger survives', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    const home = await scaffoldModeratorHome()
    chatroomConfig(e).applySection({ rolesDir: await scaffoldRoles(['taleb']), moderatorDir: home })
    const hub = 'test:hub:user-1'

    await startChatroom(e, hub, ['taleb'], '第一次议题')
    const dir1 = chatroomLedgerDirFor(e, hub)
    expect(dir1).toBe(chatroomLedgerDir(home, hub))
    await startChatroom(e, hub, ['taleb'], '第二次议题')
    const dir2 = chatroomLedgerDirFor(e, hub)
    expect(dir2).toBe(chatroomLedgerDir(home, hub, 2))

    expect(readChatroomLedgerHeader(dir1!)?.topic).toBe('第一次议题')
    expect(readChatroomLedgerHeader(dir2!)?.topic).toBe('第二次议题')
  })
})

describe('ended line on teardown', () => {
  it('graceful end writes 已收尾; interrupt writes 已中断', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    const home = await scaffoldModeratorHome()
    chatroomConfig(e).applySection({ rolesDir: await scaffoldRoles(['taleb']), moderatorDir: home })
    const hub = 'test:hub:user-1'

    await startChatroom(e, hub, ['taleb'], '议题一')
    const dir1 = chatroomLedgerDirFor(e, hub)!
    endChatroom(e, hub)
    await waitFor(() => readChatroomLedgerHeader(dir1)?.endedStatus === 'ended', 'ended line')

    await startChatroom(e, hub, ['taleb'], '议题二')
    const dir2 = chatroomLedgerDirFor(e, hub)!
    interruptChatroom(e, hub)
    await waitFor(() => readChatroomLedgerHeader(dir2)?.endedStatus === 'interrupted', 'interrupted line')
  })
})

describe('noteChatroom report section', () => {
  it('writes REPORT.md into the hub ledger', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    const home = await scaffoldModeratorHome()
    chatroomConfig(e).applySection({ rolesDir: await scaffoldRoles(['taleb']), moderatorDir: home })
    const hub = 'test:hub:user-1'
    await startChatroom(e, hub, ['taleb'], '议题')

    await noteChatroom(e, hub, 'report', '收尾总结：图景完整，两处分歧交回人类。')
    const rep = await readFile(join(chatroomLedgerDirFor(e, hub)!, 'REPORT.md'), 'utf8')
    expect(rep).toContain('收尾总结')
  })
})

describe('startChatroom prior', () => {
  it('seeds the prior pointer into the new ledger; nothing is copied', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    const home = await scaffoldModeratorHome()
    chatroomConfig(e).applySection({ rolesDir: await scaffoldRoles(['taleb']), moderatorDir: home })
    const otherHub = 'test:other:user-9'
    const priorDir = chatroomLedgerDir(home, otherHub)
    await initChatroomLedger(priorDir, '旧议题', ['taleb'])

    const hub = 'test:hub:user-1'
    await startChatroom(e, hub, ['taleb'], '新议题', { topic: '旧议题', dir: priorDir })
    const dir = chatroomLedgerDirFor(e, hub)!
    const h = readChatroomLedgerHeader(dir)
    expect(h?.prior).toContain('旧议题')
    expect(h?.prior).toContain(priorDir)
    const syn = await readFile(join(dir, 'SYNTHESIS.md'), 'utf8')
    expect(syn).toContain('## 前情（继承自 旧议题，未经本次讨论验证）')
  })
})

describe('resolveChatroomInheritPrior', () => {
  it('fails loud without a moderator dir; lists candidates on no match; resolves matches with the prior cast', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldRoles(['taleb']) })
    expect(() => resolveChatroomInheritPrior(e, '')).toThrow()

    const home = await scaffoldModeratorHome()
    chatroomConfig(e).applySection({ moderatorDir: home })
    expect(() => resolveChatroomInheritPrior(e, '不存在')).toThrow(/不存在/)

    const priorDir = chatroomLedgerDir(home, 'test:other:user-9')
    await initChatroomLedger(priorDir, '旧议题', ['taleb', 'munger'])
    const prior = resolveChatroomInheritPrior(e, '旧议题')
    expect(prior?.topic).toBe('旧议题')
    expect(prior?.dir).toBe(priorDir)
    expect(prior?.roles).toEqual(['taleb', 'munger'])
    expect(resolveChatroomInheritPrior(e, '')?.topic).toBe('旧议题')
  })
})

describe('cmdChatroom --continue', () => {
  function hubMsg(hub: string): Message {
    return { sessionKey: hub, platform: 'test', userID: 'user-1', replyCtx: 'hub-ctx' } as Message
  }

  async function runCmd(e: Engine, p: Platform, hub: string, args: string[]): Promise<void> {
    const handler = e.commandHandlers?.get('chatroom')
    expect(handler).toBeDefined()
    handler?.(p, hubMsg(hub), args)
    await settle()
    await settle()
  }

  it('seeds the prior pointer, defaults to the prior cast, and notes the prior in the ready card', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    const home = await scaffoldModeratorHome()
    chatroomConfig(e).applySection({ rolesDir: await scaffoldRoles(['taleb', 'munger']), moderatorDir: home })
    const priorDir = chatroomLedgerDir(home, 'test:other:user-9')
    await initChatroomLedger(priorDir, '旧议题', ['taleb', 'munger'])

    const hub = 'test:hub:user-1'
    await runCmd(e, p, hub, ['--continue=旧议题', '新议题'])

    // No roles named → the prior cast is the default.
    await waitFor(() => p.count === 2, 'prior cast spawned')
    const dir = chatroomLedgerDirFor(e, hub)
    await waitFor(() => readChatroomLedgerHeader(dir!)?.prior.includes('旧议题') === true, 'prior pointer seeded')
    // The ready card mentions the prior context.
    await waitFor(() => p.sentCards.some(c => JSON.stringify(c).includes('旧议题')), 'ready card prior line')
  })

  it('bare --continue takes the newest chatroom', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    const home = await scaffoldModeratorHome()
    chatroomConfig(e).applySection({ rolesDir: await scaffoldRoles(['taleb', 'munger']), moderatorDir: home })
    await initChatroomLedger(chatroomLedgerDir(home, 'test:a:user-1'), '更早的议题', ['taleb'])
    await initChatroomLedger(chatroomLedgerDir(home, 'test:other:user-9'), '最近的议题', ['taleb'])

    const hub = 'test:hub:user-1'
    await runCmd(e, p, hub, ['--continue', 'taleb,munger', '新议题'])
    await waitFor(() => p.count === 2, 'roles spawned')
    const dir = chatroomLedgerDirFor(e, hub)
    await waitFor(() => readChatroomLedgerHeader(dir!)?.prior.includes('最近的议题') === true, 'newest prior seeded')
  })

  it('no moderator dir: replies the error, spawns nothing', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldRoles(['taleb']) })
    await runCmd(e, p, 'test:hub:user-1', ['--continue', 'taleb', '新议题'])
    expect(p.count).toBe(0)
    expect(p.getSent().some(s => s.includes('moderator_dir'))).toBe(true)
  })

  it('no matching prior: replies with candidates, spawns nothing', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    const home = await scaffoldModeratorHome()
    chatroomConfig(e).applySection({ rolesDir: await scaffoldRoles(['taleb']), moderatorDir: home })
    await initChatroomLedger(chatroomLedgerDir(home, 'test:other:user-9'), '旧议题', ['taleb'])

    await runCmd(e, p, 'test:hub:user-1', ['--continue=不存在', 'taleb', '新议题'])
    expect(p.count).toBe(0)
    expect(p.getSent().some(s => s.includes('不存在'))).toBe(true)
    expect(p.getSent().some(s => s.includes('旧议题'))).toBe(true)
  })

  it('--continue without a topic is a usage error', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldRoles(['taleb']) })
    await runCmd(e, p, 'test:hub:user-1', ['--continue'])
    expect(p.count).toBe(0)
    expect(p.getSent().some(s => s.includes('用法'))).toBe(true)
  })
})
