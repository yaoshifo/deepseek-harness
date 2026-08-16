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
  /** UTF-8 byte size of the stored content. */
  bytes: number
  /** Line count of the stored content. */
  lines: number
  /** Machine-readable annotations; `provenance` marks harness-backfilled frontmatter. */
  annotations: ('provenance')[] | []
  /** Present when MEMORY.md exceeded an index limit; the write still succeeded. */
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
 * Read one memory file verbatim.
 *
 * @param claudeHome - root holding `projects/`.
 * @param cwd - absolute POSIX session working directory.
 * @param name - single-segment file name inside the memory directory.
 * @param signal - cancellation for the read.
 * @returns the file content, or `undefined` when the file does not exist.
 */
export async function readMemory(claudeHome: string, cwd: string, name: string, signal?: AbortSignal): Promise<string | undefined> {
  assertMemoryName(name)
  try {
    return await readFile(join(resolveMemoryDir(claudeHome, cwd), name), { encoding: 'utf8', signal })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
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
 * @returns the stored size, line count, provenance annotation, and any index warning.
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
  const dir = resolveMemoryDir(claudeHome, cwd)
  await mkdir(dir, { recursive: true })
  let stored = content
  const annotations: ('provenance')[] = []
  if (name !== 'MEMORY.md') {
    const backfilled = backfillProvenance(content, sessionId)
    stored = backfilled.content
    if (backfilled.backfilled) annotations.push('provenance')
  }
  const temp = join(dir, `.${name}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`)
  await writeFile(temp, stored, { encoding: 'utf8', signal })
  await rename(temp, join(dir, name))
  const warning = name === 'MEMORY.md' ? indexWarning(stored, limits) : undefined
  return {
    bytes: Buffer.byteLength(stored, 'utf8'),
    lines: countLines(stored),
    annotations,
    ...(warning !== undefined ? { warning } : {}),
  }
}

/**
 * Delete one memory file.
 *
 * @param claudeHome - root holding `projects/`.
 * @param cwd - absolute POSIX session working directory.
 * @param name - single-segment file name inside the memory directory.
 * @returns whether a file was removed.
 */
export async function deleteMemory(claudeHome: string, cwd: string, name: string): Promise<boolean> {
  assertMemoryName(name)
  try {
    await rm(join(resolveMemoryDir(claudeHome, cwd), name))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
