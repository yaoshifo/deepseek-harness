/**
 * TS-native capability-inspection commands (no Go counterpart): /skills and
 * /mcp render what this process actually loaded. /skills lists the skill
 * registry's invocation-neutral catalog for the chat's work dir (the same
 * discovery base providers use — the global layer plus workspace roots; a
 * live agent session's scoped runtime registrations are outside this view),
 * with a fuzzy query filter (`/skills [query] [page]`, alias /skill: every
 * whitespace-separated token is a case-insensitive substring of the name or
 * description) and paged rendering — listings beyond one page carry prev/next
 * buttons whose `nav:/skills <page>` action re-renders the captured snapshot
 * in place. /mcp groups the process-global tool registry's
 * `mcp__<serverName>__*` names by server (the same read as the mcpHealth
 * runtime context), marks health-watched servers that have no live tools,
 * and marks servers a project `mcpServers` allowlist hides from its
 * sessions; a query (`/mcp [query]`) filters every section to servers whose
 * name — or, for live groups, any tool name — matches it.
 *
 * Both commands are read-only and register through the engine's
 * registerCommand seam so /help lists them under the tools group.
 *
 * @module dsh-feishu-bridge/skills-mcp-commands
 */

import { Msg } from '../i18n/index.ts'
import type { Message, Platform } from '../core/types.ts'
import { splitMcpToolName } from '../core/mcp-health.ts'
import { defaultBtn, newCard, type Card, type CardButton } from '../card.ts'
import { pageArg } from './commands.ts'
import { type Engine, stripUserID } from './engine.ts'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import type { McpHealthServerConfig } from '../index.ts'

/** Maximum rendered description length per /skills entry (runes). */
const SKILL_DESCRIPTION_MAX_RUNES = 80

/** Skill entries listed per /skills card page. */
const SKILLS_PAGE_SIZE = 15

/** Tool names listed per /mcp server before the `+N` overflow marker. */
const MCP_TOOLS_PER_SERVER = 8

/** Data sources the two commands read; wired by buildProjectAssembly. */
export interface SkillsMcpCommandDeps {
  /** Skill summaries for a workspace directory; absent = the skill registry is not composed. */
  readonly listSkills?: ((cwd: string) => Promise<readonly SkillSummary[]>) | undefined
  /** Skill names the bridge service masks for this engine's sessions; absent = no mask. */
  readonly deniedSkills?: (() => readonly string[]) | undefined
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
 * One /skills listing snapshot: the query-scoped entries a chat's card pages
 * through. Captured when the command runs; page turns re-render from it.
 */
interface SkillsSnapshot {
  /** Deny- and query-filtered entries, in catalog order. */
  readonly entries: readonly SkillSummary[]
  /** Query the entries were filtered by ('' = unfiltered). */
  readonly query: string
  /** Work dir the listing was read for (rendered as the 📁 line). */
  readonly workDir: string
  /** Catalog size after the deny filter, before the query filter (the 🔍 line's denominator). */
  readonly total: number
}

/**
 * Register /skills and /mcp on an engine through the registerCommand seam
 * (handler map + resolver chain + the tools help-card group). Requires the
 * session command table (registerSessionCommands) to be installed first.
 * /skills stores each rendered listing in a per-channel snapshot map; the
 * registered `/skills` card action pages through that snapshot (a miss —
 * after a re-registration or daemon restart — renders the stale-snapshot
 * notice).
 * @param e - Engine whose command table gains both entries.
 * @param deps - The data sources the commands read.
 * @returns The disposer removing both registrations and the snapshots.
 */
export function registerSkillsMcpCommands(e: Engine, deps: SkillsMcpCommandDeps): () => void {
  // Query-scoped listings keyed by the channel-level session key
  // (stripUserID), so the listing author and a pressing user of the same
  // chat share one slot. Every /skills run replaces the chat's entry.
  const snapshots = new Map<string, SkillsSnapshot>()
  const disposeSkills = e.registerCommand({
    id: 'skills',
    handler: (p, msg, args) => { void cmdSkills(e, p, msg, args, deps, snapshots); return true },
    // 'skill' is an explicit alias; it also happens to be a ≥2-char prefix,
    // but the alias must not depend on that rule.
    match: cmd => (cmd === 'skills' || cmd === 'skill' || ('skills'.startsWith(cmd) && cmd.length >= 2)) ? 'skills' : '',
    group: 'tools',
  })
  const disposeCardAction = e.registerCardAction(['/skills'], (sessionKey, _cmd, args) => {
    const snapshot = snapshots.get(stripUserID(sessionKey))
    if (snapshot === undefined) {
      return newCard().markdown(e.i18n.t(Msg.SkillsStale)).build()
    }
    return renderSkillsCard(e, snapshot, pageArg(args.split(/\s+/)))
  })
  const disposeMcp = e.registerCommand({
    id: 'mcp',
    handler: (p, msg, args) => { void cmdMcp(e, p, msg, args, deps); return true },
    match: cmd => (cmd === 'mcp' || ('mcp'.startsWith(cmd) && cmd.length >= 2)) ? 'mcp' : '',
    group: 'tools',
  })
  return () => {
    disposeSkills()
    disposeCardAction()
    disposeMcp()
    snapshots.clear()
  }
}

/**
 * /skills: list the skill catalog visible to this chat's work dir — name,
 * capped description, and a command-only marker on entries the model cannot
 * invoke. Arguments: `[query] [page]` — a fuzzy query (every
 * whitespace-separated token must be a case-insensitive substring of the
 * name or description) and an optional trailing 1-based page number; listings
 * longer than {@link SKILLS_PAGE_SIZE} entries render one page per card with
 * prev/next buttons. The skill registry is not composed or has no entries:
 * the command says so instead of rendering an empty card; a query that
 * matches nothing gets its own no-match reply. Engine-denied names (the
 * bridge service's per-engine mask, e.g. a sibling plugin disabled on this
 * project) are dropped before rendering.
 * @param e - Engine whose i18n and card senders render the listing.
 * @param p - Platform that delivered the command message.
 * @param msg - Triggering message; its session selects the work dir.
 * @param args - Command arguments (query tokens and an optional trailing page).
 * @param deps - The skill listing source.
 * @param snapshots - Per-channel snapshot store the rendered listing is captured in.
 */
async function cmdSkills(
  e: Engine, p: Platform, msg: Message, args: string[],
  deps: SkillsMcpCommandDeps, snapshots: Map<string, SkillsSnapshot>,
): Promise<void> {
  if (deps.listSkills === undefined) {
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.SkillsUnavailable))
    return
  }
  const { query, page } = parseSkillsArgs(args)
  const workDir = e.commandWorkDir(msg)
  const denied = deps.deniedSkills?.() ?? []
  const lowered = query.toLowerCase()
  const catalog = (await deps.listSkills(workDir)).filter(entry => !denied.includes(entry.name))
  const skills = lowered === '' ? catalog : catalog.filter(entry => matchesQuery(entry, lowered))
  if (catalog.length === 0) {
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.SkillsEmpty))
    return
  }
  if (skills.length === 0) {
    await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.SkillsNoMatch, query))
    return
  }
  const snapshot: SkillsSnapshot = { entries: skills, query, workDir, total: catalog.length }
  snapshots.set(stripUserID(msg.sessionKey), snapshot)
  await e.replyWithCard(p, msg.replyCtx, renderSkillsCard(e, snapshot, page))
}

