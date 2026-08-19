/**
 * Git-worktree isolation for spawned/forked children, ported 1:1 from
 * cc-connect core/worktree.go plus the worktree-mode parsing from
 * core/engine_subtask.go. Go's exec.Command git calls become an injectable
 * async runner so tests can stub git; the default runs `git` and returns
 * combined output like Go's CombinedOutput.
 *
 * @module dsh-feishu-bridge/worktree
 */

import { execFile } from 'node:child_process'
import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Runs `git args...` in dir and returns combined stdout+stderr. Throws with
 * the trimmed output on non-zero exit (Go runGit's error shape).
 */
export type GitRunner = (dir: string, args: string[]) => Promise<string>

const defaultGitRunner: GitRunner = (dir, args) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd: dir }, (error, _stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`git ${args.join(' ')}: ${error.message}: ${stderr.trim()}`))
        return
      }
      resolve(_stdout + stderr)
    })
  })

let gitRunner: GitRunner = defaultGitRunner

/**
 * Replace the git runner (tests inject a stub). Passing undefined restores
 * the default `git` subprocess runner.
 * @param runner - The new runner, or undefined for the default.
 */
export function setGitRunner(runner: GitRunner | undefined): void {
  gitRunner = runner ?? defaultGitRunner
}

/** Internal escape hatch for tests asserting the default is restored. */
export function currentGitRunner(): GitRunner {
  return gitRunner
}

async function runGit(dir: string, args: string[]): Promise<string> {
  return gitRunner(dir, args)
}

/** How SpawnSubtask decides on git-worktree isolation for a child task (Go worktreeMode). */
export enum WorktreeMode {
  /** No isolation: children share the main working tree (the /spawn /fork default). */
  ForceOff = 0,
  /** Same-repo children get isolated, cross-repo ones do not (the subtask default). */
  Auto = 1,
  /** Always isolate. */
  ForceOn = 2,
}

/** Parse a [spawn].worktree config value (Go parseWorktreeMode). */
export function parseWorktreeMode(s: string): WorktreeMode {
  switch (s.trim().toLowerCase()) {
    case 'on': case 'true': case '1': case 'yes':
      return WorktreeMode.ForceOn
    case 'off': case 'false': case '0': case 'no':
      return WorktreeMode.ForceOff
    default:
      return WorktreeMode.Auto
  }
}

/** Whether a child should inherit the parent's conversation context (Go parseForkMode). */
export function parseForkMode(s: string): boolean {
  switch (s.trim().toLowerCase()) {
    case 'on': case 'true': case '1': case 'yes':
      return true
    default:
      return false
  }
}

/**
 * Git repository root containing dir, or undefined when dir is not inside a
 * git working tree (Go worktreeRepoRoot).
 */
export async function worktreeRepoRoot(dir: string): Promise<string | undefined> {
  let out: string
  try {
    out = await runGit(dir, ['rev-parse', '--show-toplevel'])
  } catch {
    return undefined
  }
  return out.trim()
}

/** A created worktree's coordinates (Go createWorktree's returns). */
export interface WorktreeCreateInfo {
  path: string
  branch: string
  baseSHA: string
}

/**
 * Add a new git worktree under `<repoRoot>/.claude/worktrees/<slug>` on a
 * fresh branch `cc/<slug>` based on the repo's current HEAD (Go
 * createWorktree).
 */
export async function createWorktree(repoRoot: string, slug: string): Promise<WorktreeCreateInfo> {
  const baseOut = await runGit(repoRoot, ['rev-parse', 'HEAD'])
  const baseSHA = baseOut.trim()

  const branch = `cc/${slug}`
  const path = join(repoRoot, '.claude', 'worktrees', slug)

  await runGit(repoRoot, ['worktree', 'add', '-b', branch, path, 'HEAD'])
  return { path, branch, baseSHA }
}

/**
 * Whether the worktree has uncommitted changes or commits ahead of its base —
 * work that would be lost on removal (Go worktreeDirty).
 */
export async function worktreeDirty(path: string, baseSHA: string): Promise<boolean> {
  const status = await runGit(path, ['status', '--porcelain'])
  if (status.trim() !== '') return true
  if (baseSHA !== '') {
    const ahead = await runGit(path, ['rev-list', '--count', `${baseSHA}..HEAD`])
    const n = Number.parseInt(ahead.trim(), 10)
    if (Number.isFinite(n) && n > 0) return true
  }
  return false
}

