/**
 * Engine card-action routing (Go handleCardNav's act:/wt path): a
 * card.action.trigger button press dispatched by the platform as an
 * isCardAction message runs the worktree Keep/Remove side effect and replaces
 * the pressed card in place (CardRefresher), falling back to a new card when
 * the platform cannot PATCH.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { Engine } from '../../src/engine/engine.js'
import { createWorktree } from '../../src/engine/worktree.js'
import { createStubAgent, createStubCardPlatform, newStubMessage, type RecordedCard, type StubCardPlatform } from '../stubs/engine-stubs.js'
import type { Message, Platform } from '../../src/core/types.js'

const execFileP = promisify(execFile)

interface RefreshingPlatform extends StubCardPlatform {
  refreshed: Array<{ sessionKey: string; body: string }>
  refreshCard(sessionKey: string, card: unknown): Promise<void>
}

function newRefreshingPlatform(n = 'test'): RefreshingPlatform {
  const base = createStubCardPlatform(n)
  const p: RefreshingPlatform = {
    ...base,
    refreshed: [],
    refreshCard: async (sessionKey, card) => {
      p.refreshed.push({ sessionKey, body: cardBody(card) })
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
    sess.setWorktreeInfo('/gone/wt', 'cc/x', 'abc', '/repo')

    e.receiveMessage(p, cardActionMsg('test:child-chat', 'act:/wt keep'))
    await waitFor(() => p.refreshed.length === 1, 'refreshCard')

    expect(p.refreshed[0]!.sessionKey).toBe('test:child-chat')
    expect(p.refreshed[0]!.body).not.toContain('/gone/wt') // terminal card, not the prompt
    expect(sess.getWorktreeInfo()).toEqual(['', '', '', ''])
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
    sess.setWorktreeInfo(wt.path, wt.branch, wt.baseSHA, root)

    e.receiveMessage(p, cardActionMsg('test:child-chat', 'act:/wt remove'))
    await waitFor(() => p.refreshed.length === 1, 'refreshCard')

    expect(sess.getWorktreeInfo()).toEqual(['', '', '', ''])
    const list = await execFileP('git', ['worktree', 'list'], { cwd: root })
    expect(list.stdout).not.toContain(wt.path)
  })

  it('falls back to a new card when the platform cannot PATCH', async () => {
    const p = createStubCardPlatform('test')
    const e = newEngine(p)
    const sess = e.sessions.getOrCreateActive('test:child-chat')
    sess.setWorktreeInfo('/gone/wt', 'cc/x', 'abc', '/repo')

    e.receiveMessage(p, cardActionMsg('test:child-chat', 'act:/wt keep'))
    await waitFor(() => p.sentCards.length === 1, 'fallback card')

    expect(p.sentCards).toHaveLength(1)
    expect(sess.getWorktreeInfo()).toEqual(['', '', '', ''])
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
