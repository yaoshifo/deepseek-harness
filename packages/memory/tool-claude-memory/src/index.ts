/**
 * Claude Code memory compatibility plugin.
 *
 * Shares one machine-local memory directory per working directory with Claude
 * Code (`~/.claude/projects/<slug>/memory/`): the verbatim memory strategy
 * enters the system prompt, the MEMORY.md index enters durable context once
 * per session, and four memory tools read and write the same files Claude Code
 * reads and writes. Storage goes through `node:fs` directly — never the
 * swappable `ctx.fs` provider — so the shared directory stays machine-local in
 * every deployment shape.
 *
 * @module @deepseek-ai/dsh-tool-claude-memory
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { hasMemoryInjection, readMemoryIndex, renderIndexInjection } from './inject.ts'
import { MEMORY_PROMPT } from './prompt.ts'
import { claudeProjectSlug } from './slug.ts'
import { deleteMemory, listMemory, readMemory, resolveMemoryDir, writeMemory } from './store.ts'
import type { IndexLimits } from './store.ts'

export { claudeProjectSlug } from './slug.ts'
export {
  deleteMemory,
  listMemory,
  readMemory,
  resolveMemoryDir,
  writeMemory,
} from './store.ts'
export type { IndexLimits, MemoryEntry, MemoryWriteResult } from './store.ts'
export { hasMemoryInjection, readMemoryIndex, renderIndexInjection } from './inject.ts'
export type { MemoryIndexContent } from './inject.ts'
export { MEMORY_PROMPT } from './prompt.ts'
export type { ClaudeMemorySource } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'claude-memory'

/** The tool registry, prompt registry, and agent event bus this plugin consumes. */
export const inject = ['tools', 'systemPrompt', 'agents']

/** Expand a leading `~` against the operating-system home directory. */
function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/** Model-facing memory compatibility configuration. Invalid values fail plugin load. */
export interface Config {
  /** Claude Code home directory holding `projects/`. Defaults to `~/.claude`. */
  claudeHome?: string
  /**
   * Required byte budget for the MEMORY.md index loaded into context, matching
   * Claude Code's 25 KB session-start read. Every composition states its
   * prompt-budget choice explicitly.
   */
  maxIndexBytes: number
  /** Line budget for the same read; Claude Code loads the first 200 lines. */
  maxIndexLines?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  claudeHome: z.string(),
  maxIndexBytes: z.number().required(),
  maxIndexLines: z.number(),
})

/** Description fragments shared by the four memory tools. */
const TOOLS_DESCRIPTION =
  'These tools operate only inside your persistent memory directory shared with Claude Code. '

const MEMORY_ENTRY_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    name: { type: 'string' as const, required: true as const },
    bytes: { type: 'number' as const, required: true as const },
    modified: { type: 'string' as const, required: true as const },
  },
}

/** The owning session context for one tool call; agentless or cwd-less callers are rejected. */
function memorySession(agent: Agent | undefined): { cwd: string; sessionId: string } {
  if (agent === undefined) throw new Error('memory tools require an owning agent session')
  const cwd = agent.session.header.cwd
  if (cwd === undefined) throw new Error('memory tools require a session working directory')
  /* v8 ignore next 3 -- the session layer rejects non-absolute cwds on POSIX hosts; this arm runs only on Windows hosts. */
  if (!isPosixCwd(cwd)) {
    throw new Error('memory tools require a POSIX absolute working directory (Claude Code slug layout)')
  }
  return { cwd, sessionId: String(agent.session.id) }
}

/**
 * Claude Code project slugs are verified only against POSIX layouts; a
 * non-POSIX cwd gets no memory section, no injection, and loud tool errors
 * rather than a guessed slug. The false arm is reachable only on Windows
 * hosts, where the session layer accepts drive-letter cwds.
 */
function isPosixCwd(cwd: string): boolean {
  return cwd.startsWith('/') && !cwd.includes('\\')
}

/** The cwd backing one assembly's memory surfaces, or `undefined` outside POSIX layouts. */
function memoryCwd(agent: { session: { header: { cwd?: string } } } | undefined): string | undefined {
  const cwd = agent?.session.header.cwd
  return cwd !== undefined && isPosixCwd(cwd) ? cwd : undefined
}

/**
 * Register the memory strategy section, the four memory tools, and the
 * one-time session-start index injection.
 *
 * @param ctx - registrant context carrying the consumed services.
 * @param config - deployment's explicit memory-budget choices.
 */
