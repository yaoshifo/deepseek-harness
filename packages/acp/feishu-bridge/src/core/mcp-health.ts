/**
 * MCP degradation runtime-context (opt-in): an `mcp-client` server whose
 * connection fails with `failOnStartupError: false` — or whose reconnect
 * attempts are exhausted — simply has no tools in the process-global tool
 * registry, and the agent only ever notices its tools vanished. When
 * configured, one `systemPrompt.context` line per missing server states the
 * degradation into every prompt assembly, so new sessions know the server is
 * down before they try to call it.
 *
 * Detection is tool-registry presence, not connection state: a server is
 * degraded when no `mcp__<serverName>__*` tool is visible in the global tool
 * view (`ctx.tools.schemas()` with no scope — mcp-client rows mount at profile
 * root, so their registrations land in the global layer). The text is
 * re-evaluated at each assembly, so recovery needs no listener: once the
 * server re-registers its tools, the line disappears.
 *
 * @module dsh-feishu-bridge/core-mcp-health
 */

import type { Context } from '@deepseek-ai/cordis'
import type { McpHealthConfig, McpHealthServerConfig } from '../index.js'

/** Registered context name: `feishu-bridge:mcp-health`. */
export const MCP_HEALTH_CONTEXT_NAME = 'feishu-bridge:mcp-health'

/** mcp-client's public tool-name prefix (`mcp__<serverName>__<rawName>`). */
export const MCP_TOOL_PREFIX = 'mcp__'

/**
 * Prompt order 130: after `sandbox:policy` (110), `approval:policy` (115),
 * and `subagent:delegation` (120) — a late, degraded-state line, not policy.
 */
export const MCP_HEALTH_CONTEXT_ORDER = 130

/** Default startup grace in seconds before a missing server is reported. */
export const MCP_HEALTH_DEFAULT_STARTUP_GRACE_SECS = 180

/**
 * The public tool-name prefix of one server's tools (mcp-client naming
 * contract: `mcp__<serverName>__<rawName>`).
 *
 * @param serverName - the mcp-client row's serverName.
 * @returns the prefix every tool of that server carries.
 */
function toolPrefixOf(serverName: string): string {
  return `mcp__${serverName}__`
}

/**
 * Split an mcp-client public tool name into its server and raw parts, the
 * inverse of {@link toolPrefixOf}. `mcp__<serverName>__<rawName>` splits on
 * the first `__` after the prefix, so a serverName containing `_` stays
 * intact. Ceiling (the adapter's own grouping documents the same one): two
 * live serverNames that collide on a `mcp__<a>__<b>__` prefix
 * mis-attribute each other's tools.
 *
 * @param name - Public tool name from the process-global tool registry.
 * @returns The serverName and raw tool name, or undefined when the name is
 * not an mcp tool name or the server part is empty.
 */
export function splitMcpToolName(name: string): { server: string; raw: string } | undefined {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return undefined
  const rest = name.slice(MCP_TOOL_PREFIX.length)
  const sep = rest.indexOf('__')
  if (sep <= 0) return undefined
  return { server: rest.slice(0, sep), raw: rest.slice(sep + 2) }
}

/**
 * Render the degradation text for one assembly: one line per configured
 * server still missing from the global tool view after the startup grace
 * period. Registry enumeration failure reads as healthy (empty text) — the
 * health context must never break prompt assembly.
 *
 * @param ctx - plugin context carrying the tool registry.
 * @param config - the resolved `mcpHealth` config.
 * @param startedAtMs - plugin start time, the grace-period anchor.
 * @returns the degradation lines, or '' when healthy or within grace.
 */
function renderMcpHealthText(ctx: Context, config: McpHealthConfig, startedAtMs: number): string {
  try {
    const graceMs = (config.startupGraceSecs ?? MCP_HEALTH_DEFAULT_STARTUP_GRACE_SECS) * 1000
    if (Date.now() - startedAtMs < graceMs) return ''
    const registered = ctx.tools.schemas().map(schema => schema.name)
    const missing = config.servers.filter(server =>
      !registered.some(name => name.startsWith(toolPrefixOf(server.serverName))))
    return missing.map(server => degradedLine(server)).join('\n')
  } catch {
    // Unreachable through the typed registry surface; kept so a future
    // registry change degrades to "silent" instead of failing every request.
    return ''
  }
}

/**
 * One server's degradation line as the model reads it.
 *
 * @param server - the missing server's config (name + optional fix hint).
 * @returns the single-line degradation description.
 */
function degradedLine(server: McpHealthServerConfig): string {
  const fix = server.fixHint === undefined || server.fixHint === ''
    ? ''
    : ` Fix: ${server.fixHint}`
  return `MCP server "${server.serverName}" is degraded: none of its tools are registered in this process.`
    + ` Its tools will fail or be unavailable until the connection is restored (common causes: auth token expired, connection failed, or reconnect attempts exhausted).${fix}`
}

/**
 * Register the `feishu-bridge:mcp-health` runtime context. The registration
 * is an effect on `ctx`: disposing the plugin fiber (HMR, shutdown)
 * unregisters the context.
 *
 * @param ctx - plugin context carrying `systemPrompt` and `tools`.
 * @param config - the resolved `mcpHealth` config; callers pass it only with
 *   a non-empty `servers` list.
 * @returns the exact Cordis effect disposer that unregisters the context.
 */
export function registerMcpHealthContext(ctx: Context, config: McpHealthConfig): () => void {
  const startedAtMs = Date.now()
  return ctx.systemPrompt.context({
    name: MCP_HEALTH_CONTEXT_NAME,
    order: MCP_HEALTH_CONTEXT_ORDER,
    text: () => renderMcpHealthText(ctx, config, startedAtMs),
  })
}
