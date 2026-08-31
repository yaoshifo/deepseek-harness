/**
 * TS-native capability-inspection commands (no Go counterpart): /skills and
 * /mcp render what this process actually loaded. /skills lists the skill
 * registry's invocation-neutral catalog for the chat's work dir (the same
 * discovery base providers use — the global layer plus workspace roots; a
 * live agent session's scoped runtime registrations are outside this view).
 * /mcp groups the process-global tool registry's `mcp__<serverName>__*`
 * names by server (the same read as the mcpHealth runtime context), marks
 * health-watched servers that have no live tools, and marks servers a
 * project `mcpServers` allowlist hides from its sessions.
 *
 * Both commands are read-only, take no arguments, and register through the
 * engine's registerCommand seam so /help lists them under the tools group.
 *
 * @module dsh-feishu-bridge/skills-mcp-commands
 */

import { Msg } from '../i18n/index.ts'
import type { Message, Platform } from '../core/types.ts'
import { splitMcpToolName } from '../core/mcp-health.ts'
import type { Engine } from './engine.ts'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import type { McpHealthServerConfig } from '../index.ts'

/** Maximum rendered description length per /skills entry (runes). */
const SKILL_DESCRIPTION_MAX_RUNES = 80

/** Tool names listed per /mcp server before the `+N` overflow marker. */
const MCP_TOOLS_PER_SERVER = 8

/** Data sources the two commands read; wired by buildProjectAssembly. */
export interface SkillsMcpCommandDeps {
  /** Skill summaries for a workspace directory; absent = the skill registry is not composed. */
  readonly listSkills?: ((cwd: string) => Promise<readonly SkillSummary[]>) | undefined
  /** Live process-global public tool names (the same read as the mcpHealth runtime context). */
  readonly toolNames: () => readonly string[]
  /** Servers configured for health watching (degradation cross-check). */
  readonly healthServers?: readonly McpHealthServerConfig[] | undefined
  /** Project `mcpServers` allowlist; present = sessions only see these servers' tools. */
  readonly allowlist?: readonly string[] | undefined
  /** Servers a directory `.mcp.json` would mount for a cwd; absent = the mcp-workspace service is not composed. */
  readonly listWorkspaceServers?: ((cwd: string) => Promise<readonly { readonly name: string; readonly transport: string }[]>) | undefined
}

/** One live MCP server and its parsed tool names. */
interface McpServerGroup {
  readonly server: string
  readonly tools: string[]
}

/**
 * Register /skills and /mcp on an engine through the registerCommand seam
 * (handler map + resolver chain + the tools help-card group). Requires the
 * session command table (registerSessionCommands) to be installed first.
 * @param e - Engine whose command table gains both entries.
 * @param deps - The data sources the commands read.
 * @returns The disposer removing both registrations.
 */
export function registerSkillsMcpCommands(e: Engine, deps: SkillsMcpCommandDeps): () => void {
  const disposeSkills = e.registerCommand({
    id: 'skills',
    handler: (p, msg) => { void cmdSkills(e, p, msg, deps); return true },
    match: cmd => (cmd === 'skills' || ('skills'.startsWith(cmd) && cmd.length >= 2)) ? 'skills' : '',
    group: 'tools',
  })
  const disposeMcp = e.registerCommand({
    id: 'mcp',
    handler: (p, msg) => { void cmdMcp(e, p, msg, deps); return true },
    match: cmd => (cmd === 'mcp' || ('mcp'.startsWith(cmd) && cmd.length >= 2)) ? 'mcp' : '',
    group: 'tools',
  })
  return () => {
    disposeSkills()
    disposeMcp()
  }
}

/**
 * /skills: list the skill catalog visible to this chat's work dir — name,
 * capped description, and a command-only marker on entries the model cannot
 * invoke. The skill registry is not composed or has no entries: the command
 * says so instead of rendering an empty card.
 * @param e - Engine whose i18n and card senders render the listing.
 * @param p - Platform that delivered the command message.
 * @param msg - Triggering message; its session selects the work dir.
 * @param deps - The skill listing source.
 */
async function cmdSkills(e: Engine, p: Platform, msg: Message, deps: SkillsMcpCommandDeps): Promise<void> {
  if (deps.listSkills === undefined) {
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.SkillsUnavailable))
    return
  }
  const workDir = e.commandWorkDir(msg)
  const skills = await deps.listSkills(workDir)
  if (skills.length === 0) {
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.SkillsEmpty))
    return
  }
  const lines: string[] = [`📁 ${workDir}`, '']
  for (const skill of skills) {
    const desc = capRunes(skill.description, SKILL_DESCRIPTION_MAX_RUNES)
    const marker = skill.invocation.modelInvocable ? '' : e.i18n.t(Msg.SkillsUserOnly)
    lines.push(desc === '' ? `- \`${skill.name}\`${marker}` : `- \`${skill.name}\` — ${desc}${marker}`)
  }
  await e.sendAsCard(p, msg.replyCtx, lines.join('\n'), {
    title: e.i18n.tf(Msg.SkillsTitle, skills.length),
    color: 'blue',
  })
}

