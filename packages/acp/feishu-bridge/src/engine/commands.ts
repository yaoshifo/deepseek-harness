/**
 * Session-lifecycle commands ported from cc-connect core/engine_cmd_session.go
 * and the /dir machinery in engine_cmd_workspace.go: /new /stop /sessions
 * (/list) /switch /status /dir (+/cd alias), plain-text surface only — the
 * card renderers arrive with M2's card system.
 *
 * @module dsh-feishu-bridge/commands
 */

import { statSync } from 'node:fs'
import { join } from 'node:path'
import {
  MsgAdminRequired,
  MsgDisabledShort,
  MsgEnabledShort,
  MsgDirChanged,
  MsgDirCurrent,
  MsgDirHistoryHint,
  MsgDirHistoryTitle,
  MsgDirInvalidIndex,
  MsgDirInvalidPath,
  MsgDirNoHistory,
  MsgDirNoPrevious,
  MsgDirNotSupported,
  MsgDirReset,
  MsgDirSessionReset,
  MsgDirUsage,
  MsgExecutionStopped,
  MsgListEmpty,
  MsgListError,
  MsgListPageHint,
  MsgListSwitchHint,
  MsgListTitle,
  MsgListTitlePaged,
  MsgNewSessionCreated,
  MsgNewSessionCreatedName,
  MsgNoExecution,
  MsgStatusAgentSID,
  MsgStatusSession,
  MsgStatusSessionKey,
  MsgStatusTitle,
  MsgStatusUserID,
  MsgSwitchNoMatch,
  MsgSwitchSuccess,
} from '../i18n/index.js'
import type { AgentSessionInfo, Message, Platform } from '../core/types.js'
import type { Engine } from './engine.js'
import type { SessionManager } from './session.js'
import { extractChannelID } from './engine.js'

const listPageSize = 5

/** Command IDs gated behind admin_from (Go privilegedCommands, M1 subset). */
const privilegedCommands = new Set(['dir'])

/** Canonical command names and their aliases (Go builtinCommands subset). */
export const builtinCommands: Array<{ names: string[]; id: string }> = [
  { names: ['new'], id: 'new' },
  { names: ['list', 'sessions'], id: 'list' },
  { names: ['switch', 'resume'], id: 'switch' },
  { names: ['status'], id: 'status' },
  { names: ['stop'], id: 'stop' },
  { names: ['dir', 'cd'], id: 'dir' },
]

/** Resolve a typed command prefix to its canonical ID ('' when unknown). */
export function matchPrefix(cmd: string): string {
  for (const entry of builtinCommands) {
    if (entry.names.some(n => n === cmd || (n.startsWith(cmd) && cmd.length >= 2))) return entry.id
  }
  return ''
}

/**
 * Register the M1 session commands on an engine (replaces Go's compile-time
 * dispatch table). Returns the disposer.
 */
