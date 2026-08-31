/**
 * Engine card-action routing (Go handleCardNav's act:/wt path): a
 * card.action.trigger button press dispatched by the platform as an
 * isCardAction message runs the worktree Keep/Remove side effect and replaces
 * the pressed card in place (CardRefresher), falling back to a new card when
 * the platform cannot PATCH.
 */

import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { Engine } from '../../src/engine/engine.ts'
import { DirHistory } from '../../src/engine/dir-history.ts'
import { ProjectStateStore } from '../../src/engine/project-state.ts'
import { createWorktree } from '../../src/engine/worktree.ts'
import { createStubAgent, createStubCardPlatform, newStubMessage, type RecordedCard, type StubCardPlatform } from '../stubs/engine-stubs.ts'
import { registerSessionCommands } from '../../src/engine/commands.ts'
import { newCard } from '../../src/card.ts'
import type { Message, Platform } from '../../src/core/types.ts'

const execFileP = promisify(execFile)

interface RefreshingPlatform extends StubCardPlatform {
  refreshed: Array<{ sessionKey: string; body: string; card: unknown }>
  refreshCard(sessionKey: string, card: unknown): Promise<void>
}

function newRefreshingPlatform(n = 'test'): RefreshingPlatform {
  const base = createStubCardPlatform(n)
  const p: RefreshingPlatform = {
    ...base,
    refreshed: [],
    refreshCard: async (sessionKey, card) => {
      p.refreshed.push({ sessionKey, body: cardBody(card), card })
    },
  }
  return p
}

function newEngine(p: Platform): Engine {
  return new Engine('test', createStubAgent(), [p], '', 'en')
}

function cardActionMsg(sessionKey: string, action: string): Message {
  return {
    ...newStubMessage(),
    sessionKey,
    platform: 'test',
    userID: 'u1',
    chatType: 'group',
    content: action,
    replyCtx: 'test-rctx',
    isCardAction: true,
  }
}

/** The markdown body of a recorded card (Go card.Elements[0].(CardMarkdown).Content). */
function cardBody(card: unknown): string {
  const c = card as RecordedCard
  const first = c.elements[0]
  return first?.kind === 'markdown' ? (first.content ?? '') : ''
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
  throw new Error(`timeout waiting for ${what}`)
}

/** Create a git repo with one commit and return its root. */
async function initTestRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fb-cardaction-repo-'))
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  }
  const run = (...args: string[]): Promise<string> =>
    execFileP('git', args, { cwd: root, env }).then(r => r.stdout)
  await run('init', '-b', 'main')
  await writeFile(join(root, 'README.md'), 'hello\n')
  await run('add', 'README.md')
  await run('commit', '-m', 'init')
  return root
}

