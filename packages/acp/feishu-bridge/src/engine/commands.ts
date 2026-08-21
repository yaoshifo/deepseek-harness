/**
 * Session-lifecycle commands ported from cc-connect core/engine_cmd_session.go
 * and the /dir machinery in engine_cmd_workspace.go: /new /stop /sessions
 * (/list) /switch /status /dir (+/cd alias), plus the M4 spawn family
 * (/spawn /sp, /fork /fk, /done --reply). /dir renders the picker card on
 * card platforms (dir-card.ts) with a plain-text fallback; the other
 * commands stay plain text.
 *
 * @module dsh-feishu-bridge/commands
 */

import { readFileSync } from 'node:fs'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { Msg } from '../i18n/index.js'
import type { AgentSessionInfo, Message, Platform } from '../core/types.js'
import { asCardSender, asChatAvatarStateSwitcher, asForkAtPreparer, asGroupIconAvatarSetter, asGroupRenamer, asGroupSpawner, asGroupSpawnerEx, asReplyContextReconstructor, ContinueSession, ForkAtSessionPrefix, ForkSessionPrefix, supportsCards, type GroupSpawnOptions } from '../core/types.js'
import { newCard } from '../card.js'
import type { Engine } from './engine.js'
import type { SessionManager } from './session.js'
import { childLabel } from './subtask.js'
import {
  createWorktree,
  resolveWorktreeUse,
  slugify,
  worktreeDirty,
  worktreeGone,
  worktreeRepoRoot,
} from './worktree.js'
import { buildCompactContext, maxGroupNameRunes, sanitizeGroupName } from './groupname.js'
import { buildHintsCommonElements, buildHintsPanelElements } from './hints-panel.js'
import { renderDirCardSafe } from './dir-card.js'
import { extractChannelID } from './engine.js'

const listPageSize = 5

/** Command IDs gated behind admin_from (Go privilegedCommands, M1 subset + monitor + shell + reload). */
const privilegedCommands = new Set(['dir', 'monitor', 'shell', 'reload'])

/** Canonical command names and their aliases (Go builtinCommands subset). */
export const builtinCommands: Array<{ names: string[]; id: string }> = [
  { names: ['new'], id: 'new' },
  { names: ['list', 'sessions'], id: 'list' },
  { names: ['switch', 'resume'], id: 'switch' },
  { names: ['status'], id: 'status' },
  { names: ['stop'], id: 'stop' },
  { names: ['dir', 'cd', 'chdir', 'workdir'], id: 'dir' },
  { names: ['spawn', 'sp'], id: 'spawn' },
  { names: ['fork', 'fk'], id: 'fork' },
  { names: ['done'], id: 'done' },
  { names: ['rename'], id: 'rename' },
  { names: ['hint', 'ht'], id: 'hint' },
]

/**
 * Resolve a typed command prefix to its canonical ID ('' when unknown).
 * @param cmd - The typed command token, possibly a unique ≥2-char prefix of an alias.
 * @returns The canonical command ID, or '' when no builtin matches.
 */
export function matchPrefix(cmd: string): string {
  for (const entry of builtinCommands) {
    if (entry.names.some(n => n === cmd || (n.startsWith(cmd) && cmd.length >= 2))) return entry.id
  }
  return ''
}

/**
 * Register the M1 session commands on an engine (replaces Go's compile-time
 * dispatch table). Returns the disposer.
 * @param e - The engine whose command dispatch table to install.
 * @returns The disposer restoring the engine's dispatch slots to their prior unset state.
 */
export function registerSessionCommands(e: Engine): () => void {
  const handlers: Map<string, (p: Platform, msg: Message, args: string[]) => boolean> = new Map([
    ['new', (p, msg, args) => { void cmdNew(e, p, msg, args); return true }],
    ['list', (p, msg, args) => { void cmdList(e, p, msg, args); return true }],
    ['switch', (p, msg, args) => { void cmdSwitch(e, p, msg, args); return true }],
    ['status', (p, msg) => { void cmdStatus(e, p, msg); return true }],
    ['stop', (p, msg) => {
      // A successful stop is acknowledged by the stopped-card PATCH (⏹ 已停止
      // header); text only tells the user when there was nothing to stop.
      if (!cmdStop(e, p, msg)) {
        void e.reply(p, msg.replyCtx, e.i18n.t(Msg.NoExecution))
      }
      return true
    }],
    ['dir', (p, msg, args) => { void cmdDir(e, p, msg, args); return true }],
    ['spawn', (p, msg, args) => { void cmdSpawn(e, p, msg, args); return true }],
    ['fork', (p, msg, args) => { void cmdFork(e, p, msg, args); return true }],
    ['done', (p, msg, args) => { cmdDone(e, p, msg, args); return true }],
    ['rename', (p, msg, args) => { void cmdRename(e, p, msg, args); return true }],
    ['hint', (p, msg) => { void cmdHint(e, p, msg); return true }],
  ])
  e.commandHandlers = handlers
  e.commandResolver = matchPrefix
  e.commandGate = (cmdID, p, msg) => gatePrivilegedCommand(e, cmdID, p, msg)
  return () => {
    e.commandHandlers = undefined
    e.commandResolver = undefined
    e.commandGate = undefined
  }
}

/**
 * /new: stop the current interactive session and start a fresh one.
 * @param e - The engine owning the session state.
 * @param p - The platform that delivered the command.
 * @param msg - The triggering chat message.
 * @param args - The optional name for the new session.
 */
export async function cmdNew(e: Engine, p: Platform, msg: Message, args: string[]): Promise<void> {
  const { sessions } = commandContext(e, msg)
  const old = sessions.getOrCreateActive(msg.sessionKey)

  e.stopInteractiveSession(msg.sessionKey)
  // Clear an orphan pendingRename mark: a user /rename that landed after the
  // LLM rename callback finished leaves a stale mark that would wrongly skip
  // the new session's first-message rename (Go cmdNew).
  e.clearPendingRename(msg.sessionKey)

  old.setAgentSessionID('', '')
  old.clearHistory()
  sessions.save()

  const name = args.length > 0 ? args.join(' ') : ''
  sessions.newSession(msg.sessionKey, name)

  const prefix = name === ''
    ? e.i18n.t(Msg.NewSessionCreated)
    : e.i18n.tf(Msg.NewSessionCreatedName, name)
  // Unified status footer card (/new has no token count): reset the per-turn
  // usage fields first so the previous turn's numbers don't bleed in (Go
  // buildCompletionUsage(0) + the purple card at engine_cmd_session.go:78).
  await e.buildCompletionUsage({
    totalInputTokens: 0, sdkPlausible: false, selfPct: 0,
    nonCachedDelta: 0, nonCachedCum: 0, cachedDelta: 0, cachedCum: 0,
    numTurns: 0, compactionCount: 0,
  })
  const workDir = e.perChatWorkDir(e.dirOverrideKey(msg.sessionKey))
  const cs = asCardSender(p)
  if (cs !== undefined) {
    const { headerSuffix, elements } = await e.buildStatusFooterElements(e.agent, workDir, '', msg.sessionKey)
    const title = headerSuffix !== '' ? headerSuffix : prefix
    if (elements.length > 0 || title !== '') {
      const card = newCard().title(title, 'purple').raw(...elements).build()
      try {
        await cs.sendCard(msg.replyCtx, card)
        return
      } catch (error) {
        console.warn(`/new card send failed (${p.name()}): ${String(error)}`)
      }
    }
    await e.reply(p, msg.replyCtx, prefix)
    return
  }
  await e.reply(p, msg.replyCtx, await e.buildStatusFooter(prefix, e.agent, workDir, '', msg.sessionKey))
}