export function registerSessionCommands(e: Engine): () => void {
  const handlers: Map<string, (p: Platform, msg: Message, args: string[]) => boolean> = new Map([
    ['new', (p, msg, args) => { void cmdNew(e, p, msg, args); return true }],
    ['list', (p, msg, args) => { void cmdList(e, p, msg, args); return true }],
    ['switch', (p, msg, args) => { void cmdSwitch(e, p, msg, args); return true }],
    ['status', (p, msg) => { void cmdStatus(e, p, msg); return true }],
    ['stop', (p, msg) => {
      if (cmdStop(e, p, msg)) {
        void e.reply(p, msg.replyCtx, e.i18n.t(MsgExecutionStopped))
      } else {
        void e.reply(p, msg.replyCtx, e.i18n.t(MsgNoExecution))
      }
      return true
    }],
    ['dir', (p, msg, args) => { void cmdDir(e, p, msg, args); return true }],
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

/** /new: stop the current interactive session and start a fresh one. */
export async function cmdNew(e: Engine, p: Platform, msg: Message, args: string[]): Promise<void> {
  const { sessions } = commandContext(e, msg)
  const old = sessions.getOrCreateActive(msg.sessionKey)

  e.stopInteractiveSession(msg.sessionKey)

  old.setAgentSessionID('', '')
  old.clearHistory()
  sessions.save()

  const name = args.length > 0 ? args.join(' ') : ''
  sessions.newSession(msg.sessionKey, name)

  const prefix = name === ''
    ? e.i18n.t(MsgNewSessionCreated)
    : e.i18n.tf(MsgNewSessionCreatedName, name)
  await e.reply(p, msg.replyCtx, prefix)
}

/** The engine-facing session/agent context for commands (M1: single workspace). */
function commandContext(e: Engine, _msg: Message): { agent: Engine['agent']; sessions: SessionManager; interactiveKey: string } {
  return { agent: e.agent, sessions: e.sessions, interactiveKey: _msg.sessionKey }
}

/** /list (/sessions): enumerate agent sessions, plain-text surface. */
export async function cmdList(e: Engine, p: Platform, msg: Message, args?: string[]): Promise<void> {
  const argList = args ?? []
  const { agent, sessions } = commandContext(e, msg)
  let agentSessions: AgentSessionInfo[]
  try {
    agentSessions = await agent.listSessions()
  } catch (error) {
    await e.reply(p, msg.replyCtx, e.i18n.tf(MsgListError, String(error)))
    return
  }
  agentSessions = applySessionFilter(e, agentSessions, sessions)
  enrichSessionSummaries(sessions, agentSessions)
  if (agentSessions.length === 0) {
    await e.reply(p, msg.replyCtx, e.i18n.t(MsgListEmpty))
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
    sb += e.i18n.tf(MsgListTitlePaged, agentName, total, page, totalPages)
  } else {
    sb += e.i18n.tf(MsgListTitle, agentName, total)
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
  if (totalPages > 1) sb += e.i18n.tf(MsgListPageHint, page, totalPages)
  sb += e.i18n.t(MsgListSwitchHint)
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

/** /switch (/resume): switch the chat to another agent session. */
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
    await e.reply(p, msg.replyCtx, e.i18n.tf(MsgSwitchNoMatch, query))
    return
  }

  e.stopInteractiveSession(interactiveKey)
  const session = sessions.switchToAgentSession(msg.sessionKey, matched.id, agent.name(), matched.summary)
  session.clearHistory()

  let shortID = matched.id
  if (shortID.length > 12) shortID = shortID.slice(0, 12)
  let displayName = sessions.getSessionName(matched.id)
  if (displayName === '') displayName = matched.summary
  await e.reply(p, msg.replyCtx, e.i18n.tf(MsgSwitchSuccess, displayName, shortID, matched.messageCount))
  // TODO(M7): resendLastAssistantMessage via HistoryProvider for context echo.
}

/**
 * Resolve a user query to an agent session: numeric index, exact name, ID
 * prefix, name prefix, then summary substring (Go matchSession).
 */
export function matchSession(sessions: AgentSessionInfo[], manager: SessionManager, query: string): AgentSessionInfo | undefined {
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

/** /status: project/agent/session summary, plain text. */
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
  const thinkingStr = e.display.thinkingMessages ? e.i18n.t(MsgEnabledShort) : e.i18n.t(MsgDisabledShort)
  const toolStr = e.display.toolMessages ? e.i18n.t(MsgEnabledShort) : e.i18n.t(MsgDisabledShort)
  modeStr += e.i18n.tf('status_thinking_messages', thinkingStr)
  modeStr += e.i18n.tf('status_tool_messages', toolStr)

  const s = sessions.getOrCreateActive(msg.sessionKey)
  let sessionDisplayName = sessions.getSessionName(s.getAgentSessionID())
  if (sessionDisplayName === '') sessionDisplayName = s.getName()
  const sessionStr = e.i18n.tf(MsgStatusSession, sessionDisplayName, s.getHistory(0).length)
  const sessionKeyStr = e.i18n.tf(MsgStatusSessionKey, msg.sessionKey)
  let agentSIDStr = ''
  const agentSID = s.getAgentSessionID()
  if (agentSID !== '') agentSIDStr = e.i18n.tf(MsgStatusAgentSID, agentSID)
  let userIDStr = ''
  if (msg.userID !== '') userIDStr = e.i18n.tf(MsgStatusUserID, msg.userID)

  await e.reply(p, msg.replyCtx, e.i18n.tf(MsgStatusTitle,
    e.name, agent.name(), workDirStr, platformStr, uptimeStr, langStr,
    modeStr, sessionStr, '', sessionKeyStr, agentSIDStr, userIDStr, ''))
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

/** /stop: stop the running turn (Go cmdStop). */
export function cmdStop(e: Engine, _p: Platform, msg: Message): boolean {
  return e.stopInteractiveSession(msg.sessionKey)
}

/** /dir: show or switch the agent's working directory (Go cmdDir, text path). */
export async function cmdDir(e: Engine, p: Platform, msg: Message, args: string[]): Promise<void> {
  const { agent, sessions, interactiveKey } = commandContext(e, msg)
  const switcher = agent as { getWorkDir?: () => string } | undefined
  if (switcher === undefined || typeof switcher.getWorkDir !== 'function') {
    await e.reply(p, msg.replyCtx, e.i18n.t(MsgDirNotSupported))
    return
  }

  let currentDir = switcher.getWorkDir()
  const override = e.perChatWorkDir(e.dirOverrideKey(interactiveKey))
  if (override !== '') currentDir = override

  if (args.length === 0) {
    let sb = e.i18n.tf(MsgDirCurrent, currentDir)
    if (e.dirHistory !== undefined) {
      const history = e.dirHistory.list(e.name)
      if (history.length > 0) {
        sb += '\n\n'
        sb += e.i18n.t(MsgDirHistoryTitle)
        for (let i = 0; i < history.length; i++) {
          const dir = history[i]
          if (dir === undefined) continue
          const marker = dir === currentDir ? '▶' : '◻'
          sb += `\n  ${marker} ${i + 1}. ${dir}`
        }
        sb += '\n\n'
        sb += e.i18n.t(MsgDirHistoryHint)
      }
    }
    await e.reply(p, msg.replyCtx, sb)
    return
  }

  if (args.length === 1) {
    const first = (args[0] ?? '').trim().toLowerCase()
    if (first === 'help' || first === '-h' || first === '--help') {
      await e.reply(p, msg.replyCtx, e.i18n.t(MsgDirUsage))
      return
    }
  }

  const [errMsg, successMsg] = await dirApply(e, agent, sessions, interactiveKey, msg.sessionKey, args)
  if (errMsg !== '') {
    await e.reply(p, msg.replyCtx, errMsg)
    return
  }
  await e.reply(p, msg.replyCtx, `${successMsg}\n\n${e.i18n.t(MsgDirSessionReset)}`)
}

/** Apply a directory switch (Go dirApply, M1: single-workspace keying). */
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
    return [e.i18n.t(MsgDirNotSupported), '']
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
    return ['', e.i18n.tf(MsgDirReset, baseDir)]
  }

  const arg = args.join(' ')
  let newDir: string

  const idx = Number.parseInt(arg.trim(), 10)
  if (Number.isInteger(idx) && String(idx) === arg.trim() && idx > 0) {
    if (e.dirHistory !== undefined) {
      newDir = e.dirHistory.get(e.name, idx)
      if (newDir === '') return [e.i18n.tf(MsgDirInvalidIndex, idx), '']
    } else {
      return [e.i18n.t(MsgDirNoHistory), '']
    }
  } else if (arg === '-') {
    if (e.dirHistory !== undefined) {
      newDir = e.dirHistory.previous(e.name)
      if (newDir === '') return [e.i18n.t(MsgDirNoPrevious), '']
    } else {
      return [e.i18n.t(MsgDirNoHistory), '']
    }
  } else {
    const resolved = resolveDir(e, arg)
    if (resolved === undefined) return [e.i18n.tf(MsgDirInvalidPath, arg), '']
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
  return ['', e.i18n.tf(MsgDirChanged, newDir)]
}

/** Resolve a user-supplied dir argument (tilde expansion + scan paths + stat). */
function resolveDir(e: Engine, arg: string): string | undefined {
  let newDir = expandTilde(arg.trim())
  if (!newDir.startsWith('/')) {
    const hit = e.dirHistory?.resolveScanPath(e.name, newDir)
    if (hit === undefined) return undefined
    newDir = hit
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

/** Whether the message's user may run privileged commands (Go isAdmin). */
export function isAdmin(e: Engine, userID: string): boolean {
  const adminFrom = e.adminFrom.trim()
  if (adminFrom === '' || userID === '') return false
  if (adminFrom === '*') return true
  return adminFrom.split(',').some(id => id.trim().toLowerCase() === userID.toLowerCase())
}

/** Privileged-command gate used by the engine's dispatchCommand. */
export function gatePrivilegedCommand(e: Engine, cmdID: string, p: Platform, msg: Message): boolean {
  if (!privilegedCommands.has(cmdID)) return false
  if (isAdmin(e, msg.userID)) return false
  void e.reply(p, msg.replyCtx, e.i18n.tf(MsgAdminRequired, `/${cmdID}`))
  return true
}

/** Channel ID helper re-exported for tests (Go extractChannelID). */
export { extractChannelID }