describe('handleCardAction act:/wt', () => {
  it('keep clears worktree metadata and PATCHes the done card in place', async () => {
    const p = newRefreshingPlatform()
    const e = newEngine(p)
    const sess = e.sessions.getOrCreateActive('test:child-chat')
    sess.setWorktreeInfo('/gone/wt', 'cc/x', 'abc', '/repo', '')

    e.receiveMessage(p, cardActionMsg('test:child-chat', 'act:/wt keep'))
    await waitFor(() => p.refreshed.length === 1, 'refreshCard')

    expect(p.refreshed[0]!.sessionKey).toBe('test:child-chat')
    expect(p.refreshed[0]!.body).not.toContain('/gone/wt') // terminal card, not the prompt
    expect(sess.getWorktreeInfo()).toEqual(['', '', '', '', ''])
    // A card action never starts an agent turn.
    expect(p.getSent()).toEqual([])
    expect(p.sentCards).toEqual([])
  })

  it('remove tears the worktree down and clears metadata', async () => {
    const root = await initTestRepo()
    const wt = await createWorktree(root, 'cardaction')
    await writeFile(join(wt.path, 'README.md'), 'dirty\n')
    const p = newRefreshingPlatform()
    const e = newEngine(p)
    const sess = e.sessions.getOrCreateActive('test:child-chat')
    sess.setWorktreeInfo(wt.path, wt.branch, wt.baseSHA, root, wt.baseBranch)

    e.receiveMessage(p, cardActionMsg('test:child-chat', 'act:/wt remove'))
    await waitFor(() => p.refreshed.length === 1, 'refreshCard')

    expect(sess.getWorktreeInfo()).toEqual(['', '', '', '', ''])
    const list = await execFileP('git', ['worktree', 'list'], { cwd: root })
    expect(list.stdout).not.toContain(wt.path)
  })

  it('falls back to a new card when the platform cannot PATCH', async () => {
    const p = createStubCardPlatform('test')
    const e = newEngine(p)
    const sess = e.sessions.getOrCreateActive('test:child-chat')
    sess.setWorktreeInfo('/gone/wt', 'cc/x', 'abc', '/repo', '')

    e.receiveMessage(p, cardActionMsg('test:child-chat', 'act:/wt keep'))
    await waitFor(() => p.sentCards.length === 1, 'fallback card')

    expect(p.sentCards).toHaveLength(1)
    expect(sess.getWorktreeInfo()).toEqual(['', '', '', '', ''])
  })

  it('unknown act: commands are consumed without a turn or a card', async () => {
    const p = newRefreshingPlatform()
    const e = newEngine(p)

    e.receiveMessage(p, cardActionMsg('test:child-chat', 'act:/model 3'))
    await new Promise((resolve) => { setTimeout(resolve, 50) })

    expect(p.refreshed).toEqual([])
    expect(p.sentCards).toEqual([])
    expect(p.getSent()).toEqual([])
  })
})

describe('handleCardAction registered card actions (registerCardAction)', () => {
  it('runs the registered handler and PATCHes the returned card in place', async () => {
    const p = newRefreshingPlatform()
    const e = newEngine(p)
    const seen: Array<[string, string, string]> = []
    const dispose = e.registerCardAction(['/feature-pick'], (sessionKey, cmd, args) => {
      seen.push([sessionKey, cmd, args])
      return newCard().title('picker', 'purple').markdown(`done ${args}`).build()
    })

    e.receiveMessage(p, cardActionMsg('test:hub:u1', 'act:/feature-pick toggle one'))
    await waitFor(() => p.refreshed.length === 1, 'refreshCard')

    expect(seen).toEqual([['test:hub:u1', '/feature-pick', 'toggle one']])
    expect(p.refreshed[0]!.body).toContain('done toggle one')
    // A card action never starts an agent turn nor sends a new card.
    expect(p.getSent()).toEqual([])
    expect(p.sentCards).toEqual([])
    dispose()
  })

  it('an undefined handler result leaves the pressed card; the action is still consumed', async () => {
    const p = newRefreshingPlatform()
    const e = newEngine(p)
    const dispose = e.registerCardAction(['/feature-pick'], () => undefined)

    e.receiveMessage(p, cardActionMsg('test:hub:u1', 'act:/feature-pick toggle one'))
    await new Promise((resolve) => { setTimeout(resolve, 50) })

    expect(p.refreshed).toEqual([])
    expect(p.sentCards).toEqual([])
    expect(p.getSent()).toEqual([])
    dispose()
  })

  it('the disposer removes the registration and the command falls through again', async () => {
    const p = newRefreshingPlatform()
    const e = newEngine(p)
    const dispose = e.registerCardAction(['/feature-pick'], () => newCard().title('picker', 'purple').markdown('x').build())
    dispose()

    e.receiveMessage(p, cardActionMsg('test:hub:u1', 'act:/feature-pick confirm'))
    await new Promise((resolve) => { setTimeout(resolve, 50) })

    // Unregistered again: unknown-card handling consumes the press quietly.
    expect(p.refreshed).toEqual([])
    expect(p.sentCards).toEqual([])
    expect(p.getSent()).toEqual([])
  })
})

