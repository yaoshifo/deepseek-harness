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

/**
 * Internal escape hatch for tests asserting the default is restored.
 * @returns The runner currently in effect (the default when none was injected).
 */
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

/**
 * Parse a [spawn].worktree config value (Go parseWorktreeMode).
 * @param s - Raw config value; matched case-insensitively after trimming.
 * @returns The parsed mode; unrecognized values fall back to Auto.
 */
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

/**
 * Whether a child should inherit the parent's conversation context (Go parseForkMode).
 * @param s - Raw config value; matched case-insensitively after trimming.
 * @returns True only for on/true/1/yes; anything else is false.
 */
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
 *
 * @param dir - Directory to resolve from.
 * @returns The absolute repository root, or undefined when dir is not inside a
 * git working tree.
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
 *
 * @param repoRoot - Repository root to create the worktree in.
 * @param slug - Unique name for the worktree directory and its branch.
 * @returns The new worktree's path, branch name, and base commit SHA.
 */
export async function createWorktree(repoRoot: string, slug: string): Promise<WorktreeCreateInfo> {
  const baseOut = await runGit(repoRoot, ['rev-parse', 'HEAD'])
  const baseSHA = baseOut.trim()

  const branch = `cc/${slug}`
  const path = join(repoRoot, '.claude', 'worktrees', slug)

  await runGit(repoRoot, ['worktree', 'add', '-b', branch, path, 'HEAD'])
  return { path, branch, baseSHA }
}

/** The two independent reasons a worktree counts as dirty (Go worktreeDirty). */
export interface WorktreeDirtyDetail {
  /** Uncommitted changes exist — removal loses them regardless of merge state. */
  uncommitted: boolean
  /** Commits exist ahead of the branch base — removable when already merged elsewhere. */
  ahead: boolean
}

/**
 * Split the worktree-dirty verdict into its causes (Go worktreeDirty plus the
 * merge-state distinction the /done auto-removal needs).
 *
 * @param path - Worktree directory to check.
 * @param baseSHA - Commit the worktree branched from; '' skips the ahead check.
 * @returns Whether uncommitted changes and/or commits ahead of baseSHA exist.
 */
export async function worktreeDirtyDetail(path: string, baseSHA: string): Promise<WorktreeDirtyDetail> {
  const status = await runGit(path, ['status', '--porcelain'])
  const uncommitted = status.trim() !== ''
  let ahead = false
  if (baseSHA !== '') {
    const aheadOut = await runGit(path, ['rev-list', '--count', `${baseSHA}..HEAD`])
    const n = Number.parseInt(aheadOut.trim(), 10)
    ahead = Number.isFinite(n) && n > 0
  }
  return { uncommitted, ahead }
}

/**
 * Whether branch's commits are fully contained in integrateBranch — as
 * ancestors, or as patch-equivalent commits after a rebase or cherry-pick (a
 * branch whose only unique commit is a merge falls under patch equivalence).
 * Any git failure reads as not merged so callers keep the worktree.
 *
 * @param repoRoot - Repository root that owns the branch.
 * @param branch - Branch the worktree committed to.
 * @param integrateBranch - Branch those commits are expected to have landed in.
 * @returns Whether removing branch loses no committed work.
 */
export async function worktreeMergedInto(repoRoot: string, branch: string, integrateBranch: string): Promise<boolean> {
  try {
    await runGit(repoRoot, ['merge-base', '--is-ancestor', branch, integrateBranch])
    return true
  } catch {
    // Not an ancestor (or the probe failed) — fall through to patch equivalence.
  }
  try {
    const out = await runGit(repoRoot, ['cherry', integrateBranch, branch])
    return !out.split('\n').some(line => line.startsWith('+'))
  } catch {
    return false
  }
}

/**
 * Whether a spawned/forked child should run in an isolated git worktree,
 * combining the configured spawn mode with an explicit -w flag (Go
 * resolveWorktreeUse). When auto=true the caller probes the repo root and
 * silently skips isolation for a non-git workDir.
 *
 * @param mode - Configured [spawn].worktree mode.
 * @param flag - Explicit -w flag from the spawn request.
 * @returns use: whether isolation applies; auto: whether the caller must
 * probe the repo root first.
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
 *
 * @param dir - Working directory to summarize.
 * @returns The shortstat line, or '' when empty or not a git working tree.
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
 *
 * @param errMsg - Error message from a failed `git worktree remove`.
 * @returns Whether the error indicates the worktree no longer exists.
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
 *
 * @param repoRoot - Repository root that owns the worktree.
 * @param path - Worktree directory to remove.
 * @param branch - Branch to delete afterwards; '' skips branch deletion.
 * @param force - Remove even when the worktree has uncommitted changes.
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
 *
 * @param dir - Directory whose memory/ subtree to inspect.
 * @returns Whether memory/ holds at least one non-empty file or subdirectory.
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
 *
 * @param dir - Directory whose memory/ subtree to delete.
 * @returns The removed memory/ path, or '' when there was nothing to remove.
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
 *
 * @param firstMsg - First message of the task the worktree is created for.
 * @param now - Timestamp used for the uniqueness suffix.
 * @returns The sanitized slug, `<base>-<MMDD-HHmmss>`, defaulting to `task`.
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