/**
 * The engine-facing session/agent context for commands (M1: single workspace).
 * @param e - The engine owning the session state.
 * @param _msg - The triggering chat message (only its session key is read).
 * @returns The agent, session manager, and interactive key the command acts on.
 */
export function commandContext(e: Engine, _msg: Message): { agent: Engine['agent']; sessions: SessionManager; interactiveKey: string } {
  return { agent: e.agent, sessions: e.sessions, interactiveKey: _msg.sessionKey }
}

/**
 * /list (/sessions): enumerate agent sessions, plain-text surface.
 * @param e - The engine owning the session state.
 * @param p - The platform that delivered the command.
 * @param msg - The triggering chat message.
 * @param args - The optional 1-based page number to display.
 */
export async function cmdList(e: Engine, p: Platform, msg: Message, args?: string[]): Promise<void> {
  const argList = args ?? []
  const { agent, sessions } = commandContext(e, msg)
  let agentSessions: AgentSessionInfo[]
  try {
    agentSessions = await agent.listSessions()
  } catch (error) {
    await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.ListError, String(error)))
    return
  }
  agentSessions = applySessionFilter(e, agentSessions, sessions)
  enrichSessionSummaries(sessions, agentSessions)
  if (agentSessions.length === 0) {
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.ListEmpty))
    return
  }

  const total = agentSessions.length
  const totalPages = Math.ceil(total / listPageSize)
  let page = 1
  if (argList.length > 0) {
    const n = Number.parseInt(argList[0] ?? '', 10)
    if (Number.isInteger(n) && n > 0) page = n
  }
  if (page > totalPages) page = totalPages

  const start = (page - 1) * listPageSize
  const end = Math.min(start + listPageSize, total)

  const agentName = agent.name()
  const activeSession = sessions.getOrCreateActive(msg.sessionKey)
  const activeAgentID = activeSession.getAgentSessionID()
  const liveSessions = liveAgentSessionIDs(e)

  let sb = ''
  if (totalPages > 1) {
    sb += e.i18n.tf(Msg.ListTitlePaged, agentName, total, page, totalPages)
  } else {
    sb += e.i18n.tf(Msg.ListTitle, agentName, total)
  }
  for (let i = start; i < end; i++) {
    const s = agentSessions[i]
    if (s === undefined) continue
    let marker = '◻'
    if (s.id === activeAgentID) marker = '▶'
    else if (liveSessions[s.id]) marker = '●'
    let displayName = sessions.getSessionName(s.id)
    if (displayName !== '') {
      displayName = `📌 ${displayName}`
    } else {
      displayName = s.summary.replaceAll('\n', ' ').trim().split(/\s+/).join(' ')
      if (displayName === '') displayName = '(empty)'
      if (Array.from(displayName).length > 40) displayName = `${Array.from(displayName).slice(0, 40).join('')}…`
    }
    sb += `${marker} **${i + 1}.** ${displayName} · **${s.messageCount}** msgs · ${formatModified(s.modifiedAt)}\n`
  }
  if (totalPages > 1) sb += e.i18n.tf(Msg.ListPageHint, page, totalPages)
  sb += e.i18n.t(Msg.ListSwitchHint)
  await e.reply(p, msg.replyCtx, sb)
}

/** Agent session IDs with a live process (for /list markers). */
function liveAgentSessionIDs(e: Engine): Record<string, true> {
  const live: Record<string, true> = {}
  for (const state of e.interactiveStates.values()) {
    if (state.agentSession !== undefined && state.agentSession.alive()) {
      const sid = state.agentSession.currentSessionID()
      if (sid !== '') live[sid] = true
    }
  }
  return live
}

/** Conditionally filter to cc-connect-owned sessions (Go applySessionFilter). */
function applySessionFilter(e: Engine, sessions: AgentSessionInfo[], sm: SessionManager): AgentSessionInfo[] {
  return e.filterExternalSessions
    ? filterOwned(sessions, sm.knownAgentSessionIDs())
    : sessions
}

function filterOwned(sessions: AgentSessionInfo[], known: Record<string, true> | null): AgentSessionInfo[] {
  if (known === null || Object.keys(known).length === 0) return sessions
  return sessions.filter(s => s.id in known)
}

/** Fill summaries from the first user history entry (Go enrichSessionSummaries). */
function enrichSessionSummaries(sessions: SessionManager, agentSessions: AgentSessionInfo[]): void {
  for (let i = 0; i < agentSessions.length; i++) {
    const info = agentSessions[i]
    if (info === undefined) continue
    const s = sessions.findByAgentSessionID(info.id)
    if (s === undefined) continue
    for (const entry of s.getHistory(0)) {
      if (entry.role === 'user' && entry.content !== '') {
        if (entry.content.startsWith('---\n')) break
        let summary = entry.content.replaceAll('\n', ' ')
        summary = summary.trim().split(/\s+/).join(' ')
        if (Array.from(summary).length > 40) summary = `${Array.from(summary).slice(0, 40).join('')}…`
        info.summary = summary
        break
      }
    }
  }
}

function formatModified(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * /switch (/resume): switch the chat to another agent session.
 * @param e - The engine owning the session state.
 * @param p - The platform that delivered the command.
 * @param msg - The triggering chat message.
 * @param args - The target session selector: list index, name, ID prefix, or summary substring.
 */
export async function cmdSwitch(e: Engine, p: Platform, msg: Message, args: string[]): Promise<void> {
  if (args.length === 0) {
    await e.reply(p, msg.replyCtx, 'Usage: /switch <number | id_prefix | name>')
    return
  }
  const query = args.join(' ').trim()
  const { agent, sessions, interactiveKey } = commandContext(e, msg)
  let agentSessions: AgentSessionInfo[]
  try {
    agentSessions = await agent.listSessions()
  } catch (error) {
    await e.reply(p, msg.replyCtx, e.i18n.tf('error', String(error)))
    return
  }
  agentSessions = applySessionFilter(e, agentSessions, sessions)

  const matched = matchSession(agentSessions, sessions, query)
  if (matched === undefined) {
    await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.SwitchNoMatch, query))
    return
  }

  e.stopInteractiveSession(interactiveKey)
  const session = sessions.switchToAgentSession(msg.sessionKey, matched.id, agent.name(), matched.summary)
  session.clearHistory()

  let shortID = matched.id
  if (shortID.length > 12) shortID = shortID.slice(0, 12)
  let displayName = sessions.getSessionName(matched.id)
  if (displayName === '') displayName = matched.summary
  await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.SwitchSuccess, displayName, shortID, matched.messageCount))
  // TODO(M7): resendLastAssistantMessage via HistoryProvider for context echo.
}

/** Name-lookup surface matchSession needs from a session manager. */
export type SessionNameLookup = Pick<SessionManager, 'getSessionName'>

