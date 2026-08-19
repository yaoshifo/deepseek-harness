/**
 * Session-lifecycle commands ported from cc-connect core/engine_cmd_session.go
 * and the /dir machinery in engine_cmd_workspace.go: /new /stop /sessions
 * (/list) /switch /status /dir (+/cd alias), plus the M4 spawn family
 * (/spawn /sp, /fork /fk, /done --reply). Plain-text surface only — the
 * card renderers arrive with M2's card system.
 *
 * @module dsh-feishu-bridge/commands
 */

import { readFileSync } from 'node:fs'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import {
  MsgAdminRequired,
  MsgDisabledShort,
  MsgDoneDirtyChildren,
  MsgDonePrivateNotAllowed,
  MsgDoneRecursiveSummary,
  MsgDoneReplyNoParent,
  MsgDoneUnknownFlag,
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
  MsgDoneNotSupported,
  MsgExecutionStopped,
  MsgForkGroupReady,
  MsgForkNoContext,
  MsgForkUnknownFlag,
  MsgListEmpty,
  MsgListError,
  MsgListPageHint,
  MsgListSwitchHint,
  MsgListTitle,
  MsgListTitlePaged,
  MsgNewSessionCreated,
  MsgNewSessionCreatedName,
  MsgNoExecution,
  MsgSpawnDirError,
  MsgSpawnError,
  MsgSpawnNotSupported,
  MsgSpawnMemoryBlock,
  MsgSpawnMemoryBlockTitle,
  MsgSpawnMemoryWarn,
  MsgSpawnMemoryWarnTitle,
  MsgSpawnGroupReady,
  MsgSpawnUnknownFlag,
  MsgStatusAgentSID,
  MsgStatusSession,
  MsgStatusSessionKey,
  MsgStatusTitle,
  MsgStatusUserID,
  MsgSwitchNoMatch,
  MsgSwitchSuccess,
  MsgWorktreeCreateError,
  MsgWorktreeNotGit,
} from '../i18n/index.js'
import type { AgentSessionInfo, Message, Platform } from '../core/types.js'
import { asChatAvatarStateSwitcher, asGroupSpawner, asGroupSpawnerEx, asReplyContextReconstructor, ContinueSession, ForkAtSessionPrefix, ForkSessionPrefix, type GroupSpawnOptions } from '../core/types.js'
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
import { maxGroupNameRunes } from './groupname.js'
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
  { names: ['spawn', 'sp'], id: 'spawn' },
  { names: ['fork', 'fk'], id: 'fork' },
  { names: ['done'], id: 'done' },
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
    ['spawn', (p, msg, args) => { void cmdSpawn(e, p, msg, args); return true }],
    ['fork', (p, msg, args) => { void cmdFork(e, p, msg, args); return true }],
    ['done', (p, msg, args) => { cmdDone(e, p, msg, args); return true }],
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
/** Name-lookup surface matchSession needs from a session manager. */
export type SessionNameLookup = Pick<SessionManager, 'getSessionName'>

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
  // A user stop disarms the subtask one-shot auto-report — after the user
  // takes over, later turns must not auto-report to the parent.
  e.suppressSubtaskAutoReport(msg.sessionKey)
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

// ── M4: /spawn /fork /done (Go engine_cmd_session.go) ─────────────────────

/**
 * Pull a --dir/-d <path> option out of args: returns the path ('' if
 * absent) and the remaining args (Go extractDirFlag).
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

/** Strip a boolean --worktree / -w flag from args (Go extractWorktreeFlag). */
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
 */
export function evalSpawnMemoryGuard(ramPct: number, warnPct: number, blockPct: number): { block: boolean; warn: boolean } {
  if (blockPct > 0 && ramPct >= blockPct) return { block: true, warn: false }
  if (warnPct > 0 && ramPct >= warnPct) return { block: false, warn: true }
  return { block: false, warn: false }
}

/** System RAM usage percentage from /proc/meminfo; false off-Linux or on failure (Go readMemUsedPct). */
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
    void e.sendAsCard(p, replyCtx, e.i18n.tf(MsgSpawnMemoryBlock, pct), { title: e.i18n.t(MsgSpawnMemoryBlockTitle), color: 'red' })
    return true
  }
  if (warn) {
    void e.sendAsCard(p, replyCtx, e.i18n.tf(MsgSpawnMemoryWarn, pct), { title: e.i18n.t(MsgSpawnMemoryWarnTitle), color: 'orange' })
  }
  return false
}

/** Resolve the repo root and create an isolated worktree for a child (Go setupWorktree). */
async function setupWorktree(
  e: Engine, p: Platform, msg: Message, workDir: string, firstMsg: string, auto: boolean,
): Promise<{ path: string; branch: string; base: string; root: string } | undefined> {
  const root = await worktreeRepoRoot(workDir).catch(() => undefined)
  if (root === undefined) {
    if (!auto) void e.reply(p, msg.replyCtx, e.i18n.tf(MsgWorktreeNotGit, workDir))
    return undefined
  }
  try {
    const created = await createWorktree(root, slugify(firstMsg))
    return { path: created.path, branch: created.branch, base: created.baseSHA, root }
  } catch (error) {
    if (!auto) {
      void e.reply(p, msg.replyCtx, e.i18n.tf(MsgWorktreeCreateError, String(error instanceof Error ? error.message : error)))
    } else {
      console.warn(`spawn: auto worktree create failed; continuing without isolation (${workDir}): ${String(error)}`)
    }
    return undefined
  }
}