/**
 * Split /skills arguments into query and page: a trailing standalone positive
 * integer is the 1-based page number; the remaining tokens, joined by single
 * spaces, are the query. A skill literally named as a bare number is
 * unreachable through this form — the page wins.
 * @param args - Command argument tokens.
 * @returns The query string ('' when none) and the 1-based page (1 when absent or invalid).
 */
function parseSkillsArgs(args: readonly string[]): { query: string; page: number } {
  const tokens = [...args]
  let page = 1
  const last = tokens.at(-1)
  if (last !== undefined && /^\d+$/.test(last)) {
    const n = Number.parseInt(last, 10)
    if (n > 0) {
      page = n
      tokens.pop()
    }
  }
  return { query: tokens.join(' ').trim(), page }
}

/**
 * Render one page of a /skills listing: title (paged variant when the
 * listing spans pages), the 📁 work-dir line, the 🔍 query line when
 * filtered, the page's entry lines, prev/next buttons, and a page hint.
 * @param e - Engine whose i18n renders the copy.
 * @param snapshot - The listing snapshot to render.
 * @param page - Requested 1-based page; clamped into the valid range.
 * @returns The rendered card.
 */
function renderSkillsCard(e: Engine, snapshot: SkillsSnapshot, page: number): Card {
  const total = snapshot.entries.length
  const pages = Math.max(1, Math.ceil(total / SKILLS_PAGE_SIZE))
  if (page < 1) page = 1
  if (page > pages) page = pages
  const start = (page - 1) * SKILLS_PAGE_SIZE
  const end = Math.min(start + SKILLS_PAGE_SIZE, total)

  const title = pages > 1
    ? e.i18n.tf(Msg.SkillsTitlePaged, total, page, pages)
    : e.i18n.tf(Msg.SkillsTitle, total)
  const cb = newCard().title(title, 'blue')
  const lines: string[] = [`📁 ${snapshot.workDir}`]
  if (snapshot.query !== '') {
    lines.push('', e.i18n.tf(Msg.SkillsQueryLine, snapshot.query, total, snapshot.total))
  }
  lines.push('')
  for (const skill of snapshot.entries.slice(start, end)) {
    const desc = capRunes(skill.description, SKILL_DESCRIPTION_MAX_RUNES)
    const marker = skill.invocation.modelInvocable ? '' : e.i18n.t(Msg.SkillsUserOnly)
    lines.push(desc === '' ? `- \`${skill.name}\`${marker}` : `- \`${skill.name}\` — ${desc}${marker}`)
  }
  cb.markdown(lines.join('\n'))

  const nav: CardButton[] = []
  if (page > 1) nav.push(defaultBtn(e.i18n.t(Msg.CardPrev), `nav:/skills ${page - 1}`))
  if (page < pages) nav.push(defaultBtn(e.i18n.t(Msg.CardNext), `nav:/skills ${page + 1}`))
  if (nav.length > 0) cb.buttons(...nav)
  if (pages > 1) cb.note(e.i18n.tf(Msg.SkillsPageHint, page, pages))
  return cb.build()
}