/**
 * Resolve a user query to an agent session: numeric index, exact name, ID
 * prefix, name prefix, then summary substring (Go matchSession).
 * @param sessions - The agent session listing, in /list order.
 * @param manager - Session manager consulted for user-assigned session names.
 * @param query - The user's selector text.
 * @returns The first matching session, or undefined when nothing matches.
 */
export function matchSession(sessions: AgentSessionInfo[], manager: SessionNameLookup, query: string): AgentSessionInfo | undefined {
  if (sessions.length === 0) return undefined
  const idx = Number.parseInt(query, 10)
  if (Number.isInteger(idx) && String(idx) === query.trim() && idx >= 1 && idx <= sessions.length) {
    return sessions[idx - 1]
  }
  const queryLower = query.toLowerCase()
  for (const candidate of sessions) {
    const name = manager.getSessionName(candidate.id)
    if (name !== '' && name.toLowerCase() === queryLower) return candidate
  }
  for (const candidate of sessions) {
    if (candidate.id.startsWith(query)) return candidate
  }
  for (const candidate of sessions) {
    const name = manager.getSessionName(candidate.id)
    if (name !== '' && name.toLowerCase().startsWith(queryLower)) return candidate
  }
  for (const candidate of sessions) {
    const summary = candidate.summary
    if (summary !== '' && summary.toLowerCase().includes(queryLower)) return candidate
  }
  return undefined
}

/**
 * /hint: show the configured hint buttons as a card, or a numbered text list
 * on platforms without cards (Go cmdHint / renderHintsCard).
 * @param e - The engine whose hint groups to render.
 * @param p - The platform that delivered the command.
 * @param msg - The triggering chat message.
 */
export async function cmdHint(e: Engine, p: Platform, msg: Message): Promise<void> {
  if (e.hints.length === 0 && e.hintsWithParam.length === 0 && e.hintsCommon.length === 0) {
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.HintsEmpty))
    return
  }
  const cs = asCardSender(p)
  if (cs !== undefined) {
    const common = buildHintsCommonElements(e.hintsCommon, e.hintUsage)
    const panels = buildHintsPanelElements(e.hints, e.hintsWithParam, e.hintUsage)
    const card = newCard()
    if (common.length > 0) card.form('hints_common_form', ...common)
    if (panels.length > 0) {
      card.form('hints_form', {
        kind: 'collapsiblePanel',
        expanded: false,
        title: `💡 ${e.i18n.t(Msg.BuiltinCmdHint)}`,
        elements: panels,
      })
    }
    try {
      await cs.sendCard(msg.replyCtx, card.build())
      return
    } catch (error) {
      console.warn(`/hint card send failed (${p.name()}): ${String(error)}`)
    }
  }
  const lines: string[] = []
  let idx = 0
  for (const h of e.hintsCommon) {
    idx++
    lines.push(`  ${idx}. ${h}`)
  }
  for (const h of e.hints) {
    idx++
    lines.push(`  ${idx}. ${h}`)
  }
  for (const h of e.hintsWithParam) {
    idx++
    lines.push(`  ${idx}. ${h}`)
  }
  await e.reply(p, msg.replyCtx, lines.join('\n'))
}

/**
 * /status: project/agent/session summary, plain text.
 * @param e - The engine owning the session state.
 * @param p - The platform that delivered the command.
 * @param msg - The triggering chat message.
 */
export async function cmdStatus(e: Engine, p: Platform, msg: Message): Promise<void> {
  const { agent, sessions } = commandContext(e, msg)
  const platNames = e.platforms.map(pl => pl.name())
  const platformStr = platNames.length === 0 ? '-' : platNames.join(', ')
  const workDirStr = e.commandWorkDir(msg)
  const uptimeStr = formatUptime(Date.now() - e.startedAt)
  const langStr = e.i18n.currentLang() || 'en'

  let modeStr = ''
  const modeSwitcher = agent as { getMode?: () => string }
  if (typeof modeSwitcher.getMode === 'function') {
    const mode = modeSwitcher.getMode()
    if (mode !== '') modeStr += e.i18n.tf('status_mode', mode)
  }
  const thinkingStr = e.display.thinkingMessages ? e.i18n.t(Msg.EnabledShort) : e.i18n.t(Msg.DisabledShort)
  const toolStr = e.display.toolMessages ? e.i18n.t(Msg.EnabledShort) : e.i18n.t(Msg.DisabledShort)
  modeStr += e.i18n.tf('status_thinking_messages', thinkingStr)
  modeStr += e.i18n.tf('status_tool_messages', toolStr)

  const s = sessions.getOrCreateActive(msg.sessionKey)
  let sessionDisplayName = sessions.getSessionName(s.getAgentSessionID())
  if (sessionDisplayName === '') sessionDisplayName = s.getName()
  const sessionStr = e.i18n.tf(Msg.StatusSession, sessionDisplayName, s.getHistory(0).length)

  // Cron line (Go engine_cmd_misc.go): the session's job count when any
  // exist — the M6a leftover /status wiring.
  let cronStr = ''
  if (e.cronScheduler !== undefined) {
    const jobs = e.cronScheduler.store().listBySessionKey(msg.sessionKey)
    if (jobs.length > 0) {
      let enabledCount = 0
      for (const j of jobs) {
        if (j.enabled) enabledCount++
      }
      cronStr = e.i18n.tf(Msg.StatusCron, jobs.length, enabledCount)
    }
  }

  const sessionKeyStr = e.i18n.tf(Msg.StatusSessionKey, msg.sessionKey)
  let agentSIDStr = ''
  const agentSID = s.getAgentSessionID()
  if (agentSID !== '') agentSIDStr = e.i18n.tf(Msg.StatusAgentSID, agentSID)
  let userIDStr = ''
  if (msg.userID !== '') userIDStr = e.i18n.tf(Msg.StatusUserID, msg.userID)

  await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.StatusTitle,
    e.name, agent.name(), workDirStr, platformStr, uptimeStr, langStr,
    modeStr, sessionStr, cronStr, sessionKeyStr, agentSIDStr, userIDStr, ''))
}