/** /spawn: create a new group running a delegated task (Go cmdSpawn). */
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
    void e.reply(p, msg.replyCtx, e.i18n.tf(MsgSpawnUnknownFlag, bad))
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
    readyTitleKey: MsgSpawnGroupReady,
  })
}

/** /fork: create a group whose session forks the current chat's context (Go cmdFork). */
export async function cmdFork(e: Engine, p: Platform, msg: Message, args: string[]): Promise<void> {
  const [dirArg, afterDir] = extractDirFlag(args)
  const [flagWT, rest] = extractWorktreeFlag(afterDir)
  const bad = unknownFlag(rest, new Set())
  if (bad !== '') {
    void e.reply(p, msg.replyCtx, e.i18n.tf(MsgForkUnknownFlag, bad))
    return
  }
  const firstMsg = rest.join(' ').trim()

  const { sessions } = commandContext(e, msg)
  const origID = sessions.getOrCreateActive(msg.sessionKey).getAgentSessionID()
  if (origID === '' || origID === ContinueSession || origID.startsWith(ForkSessionPrefix) || origID.startsWith(ForkAtSessionPrefix)) {
    void e.reply(p, msg.replyCtx, e.i18n.t(MsgForkNoContext))
    return
  }

  let groupName = `${e.name} 分支`
  if (firstMsg !== '' && !e.groupNameEnabled) groupName = firstMsg
  if (Array.from(groupName).length > maxGroupNameRunes) {
    groupName = `${Array.from(groupName).slice(0, maxGroupNameRunes - 3).join('')}...`
  }

  // TODO(M7): the quoted-message rollback fork (PrepareForkAtSession)
  // arrives with the fork-at domain.
  const forkSentinelID = `${ForkSessionPrefix}${origID}`

  await spawnGroupCommon(e, p, msg, groupName, firstMsg, {
    dirArg,
    flagWT,
    spawnOpts: { topicGroup: false, workDir: '' },
    threadFlag: false,
    forkSentinelID,
    readyTitleKey: MsgForkGroupReady,
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
    void e.reply(p, msg.replyCtx, e.i18n.t(MsgSpawnNotSupported))
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
        void e.reply(p, msg.replyCtx, e.i18n.tf(MsgSpawnDirError, opts.dirArg))
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
    void e.reply(p, msg.replyCtx, e.i18n.tf(MsgSpawnError, String(error instanceof Error ? error.message : error)))
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
    const card = e.buildSpawnNotifyCard(spawnOpts.workDir, e.i18n.t(opts.readyTitleKey), threadNote(opts.threadFlag), jumpMD)
    void e.replyWithCard(p, syntheticMsg.replyCtx, card)
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

/** /done: tear down a spawned group, optionally reporting to its parent (Go cmdDone). */
export function cmdDone(e: Engine, p: Platform, msg: Message, args: string[]): void {
  const bad = unknownFlag(args, new Set(['-r', '--reply']))
  if (bad !== '') {
    void e.reply(p, msg.replyCtx, e.i18n.tf(MsgDoneUnknownFlag, bad))
    return
  }
  const replyToParentFlag = hasFlag(args, '--reply', '-r')

  // /done only makes sense in a spawned group; in a private chat it would
  // recursively tear down the whole spawn subtree rooted here.
  if (msg.chatType === 'p2p') {
    void e.reply(p, msg.replyCtx, e.i18n.t(MsgDonePrivateNotAllowed))
    return
  }

  if (asChatAvatarStateSwitcher(p) === undefined) {
    void e.reply(p, msg.replyCtx, e.i18n.t(MsgDoneNotSupported))
    return
  }

  // --reply: push this chat's last result to its parent before teardown.
  if (replyToParentFlag) {
    const sess = e.sessions.getOrCreateActive(msg.sessionKey)
    if (sess.getParentSessionKey() === '') {
      void e.reply(p, msg.replyCtx, e.i18n.t(MsgDoneReplyNoParent))
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
      void e.reply(p, rootCtx, e.i18n.tf(MsgDoneRecursiveSummary, descendants.length))
    }
    if (dirtyLines.length > 0) {
      void e.reply(p, rootCtx, e.i18n.tf(MsgDoneDirtyChildren, dirtyLines.join('\n')))
    }
  })()
}

/**
 * Tear down one chat's subtask state: stop its agent session, dim the
 * avatar, mark the spawned chat done, and handle its worktree (Go
 * cleanupOneChat). asChild=true skips a dirty worktree (the caller
 * summarizes) instead of showing the interactive card.
 */
async function cleanupOneChat(
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