/**
 * Whether a spawned/forked child should run in an isolated git worktree,
 * combining the configured spawn mode with an explicit -w flag (Go
 * resolveWorktreeUse). When auto=true the caller probes the repo root and
 * silently skips isolation for a non-git workDir.
 */
export function resolveWorktreeUse(mode: WorktreeMode, flag: boolean): { use: boolean; auto: boolean } {
  if (flag || mode === WorktreeMode.ForceOn) return { use: true, auto: false }
  if (mode === WorktreeMode.ForceOff) return { use: false, auto: false }
  return { use: false, auto: true }
}

/**
 * One-line summary of uncommitted changes in dir (e.g. "3 files changed, 47
 * insertions(+), 8 deletions(-)"), or '' when there is nothing to summarize
 * or dir is not a git working tree (Go gitDiffShortstat).
 */
export async function gitDiffShortstat(dir: string): Promise<string> {
  let out: string
  try {
    out = await runGit(dir, ['diff', '--shortstat', 'HEAD'])
  } catch {
    return ''
  }
  return out.trim()
}

/**
 * Whether a `git worktree remove` error means the worktree is already gone —
 * directory deleted out-of-band, or never/no-longer registered (Go
 * worktreeGone).
 */
export function worktreeGone(errMsg: string): boolean {
  const m = errMsg.toLowerCase()
  return m.includes('is not a working tree')
    || m.includes('no such file')
    || m.includes('not a working tree')
}

/**
 * Remove the worktree at path and delete its branch. Idempotent: an
 * already-gone worktree is treated as success (prune + best-effort branch
 * delete). When force is true the worktree is removed even with uncommitted
 * changes (Go removeWorktree).
 */
export async function removeWorktree(repoRoot: string, path: string, branch: string, force: boolean): Promise<void> {
  const args = ['worktree', 'remove']
  if (force) args.push('--force')
  args.push(path)
  try {
    await runGit(repoRoot, args)
  } catch (error) {
    if (!worktreeGone(error instanceof Error ? error.message : String(error))) {
      throw error
    }
    // Directory already gone; clear the stale registration so a future
    // `git worktree add` of the same path doesn't collide.
    await runGit(repoRoot, ['worktree', 'prune']).catch(() => undefined)
  }
  if (branch !== '') {
    // Branch deletion is best-effort: a branch that was merged/renamed away
    // should not block the worktree teardown.
    await runGit(repoRoot, ['branch', '-D', branch]).catch(() => undefined)
  }
}

/**
 * Whether `<dir>/memory` holds at least one non-empty file (or any
 * subdirectory). An empty or missing memory/ dir is "no memory" (Go
 * memoryHasContent).
 */
export function memoryHasContent(dir: string): boolean {
  let entries
  try {
    entries = readdirSync(join(dir, 'memory'))
  } catch {
    return false
  }
  for (const e of entries) {
    try {
      if (statSync(join(dir, 'memory', e)).isDirectory()) return true
    } catch {
      continue
    }
    try {
      if (statSync(join(dir, 'memory', e)).size > 0) return true
    } catch {
      continue
    }
  }
  return false
}

/**
 * Delete the memory/ subtree under dir, but nothing else. Returns the removed
 * path, or '' when there was no memory to remove (Go removeOrphanMemory).
 */
export function removeOrphanMemory(dir: string): string {
  if (!memoryHasContent(dir)) return ''
  const mem = join(dir, 'memory')
  try {
    rmSync(mem, { recursive: true, force: true })
  } catch (error) {
    console.warn(`worktree: orphan memory cleanup failed (${mem}): ${String(error)}`)
    return ''
  }
  return mem
}

/**
 * Turn a first message into a filesystem/branch-safe slug, capped to ~30
 * runes and suffixed with a timestamp to keep worktree paths unique (Go
 * slugify).
 */
export function slugify(firstMsg: string, now = new Date()): string {
  let b = ''
  let prevDash = false
  for (const r of firstMsg.trim().toLowerCase()) {
    const isAsciiLetter = r.charCodeAt(0) < 128 && /[a-z]/.test(r)
    const isAsciiDigit = r.charCodeAt(0) < 128 && /\d/.test(r)
    if (isAsciiLetter || isAsciiDigit) {
      b += r
      prevDash = false
    } else if (!prevDash && b.length > 0) {
      b += '-'
      prevDash = true
    }
    if (Array.from(b).length >= 30) break
  }
  let base = b.replace(/^-+|-+$/g, '')
  if (base === '') base = 'task'
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${base}-${stamp}`
}