function formatUptime(ms: number): string {
  const sec = Math.floor(ms / 1000)
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/**
 * /stop: stop the running turn (Go cmdStop).
 * @param e - The engine owning the interactive session.
 * @param _p - Unused platform, kept for handler-signature parity.
 * @param msg - The triggering chat message.
 * @returns Whether an interactive session was actually stopped.
 */
export function cmdStop(e: Engine, _p: Platform, msg: Message): boolean {
  // A user stop disarms the subtask one-shot auto-report — after the user
  // takes over, later turns must not auto-report to the parent.
  e.suppressSubtaskAutoReport(msg.sessionKey)
  return e.stopInteractiveSession(msg.sessionKey)
}

/**
 * /dir: show or switch the agent's working directory (Go cmdDir): the picker
 * card on card platforms, plain text otherwise.
 * @param e - The engine owning the dir override and history.
 * @param p - The platform that delivered the command.
 * @param msg - The triggering chat message.
 * @param args - The target: a path, history index, '-', 'reset', or 'help'/'-h'/'--help'; empty shows the current dir.
 */
export async function cmdDir(e: Engine, p: Platform, msg: Message, args: string[]): Promise<void> {
  const { agent, sessions, interactiveKey } = commandContext(e, msg)
  const switcher = agent as { getWorkDir?: () => string } | undefined
  if (switcher === undefined || typeof switcher.getWorkDir !== 'function') {
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.DirNotSupported))
    return
  }

  let currentDir = switcher.getWorkDir()
  const override = e.perChatWorkDir(e.dirOverrideKey(interactiveKey))
  if (override !== '') currentDir = override

  if (args.length === 0) {
    if (supportsCards(p)) {
      await e.replyWithCard(p, msg.replyCtx, renderDirCardSafe(e, msg.sessionKey, 1, ''))
      return
    }
    let sb = e.i18n.tf(Msg.DirCurrent, currentDir)
    if (e.dirHistory !== undefined) {
      const history = e.dirHistory.list(e.name)
      if (history.length > 0) {
        sb += '\n\n'
        sb += e.i18n.t(Msg.DirHistoryTitle)
        for (let i = 0; i < history.length; i++) {
          const dir = history[i]
          if (dir === undefined) continue
          const marker = dir === currentDir ? '▶' : '◻'
          sb += `\n  ${marker} ${i + 1}. ${dir}`
        }
        sb += '\n\n'
        sb += e.i18n.t(Msg.DirHistoryHint)
      }
    }
    await e.reply(p, msg.replyCtx, sb)
    return
  }

  if (args.length === 1) {
    const first = (args[0] ?? '').trim().toLowerCase()
    if (first === 'help' || first === '-h' || first === '--help') {
      await e.reply(p, msg.replyCtx, e.i18n.t(Msg.DirUsage))
      return
    }
  }

  const [errMsg, successMsg] = await dirApply(e, agent, sessions, interactiveKey, msg.sessionKey, args)
  if (errMsg !== '') {
    await e.reply(p, msg.replyCtx, errMsg)
    return
  }
  if (supportsCards(p)) {
    await e.replyWithCard(p, msg.replyCtx, renderDirCardSafe(e, msg.sessionKey, 1, e.i18n.t(Msg.DirSessionReset)))
    return
  }
  await e.reply(p, msg.replyCtx, `${successMsg}\n\n${e.i18n.t(Msg.DirSessionReset)}`)
}

/**
 * Apply a directory switch (Go dirApply, M1: single-workspace keying).
 * @param e - The engine owning the dir override and history.
 * @param agent - The agent whose base work dir backs the reset path.
 * @param sessions - The session manager whose chat state is reset by the switch.
 * @param interactiveKey - The interactive key whose dir override is rewritten.
 * @param sessionKey - The session key whose chat state is reset by the switch.
 * @param args - The target: a path, history index, '-', or 'reset'.
 * @returns The error message at index 0 when the switch failed, otherwise the success message at index 1.
 */
export async function dirApply(
  e: Engine,
  agent: Engine['agent'],
  sessions: SessionManager,
  interactiveKey: string,
  sessionKey: string,
  args: string[],
): Promise<[errMsg: string, successMsg: string]> {
  const switcher = agent as { getWorkDir?: () => string }
  if (typeof switcher.getWorkDir !== 'function') {
    return [e.i18n.t(Msg.DirNotSupported), '']
  }
  let currentDir = switcher.getWorkDir()
  const override = e.perChatWorkDir(e.dirOverrideKey(interactiveKey))
  if (override !== '') currentDir = override

  if (args.length === 1 && (args[0] ?? '').trim().toLowerCase() === 'reset') {
    let baseDir = e.baseWorkDir.trim()
    if (baseDir === '') baseDir = currentDir
    await e.cleanupInteractiveState(interactiveKey)
    const s = sessions.getOrCreateActive(sessionKey)
    s.setAgentSessionID('', '')
    s.clearHistory()
    sessions.save()
    e.projectState?.clearWorkspaceDirOverride(e.dirOverrideKey(interactiveKey))
    e.projectState?.save()
    e.dirHistory?.add(e.name, baseDir)
    return ['', e.i18n.tf(Msg.DirReset, baseDir)]
  }

  const arg = args.join(' ')
  let newDir: string

  const idx = Number.parseInt(arg.trim(), 10)
  if (Number.isInteger(idx) && String(idx) === arg.trim() && idx > 0) {
    if (e.dirHistory !== undefined) {
      newDir = e.dirHistory.get(e.name, idx)
      if (newDir === '') return [e.i18n.tf(Msg.DirInvalidIndex, idx), '']
    } else {
      return [e.i18n.t(Msg.DirNoHistory), '']
    }
  } else if (arg === '-') {
    if (e.dirHistory !== undefined) {
      newDir = e.dirHistory.previous(e.name)
      if (newDir === '') return [e.i18n.t(Msg.DirNoPrevious), '']
    } else {
      return [e.i18n.t(Msg.DirNoHistory), '']
    }
  } else {
    const resolved = resolveDir(e, arg)
    if (resolved === undefined) return [e.i18n.tf(Msg.DirInvalidPath, arg), '']
    newDir = resolved
  }

  await e.cleanupInteractiveState(interactiveKey)
  const s = sessions.getOrCreateActive(sessionKey)
  s.setAgentSessionID('', '')
  s.clearHistory()
  sessions.save()
  e.dirHistory?.add(e.name, newDir)
  e.projectState?.setWorkspaceDirOverride(e.dirOverrideKey(interactiveKey), newDir)
  e.projectState?.save()
  return ['', e.i18n.tf(Msg.DirChanged, newDir)]
}

/** Resolve a user-supplied dir argument (tilde expansion + scan paths + stat). */
function resolveDir(e: Engine, arg: string): string | undefined {
  let newDir = expandTilde(arg.trim())
  if (!newDir.startsWith('/')) {
    // Relative bare names resolve ONLY against scan roots (Go resolveDir):
    // no work-dir/cwd fallback, so a typo'd name cannot silently land under
    // an unrelated directory. After an exact miss, the fuzzy fallback picks
    // the closest scanned/MRU basename (#3).
    const hit = e.dirHistory?.resolveScanPath(e.name, newDir)
    if (hit !== undefined) {
      newDir = hit
    } else {
      const fuzzy = e.dirHistory?.resolveScanPathFuzzy(e.name, newDir)
      if (fuzzy === undefined) return undefined
      newDir = fuzzy
    }
  }
  try {
    if (!statSyncIsDir(newDir)) return undefined
  } catch {
    return undefined
  }
  return newDir
}

function statSyncIsDir(path: string): boolean {
  return statSync(path).isDirectory()
}

function expandTilde(path: string): string {
  const home = process.env.HOME ?? ''
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return path
}

/**
 * Whether the message's user may run privileged commands (Go isAdmin).
 * @param e - The engine carrying the configured admin_from allowlist.
 * @param userID - The platform user ID to check, case-insensitively.
 * @returns Whether userID is allowlisted in admin_from ('*' admits everyone).
 */
export function isAdmin(e: Engine, userID: string): boolean {
  const adminFrom = e.adminFrom.trim()
  if (adminFrom === '' || userID === '') return false
  if (adminFrom === '*') return true
  return adminFrom.split(',').some(id => id.trim().toLowerCase() === userID.toLowerCase())
}