/**
 * /mcp: list live MCP servers — one line per server with its tool count and
 * tool names (capped per server), a degraded marker on health-watched
 * servers with no live tools, and a masked marker on servers this project's
 * `mcpServers` allowlist hides from its sessions. No servers at all: the
 * command says so instead of rendering an empty card.
 * @param e - Engine whose i18n and card senders render the listing.
 * @param p - Platform that delivered the command message.
 * @param msg - Triggering message (reply context only).
 * @param deps - The tool-registry and configuration sources.
 */
async function cmdMcp(e: Engine, p: Platform, msg: Message, deps: SkillsMcpCommandDeps): Promise<void> {
  const groups = mcpServerGroups(deps.toolNames())
  const degraded = (deps.healthServers ?? [])
    .map(server => server.serverName)
    .filter(name => !groups.some(group => group.server === name))
  // Directory mounts are per-session (agent scope), never in the
  // process-global view, so the section reads the discovery service by the
  // chat's work dir instead of the tool registry.
  const workspace = deps.listWorkspaceServers === undefined
    ? []
    : await deps.listWorkspaceServers(e.commandWorkDir(msg))
  if (groups.length === 0 && degraded.length === 0 && workspace.length === 0) {
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.McpEmpty))
    return
  }
  const lines: string[] = []
  for (const group of groups) {
    let line = `**${group.server}**${e.i18n.tf(Msg.McpTools, group.tools.length)}`
    if (deps.allowlist !== undefined && !deps.allowlist.includes(group.server)) {
      line += e.i18n.t(Msg.McpMasked)
    }
    lines.push(line)
    lines.push(renderToolNames(group.tools))
  }
  for (const server of degraded) {
    lines.push(`**${server}**${e.i18n.t(Msg.McpDegraded)}`)
  }
  if (workspace.length > 0) {
    lines.push('', `${e.i18n.tf(Msg.McpWorkspaceSection, workspace.length)}${e.i18n.t(Msg.McpWorkspaceNote)}`)
    for (const server of workspace) {
      lines.push(`**${server.name}** (${server.transport})`)
    }
  }
  await e.sendAsCard(p, msg.replyCtx, lines.join('\n'), {
    title: e.i18n.tf(Msg.McpTitle, groups.length + degraded.length + workspace.length),
    color: 'blue',
  })
}

/**
 * Tool names of one server, capped at {@link MCP_TOOLS_PER_SERVER} entries
 * with a `+N` overflow marker; indented to sit under the server line.
 * @param tools - The server's parsed tool names, in registry order.
 * @returns The rendered tool-names line.
 */
function renderToolNames(tools: string[]): string {
  const shown = tools.slice(0, MCP_TOOLS_PER_SERVER)
  const overflow = tools.length - shown.length
  const text = shown.join(', ')
  return overflow > 0 ? `  ${text}, +${overflow}` : `  ${text}`
}

/**
 * Group public tool names by their mcp-client server (the split's naming
 * contract and its collision ceiling live on
 * {@link splitMcpToolName}).
 * @param names - Public tool names from the process-global tool registry.
 * @returns The live servers in name order, each with its tool names.
 */
function mcpServerGroups(names: readonly string[]): McpServerGroup[] {
  const groups = new Map<string, string[]>()
  for (const name of names) {
    const parsed = splitMcpToolName(name)
    if (parsed === undefined) continue
    const bucket = groups.get(parsed.server)
    if (bucket === undefined) groups.set(parsed.server, [parsed.raw])
    else bucket.push(parsed.raw)
  }
  return [...groups.entries()]
    .map(([server, tools]) => ({ server, tools }))
    .sort((a, b) => a.server.localeCompare(b.server))
}

/**
 * Cap a value to maxLen runes, appending an ellipsis when truncated (the
 * same inline clip commands.ts uses for display names).
 * @param value - The string to cap.
 * @param maxLen - Maximum rune count.
 * @returns The capped string.
 */
function capRunes(value: string, maxLen: number): string {
  const runes = Array.from(value)
  if (runes.length <= maxLen) return value
  return `${runes.slice(0, maxLen).join('')}…`
}
