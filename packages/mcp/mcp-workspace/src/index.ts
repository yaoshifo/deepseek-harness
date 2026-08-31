/**
 * Directory-scoped MCP discovery service (`ctx.mcpWorkspace`): mounts the
 * MCP servers a session's working directory declares in a Claude
 * Code-compatible `.mcp.json` into that agent's own scope, so the tools are
 * visible only to sessions working in a configured root directory.
 *
 * Trust model: `Config.roots` is an explicit list of absolute directory
 * paths; a session cwd outside every root mounts nothing and logs an error.
 * The mounted stdio child processes are spawned by the daemon through
 * mcp-client — they do not run under the dsh sandbox policy, so roots must
 * stay narrow (a writable `.mcp.json` inside a root is executed code).
 *
 * @module @deepseek-ai/dsh-mcp-workspace
 */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type { AgentSetup } from '@deepseek-ai/dsh-agent'
import type { DirectoryMcpServer, McpWorkspaceConfig, WorkspaceParseOutcome } from './types.ts'
import { parseWorkspaceMcp } from './parse.ts'

/** Default cap on how long one server's initial discovery may hold session setup. */
export const DEFAULT_STARTUP_TIMEOUT_MS = 10_000

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Directory-scoped MCP discovery and per-agent mounting of `.mcp.json` servers. */
    mcpWorkspace: McpWorkspaceService
  }
}

/**
 * Read the session cwd off an agent setup context. The agent association is
 * installed on `Agent.ctx` before setup runs; its absence (or a cwd-less
 * header) simply leaves nothing to mount.
 */
function sessionCwdOf(agentCtx: Context): string | undefined {
  const cwd = agentCtx.agent?.session.header.cwd
  return cwd !== undefined && cwd !== '' ? cwd : undefined
}

/**
 * Whether `cwd` is a configured root or lies underneath one. Both sides are
 * plain absolute paths; lexical comparison only (no realpath), matching the
 * session header's already-validated cwd.
 */
function isWithinRoots(cwd: string, roots: readonly string[]): boolean {
  for (const root of roots) {
    if (cwd === root || cwd.startsWith(root + sep)) return true
  }
  return false
}

/**
 * The directory MCP discovery service.
 *
 * `wrap(setup)` composes the directory mount onto a creation-time AgentSetup
 * (fresh, fork, and resume paths alike): the inner setup runs first so its
 * publication commit propagates, then every `.mcp.json` server mounts into
 * the agent scope through `agentCtx.plugin(mcpClient, config)`. `mountedFor`
 * answers which servers a cwd would mount, for `/mcp` display.
 */
export class McpWorkspaceService extends Service {
  /** Loader-facing plugin config. */
  static Config = z.object({
    roots: z.array(z.string()).default([]),
    startupTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STARTUP_TIMEOUT_MS),
  })

  private readonly roots: readonly string[]
  private readonly startupTimeoutMs: number

  constructor(ctx: Context, config: McpWorkspaceConfig) {
    super(ctx, 'mcpWorkspace')
    for (const root of config.roots) {
      if (!isAbsolute(root)) {
        throw new Error(`mcp-workspace: roots entry is not an absolute directory path: ${root}`)
      }
    }
    this.roots = [...new Set(config.roots.map(root => resolve(root)))]
    this.startupTimeoutMs = config.startupTimeoutMs
  }

  /**
   * Wrap a creation-time AgentSetup with this session's directory MCP mount.
   * The inner setup runs first (a project tool mask computed inside it must
   * not see the directory tools), then `.mcp.json` servers mount into the
   * agent's own scope and disappear with it. Each server failure degrades to
   * that server's tools being absent; session creation never rolls back.
   * @param setup - the inner creation-time setup, or undefined.
   * @returns the wrapping setup.
   */
  wrap(setup: AgentSetup | undefined): AgentSetup {
    return async (agentCtx) => {
      const commit = await setup?.(agentCtx)
      await this.mount(agentCtx)
      return commit
    }
  }

  /**
   * Mount the session-cwd `.mcp.json` servers into one agent scope. The
   * composition primitive behind {@link wrap}, for callers that already hold
   * an agent creation window of their own.
   * @param agentCtx - the unpublished agent's scoped creation context.
   */
  async mount(agentCtx: Context): Promise<void> {
    await this.mountForAgent(agentCtx)
  }

  /**
   * List the servers a directory mount would load for one cwd, for `/mcp`.
   * @param cwd - the session working directory to inspect.
   * @returns mapped server entries; empty when the cwd is untrusted, the file
   *   is absent, or parsing fails.
   */
  async mountedFor(cwd: string): Promise<readonly DirectoryMcpServer[]> {
    if (!isWithinRoots(cwd, this.roots)) return []
    const outcome = await this.readAndParse(cwd)
    return outcome?.servers.map(server => ({
      name: server.name,
      transport: server.config.transport,
    })) ?? []
  }

  /** Read and parse the cwd's `.mcp.json`, or undefined when it is absent. */
  private async readAndParse(cwd: string): Promise<WorkspaceParseOutcome | undefined> {
    let text: string
    try {
      text = await readFile(join(cwd, '.mcp.json'), 'utf8')
    } catch {
      return undefined
    }
    return parseAndLog(text, cwd, this.ctx)
  }

  /** Mount every `.mcp.json` server of the agent's session cwd into its scope. */
  private async mountForAgent(agentCtx: Context): Promise<void> {
    const cwd = sessionCwdOf(agentCtx)
    if (cwd === undefined) {
      this.ctx.logger.debug('mcp-workspace: session header carries no cwd; directory MCP discovery skipped')
      return
    }
    if (!isWithinRoots(cwd, this.roots)) {
      this.ctx.logger.error(`mcp-workspace: session cwd ${cwd} is outside the configured roots; directory MCP discovery skipped`)
      return
    }
    let text: string
    let mtimeMs: number
    try {
      const file = join(cwd, '.mcp.json')
      ;[text, { mtimeMs }] = await Promise.all([readFile(file, 'utf8'), stat(file)])
    } catch {
      // No file in a trusted root is the common case, not a misconfiguration.
      this.ctx.logger.debug(`mcp-workspace: no .mcp.json under ${cwd}; directory MCP discovery skipped`)
      return
    }
    const { servers } = parseAndLog(text, cwd, this.ctx)
    if (servers.length === 0) return
    // Provenance for the escape-chain audit trail: which file revision put
    // which servers into a session is answerable from the logs after the fact.
    const digest = createHash('sha256').update(text).digest('hex').slice(0, 16)
    this.ctx.logger.info(
      `mcp-workspace: mounting ${String(servers.length)} server(s) from ${join(cwd, '.mcp.json')} for session cwd ${cwd} (mtime ${new Date(mtimeMs).toISOString()}, sha256:${digest})`,
    )
    await Promise.all(servers.map(async (server) => {
      try {
        await agentCtx.plugin(McpClient, { ...server.config, startupTimeoutMs: this.startupTimeoutMs })
      } catch (error: unknown) {
        agentCtx.logger.error(`mcp-workspace: server "${server.name}" failed to mount: ${String(error)}`)
      }
    }))
  }
}

/** Parse one file body, route its problems to the log, and return the outcome. */
function parseAndLog(text: string, directory: string, ctx: Context): WorkspaceParseOutcome {
  const outcome = parseWorkspaceMcp(text, directory, process.env)
  for (const problem of outcome.problems) {
    if (problem.level === 'error') ctx.logger.error(`mcp-workspace: ${problem.message}`)
    else ctx.logger.warn(`mcp-workspace: ${problem.message}`)
  }
  return outcome
}

export default McpWorkspaceService