/**
 * Privileged-command gate used by the engine's dispatchCommand.
 * @param e - The engine carrying the admin_from allowlist.
 * @param cmdID - The canonical command ID being dispatched.
 * @param p - The platform that delivered the command, used to send the denial reply.
 * @param msg - The triggering chat message.
 * @returns Whether the command was blocked with an admin-required reply; false lets dispatch proceed.
 */
export function gatePrivilegedCommand(e: Engine, cmdID: string, p: Platform, msg: Message): boolean {
  if (!privilegedCommands.has(cmdID)) return false
  if (isAdmin(e, msg.userID)) return false
  void e.reply(p, msg.replyCtx, e.i18n.tf(Msg.AdminRequired, `/${cmdID}`))
  return true
}

/** Channel ID helper re-exported for tests (Go extractChannelID). */
export { extractChannelID }

// ── M4: /spawn /fork /done (Go engine_cmd_session.go) ─────────────────────

/**
 * Pull a --dir/-d <path> option out of args: returns the path ('' if
 * absent) and the remaining args (Go extractDirFlag).
 * @param args - Raw command arguments to scan.
 * @returns The --dir value ('' when absent) and the arguments without the flag pair.
 */
export function extractDirFlag(args: string[]): [string, string[]] {
  let dir = ''
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === undefined) continue
    if (a === '--dir' || a === '-d') {
      if (i + 1 < args.length) {
        dir = args[i + 1] ?? ''
        i++
      }
      continue
    }
    out.push(a)
  }
  return [dir, out]
}

/**
 * Strip a boolean --worktree / -w flag from args (Go extractWorktreeFlag).
 * @param args - Raw command arguments to scan.
 * @returns Whether the flag was present, and the arguments without it.
 */
export function extractWorktreeFlag(args: string[]): [boolean, string[]] {
  let use = false
  const out: string[] = []
  for (const a of args) {
    if (a === '--worktree' || a === '-w') {
      use = true
      continue
    }
    out.push(a)
  }
  return [use, out]
}

/** Whether any of the given flags appears in args (Go hasFlag). */
function hasFlag(args: string[], ...flags: string[]): boolean {
  return args.some(a => flags.includes(a))
}

/**
 * The first "-"-prefixed token in args not in allowed; '' when every
 * flag-like token was recognized (Go unknownFlag).
 */
function unknownFlag(args: string[], allowed: ReadonlySet<string>): string {
  for (const a of args) {
    if (a.length > 1 && a.startsWith('-') && !allowed.has(a)) return a
  }
  return ''
}

/**
 * Whether a spawn should be blocked or merely warned at the given RAM usage
 * (Go evalSpawnMemoryGuard). 0 disables a tier; block beats warn.
 * @param ramPct - Current system RAM usage percentage.
 * @param warnPct - Percentage at or above which to warn; 0 disables the warn tier.
 * @param blockPct - Percentage at or above which to block; 0 disables the block tier.
 * @returns The block and warn verdicts; both false below every enabled tier.
 */
export function evalSpawnMemoryGuard(ramPct: number, warnPct: number, blockPct: number): { block: boolean; warn: boolean } {
  if (blockPct > 0 && ramPct >= blockPct) return { block: true, warn: false }
  if (warnPct > 0 && ramPct >= warnPct) return { block: false, warn: true }
  return { block: false, warn: false }
}

/**
 * System RAM usage percentage from /proc/meminfo; false off-Linux or on failure (Go readMemUsedPct).
 * @returns The used-memory percentage and whether the reading succeeded.
 */
export function readMemUsedPct(): { pct: number; ok: boolean } {
  let data: string
  try {
    data = readFileSync('/proc/meminfo', 'utf8')
  } catch {
    return { pct: 0, ok: false }
  }
  let memTotal = 0
  let memAvailable = 0
  for (const line of data.split('\n')) {
    if (line.startsWith('MemTotal:')) {
      memTotal = Number.parseInt(line.replace(/[^0-9]/g, ''), 10) || 0
    } else if (line.startsWith('MemAvailable:')) {
      memAvailable = Number.parseInt(line.replace(/[^0-9]/g, ''), 10) || 0
    }
  }
  if (memTotal === 0) return { pct: 0, ok: false }
  return { pct: Math.floor(((memTotal - memAvailable) * 100) / memTotal), ok: true }
}

/** Run the RAM guard before /spawn //fork create a group (Go checkSpawnMemoryGuard). */
function checkSpawnMemoryGuard(e: Engine, p: Platform, replyCtx: unknown): boolean {
  const { pct, ok } = readMemUsedPct()
  if (!ok) return false
  const { block, warn } = evalSpawnMemoryGuard(pct, e.spawnMemWarnPct, e.spawnMemBlockPct)
  if (block) {
    void e.sendAsCard(p, replyCtx, e.i18n.tf(Msg.SpawnMemoryBlock, pct), { title: e.i18n.t(Msg.SpawnMemoryBlockTitle), color: 'red' })
    return true
  }
  if (warn) {
    void e.sendAsCard(p, replyCtx, e.i18n.tf(Msg.SpawnMemoryWarn, pct), { title: e.i18n.t(Msg.SpawnMemoryWarnTitle), color: 'orange' })
  }
  return false
}

/** Resolve the repo root and create an isolated worktree for a child (Go setupWorktree). */
async function setupWorktree(
  e: Engine, p: Platform, msg: Message, workDir: string, firstMsg: string, auto: boolean,
): Promise<{ path: string; branch: string; base: string; root: string } | undefined> {
  const root = await worktreeRepoRoot(workDir).catch(() => undefined)
  if (root === undefined) {
    if (!auto) void e.reply(p, msg.replyCtx, e.i18n.tf(Msg.WorktreeNotGit, workDir))
    return undefined
  }
  try {
    const created = await createWorktree(root, slugify(firstMsg))
    return { path: created.path, branch: created.branch, base: created.baseSHA, root }
  } catch (error) {
    if (!auto) {
      void e.reply(p, msg.replyCtx, e.i18n.tf(Msg.WorktreeCreateError, String(error instanceof Error ? error.message : error)))
    } else {
      console.warn(`spawn: auto worktree create failed; continuing without isolation (${workDir}): ${String(error)}`)
    }
    return undefined
  }
}

/**
 * /spawn: create a new group running a delegated task (Go cmdSpawn).
 * @param e - The engine owning spawn and session state.
 * @param p - The platform that must support group spawning.
 * @param msg - The triggering chat message.
 * @param args - The delegated task text, with optional --dir/-d, --worktree/-w, and --thread/-t flags.
 */