export function apply(ctx: Context, config: Config): void {
  const claudeHome = expandHome(config.claudeHome ?? '~/.claude')
  const limits: IndexLimits = {
    maxIndexBytes: config.maxIndexBytes,
    maxIndexLines: config.maxIndexLines ?? 200,
  }

  ctx.systemPrompt.section({
    name: 'claude-memory',
    order: 110,
    text: (context) => {
      const cwd = memoryCwd(context.agent)
      if (cwd === undefined || context.agent?.session.header.origin === 'subagent') return ''
      return MEMORY_PROMPT.replaceAll(
        '{{memoryDirectory}}',
        resolveMemoryDir(claudeHome, cwd),
      )
    },
  })

  ctx.tools.register(defineTool({
    name: 'memory_list',
    description: TOOLS_DESCRIPTION
      + 'List every file in the memory directory with byte sizes and modification times. '
      + 'MEMORY.md is the index; every other file is one remembered fact.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exists: { type: 'boolean', required: true },
          entries: { type: 'array', required: true, items: MEMORY_ENTRY_SCHEMA },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.exists
        ? value.entries.map(entry => `${entry.name} (${entry.bytes}B)`).join('\n') || '(empty)'
        : 'No memory directory yet.' }],
    },
    async execute(_args, exec) {
      const { cwd } = memorySession(exec.agent)
      const entries = await listMemory(claudeHome, cwd)
      return { exists: entries !== undefined, entries: entries ?? [] }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_read',
    description: TOOLS_DESCRIPTION
      + 'Read one file verbatim, for example MEMORY.md or a topic memory file.',
    parameters: {
      name: { type: 'string', required: true, description: 'File name inside the memory directory, e.g. MEMORY.md.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { content: { type: 'string', required: true } } },
      render: (args, value) => [{ type: 'text', text: value.content || `(empty: ${args.name})` }],
    },
    async execute(args, exec) {
      const { cwd } = memorySession(exec.agent)
      const content = await readMemory(claudeHome, cwd, args.name, exec.signal)
      if (content === undefined) throw new Error(`memory not found: ${args.name}`)
      return { content }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_write',
    description: TOOLS_DESCRIPTION
      + 'Write one memory file with the COMPLETE content (full replacement, no partial edits). '
      + 'The directory is created on demand; no mkdir is needed. Frontmatter provenance '
      + '(node_type, originSessionId) is backfilled automatically. After writing a memory file, '
      + 'add or update its one-line pointer in MEMORY.md.',
    parameters: {
      name: { type: 'string', required: true, description: 'File name inside the memory directory, e.g. feedback-foo.md or MEMORY.md.' },
      content: { type: 'string', required: true, description: 'The complete new file content, including frontmatter.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bytes: { type: 'number', required: true },
          lines: { type: 'number', required: true },
          annotations: { type: 'array', required: true, items: { type: 'string', enum: ['provenance'] } },
          warning: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.warning === undefined
        ? `Wrote ${value.lines} lines (${value.bytes}B)${value.annotations.includes('provenance') ? ' + provenance frontmatter' : ''}.`
        : `Wrote ${value.lines} lines (${value.bytes}B). ${value.warning}` }],
    },
    async execute(args, exec) {
      const { cwd, sessionId } = memorySession(exec.agent)
      return await writeMemory(claudeHome, cwd, args.name, args.content, sessionId, limits, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_delete',
    description: TOOLS_DESCRIPTION
      + 'Delete one memory file that turned out to be wrong, then remove its line from MEMORY.md.',
    parameters: {
      name: { type: 'string', required: true, description: 'File name inside the memory directory.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { deleted: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.deleted ? 'Deleted.' : 'No such file.' }],
    },
    async execute(args, exec) {
      const { cwd } = memorySession(exec.agent)
      return { deleted: await deleteMemory(claudeHome, cwd, args.name) }
    },
  }))

  ctx.on('agent/pre-step', async (
    { agent, messages, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    const cwd = memoryCwd(agent)
    if (cwd === undefined || agent.session.header.origin === 'subagent') return decision
    if (step !== 1 || decision.kind !== 'enter' || decision.messages.length === 0) return decision
    if (hasMemoryInjection(agent.session.events)) return decision
    let index
    try {
      index = await readMemoryIndex(claudeHome, cwd, limits, signal)
    } catch (error) {
      // A transient read failure skips this injection; the memory tools still
      // fail loud with the real error when called. Abort is cancellation, not
      // failure — let it propagate.
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      return decision
    }
    if (index === undefined) return decision
    signal.throwIfAborted()
    const text = renderIndexInjection(index, resolveMemoryDir(claudeHome, cwd))
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'claude-memory',
        version: 1,
        project: claudeProjectSlug(cwd),
        digest: index.digest,
      },
    })
    const lastClaimedIndex = decision.messages.findLastIndex(entry => messages.includes(entry))
    const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, message)
    return { kind: 'enter', messages: entered }
  })
}
