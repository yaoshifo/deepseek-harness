/**
 * Shared unread-rejection enrichment for the guarded mutation tools: attach the target's
 * current read window to the plain diagnostic so the model can retry directly.
 * @module @deepseek-ai/dsh-tool-fs/src/unread-attachment
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { ReadToolCaps } from './read.ts'
import { buildWindow, formatReadOutput } from './read-render.ts'

/**
 * Attach the file's current read window to an unread-mutation rejection so the model can retry
 * directly instead of spending a round on a separate read. The recovery read is itself an
 * authoritative observation, so the retried mutation guards on its version. A confirmed-absent
 * target passes the sharper not-found refusal through; any failure of the recovery read
 * falls back to the plain diagnostic, matching the pre-enrichment behavior byte for byte.
 * @param ctx - the plugin context providing filesystem access and observation events.
 * @param exec - the current tool execution, including the cancellation signal.
 * @param target - the already-resolved mutation target.
 * @param caps - the deployment's read caps, shared with the `read` tool.
 * @param plain - the plain unread diagnostic this enrichment replaces or wraps.
 * @param verb - the mutating tool's name, selecting the retry guidance's wording.
 * @returns the enriched (or fallback) `FsError` to throw.
 */
export async function enrichNotObserved(
  ctx: Context,
  exec: ToolExecution,
  target: FsTarget,
  caps: ReadToolCaps,
  plain: FsError,
  verb: 'edit' | 'write',
): Promise<FsError> {
  try {
    const info = await ctx.fs.stat(target, exec.signal)
    if (info === undefined) {
      ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
      return new FsError(`cannot ${verb} "${target.displayPath}": not found`, 'FS_NOT_FOUND', { cause: plain })
    }
    if (info.type !== 'file') return plain
    // Same size routing as the read tool: stream large or size-unknown files.
    const chunks = info.size === undefined || info.size >= caps.streamMinSize
      ? await ctx.fs.streamText(target, exec.signal)
      : [await ctx.fs.readText(target, exec.signal)]
    const window = await buildWindow(
      chunks,
      { offset: 1, limit: caps.limit, maxLineLength: caps.maxLineLength, maxBytes: caps.maxBytes },
      target.displayPath,
    )
    ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
    const content = formatReadOutput(target.displayPath, {
      offset: 1,
      lines: window.lines,
      totalLines: window.totalLines,
      ...window.truncatedByBytes ? { truncatedByBytes: true } : {},
    })
    return new FsError(
      `cannot modify "${target.displayPath}": file has not been read — current content (up to ${caps.limit} lines) follows; retry the ${verb} directly\n\n${content}`,
      'FS_NOT_OBSERVED',
      { cause: plain },
    )
  } catch {
    return plain
  }
}
