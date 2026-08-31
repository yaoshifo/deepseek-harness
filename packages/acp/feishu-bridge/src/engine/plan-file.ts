/**
 * Bridge-side plan persistence, aligned with Claude Code's plan files: the
 * full plan markdown is written into the user-level plans directory as
 * `<cwd-slug>-<title-slug>.md`; a same-name file holding different content
 * gets a `-YYYYMMDD-HHMMSS`-suffixed sibling instead of an overwrite, and
 * identical content keeps the existing file untouched.
 *
 * @module dsh-feishu-bridge/plan-file
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from '../atomicwrite.ts'
import { extractMarkdownTitle, slugifyTitle } from './plan-render.ts'

/** Plan-file permission, matching the plan .md files Claude Code writes. */
const PLAN_FILE_MODE = 0o644

/**
 * Filesystem-safe cwd slug: separators, spaces, and colons collapse to
 * dashes, lowercased, no leading/trailing dash (Claude Code plan-file naming).
 *
 * @param workdir - Project working directory the plan belongs to.
 * @returns The slugified directory path.
 */
function cwdSlug(workdir: string): string {
  return workdir.toLowerCase().replace(/[/\\ :]+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * Local-clock `-YYYYMMDD-HHMMSS` suffix (Claude Code plan-revision naming).
 *
 * @param now - Timestamp of the write.
 * @returns The formatted suffix.
 */
function timestampSuffix(now: Date): string {
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return `${String(now.getFullYear())}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`
}

/**
 * Persist a presented plan under `dir`, named after the project workdir and
 * the plan's first Markdown heading. Writing fails loud (throws) — the caller
 * decides the fallback.
 *
 * @param dir - Plans directory; created when missing.
 * @param workdir - Project working directory, slugified into the basename.
 * @param content - Full plan markdown.
 * @param now - Timestamp of the write; only read for the revision suffix.
 * @returns The written (or already-identical existing) file path.
 */
export function savePlanFile(dir: string, workdir: string, content: string, now: Date = new Date()): string {
  const base = `${cwdSlug(workdir)}-${slugifyTitle(extractMarkdownTitle(content), 'plan')}`
  let path = join(dir, `${base}.md`)
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8').trim() === content.trim()) return path
    path = join(dir, `${base}-${timestampSuffix(now)}.md`)
  }
  mkdirSync(dir, { recursive: true })
  atomicWriteFileSync(path, new TextEncoder().encode(`${content.trim()}\n`), PLAN_FILE_MODE)
  return path
}
