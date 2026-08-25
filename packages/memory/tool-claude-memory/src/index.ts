/**
 * Claude Code memory compatibility plugin, with an optional dsh-only global
 * scope.
 *
 * Shares one machine-local memory directory per working directory with Claude
 * Code (`~/.claude/projects/<slug>/memory/`): the verbatim memory strategy
 * enters the system prompt, the MEMORY.md index enters durable context once
 * per session, and the memory tools read and write the same files Claude Code
 * reads and writes. A deployment may additionally enable a cross-project
 * global memory directory (`~/.claude/memory/`): its index is injected
 * alongside the project index, and the tools take a `scope` parameter.
 * Storage goes through `node:fs` directly — never the swappable `ctx.fs`
 * provider — so both directories stay machine-local in every deployment shape.
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
import type { MemoryScope } from './inject.ts'
import { GLOBAL_MEMORY_PROMPT, MEMORY_PROMPT } from './prompt.ts'
import { claudeProjectSlug } from './slug.ts'
import { deleteMemory, listMemory, readMemory, resolveGlobalMemoryDir, resolveMemoryDir, updateMemoryIndex, writeMemory } from './store.ts'
import type { IndexLimits, MemoryIndexChange } from './store.ts'

export { claudeProjectSlug } from './slug.ts'
export {
  deleteMemory,
  listMemory,
  readMemory,
  resolveGlobalMemoryDir,
  resolveMemoryDir,
  updateMemoryIndex,
  writeMemory,
} from './store.ts'
export type { IndexLimits, MemoryEntry, MemoryIndexChange, MemoryIndexResult, MemoryWriteResult } from './store.ts'
export { hasMemoryInjection, readMemoryIndex, renderIndexInjection } from './inject.ts'
export type { MemoryIndexContent, MemoryScope } from './inject.ts'
export { GLOBAL_MEMORY_PROMPT, MEMORY_PROMPT } from './prompt.ts'
export type { ClaudeMemorySource } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'claude-memory'

/** The tool registry, prompt registry, and agent event bus this plugin consumes. */
export const inject = ['tools', 'systemPrompt', 'agents']

/**
 * Global-memory tuning. The scope is enabled by default; `enabled: false` is
 * the opt-out. Both budgets default to the deployment's project budgets.
 */
export interface GlobalConfig {
  /** Whether the global scope is enabled; defaults to `true`. */
  enabled?: boolean
  /** Byte budget for the global MEMORY.md index; defaults to the project `maxIndexBytes`. */
  maxIndexBytes?: number
  /** Line budget for the global index; defaults to the project `maxIndexLines`. */
  maxIndexLines?: number
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
  /**
   * Tuning for the cross-project global memory directory (`<claudeHome>/memory/`),
   * which is enabled by default: the session start injects its index alongside
   * the project one and the tools take a `scope` parameter. Set `enabled: false`
   * to disable the scope; budgets default to the project ones.
   */
  global?: GlobalConfig
}

/**
 * Schemastery validation for {@link Config}. Two nested-object quirks shape
 * this schema: an absent `global` key arrives as `{}` rather than
 * `undefined`, and nested `required()` fields are enforced even when the outer
 * key is absent. `apply` therefore resolves the default-on semantics from the
 * (possibly empty) object and rejects a non-positive explicit byte budget
 * loudly at load.
 */
export const Config: z<Config> = z.object({
  claudeHome: z.string(),
  maxIndexBytes: z.number().required(),
  maxIndexLines: z.number(),
  global: z.object({
    enabled: z.boolean(),
    maxIndexBytes: z.number(),
    maxIndexLines: z.number(),
  }),
})

/** Description fragment shared by every memory tool. */
const TOOLS_DESCRIPTION =
  'These tools operate only inside your persistent memory directory shared with Claude Code. '

/** Description fragment for tools when the deployment enables the global scope. */
const GLOBAL_TOOLS_DESCRIPTION =
  "Pass scope: 'global' to operate on the cross-project global memory directory instead; the Memory section of your instructions states which facts belong there. "

/** The `scope` tool parameter, present only when global memory is enabled. */
function scopeParameter() {
  return {
    scope: {
      type: 'string' as const,
      enum: ['project', 'global'] as const,
      description: "Memory directory to operate on: 'project' (default) or 'global'.",
    },
  }
}

/** The scope one tool call addresses; absent means the global-less default. */
function callScope(args: object): MemoryScope {
  return (args as { scope?: unknown }).scope === 'global' ? 'global' : 'project'
}

/**
 * The owning session context for one project-scope tool call; agentless or
 * cwd-less callers are rejected.
 */
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
 * The owning session context for one global-scope tool call; only an agentless
 * caller is rejected — global memory is not keyed by a working directory.
 */
