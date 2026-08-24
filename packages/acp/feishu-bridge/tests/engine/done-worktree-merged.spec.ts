/**
 * /done merged-child auto-removal: a child worktree whose only dirty cause is
 * commits already contained in the configured spawn.integrateBranch is removed
 * automatically instead of being kept for the per-child Keep/Remove card;
 * unmerged commits, uncommitted changes, and the unset config all keep the
 * current preserve behavior.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { Engine } from '../../src/engine/engine.js'
import { cleanupOneChat } from '../../src/engine/commands.js'
import { createWorktree, worktreeMergedInto, type WorktreeCreateInfo } from '../../src/engine/worktree.js'
import { createStubAgent, createStubCardPlatform, newStubMessage } from '../stubs/engine-stubs.js'
import type { Platform } from '../../src/core/types.js'

const execFileP = promisify(execFile)

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
}

/** Run git in dir and return stdout. */
async function git(dir: string, ...args: string[]): Promise<string> {
  const r = await execFileP('git', args, { cwd: dir, env: GIT_ENV })
  return r.stdout
}

/** Create a git repo on branch main with one commit and return its root. */
async function initTestRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fb-done-merged-repo-'))
  await git(root, 'init', '-b', 'main')
  await writeFile(join(root, 'README.md'), 'hello\n')
  await git(root, 'add', 'README.md')
  await git(root, 'commit', '-m', 'init')
  return root
}

/** Create a worktree and commit one edit on its branch. */
async function committedWorktree(root: string, slug: string, content: string): Promise<WorktreeCreateInfo> {
  const wt = await createWorktree(root, slug)
  await writeFile(join(wt.path, 'README.md'), content)
  await git(wt.path, 'add', 'README.md')
  await git(wt.path, 'commit', '-m', `work ${slug}`)
  return wt
}

function newEngine(p: Platform): Engine {
  return new Engine('test', createStubAgent(), [p], '', 'en')
}

describe('worktreeMergedInto', () => {
  it('true when the branch is an ancestor of the integrate branch', async () => {
    const root = await initTestRepo()
    const wt = await committedWorktree(root, 'anc', 'merged work\n')
    await git(root, 'merge', wt.branch)

    await expect(worktreeMergedInto(root, wt.branch, 'main')).resolves.toBe(true)
  })

  it('true for patch-equivalent commits after a cherry-pick', async () => {
    const root = await initTestRepo()
    const wt = await committedWorktree(root, 'picked', 'picked work\n')
    await git(root, 'cherry-pick', wt.branch) // same patch on main, branch not an ancestor

    await expect(worktreeMergedInto(root, wt.branch, 'main')).resolves.toBe(true)
  })

  it('false when commits exist only on the worktree branch', async () => {
    const root = await initTestRepo()
    const wt = await committedWorktree(root, 'unique', 'unmerged work\n')

    await expect(worktreeMergedInto(root, wt.branch, 'main')).resolves.toBe(false)
  })

  it('false when the integrate branch does not exist', async () => {
    const root = await initTestRepo()
    const wt = await committedWorktree(root, 'lost', 'work\n')

    await expect(worktreeMergedInto(root, wt.branch, 'nope')).resolves.toBe(false)
  })
})

describe('cleanupOneChat merged auto-removal', () => {
  it('removes a child whose commits landed in the integrate branch', async () => {
    const root = await initTestRepo()
    const wt = await committedWorktree(root, 'merged', 'merged work\n')
    await git(root, 'merge', wt.branch)
    const p = createStubCardPlatform('test')
    const e = newEngine(p)
    e.setSpawnIntegrateBranch('main')
    const sess = e.sessions.getOrCreateActive('test:child')
    sess.setWorktreeInfo(wt.path, wt.branch, wt.baseSHA, root)

    const r = await cleanupOneChat(e, p, 'test:child', newStubMessage().replyCtx, true)

    expect(r.dirty).toBe(false)
    expect(sess.getWorktreeInfo()).toEqual(['', '', '', ''])
    await expect(git(root, 'worktree', 'list')).resolves.not.toContain(wt.path)
    await expect(git(root, 'branch', '--list', wt.branch)).resolves.toBe('')
    expect(p.getSent().some(m => m.includes('main'))).toBe(true)
  })

  it('keeps a merged child when no integrate branch is configured', async () => {
    const root = await initTestRepo()
    const wt = await committedWorktree(root, 'unconf', 'merged work\n')
    await git(root, 'merge', wt.branch)
    const p = createStubCardPlatform('test')
    const e = newEngine(p)
    const sess = e.sessions.getOrCreateActive('test:child')
    sess.setWorktreeInfo(wt.path, wt.branch, wt.baseSHA, root)

    const r = await cleanupOneChat(e, p, 'test:child', newStubMessage().replyCtx, true)

    expect(r.dirty).toBe(true)
    expect(existsSync(wt.path)).toBe(true)
    expect(sess.getWorktreeInfo()[0]).toBe(wt.path)
  })

  it('keeps a child whose commits never landed anywhere', async () => {
    const root = await initTestRepo()
    const wt = await committedWorktree(root, 'unmerged', 'unmerged work\n')
    const p = createStubCardPlatform('test')
    const e = newEngine(p)
    e.setSpawnIntegrateBranch('main')
    const sess = e.sessions.getOrCreateActive('test:child')
    sess.setWorktreeInfo(wt.path, wt.branch, wt.baseSHA, root)

    const r = await cleanupOneChat(e, p, 'test:child', newStubMessage().replyCtx, true)

    expect(r.dirty).toBe(true)
    expect(existsSync(wt.path)).toBe(true)
  })

  it('keeps uncommitted changes even with the integrate branch configured', async () => {
    const root = await initTestRepo()
    const wt = await createWorktree(root, 'dirty')
    await writeFile(join(wt.path, 'README.md'), 'uncommitted\n')
    const p = createStubCardPlatform('test')
    const e = newEngine(p)
    e.setSpawnIntegrateBranch('main')
    const sess = e.sessions.getOrCreateActive('test:child')
    sess.setWorktreeInfo(wt.path, wt.branch, wt.baseSHA, root)

    const r = await cleanupOneChat(e, p, 'test:child', newStubMessage().replyCtx, false)

    expect(r.dirty).toBe(true)
    expect(existsSync(wt.path)).toBe(true)
    // The root chat gets the interactive Keep/Remove card.
    expect(p.sentCards.length).toBe(1)
  })
})
