/**
 * Local backing store for one Claude Code memory directory.
 *
 * All IO targets `~/.claude/projects/<slug>/memory/` directly through `node:fs`
 * on the host machine, never through the swappable `ctx.fs` provider: the
 * memory directory must stay machine-local so Claude Code and dsh read and
 * write the same files regardless of deployment shape.
 *
 * @module @deepseek-ai/dsh-tool-claude-memory
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { claudeProjectSlug } from './slug.ts'

/** One indexed memory file as returned by {@link listMemory}. */
export interface MemoryEntry {
  /** File name inside the memory directory. */
  name: string
  /** UTF-8 byte size. */
  bytes: number
  /** Last modification time, ISO 8601. */
  modified: string
}

/** Outcome of one {@link writeMemory} call. */
export interface MemoryWriteResult {
  /** On-disk file name after `.md` normalization. */
  name: string
  /** UTF-8 byte size of the stored content. */
  bytes: number
  /** Line count of the stored content. */
  lines: number
  /** Machine-readable annotations; `provenance` marks harness-backfilled frontmatter. */
  annotations: ('provenance')[] | []
  /** Present when MEMORY.md exceeded an index limit; the write still succeeded. */
  warning?: string
}

/** One MEMORY.md pointer-line change: insert-or-update, or remove. */
export type MemoryIndexChange =
  | {
    readonly action: 'upsert'
    /** The memory file the pointer line links to; `.md` is normalized like every other name. */
    readonly name: string
    /** The link text, rendered as `- [title](name.md) — hook`. */
    readonly title: string
    /** The one-line hook rendered after the em dash. */
    readonly hook: string
  }
  | {
    readonly action: 'remove'
    /** The memory file whose pointer line is removed. */
    readonly name: string
  }

/** Outcome of one {@link updateMemoryIndex} call. */
export interface MemoryIndexResult {
  /** The memory file name after `.md` normalization. */
  name: string
  /** Which change ran. */
  action: 'upsert' | 'remove'
  /** Whether MEMORY.md content actually changed; a no-op writes nothing. */
  changed: boolean
  /** Line count of the resulting index (0 when no index exists). */
  lines: number
  /** UTF-8 byte size of the resulting index (0 when no index exists). */
  bytes: number
  /** Present when the resulting index exceeded a limit; the change still succeeded. */
  warning?: string
}

/** Index budget applied to MEMORY.md writes. */
export interface IndexLimits {
  maxIndexLines: number
  maxIndexBytes: number
}

/**
 * The Claude Code memory directory for one working directory.
 * @param claudeHome - root holding `projects/`.
 * @param cwd - absolute POSIX session working directory.
 * @returns the memory directory path.
 */
export function resolveMemoryDir(claudeHome: string, cwd: string): string {
  return join(claudeHome, 'projects', claudeProjectSlug(cwd), 'memory')
}

/**
 * Reject names that could escape the memory directory. This is the trust
 * boundary; frontmatter or content quality stays model-governed.
 */
function assertMemoryName(name: string): void {
  const trimmed = name.trim()
  if (
    trimmed.length === 0 || trimmed !== name
    || name.includes('/') || name.includes('\\')
    || name === '.' || name === '..'
  ) {
    throw new Error(`invalid memory name: ${JSON.stringify(name)}`)
  }
}

/**
 * The on-disk name for one memory write: every topic file carries the `.md`
 * suffix so index links and tool calls agree; `MEMORY.md` stays exact.
 */
function resolveMemoryFileName(name: string): string {
  return name === 'MEMORY.md' || name.endsWith('.md') ? name : `${name}.md`
}

/**
 * The alternate spelling for one missed memory name — with or without the
 * `.md` suffix — so reads and deletes heal extension-less legacy files and
 * names the writer normalized. `undefined` when no distinct alternate exists.
 */
function alternateMemoryName(name: string): string | undefined {
  if (name.endsWith('.md')) {
    return name.length > '.md'.length ? name.slice(0, -'.md'.length) : undefined
  }
  return `${name}.md`
}

