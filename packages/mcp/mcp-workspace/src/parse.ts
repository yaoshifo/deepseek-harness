/**
 * Claude Code-compatible `.mcp.json` parsing: validates the `mcpServers`
 * object, maps each entry to an mcp-client Config, expands `${VAR}` /
 * `${VAR:-default}` references, and reports misconfigured entries as
 * per-server problems instead of failing the whole file. Duplicate server
 * names inside one file are a file-level failure (all servers skipped).
 *
 * Mapping rules (aligned with Claude Code's documented behavior):
 * - no `type` or `type: "stdio"` with a `command` → stdio transport
 * - `type: "http"` (alias `type: "streamable-http"`) with a `url` → streamable-http
 * - a `url` without `type` is a configuration error (Claude Code reads the
 *   entry as stdio and reports it): the server is skipped
 * - `type: "sse"` is a distinct transport this client does not implement:
 *   the server is skipped rather than mis-mapped to streamable-http
 * - `command` together with `url`, `type: "ws"`, and unknown types are skipped
 * - unknown fields (e.g. Claude Code's `alwaysLoad`) are ignored
 *
 * @module @deepseek-ai/dsh-mcp-workspace/parse
 */

import { Config as McpClientConfig } from '@deepseek-ai/dsh-mcp-client'
import type { ParsedWorkspaceServer, WorkspaceParseOutcome, WorkspaceParseProblem } from './types.ts'

/** mcp-client server-name grammar, re-checked here so skips carry a precise message. */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

/** `${VAR}` and `${VAR:-default}` references, the two forms Claude Code expands. */
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

/** One parse problem under construction, before levels are frozen. */
type Problem = WorkspaceParseProblem

/**
 * Parse one `.mcp.json` body.
 * @param text - raw file content.
 * @param directory - absolute directory holding the file; stdio servers run there.
 * @param env - environment used for `${VAR}` expansion (the daemon process env).
 * @returns mapped servers (empty on file-level failure) plus loggable problems.
 */
export function parseWorkspaceMcp(
  text: string,
  directory: string,
  env: Readonly<Record<string, string | undefined>>,
): WorkspaceParseOutcome {
  const problems: Problem[] = []

  let root: unknown
  try {
    root = JSON.parse(text)
  } catch (error: unknown) {
    return {
      servers: [],
      problems: [{ level: 'error', message: `.mcp.json is not valid JSON: ${String(error)}` }],
    }
  }

  const duplicates = duplicateServerNames(text)
  if (duplicates !== undefined) {
    return {
      servers: [],
      problems: [
        { level: 'error', message: `mcpServers contains duplicate server name(s): ${duplicates.join(', ')} — the whole file is skipped` },
      ],
    }
  }

  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    return { servers: [], problems: [{ level: 'error', message: '.mcp.json must contain a JSON object' }] }
  }
  const servers = (root as { mcpServers?: unknown }).mcpServers
  if (servers === undefined) return { servers: [], problems }
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
    return { servers: [], problems: [{ level: 'error', message: 'mcpServers must contain a JSON object' }] }
  }

  const mapped: ParsedWorkspaceServer[] = []
  for (const [name, entry] of Object.entries(servers)) {
    const server = mapEntry(name, entry, directory, env, problems)
    if (server !== undefined) mapped.push(server)
  }
  return { servers: mapped, problems }
}

/**
 * Map one `mcpServers` entry to an mcp-client Config, or record problems and
 * return undefined to skip the server.
 */
function mapEntry(
  name: string,
  entry: unknown,
  directory: string,
  env: Readonly<Record<string, string | undefined>>,
  problems: Problem[],
): ParsedWorkspaceServer | undefined {
  if (!SERVER_NAME.test(name)) {
    problems.push({ level: 'error', message: `mcpServers key "${name}" does not match [A-Za-z0-9_-]{1,32}; rename the server` })
    return undefined
  }
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    problems.push({ level: 'error', message: `mcpServers["${name}"] must contain a JSON object` })
    return undefined
  }
  const record = entry as Record<string, unknown>
  const type = record.type
  const hasCommand = typeof record.command === 'string' && record.command !== ''
  const hasUrl = typeof record.url === 'string' && record.url !== ''

  if (hasUrl && type === undefined) {
    problems.push({
      level: 'error',
      message: `mcpServers["${name}"] has a "url" but no "type"; add "type": "http" to this entry`,
    })
    return undefined
  }
  if (hasCommand && hasUrl) {
    problems.push({ level: 'error', message: `mcpServers["${name}"] declares both "command" and "url"; keep exactly one transport` })
    return undefined
  }
  if (type !== undefined && type !== 'stdio' && type !== 'http' && type !== 'streamable-http') {
    problems.push({
      level: 'error',
      message: type === 'sse'
        ? `mcpServers["${name}"] declares "type": "sse", which this client does not support; use a Streamable HTTP endpoint`
        : `mcpServers["${name}"] declares unsupported type ${JSON.stringify(type)}`,
    })
    return undefined
  }

  if (type === 'http' || type === 'streamable-http') {
    if (!hasUrl) {
      problems.push({ level: 'error', message: `mcpServers["${name}"] declares an http transport without a "url"` })
      return undefined
    }
    const headers = expandRecord(record.headers, name, 'headers', env, problems)
    if (headers === undefined) return undefined
    const url = expandString(record.url as string, name, 'url', env, problems)
    return buildConfig(name, {
      transport: 'streamable-http',
      serverName: name,
      url,
      headers,
    }, problems)
  }

  if (!hasCommand) {
    problems.push({
      level: 'error',
      message: hasUrl
        ? `mcpServers["${name}"] declares a stdio transport with a "url" but no "command"`
        : `mcpServers["${name}"] has neither "command" nor "url"`,
    })
    return undefined
  }
  const args = expandStrings(record.args, name, 'args', env, problems)
  if (args === undefined) return undefined
  const entryEnv = expandRecord(record.env, name, 'env', env, problems)
  if (entryEnv === undefined) return undefined
  const command = expandString(record.command as string, name, 'command', env, problems)
  return buildConfig(name, {
    transport: 'stdio',
    serverName: name,
    command,
    args,
    env: entryEnv,
    cwd: directory,
  }, problems)
}