export async function cmdSpawn(e: Engine, p: Platform, msg: Message, args: string[]): Promise<void> {
  let threadFlag = false
  const noThread: string[] = []
  for (const a of args) {
    if (a === '--thread' || a === '-t') {
      threadFlag = true
      continue
    }
    noThread.push(a)
  }
  const [dirArg, afterDir] = extractDirFlag(noThread)
  const [flagWT, rest] = extractWorktreeFlag(afterDir)
  const bad = unknownFlag(rest, new Set())
  if (bad !== '') {
    void e.reply(p, msg.replyCtx, e.i18n.tf(Msg.SpawnUnknownFlag, bad))
    return
  }
  const firstMsg = rest.join(' ').trim()
  // TODO(M7): the quoted-plan spawn path (rolling the child back to the
  // plan-producing turn) arrives with the plan-card domain.
  const forkSentinelID = ''

  let groupName = `${e.name} 副本`
  // With LLM rename on the group is created under a neutral placeholder;
  // off, the first message names the group.
  if (firstMsg !== '' && !e.groupNameEnabled) groupName = firstMsg
  if (Array.from(groupName).length > maxGroupNameRunes) {
    groupName = `${Array.from(groupName).slice(0, maxGroupNameRunes - 3).join('')}...`
  }

  await spawnGroupCommon(e, p, msg, groupName, firstMsg, {
    dirArg,
    flagWT,
    spawnOpts: { topicGroup: threadFlag, workDir: '' },
    threadFlag,
    forkSentinelID,
    readyTitleKey: Msg.SpawnGroupReady,
  })
}

/**
 * /fork: create a group whose session forks the current chat's context (Go cmdFork).
 * @param e - The engine owning spawn and session state.
 * @param p - The platform that must support group spawning.
 * @param msg - The triggering chat message, whose chat must hold a forkable agent session.
 * @param args - The first message for the forked group, with optional --dir/-d and --worktree/-w flags.
 */
export async function cmdFork(e: Engine, p: Platform, msg: Message, args: string[]): Promise<void> {
  const [dirArg, afterDir] = extractDirFlag(args)
  const [flagWT, rest] = extractWorktreeFlag(afterDir)
  const bad = unknownFlag(rest, new Set())
  if (bad !== '') {
    void e.reply(p, msg.replyCtx, e.i18n.tf(Msg.ForkUnknownFlag, bad))
    return
  }
  const firstMsg = rest.join(' ').trim()

  const { agent, sessions } = commandContext(e, msg)
  const origID = sessions.getOrCreateActive(msg.sessionKey).getAgentSessionID()
  if (origID === '' || origID === ContinueSession || origID.startsWith(ForkSessionPrefix) || origID.startsWith(ForkAtSessionPrefix)) {
    void e.reply(p, msg.replyCtx, e.i18n.t(Msg.ForkNoContext))
    return
  }

  let groupName = `${e.name} 分支`
  if (firstMsg !== '' && !e.groupNameEnabled) groupName = firstMsg
  if (Array.from(groupName).length > maxGroupNameRunes) {
    groupName = `${Array.from(groupName).slice(0, maxGroupNameRunes - 3).join('')}...`
  }

  // Rollback fork: when the user replied to a historical message, truncate the
  // transcript to that turn and resume from the copy (Go cmdFork quoted
  // branch). Without a quote — or with --worktree, whose path is only known
  // inside spawnGroupCommon so the truncated copy cannot be placed ahead of
  // time — this stays a whole-session fork.
  let forkSentinelID = `${ForkSessionPrefix}${origID}`
  if (msg.parentMessageID !== '' && (msg.quotedUpdateTimeMs ?? 0) > 0 && !flagWT) {
    const prep = asForkAtPreparer(agent)
    if (prep === undefined) {
      void e.reply(p, msg.replyCtx, e.i18n.t(Msg.ForkAtNotSupported))
      return
    }
    // Resolve the source transcript's workDir from the per-chat override (set
    // by /dir), then the agent's workDir, then the engine base workDir (Go
    // parity; the shared agent slot would miss transcripts under an override).
    let parentWorkDir = e.perChatWorkDir(e.dirOverrideKey(msg.sessionKey))
    if (parentWorkDir === '') parentWorkDir = e.agentWorkDir()
    if (parentWorkDir === '') parentWorkDir = e.baseWorkDir
    let childWorkDir = parentWorkDir
    if (dirArg !== '') {
      const resolved = resolveDir(e, dirArg)
      if (resolved !== undefined) childWorkDir = resolved
    }
    try {
      const newID = await prep.prepareForkAtSession(
        origID, childWorkDir, msg.quotedText, msg.quotedSenderType ?? '', msg.quotedUpdateTimeMs ?? 0,
      )
      forkSentinelID = `${ForkAtSessionPrefix}${newID}`
    } catch (error) {
      console.warn(`fork-at: truncate failed (orig=${origID}): ${String(error instanceof Error ? error.message : error)}`)
      void e.reply(p, msg.replyCtx, e.i18n.t(Msg.ForkAtTruncateFailed))
      return
    }
  }

  await spawnGroupCommon(e, p, msg, groupName, firstMsg, {
    dirArg,
    flagWT,
    spawnOpts: { topicGroup: false, workDir: '' },
    threadFlag: false,
    forkSentinelID,
    readyTitleKey: Msg.ForkGroupReady,
  })
}

/** The /spawn //fork difference points (Go spawnCommonOpts). */
interface SpawnCommonOpts {
  dirArg: string
  flagWT: boolean
  spawnOpts: GroupSpawnOptions
  threadFlag: boolean
  forkSentinelID: string
  readyTitleKey: Parameters<Engine['i18n']['t']>[0]
}

/**
 * The shared /spawn //fork group-creation skeleton: spawner assertion →
 * memory guard → workdir resolution (per-chat override → agent base → --dir
 * → worktree) → group creation → per-chat override persistence → child
 * Session metadata → reaction → notify card → first-message injection (Go
 * spawnGroupCommon).
 */