describe('handleCardAction /dir', () => {
  const SK = 'test:chat1:u1'

  /** Engine wired for /dir card actions: work-dir agent, history, override store. */
  function newDirEngine(p: Platform, dirs: string[], current: string): Engine {
    const agent = { ...createStubAgent(), getWorkDir: () => dirs[0] ?? '' }
    const e = new Engine('test', agent, [p], '', 'en')
    const dh = new DirHistory(mkdtempSync(join(tmpdir(), 'fb-diract-')))
    for (const d of dirs) dh.add('test', d)
    e.setDirHistory(dh)
    const store = new ProjectStateStore(join(mkdtempSync(join(tmpdir(), 'fb-diract-state-')), 'test.state.json'))
    e.setProjectStateStore(store)
    e.setBaseWorkDir(dirs[0] ?? '')
    e.projectState?.setWorkspaceDirOverride(e.dirOverrideKey(SK), current)
    return e
  }

  function makeDirs(n: number): string[] {
    const root = mkdtempSync(join(tmpdir(), 'fb-diract-dirs-'))
    const dirs: string[] = []
    for (let i = 1; i <= n; i++) {
      const d = join(root, `d${i}`)
      mkdirSync(d)
      dirs.push(d)
    }
    return dirs
  }

  function markdowns(card: unknown): string[] {
    const c = card as RecordedCard
    return c.elements
      .filter(el => el.kind === 'markdown')
      .map(el => (el as { content?: string }).content ?? '')
  }

  it('act:/dir select N switches the override and PATCHes the card with the reset notice', async () => {
    const dirs = makeDirs(3)
    const p = newRefreshingPlatform()
    const e = newDirEngine(p, dirs, dirs[0] ?? '')
    const dh = e.dirHistory
    const target = dh?.get('test', 2) ?? ''

    e.receiveMessage(p, cardActionMsg(SK, 'act:/dir select 2'))
    await waitFor(() => p.refreshed.length === 1, 'refreshCard')

    expect(e.projectState?.workspaceDirOverride(e.dirOverrideKey(SK))).toBe(target)
    expect(p.refreshed[0]!.sessionKey).toBe(SK)
    expect(markdowns(p.refreshed[0]!.card)).toContain('Session ended. Next conversation will start a new Agent session.')
  })

  it('act:/dir reset restores the base work dir', async () => {
    const dirs = makeDirs(3)
    const p = newRefreshingPlatform()
    const e = newDirEngine(p, dirs, dirs[1] ?? '')

    e.receiveMessage(p, cardActionMsg(SK, 'act:/dir reset'))
    await waitFor(() => p.refreshed.length === 1, 'refreshCard')

    expect(e.projectState?.workspaceDirOverride(e.dirOverrideKey(SK))).toBe('')
    expect(p.getSent()).toEqual([])
  })

  it('act:/dir prev switches to the previous history entry', async () => {
    const dirs = makeDirs(3)
    const p = newRefreshingPlatform()
    const e = newDirEngine(p, dirs, dirs[0] ?? '')
    const prev = e.dirHistory?.get('test', 2) ?? ''

    e.receiveMessage(p, cardActionMsg(SK, 'act:/dir prev'))
    await waitFor(() => p.refreshed.length === 1, 'refreshCard')

    expect(e.projectState?.workspaceDirOverride(e.dirOverrideKey(SK))).toBe(prev)
  })

  it('act:/dir select with an invalid index re-renders without the notice and without switching', async () => {
    const dirs = makeDirs(3)
    const p = newRefreshingPlatform()
    const e = newDirEngine(p, dirs, dirs[0] ?? '')

    e.receiveMessage(p, cardActionMsg(SK, 'act:/dir select 99'))
    await waitFor(() => p.refreshed.length === 1, 'refreshCard')

    expect(e.projectState?.workspaceDirOverride(e.dirOverrideKey(SK))).toBe(dirs[0] ?? '')
  })

  it('nav:/dir N only turns the page: no side effect, requested page rendered', async () => {
    const dirs = makeDirs(7)
    const p = newRefreshingPlatform()
    const e = newDirEngine(p, dirs, dirs[0] ?? '')

    e.receiveMessage(p, cardActionMsg(SK, 'nav:/dir 2'))
    await waitFor(() => p.refreshed.length === 1, 'refreshCard')

    expect(e.projectState?.workspaceDirOverride(e.dirOverrideKey(SK))).toBe(dirs[0] ?? '')
    expect(markdowns(p.refreshed[0]!.card)).not.toContain('Session ended. Next conversation will start a new Agent session.')
  })

  it('a non-admin operator cannot enter delete mode from the list card', async () => {
    // act:/delete-mode submit deletes whole sessions; the list card's
    // danger button must not bypass admin_from.
    const p = newRefreshingPlatform()
    const e = newDirEngine(p, makeDirs(1), makeDirs(1)[0] ?? '')
    registerSessionCommands(e)
    e.setAdminFrom('ou_admin')

    e.receiveMessage(p, cardActionMsg(SK, 'act:/delete-mode enter'))
    await waitFor(() => p.getSent().length > 0, 'admin-required reply')

    expect(e.interactiveStates.get(SK)?.deleteMode, 'delete mode never armed').toBeUndefined()
    expect(p.getSent().some(m => m.includes('/delete-mode'))).toBe(true)
  })

  it('a non-admin operator cannot switch dirs through the card buttons', async () => {
    // The text path gates /dir behind admin_from; the card-action path must
    // not bypass it (the /help card links /dir from its system page).
    const dirs = makeDirs(3)
    const p = newRefreshingPlatform()
    const e = newDirEngine(p, dirs, dirs[0] ?? '')
    registerSessionCommands(e)
    e.setAdminFrom('ou_admin')

    e.receiveMessage(p, cardActionMsg(SK, 'act:/dir select 2'))
    await waitFor(() => p.getSent().length > 0, 'admin-required reply')

    expect(e.projectState?.workspaceDirOverride(e.dirOverrideKey(SK))).toBe(dirs[0] ?? '')
    expect(p.getSent().some(m => m.includes('/dir'))).toBe(true)
  })

  it('an admin operator still switches dirs through the card buttons', async () => {
    const dirs = makeDirs(3)
    const p = newRefreshingPlatform()
    const e = newDirEngine(p, dirs, dirs[0] ?? '')
    registerSessionCommands(e)
    e.setAdminFrom('*')
    const target = e.dirHistory?.get('test', 2) ?? ''

    e.receiveMessage(p, cardActionMsg(SK, 'act:/dir select 2'))
    await waitFor(() => p.refreshed.length === 1, 'refreshCard')

    expect(e.projectState?.workspaceDirOverride(e.dirOverrideKey(SK))).toBe(target)
  })

  it('falls back to a new card when the platform cannot PATCH', async () => {
    const dirs = makeDirs(3)
    const p = createStubCardPlatform('test')
    const e = newDirEngine(p, dirs, dirs[0] ?? '')

    e.receiveMessage(p, cardActionMsg(SK, 'act:/dir select 2'))
    await waitFor(() => p.sentCards.length === 1, 'fallback card')

    expect(p.sentCards).toHaveLength(1)
    const card = p.sentCards[0] as { header?: { color: string } }
    expect(card.header?.color).toBe('turquoise')
  })

  it('unknown nav: commands are consumed without a turn or a card', async () => {
    const dirs = makeDirs(2)
    const p = newRefreshingPlatform()
    const e = newDirEngine(p, dirs, dirs[0] ?? '')

    e.receiveMessage(p, cardActionMsg(SK, 'nav:/model'))
    await new Promise((resolve) => { setTimeout(resolve, 50) })

    expect(p.refreshed).toEqual([])
    expect(p.sentCards).toEqual([])
    expect(p.getSent()).toEqual([])
  })
})