/**
 * Validate one mapped entry through the mcp-client Config schema so defaults
 * materialize; a schema rejection is a misconfigured entry, not a crash.
 */
function buildConfig(name: string, input: object, problems: Problem[]): ParsedWorkspaceServer | undefined {
  try {
    const config = McpClientConfig(input as never)
    return { name, config }
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    problems.push({ level: 'error', message: `mcpServers["${name}"] is invalid: ${detail}` })
    return undefined
  }
}

/** Expand `${VAR}` refs in one string field, keeping missing refs literally. */
function expandString(
  value: string,
  server: string,
  field: string,
  env: Readonly<Record<string, string | undefined>>,
  problems: Problem[],
): string {
  return value.replace(ENV_REF, (ref, variable: string, fallback?: string) => {
    const resolved = env[variable]
    if (resolved !== undefined) return resolved
    if (fallback !== undefined) return fallback
    // Claude Code keeps the unexpanded reference and warns; the variable may
    // legitimately appear later (rotation), so the entry stays loadable.
    problems.push({ level: 'warn', message: `mcpServers["${server}"].${field} references unset variable ${ref} without a default` })
    return ref
  })
}

/** Expand a `Record<string, string>` field; non-string values reject the entry. */
function expandRecord(
  value: unknown,
  server: string,
  field: string,
  env: Readonly<Record<string, string | undefined>>,
  problems: Problem[],
): Record<string, string> | undefined {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    problems.push({ level: 'error', message: `mcpServers["${server}"].${field} must contain a JSON object` })
    return undefined
  }
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      problems.push({ level: 'error', message: `mcpServers["${server}"].${field}["${key}"] must be a string` })
      return undefined
    }
    result[key] = expandString(entry, server, `${field}["${key}"]`, env, problems)
  }
  return result
}

/** Expand a `string[]` field; non-string members reject the entry. */
function expandStrings(
  value: unknown,
  server: string,
  field: string,
  env: Readonly<Record<string, string | undefined>>,
  problems: Problem[],
): string[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    problems.push({ level: 'error', message: `mcpServers["${server}"].${field} must contain an array` })
    return undefined
  }
  const result: string[] = []
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string') {
      problems.push({ level: 'error', message: `mcpServers["${server}"].${field}[${index}] must be a string` })
      return undefined
    }
    result.push(expandString(entry, server, `${field}[${index}]`, env, problems))
  }
  return result
}

/**
 * Names that appear as `mcpServers` object keys more than once in the raw
 * text. `JSON.parse` silently keeps the last duplicate, so detection needs a
 * raw scan: track string tokens (with escapes) and brace depth, treat a
 * string followed by `:` as a key at its enclosing depth, and collect keys
 * inside the value object of an `mcpServers` key.
 * @param text - raw `.mcp.json` content.
 * @returns duplicate names, or undefined when the text has no duplicate.
 */
function duplicateServerNames(text: string): string[] | undefined {
  const counts = new Map<string, number>()
  const duplicates: string[] = []
  let depth = 0
  let inString = false
  let escaped = false
  let tokenStart = -1
  let pendingKey: { name: string; depth: number } | undefined
  let mcpServersDepth: number | undefined
  /** Depth of a just-seen `mcpServers` key whose value object has not opened yet. */
  let pendingMcpServersDepth: number | undefined

  const count = (name: string): void => {
    const seen = counts.get(name) ?? 0
    if (seen === 1) duplicates.push(name)
    counts.set(name, seen + 1)
  }

  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i)
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') {
        inString = false
        // A string token is a key only when the next non-space character is ':'.
        let j = i + 1
        while (j < text.length && /\s/.test(text.charAt(j))) j++
        if (text[j] === ':') pendingKey = { name: text.slice(tokenStart, i), depth }
      }
      continue
    }
    if (char === '"') {
      inString = true
      escaped = false
      tokenStart = i + 1
      continue
    }
    if (pendingKey !== undefined) {
      const { name, depth: keyDepth } = pendingKey
      pendingKey = undefined
      if (name === 'mcpServers') {
        count('mcpServers')
        mcpServersDepth = undefined
        // Track the value object only when it really is one: peek past the
        // ':' for the opening brace, so a non-object value (already a
        // file-level error after parse) cannot borrow a sibling's depth.
        let j = i + 1
        while (j < text.length && /\s/.test(text.charAt(j))) j++
        if (text[j] === '{') pendingMcpServersDepth = keyDepth
      } else if (mcpServersDepth !== undefined && keyDepth === mcpServersDepth) {
        count(name)
      }
    }
    if (char === '{') {
      depth++
      if (pendingMcpServersDepth !== undefined && depth === pendingMcpServersDepth + 1) {
        mcpServersDepth = depth
        pendingMcpServersDepth = undefined
      }
    } else if (char === '}') {
      if (mcpServersDepth !== undefined && depth === mcpServersDepth) mcpServersDepth = undefined
      depth--
    }
  }
  return duplicates.length > 0 ? duplicates : undefined
}