async function spawnGroupCommon(
  e: Engine, p: Platform, msg: Message, groupName: string, firstMsg: string, opts: SpawnCommonOpts,
): Promise<void> {
  const spawner = asGroupSpawner(p)
  if (spawner === undefined) {
    void e.reply(p, msg.replyCtx, e.i18n.t(Msg.SpawnNotSupported))
    return
  }
  if (checkSpawnMemoryGuard(e, p, msg.replyCtx)) return

  const spawnOpts: GroupSpawnOptions = { ...opts.spawnOpts }
  let wtPath = ''
  let wtBranch = ''
  let wtBase = ''
  let wtRoot = ''
  {
    let workDir = ''
    const override = e.perChatWorkDir(e.dirOverrideKey(msg.sessionKey))
    if (override !== '') workDir = override
    else workDir = e.agentWorkDir()
    if (opts.dirArg !== '') {
      const resolved = resolveDir(e, opts.dirArg)
      if (resolved === undefined) {
        void e.reply(p, msg.replyCtx, e.i18n.tf(Msg.SpawnDirError, opts.dirArg))
        return
      }
      workDir = resolved
    }
    // Create an isolated git worktree before the group exists (fail fast to
    // avoid orphan groups), then point the child's work dir at it.
    const { use, auto } = resolveWorktreeUse(e.spawnWorktree, opts.flagWT)
    if (use || auto) {
      const wt = await setupWorktree(e, p, msg, workDir, firstMsg, auto)
      if (wt !== undefined) {
        wtPath = wt.path
        wtBranch = wt.branch
        wtBase = wt.base
        wtRoot = wt.root
        workDir = wt.path
      } else if (!auto) {
        return
      }
    }
    spawnOpts.workDir = workDir
  }

  const spawnMsg: Message = msg
  const spawnerEx = asGroupSpawnerEx(p)
  let syntheticMsg: Message | undefined
  try {
    syntheticMsg = spawnerEx !== undefined
      ? await spawnerEx.spawnGroupWithOptions(spawnMsg, groupName, firstMsg, spawnOpts)
      : await spawner.spawnGroup(spawnMsg, groupName, firstMsg)
  } catch (error) {
    void e.reply(p, msg.replyCtx, e.i18n.tf(Msg.SpawnError, String(error instanceof Error ? error.message : error)))
    return
  }

  // Persist the resolved work_dir as the spawned chat's per-chat override so
  // dir resolution and tag resolution cannot drift apart.
  if (spawnOpts.workDir !== '' && e.projectState !== undefined) {
    e.projectState.setWorkspaceDirOverride(e.dirOverrideKey(syntheticMsg.sessionKey), spawnOpts.workDir)
    e.projectState.save()
  }

  // Record the originating session so the child can push its result back on
  // /done --reply; /fork additionally seeds the fork sentinel.
  {
    const ns = e.sessions.getOrCreateActive(syntheticMsg.sessionKey)
    if (opts.forkSentinelID !== '') ns.setAgentSessionID(opts.forkSentinelID, e.agent.name())
    ns.setParentSessionKey(msg.sessionKey)
    ns.setParentChatName(effectiveParentLabel(e, p, msg))
    ns.setName(groupName)
    if (msg.userID !== '') ns.setSpawnUserID(msg.userID)
    if (wtPath !== '') ns.setWorktreeInfo(wtPath, wtBranch, wtBase, wtRoot)
    // Inherit the parent's current effective permission mode so the child
    // doesn't reset to the configured plan and re-prompt for an ExitPlanMode
    // the parent already approved.
    ns.setInheritedMode(parentEffectiveMode(e, msg.sessionKey))
    e.sessions.save()
  }

  e.addReaction(p, msg.replyCtx, 'Done')

  // Notification card for both paths (with and without user message).
  {
    const jumpMD = parentJumpButtonsFor(e, msg)
    const readyTitle = e.i18n.t(opts.readyTitleKey)
    // Zero the per-turn usage first so the parent chat's last-turn
    // duration/rate don't bleed onto the child's readiness card (Go
    // buildCompletionUsage(0) before the card, engine_cmd_session.go).
    await e.buildCompletionUsage({
      totalInputTokens: 0, sdkPlausible: false, selfPct: 0,
      nonCachedDelta: 0, nonCachedCum: 0, cachedDelta: 0, cachedCum: 0,
      numTurns: 0, compactionCount: 0,
    })
    try {
      const card = await e.buildSpawnNotifyCard(spawnOpts.workDir, readyTitle, threadNote(opts.threadFlag), jumpMD, syntheticMsg.sessionKey)
      await e.replyWithCard(p, syntheticMsg.replyCtx, card)
    } catch (error) {
      console.warn(`spawn: card send failed (${p.name()}): ${String(error)}`)
    }
  }

  if (firstMsg !== '') {
    // The synthetic first message never went through platform dispatch, so
    // mark it here — otherwise the first-message rename and pin panel never
    // fire for spawned groups.
    syntheticMsg.isSpawnedGroup = true
    e.receiveMessage(p, syntheticMsg)
  }
}

/** Extra note for topic groups (Go spawnGroupCommon threadFlag branch). */
function threadNote(threadFlag: boolean): string {
  if (!threadFlag) return ''
  return '在此群中每个话题自动拥有独立的会话，直接发消息即可开始。'
}

/** The parent chat's display name for jump buttons (Go effectiveParentLabel). */
function effectiveParentLabel(e: Engine, p: Platform, msg: Message): string {
  if (msg.chatType === 'p2p') {
    const bi = p as { botDisplayName?: () => string }
    if (typeof bi.botDisplayName === 'function') {
      const n = bi.botDisplayName().trim()
      if (n !== '') return n
    }
    return e.name
  }
  return msg.chatName
}

/** Parent's current effective permission mode, '' with no live state (Go parentEffectiveMode). */
function parentEffectiveMode(e: Engine, sessionKey: string): string {
  const state = e.interactiveStates.get(sessionKey)
  if (state === undefined) return ''
  return state.effectiveMode
}

/** Parent-jump markdown line for the spawn notify card. */
function parentJumpButtonsFor(e: Engine, msg: Message): { content: string; ok: boolean } {
  const pcid = extractChannelID(msg.sessionKey)
  if (pcid === '') return { content: '', ok: false }
  const url = e.chatJumpURL(msg.platform === '' ? undefined : e.platforms.find(pl => pl.name() === msg.platform), pcid)
  if (url === '') return { content: '', ok: false }
  return { content: `[↩ ${effectiveParentLabel(e, e.platforms[0] as Platform, msg)}](${url})`, ok: true }
}

/**
 * /done: tear down a spawned group, optionally reporting to its parent (Go cmdDone).
 * @param e - The engine owning the spawned-chat subtree.
 * @param p - The platform that must support avatar-state switching.
 * @param msg - The triggering chat message, which must come from a spawned group.
 * @param args - Optional --reply/-r to push this chat's last result to its parent before teardown.
 */
export function cmdDone(e: Engine, p: Platform, msg: Message, args: string[]): void {
  const bad = unknownFlag(args, new Set(['-r', '--reply']))
  if (bad !== '') {
    void e.reply(p, msg.replyCtx, e.i18n.tf(Msg.DoneUnknownFlag, bad))
    return
  }
  const replyToParentFlag = hasFlag(args, '--reply', '-r')

  // /done only makes sense in a spawned group; in a private chat it would
  // recursively tear down the whole spawn subtree rooted here.
  if (msg.chatType === 'p2p') {
    void e.reply(p, msg.replyCtx, e.i18n.t(Msg.DonePrivateNotAllowed))
    return
  }

  if (asChatAvatarStateSwitcher(p) === undefined) {
    void e.reply(p, msg.replyCtx, e.i18n.t(Msg.DoneNotSupported))
    return
  }

  // --reply: push this chat's last result to its parent before teardown.
  if (replyToParentFlag) {
    const sess = e.sessions.getOrCreateActive(msg.sessionKey)
    if (sess.getParentSessionKey() === '') {
      void e.reply(p, msg.replyCtx, e.i18n.t(Msg.DoneReplyNoParent))
    } else {
      e.replyToParent(p, sess, sess.lastResultOrReply())
    }
  }

  e.addReaction(p, msg.replyCtx, 'Done')

  // Recursively tear down descendant subtask groups (deepest first), then
  // this chat; git/worktree ops can be slow → run in the background.
  const descendants = e.collectSubtree(msg.sessionKey)
  const rootKey = msg.sessionKey
  const rootCtx = msg.replyCtx
  void (async () => {
    const dirtyLines: string[] = []
    for (const childKey of descendants) {
      const { name, dirty } = await cleanupOneChat(e, p, childKey, undefined, true)
      if (!dirty) continue
      const url = e.chatJumpURL(p, extractChannelID(childKey))
      dirtyLines.push(url !== '' ? `- [${name}](${url})` : `- ${name}`)
    }
    // Clean this chat last. As the chat the user is in, a dirty worktree
    // here shows the interactive Keep/Remove card.
    await cleanupOneChat(e, p, rootKey, rootCtx, false)

    if (descendants.length > 0) {
      void e.reply(p, rootCtx, e.i18n.tf(Msg.DoneRecursiveSummary, descendants.length))
    }
    if (dirtyLines.length > 0) {
      void e.reply(p, rootCtx, e.i18n.tf(Msg.DoneDirtyChildren, dirtyLines.join('\n')))
    }
  })()
}

