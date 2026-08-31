/**
 * Type declarations for `@deepseek-ai/dsh-mcp-workspace`. Types only — runtime
 * code lives in `parse.ts` and `index.ts`.
 *
 * @module @deepseek-ai/dsh-mcp-workspace/types
 */

import type { Config as McpClientConfig } from '@deepseek-ai/dsh-mcp-client'

/** One server entry from a directory `.mcp.json`, mapped to its mcp-client Config. */
export interface ParsedWorkspaceServer {
  /** Server name, already validated against the mcp-client name grammar. */
  readonly name: string
  /** Resolved mcp-client plugin config for this server. */
  readonly config: McpClientConfig
}

/** Log severity of one parse problem. */
export type WorkspaceProblemLevel = 'error' | 'warn'

/** One human-readable problem found while parsing a `.mcp.json` body. */
export interface WorkspaceParseProblem {
  readonly level: WorkspaceProblemLevel
  readonly message: string
}

/** Result of parsing one `.mcp.json` body: mapped servers plus loggable problems. */
export interface WorkspaceParseOutcome {
  readonly servers: readonly ParsedWorkspaceServer[]
  readonly problems: readonly WorkspaceParseProblem[]
}

/** One directory-mounted server as listed by `ctx.mcpWorkspace.mountedFor()`. */
export interface DirectoryMcpServer {
  /** Server name as it appears in `mcpServers`. */
  readonly name: string
  /** Transport the entry mapped to. */
  readonly transport: 'stdio' | 'streamable-http'
}

/** Plugin Config: allowed directory roots and the bounded startup wait per server. */
export interface McpWorkspaceConfig {
  /** Absolute directory paths whose sessions may mount their `.mcp.json`. */
  readonly roots: readonly string[]
  /** Cap (ms) each server's initial connection + tool discovery may hold the session setup. */
  readonly startupTimeoutMs: number
}