/**
 * /mcp: list live MCP servers — one line per server with its tool count and
 * tool names (capped per server), a degraded marker on health-watched
 * servers with no live tools, and a masked marker on servers this project's
 * `mcpServers` allowlist hides from its sessions. An argument filters every
 * section to servers matching it (case-insensitive substring of the server
 * name or, for live groups, any tool name; every whitespace-separated token
 * must hit). No servers at all: the command says so instead of rendering an
 * empty card; a query that matches nothing gets its own no-match reply.
 * @param e - Engine whose i18n and card senders render the listing.
 * @param p - Platform that delivered the command message.
 * @param msg - Triggering message (reply context only).
 * @param args - Command arguments; joined into the filter query.
 * @param deps - The tool-registry and configuration sources.
 */
async function cmdMcp(e: Engine, p: Platform, msg: Message, args: string[], deps: SkillsMcpCommandDeps): Promise<void> {
  const displayQuery = args.join(' ').trim()
  const query = displayQuery.toLowerCase()
  const allGroups = mcpServerGroups(deps.toolNames())
  const groups = query === '' ? allGroups : allGroups.filter(group => mcpGroupMatchesQuery(query, group.server, group.tools))
  const allDegraded = (deps.healthServers ?? [])
    .map(server => server.serverName)
    .filter(name => !allGroups.some(group => group.server === name))
  const degraded = query === '' ? allDegraded : allDegraded.filter(name => matchesNameQuery(query, name))
  // Directory mounts are per-session (agent scope), never in the
  // process-global view, so the section reads the discovery service by the
  // chat's work dir instead of the tool registry.
  const allWorkspace = deps.listWorkspaceServers === undefined
    ? []
    : await deps.listWorkspaceServers(e.commandWorkDir(msg))
  const workspace = query === '' ? allWorkspace : allWorkspace.filter(server => matchesNameQuery(query, server.name))
  const total = allGroups.length + allDegraded.length + allWorkspace.length
  if (total === 0) {
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.McpEmpty))
    return
  }
  if (groups.length === 0 && degraded.length === 0 && workspace.length === 0) {
    await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.McpNoMatch, displayQuery))
    return
  }
  const lines: string[] = []
  if (query !== '') {
    lines.push(e.i18n.tf(Msg.McpQueryLine, displayQuery, groups.length + degraded.length + workspace.length, total), '')
  }
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
 * Whether an MCP server matches a lowercased /mcp query: every
 * whitespace-separated token must be a case-insensitive substring of the
 * server name or one of its tool names.
 * @param query - Lowercased query string.
 * @param server - The server's name.
 * @param tools - The server's tool names.
 * @returns True when every token hits the server name or any tool name.
 */
function mcpGroupMatchesQuery(query: string, server: string, tools: readonly string[]): boolean {
  const name = server.toLowerCase()
  return query.split(/\s+/).every(token =>
    name.includes(token) || tools.some(tool => tool.toLowerCase().includes(token)))
}

/**
 * Whether a bare server name (degraded or workspace mounts — no tool names)
 * matches a lowercased /mcp query: every whitespace-separated token must be
 * a case-insensitive substring of the name.
 * @param query - Lowercased query string.
 * @param name - The server's name.
 * @returns True when every token hits the name.
 */
function matchesNameQuery(query: string, name: string): boolean {
  const lowered = name.toLowerCase()
  return query.split(/\s+/).every(token => lowered.includes(token))
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
 * Whether a skill entry matches a lowercased query string: every
 * whitespace-separated token must be a case-insensitive substring of the
 * entry's name or description.
 * @param entry - The skill summary to test.
 * @param query - Lowercased query string.
 * @returns True when every token hits either field.
 */
function matchesQuery(entry: SkillSummary, query: string): boolean {
  const name = entry.name.toLowerCase()
  const description = entry.description.toLowerCase()
  return query.split(/\s+/).every(token => name.includes(token) || description.includes(token))
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