/**
 * Tear down one chat's subtask state: stop its agent session, dim the
 * avatar, mark the spawned chat done, and handle its worktree (Go
 * cleanupOneChat). asChild=true skips a dirty worktree (the caller
 * summarizes) instead of showing the interactive card.
 * @param e - The engine owning the chat's session and interactive state.
 * @param p - The platform the chat lives on.
 * @param sessionKey - The chat's session key.
 * @param replyCtx - Reply context for the interactive Keep/Remove card; reconstructed from the platform when undefined.
 * @param asChild - Whether this is a descendant teardown, which skips the dirty-worktree card.
 * @returns The chat's display name and whether its worktree was left dirty.
 */
export async function cleanupOneChat(
  e: Engine, p: Platform, sessionKey: string, replyCtx: unknown, asChild: boolean,
): Promise<{ name: string; dirty: boolean }> {
  const sess = e.sessions.getOrCreateActive(sessionKey)
  const name = childLabel(sess)

  let ctx = replyCtx
  if (ctx === undefined || ctx === null) {
    const r = asReplyContextReconstructor(p)
    if (r !== undefined) {
      try {
        ctx = await r.reconstructReplyCtx(sessionKey)
      } catch {
        ctx = undefined
      }
    }
  }

  e.stopInteractiveSession(sessionKey)

  // /done dims the avatar and marks the chat inactive; the heart tag is
  // untouched — tagging is the independent /tag-/untag axis.
  const switcher = asChatAvatarStateSwitcher(p)
  if (switcher !== undefined) {
    try {
      await switcher.setChatAvatarActive(sessionKey, false)
    } catch (error) {
      console.warn(`done: dim avatar failed (${sessionKey}): ${String(error)}`)
    }
  }
  e.markSpawnedChatDone(p, sessionKey)

  const [path, , base] = sess.getWorktreeInfo()
  if (path === '') return { name, dirty: false }
  let dirty: boolean
  try {
    dirty = await worktreeDirty(path, base)
  } catch (derr) {
    const errMsg = String(derr instanceof Error ? derr.message : derr)
    if (worktreeGone(errMsg)) {
      // Stale metadata only — clear it and report clean so callers don't
      // falsely announce a Keep/Remove card.
      await e.finishWorktreeRemoval(p, ctx, sessionKey, true)
      return { name, dirty: false }
    }
    // Genuine uncertainty (permissions, corrupt repo): preserve and warn.
    console.warn(`done: worktree dirty check failed; preserving (${sessionKey}): ${errMsg}`)
    return { name, dirty: true }
  }
  if (dirty) {
    if (asChild) return { name, dirty: true } // skip; caller summarizes
    await e.replyWithCard(p, ctx, e.renderWorktreeCard(sessionKey))
    return { name, dirty: true }
  }
  await e.finishWorktreeRemoval(p, ctx, sessionKey, false)
  return { name, dirty: false }
}

/**
 * /rename: rename the current spawned sub-group. With a name argument it
 * sets that name directly (and marks the manual rename so the async
 * first-message LLM rename cannot clobber it); with no argument it
 * regenerates a name from the full conversation history via
 * LightweightQuery — the same engine as #49's first-message naming, but
 * seeded with the whole talk instead of just message one, so the name can
 * catch up as the task becomes clearer. No-op outside spawned groups (Go
 * cmdRename).
 * @param e - The engine owning the group-name generation.
 * @param p - The platform that must support group renaming.
 * @param msg - The triggering chat message, which must come from a spawned group.
 * @param args - The new name; empty regenerates a name from the conversation history.
 */
export async function cmdRename(e: Engine, p: Platform, msg: Message, args: string[]): Promise<void> {
  if (!msg.isSpawnedGroup) {
    void e.reply(p, msg.replyCtx, e.i18n.t(Msg.RenameSpawnedOnly))
    return
  }
  const renamer = asGroupRenamer(p)
  if (renamer === undefined) {
    void e.reply(p, msg.replyCtx, e.i18n.t(Msg.RenameNotSupported))
    return
  }

  // /rename <name...> → set directly, skipping the LLM. This is also the
  // fallback path for backends without LightweightQuery.
  const direct = sanitizeGroupName(args.join(' '))
  if (direct !== '') {
    try {
      await renamer.renameGroup(msg.sessionKey, direct)
    } catch (error) {
      void e.reply(p, msg.replyCtx, e.i18n.tf(Msg.RenameError, String(error)))
      return
    }
    // 手动改名成功：标记该群名由用户指定。首条消息异步 LLM 改名
    // （handleGroupNameGenerate 回调）会检查该标记并在命中时跳过，
    // 避免覆盖用户手动起的群名。
    e.markPendingRename(msg.sessionKey)
    void e.reply(p, msg.replyCtx, e.i18n.tf(Msg.RenameDone, direct))
    return
  }

  // /rename (no args) → regenerate from the full conversation history.
  const sess = e.sessions.getOrCreateActive(msg.sessionKey)
  const history = sess.getHistory(0)
  if (history.length === 0) {
    void e.reply(p, msg.replyCtx, e.i18n.t(Msg.RenameNoHistory))
    return
  }
  const current = sess.getName()
  const timeout = e.groupNameTimeout > 0 ? e.groupNameTimeout : 30_000
  const replyCtx = msg.replyCtx
  const sessionKey = msg.sessionKey
  void (async () => {
    try {
      const [generated, icon] = await e.generateGroupName(
        buildCompactContext(history),
        AbortSignal.timeout(timeout),
      )
      if (generated === '') {
        void e.reply(p, replyCtx, e.i18n.t(Msg.RenameFailed))
        return
      }
      const nameUnchanged = generated.trim().toLowerCase() === current.trim().toLowerCase()
      if (!nameUnchanged) {
        try {
          await renamer.renameGroup(sessionKey, generated)
        } catch (error) {
          void e.reply(p, replyCtx, e.i18n.tf(Msg.RenameError, String(error)))
          return
        }
      }
      // 头像刷新独立于改名：即使群名未变也重设头像（用户可能只为换图标而 /rename）。
      if (e.groupNameSetAvatar && icon !== '') {
        const setter = asGroupIconAvatarSetter(p)
        if (setter !== undefined) {
          try {
            await setter.setGroupIconAvatar(sessionKey, icon, generated)
            e.recordGroupIcon(icon)
          } catch (error) {
            console.warn(`rename: set icon avatar failed (${icon}): ${String(error)}`)
          }
        }
      }
      if (nameUnchanged) {
        void e.reply(p, replyCtx, e.i18n.t(Msg.RenameUnchanged))
      } else {
        void e.reply(p, replyCtx, e.i18n.tf(Msg.RenameDone, generated))
      }
    } catch {
      // Backend lacks ForkQuerierWithProvider → tell the user how to recover.
      void e.reply(p, replyCtx, e.i18n.t(Msg.RenameBackendNotSupported))
    }
  })()
}
