/**
 * /done merged-child auto-removal: a child worktree whose only dirty cause is
 * commits already contained in its containment target is removed automatically
 * instead of being kept for the per-child Keep/Remove card. The target
 * defaults to the branch HEAD was on when the worktree was created (per-repo,
 * zero config); `spawn.integrateBranch` overrides it globally. Unmerged
 * commits and uncommitted changes keep the preserve behavior, and a worktree
 * created from a detached HEAD stays on the interactive path unless the
 * override is configured.
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

/** Create a worktree (recording the creation-time base branch) and commit one edit on its branch. */
async function committedWorktree(root: string, slug: string, content: string): Promise<WorktreeCreateInfo> {
  const wt = await createWorktree(root, slug)
  expect(wt.baseBranch).toBe('main')
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

describe('createWorktree base branch recording', () => {
  it('records the branch HEAD was on; a detached HEAD records ""', async () => {
    const root = await initTestRepo()
    await git(root, 'checkout', '--detach')
    const wt = await createWorktree(root, 'detached')
    expect(wt.baseBranch).toBe('')
  })
})

describe('cleanupOneChat merged auto-removal', () => {
  it('default-on: removes a merged child against its recorded base branch, no config', async () => {
    const root = await initTestRepo()
    const wt = await committedWorktree(root, 'default', 'merged work\n')
    await git(root, 'merge', wt.branch)
    const p = createStubCardPlatform('test')
    const e = newEngine(p)
    const sess = e.sessions.getOrCreateActive('test:child')
    sess.setWorktreeInfo(wt.path, wt.branch, wt.baseSHA, root, wt.baseBranch)

    const r = await cleanupOneChat(e, p, 'test:child', newStubMessage().replyCtx, true)

    expect(r.dirty).toBe(false)
    expect(sess.getWorktreeInfo()).toEqual(['', '', '', '', ''])
    await expect(git(root, 'worktree', 'list')).resolves.not.toContain(wt.path)
    await expect(git(root, 'branch', '--list', wt.branch)).resolves.toBe('')
    expect(p.getSent().some(m => m.includes('main'))).toBe(true)
  })

  it('the integrateBranch override replaces the recorded base branch', async () => {
    const root = await initTestRepo()
    await git(root, 'branch', 'dev') // landing branch that is not the base branch
    const wt = await committedWorktree(root, 'over', 'landed elsewhere\n')
    await git(root, 'checkout', 'dev')
    await git(root, 'merge', wt.branch)
    await git(root, 'checkout', 'main')
    const p = createStubCardPlatform('test')
    const e = newEngine(p)
    e.setSpawnIntegrateBranch('dev')
    const sess = e.sessions.getOrCreateActive('test:child')
    sess.setWorktreeInfo(wt.path, wt.branch, wt.baseSHA, root, '') // no recorded base branch

    const r = await cleanupOneChat(e, p, 'test:child', newStubMessage().replyCtx, true)

    expect(r.dirty).toBe(false)
    expect(sess.getWorktreeInfo()).toEqual(['', '', '', '', ''])
    await expect(git(root, 'worktree', 'list')).resolves.not.toContain(wt.path)
    expect(p.getSent().some(m => m.includes('dev'))).toBe(true)
  })

  it('keeps a merged child with no recorded base branch and no override', async () => {
    const root = await initTestRepo()
    const wt = await committedWorktree(root, 'unconf', 'merged work\n')
    await git(root, 'merge', wt.branch)
    const p = createStubCardPlatform('test')
    const e = newEngine(p)
    const sess = e.sessions.getOrCreateActive('test:child')
    sess.setWorktreeInfo(wt.path, wt.branch, wt.baseSHA, root, '') // detached creation, override unset

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
    const sess = e.sessions.getOrCreateActive('test:child')
    sess.setWorktreeInfo(wt.path, wt.branch, wt.baseSHA, root, wt.baseBranch)

    const r = await cleanupOneChat(e, p, 'test:child', newStubMessage().replyCtx, true)

    expect(r.dirty).toBe(true)
    expect(existsSync(wt.path)).toBe(true)
  })

  it('keeps uncommitted changes even with a containment target', async () => {
    const root = await initTestRepo()
    const wt = await createWorktree(root, 'dirty')
    await writeFile(join(wt.path, 'README.md'), 'uncommitted\n')
    const p = createStubCardPlatform('test')
    const e = newEngine(p)
    const sess = e.sessions.getOrCreateActive('test:child')
    sess.setWorktreeInfo(wt.path, wt.branch, wt.baseSHA, root, wt.baseBranch)

    const r = await cleanupOneChat(e, p, 'test:child', newStubMessage().replyCtx, false)

    expect(r.dirty).toBe(true)
    expect(existsSync(wt.path)).toBe(true)
    // The root chat gets the interactive Keep/Remove card.
    expect(p.sentCards.length).toBe(1)
  })
})