function globalMemorySession(agent: Agent | undefined): { sessionId: string } {
  if (agent === undefined) throw new Error('memory tools require an owning agent session')
  return { sessionId: String(agent.session.id) }
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

/** Require a non-empty, single-line `memory_index` upsert field. */
function singleLine(field: 'title' | 'hook', value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`memory_index upsert requires a non-empty ${field}`)
  }
  if (value.includes('\n')) {
    throw new Error(`memory_index upsert ${field} must be a single line`)
  }
  return value
}

/**
 * Register the memory strategy section, the memory tools, and the one-time
 * session-start index injections.
 *
 * @param ctx - registrant context carrying the consumed services.
 * @param config - deployment's explicit memory-budget choices.
 */
export function apply(ctx: Context, config: Config): void {
  const globalConfig = config.global ?? {}
  if (globalConfig.maxIndexBytes !== undefined
    && (typeof globalConfig.maxIndexBytes !== 'number' || globalConfig.maxIndexBytes <= 0)) {
    throw new Error('global.maxIndexBytes must be a positive number')
  }
  const claudeHome = expandHome(config.claudeHome ?? '~/.claude')
  const limits: IndexLimits = {
    maxIndexBytes: config.maxIndexBytes,
    maxIndexLines: config.maxIndexLines ?? 200,
  }
  const globalLimits: IndexLimits | undefined = globalConfig.enabled === false
    ? undefined
    : {
      maxIndexBytes: globalConfig.maxIndexBytes ?? limits.maxIndexBytes,
      maxIndexLines: globalConfig.maxIndexLines ?? limits.maxIndexLines,
    }
  const globalDir = resolveGlobalMemoryDir(claudeHome)

  ctx.systemPrompt.section({
    name: 'claude-memory',
    order: 110,
    text: (context) => {
      const cwd = memoryCwd(context.agent)
      if (cwd === undefined || context.agent?.session.header.origin === 'subagent') return ''
      let text = MEMORY_PROMPT.replaceAll(
        '{{memoryDirectory}}',
        resolveMemoryDir(claudeHome, cwd),
      )
      if (globalLimits !== undefined) {
        text += '\n' + GLOBAL_MEMORY_PROMPT.replaceAll('{{globalMemoryDirectory}}', globalDir)
      }
      return text
    },
  })

  const toolsDescription = TOOLS_DESCRIPTION + (globalLimits === undefined ? '' : GLOBAL_TOOLS_DESCRIPTION)
  const scopeParam = globalLimits === undefined ? {} : scopeParameter()

  /** Resolve the directory, limits, and session context one tool call addresses. */
  function resolveCall(agent: Agent | undefined, args: object): {
    dir: string
    limits: IndexLimits
    sessionId: string
  } {
    if (callScope(args) === 'global') {
      if (globalLimits === undefined) {
        throw new Error('global memory scope is not enabled in this deployment')
      }
      return { dir: globalDir, limits: globalLimits, sessionId: globalMemorySession(agent).sessionId }
    }
    const session = memorySession(agent)
    return { dir: resolveMemoryDir(claudeHome, session.cwd), limits, sessionId: session.sessionId }
  }

  ctx.tools.register(defineTool({
    name: 'memory_list',
    description: toolsDescription
      + 'List every file in the memory directory with byte sizes and modification times. '
      + 'MEMORY.md is the index; every other file is one remembered fact.',
    parameters: { ...scopeParam },
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
    async execute(args, exec) {
      const { dir } = resolveCall(exec.agent, args)
      const entries = await listMemory(dir)
      return { exists: entries !== undefined, entries: entries ?? [] }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_read',
    description: toolsDescription
      + 'Read one file verbatim, for example MEMORY.md or a topic memory file.',
    parameters: {
      ...scopeParam,
      name: { type: 'string', required: true, description: 'File name inside the memory directory, e.g. feedback-foo.md or MEMORY.md. On a miss, the .md suffix is retried added or removed.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { content: { type: 'string', required: true } } },
      render: (args, value) => [{ type: 'text', text: value.content || `(empty: ${args.name})` }],
    },
    async execute(args, exec) {
      const { dir } = resolveCall(exec.agent, args)
      const content = await readMemory(dir, args.name, exec.signal)
      if (content === undefined) throw new Error(`memory not found: ${args.name}`)
      return { content }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_write',
    description: toolsDescription
      + 'Write one memory file with the COMPLETE content (full replacement, no partial edits). '
      + 'The directory is created on demand; no mkdir is needed. Frontmatter provenance '
      + '(node_type, originSessionId) is backfilled automatically. After writing a memory file, '
      + 'add or update its one-line pointer in MEMORY.md with memory_index.',
    parameters: {
      ...scopeParam,
      name: { type: 'string', required: true, description: 'File name inside the memory directory; a missing .md suffix is appended automatically. MEMORY.md is the index.' },
      content: { type: 'string', required: true, description: 'The complete new file content, including frontmatter.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          bytes: { type: 'number', required: true },
          lines: { type: 'number', required: true },
          annotations: { type: 'array', required: true, items: { type: 'string', enum: ['provenance'] } },
          warning: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.warning === undefined
        ? `Wrote ${value.lines} lines (${value.bytes}B) to ${value.name}${value.annotations.includes('provenance') ? ' + provenance frontmatter' : ''}.`
        : `Wrote ${value.lines} lines (${value.bytes}B) to ${value.name}. ${value.warning}` }],
    },
    async execute(args, exec) {
      const { dir, limits: callLimits, sessionId } = resolveCall(exec.agent, args)
      return await writeMemory(dir, args.name, args.content, sessionId, callLimits, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_delete',
    description: toolsDescription
      + 'Delete one memory file that turned out to be wrong, then remove its line from MEMORY.md with memory_index.',
    parameters: {
      ...scopeParam,
      name: { type: 'string', required: true, description: 'File name inside the memory directory, e.g. feedback-foo.md. On a miss, the .md suffix is retried added or removed.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { deleted: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.deleted ? 'Deleted.' : 'No such file.' }],
    },
    async execute(args, exec) {
      const { dir } = resolveCall(exec.agent, args)
      return { deleted: await deleteMemory(dir, args.name) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_index',
    description: toolsDescription
      + 'Upsert or remove one pointer line in the MEMORY.md index, keyed by the memory file\'s name. '
      + 'Prefer this over rewriting the whole index with memory_write.',
    parameters: {
      ...scopeParam,
      action: { type: 'string', required: true, enum: ['upsert', 'remove'], description: 'upsert inserts or updates the pointer line; remove deletes it.' },
      name: { type: 'string', required: true, description: 'Memory file the pointer line links to, e.g. feedback-foo.md; a missing .md suffix is appended automatically.' },
      title: { type: 'string', description: 'Pointer-line link text; required for upsert and must stay single-line.' },
      hook: { type: 'string', description: 'One-line hook rendered after the em dash; required for upsert and must stay single-line.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          action: { type: 'string', required: true, enum: ['upsert', 'remove'] },
          changed: { type: 'boolean', required: true },
          lines: { type: 'number', required: true },
          bytes: { type: 'number', required: true },
          warning: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: (value.action === 'upsert'
          ? `Upserted index pointer for ${value.name}; index now ${value.lines} lines (${value.bytes}B).`
          : value.changed
            ? `Removed index pointer for ${value.name}; index now ${value.lines} lines (${value.bytes}B).`
            : `No index pointer for ${value.name}.`)
          + (value.warning === undefined ? '' : ` ${value.warning}`),
      }],
    },
    async execute(args, exec) {
      const { dir, limits: callLimits } = resolveCall(exec.agent, args)
      const change: MemoryIndexChange = args.action === 'remove'
        ? { action: 'remove', name: args.name }
        : {
          action: 'upsert',
          name: args.name,
          title: singleLine('title', args.title),
          hook: singleLine('hook', args.hook),
        }
      return await updateMemoryIndex(dir, change, callLimits, exec.signal)
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
    const injections = await collectInjections(agent, cwd, signal)
    if (injections.length === 0) return decision
    const lastClaimedIndex = decision.messages.findLastIndex(entry => messages.includes(entry))
    let entered = decision.messages
    let at = lastClaimedIndex + 1
    for (const message of injections) {
      entered = entered.toSpliced(at, 0, message)
      at++
    }
    return { kind: 'enter', messages: entered }
  })

  /**
   * The not-yet-injected index messages for this session, global first. A
   * transient read failure skips that injection; the memory tools still fail
   * loud with the real error when called. Abort is cancellation, not failure
   * — it propagates.
   */
  async function collectInjections(
    agent: Agent,
    cwd: string,
    signal: AbortSignal,
  ): Promise<ReturnType<typeof createUserMessage>[]> {
    const injections: ReturnType<typeof createUserMessage>[] = []
    const scopes: Array<{ scope: MemoryScope; dir: string; limits: IndexLimits | undefined }> = [
      { scope: 'global', dir: globalDir, limits: globalLimits },
      { scope: 'project', dir: resolveMemoryDir(claudeHome, cwd), limits },
    ]
    for (const { scope, dir, limits: scopeLimits } of scopes) {
      if (scopeLimits === undefined) continue
      if (hasMemoryInjection(agent.session.events, scope)) continue
      let index
      try {
        index = await readMemoryIndex(dir, scopeLimits, signal)
      } catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
        continue
      }
      if (index === undefined) continue
      signal.throwIfAborted()
      injections.push(createUserMessage({
        content: [{ type: 'text', text: renderIndexInjection(index, dir, scope) }],
        source: {
          kind: 'claude-memory',
          version: 2,
          scope,
          ...(scope === 'project' ? { project: claudeProjectSlug(cwd) } : {}),
          digest: index.digest,
        },
      }))
    }
    return injections
  }
}

const MEMORY_ENTRY_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    name: { type: 'string' as const, required: true as const },
    bytes: { type: 'number' as const, required: true as const },
    modified: { type: 'string' as const, required: true as const },
  },
}

/** Expand a leading `~` against the operating-system home directory. */
function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}