/** Read one UTF-8 file, mapping ENOENT to `undefined` so a miss stays distinguishable from failure. */
async function readFileOrNull(path: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    return await readFile(path, { encoding: 'utf8', signal })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Count content lines the way an editor does: newline-separated segments. */
function countLines(content: string): number {
  return content.split('\n').length
}

/**
 * Backfill `node_type: memory` and `originSessionId` inside an existing
 * frontmatter `metadata:` block, mirroring what the Claude Code harness adds
 * after a model Write. Frontmatter without a `metadata:` block and plain
 * non-frontmatter content pass through untouched — the memory format relies on
 * prompt discipline, not schema enforcement.
 */
function backfillProvenance(content: string, sessionId: string): { content: string; backfilled: boolean } {
  const lines = content.split('\n')
  if (lines[0] !== undefined && lines[0] !== '---') return { content, backfilled: false }
  const end = lines.indexOf('---', 1)
  if (end === -1) return { content, backfilled: false }
  const metaIndex = lines.findIndex((line, index) => index > 0 && index < end && line === 'metadata:')
  if (metaIndex === -1) return { content, backfilled: false }
  let blockEnd = end
  for (let index = metaIndex + 1; index < end; index++) {
    const line = lines[index]
    if (line === undefined || (line.length > 0 && !line.startsWith(' '))) break
    blockEnd = index + 1
  }
  const block = lines.slice(metaIndex + 1, blockEnd).join('\n')
  const additions: string[] = []
  if (!/^ {2}node_type:/m.test(block)) additions.push('  node_type: memory')
  if (!/^ {2}originSessionId:/m.test(block)) additions.push(`  originSessionId: ${sessionId}`)
  if (additions.length === 0) return { content, backfilled: false }
  lines.splice(blockEnd, 0, ...additions)
  return { content: lines.join('\n'), backfilled: true }
}

/** Warn (never fail) when the index outgrows what session-start loading reads. */
function indexWarning(content: string, limits: IndexLimits): string | undefined {
  const lines = countLines(content)
  const bytes = Buffer.byteLength(content, 'utf8')
  if (lines > limits.maxIndexLines) {
    return `MEMORY.md is ${lines} lines; only the first ${limits.maxIndexLines} lines load at session start `
      + '— move detail into topic files and rewrite the index.'
  }
  if (bytes > limits.maxIndexBytes) {
    return `MEMORY.md is ${bytes} bytes; only the first ${limits.maxIndexBytes} bytes load at session start `
      + '— move detail into topic files and rewrite the index.'
  }
  return undefined
}

/**
 * List every file in the memory directory, sorted by name.
 *
 * @param claudeHome - root holding `projects/`.
 * @param cwd - absolute POSIX session working directory.
 * @returns the entries, or `undefined` when the directory does not exist yet.
 */
export async function listMemory(claudeHome: string, cwd: string): Promise<MemoryEntry[] | undefined> {
  const dir = resolveMemoryDir(claudeHome, cwd)
  let dirents
  try {
    dirents = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const files = dirents.filter(dirent => dirent.isFile()).map(dirent => dirent.name).sort()
  const entries: MemoryEntry[] = []
  for (const name of files) {
    const info = await stat(join(dir, name))
    entries.push({ name, bytes: info.size, modified: info.mtime.toISOString() })
  }
  return entries
}

/**
 * Read one memory file verbatim. A miss is retried once with the `.md` suffix
 * added or removed, healing extension-less legacy files and normalized names.
 *
 * @param claudeHome - root holding `projects/`.
 * @param cwd - absolute POSIX session working directory.
 * @param name - single-segment file name inside the memory directory.
 * @param signal - cancellation for the read.
 * @returns the file content, or `undefined` when neither spelling exists.
 */
export async function readMemory(claudeHome: string, cwd: string, name: string, signal?: AbortSignal): Promise<string | undefined> {
  assertMemoryName(name)
  const dir = resolveMemoryDir(claudeHome, cwd)
  const exact = await readFileOrNull(join(dir, name), signal)
  if (exact !== undefined) return exact
  const alternate = alternateMemoryName(name)
  if (alternate === undefined) return undefined
  return await readFileOrNull(join(dir, alternate), signal)
}

/**
 * Write one memory file as an atomic rename, creating the directory lazily.
 * MEMORY.md is checked against the index budget after the write; provenance
 * fields are backfilled into any frontmatter `metadata:` block elsewhere.
 *
 * @param claudeHome - root holding `projects/`.
 * @param cwd - absolute POSIX session working directory.
 * @param name - single-segment file name inside the memory directory.
 * @param content - the complete new file content.
 * @param sessionId - the writing dsh session id, recorded as provenance.
 * @param limits - index budget applied to a MEMORY.md write.
 * @param signal - cancellation for directory creation and the write.
 * @returns the stored name, size, line count, provenance annotation, and any index warning.
 */
export async function writeMemory(
  claudeHome: string,
  cwd: string,
  name: string,
  content: string,
  sessionId: string,
  limits: IndexLimits,
  signal?: AbortSignal,
): Promise<MemoryWriteResult> {
  assertMemoryName(name)
  const fileName = resolveMemoryFileName(name)
  const dir = resolveMemoryDir(claudeHome, cwd)
  await mkdir(dir, { recursive: true })
  let stored = content
  const annotations: ('provenance')[] = []
  if (fileName !== 'MEMORY.md') {
    const backfilled = backfillProvenance(content, sessionId)
    stored = backfilled.content
    if (backfilled.backfilled) annotations.push('provenance')
  }
  const temp = join(dir, `.${fileName}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`)
  await writeFile(temp, stored, { encoding: 'utf8', signal })
  await rename(temp, join(dir, fileName))
  const warning = fileName === 'MEMORY.md' ? indexWarning(stored, limits) : undefined
  return {
    name: fileName,
    bytes: Buffer.byteLength(stored, 'utf8'),
    lines: countLines(stored),
    annotations,
    ...(warning !== undefined ? { warning } : {}),
  }
}

/**
 * Delete one memory file. A miss is retried once with the `.md` suffix added
 * or removed, mirroring {@link readMemory}.
 *
 * @param claudeHome - root holding `projects/`.
 * @param cwd - absolute POSIX session working directory.
 * @param name - single-segment file name inside the memory directory.
 * @returns whether a file was removed.
 */
export async function deleteMemory(claudeHome: string, cwd: string, name: string): Promise<boolean> {
  assertMemoryName(name)
  const dir = resolveMemoryDir(claudeHome, cwd)
  const alternate = alternateMemoryName(name)
  return await removeOnce(join(dir, name))
    || (alternate !== undefined && await removeOnce(join(dir, alternate)))
}

/** Remove one file, mapping ENOENT to `false` so a miss stays distinguishable from failure. */
async function removeOnce(path: string): Promise<boolean> {
  try {
    await rm(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Upsert or remove one memory file's pointer line in MEMORY.md, keyed by the
 * line's link target. Matching tolerates both `.md` spellings and collapses
 * duplicate lines into one; an upsert with no match appends after the last
 * non-empty line, creating the index with its `# Memory Index` header when
 * missing. A no-op remove writes nothing. The write is the same atomic
 * temp-and-rename as {@link writeMemory}, with the same last-write-wins
 * semantics against a concurrent full-index `memory_write`.
 *
 * @param claudeHome - root holding `projects/`.
 * @param cwd - absolute POSIX session working directory.
 * @param change - the pointer-line upsert or remove.
 * @param limits - index budget applied to the resulting MEMORY.md.
 * @param signal - cancellation for the directory creation and the write.
 * @returns the normalized name, whether content changed, and the resulting index stats.
 */
export async function updateMemoryIndex(
  claudeHome: string,
  cwd: string,
  change: MemoryIndexChange,
  limits: IndexLimits,
  signal?: AbortSignal,
): Promise<MemoryIndexResult> {
  assertMemoryName(change.name)
  if (change.name === 'MEMORY.md') {
    throw new Error(`invalid memory name: ${JSON.stringify(change.name)} (the index cannot point at itself)`)
  }
  const fileName = resolveMemoryFileName(change.name)
  const alternate = alternateMemoryName(fileName)
  const dir = resolveMemoryDir(claudeHome, cwd)
  const current = await readFileOrNull(join(dir, 'MEMORY.md'), signal)
  if (current === undefined && change.action === 'remove') {
    return { name: fileName, action: 'remove', changed: false, lines: 0, bytes: 0 }
  }

  /** Whether one line is a pointer to this memory file under either spelling. */
  const pointsAt = (line: string): boolean =>
    line.includes(`](${fileName})`) || (alternate !== undefined && line.includes(`](${alternate})`))

  if (current === undefined) {
    // A missing index gains its canonical header and the first pointer line.
    const stored = change.action === 'upsert'
      ? `# Memory Index\n\n- [${change.title}](${fileName}) — ${change.hook}\n`
      : ''
    if (stored === '') {
      return { name: fileName, action: 'remove', changed: false, lines: 0, bytes: 0 }
    }
    await writeStoredIndex(dir, stored, signal)
    const warning = indexWarning(stored, limits)
    return {
      name: fileName,
      action: 'upsert',
      changed: true,
      lines: countLines(stored),
      bytes: Buffer.byteLength(stored, 'utf8'),
      ...(warning !== undefined ? { warning } : {}),
    }
  }

  const result: string[] = []
  let changed = false
  let placed = false
  for (const line of current.split('\n')) {
    if (!pointsAt(line)) {
      result.push(line)
      continue
    }
    changed = true
    if (change.action === 'upsert' && !placed) {
      result.push(`- [${change.title}](${fileName}) — ${change.hook}`)
      placed = true
    }
  }
  if (change.action === 'upsert' && !placed) {
    let at = result.length
    while (at > 0 && (result[at - 1] ?? '').trim() === '') at--
    result.splice(at, 0, `- [${change.title}](${fileName}) — ${change.hook}`)
    changed = true
  }
  if (!changed) {
    return {
      name: fileName,
      action: change.action,
      changed: false,
      lines: countLines(current),
      bytes: Buffer.byteLength(current, 'utf8'),
    }
  }

  const stored = result.join('\n')
  await writeStoredIndex(dir, stored, signal)
  const warning = indexWarning(stored, limits)
  return {
    name: fileName,
    action: change.action,
    changed: true,
    lines: countLines(stored),
    bytes: Buffer.byteLength(stored, 'utf8'),
    ...(warning !== undefined ? { warning } : {}),
  }
}

/** Atomically replace MEMORY.md with `stored` through a temp file and rename. */
async function writeStoredIndex(dir: string, stored: string, signal?: AbortSignal): Promise<void> {
  await mkdir(dir, { recursive: true })
  const temp = join(dir, `.MEMORY.md.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`)
  await writeFile(temp, stored, { encoding: 'utf8', signal })
  await rename(temp, join(dir, 'MEMORY.md'))
}
