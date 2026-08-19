/**
 * Engine core ported from cc-connect core/engine.go + engine_events.go:
 * routes messages between platforms and the agent for one project. M1 keeps
 * the state shape (interactiveStates map, queued messages, idle/stall timers)
 * and the event loop's result/text/thinking basics; card/streaming surfaces,
 * the watchdog, the unsolicited reader, and multi-workspace arrive with the
 * milestones that port their tests (TODO(M2)/TODO(M3) markers below).
 *
 * Concurrency mapping (plan D7): goroutines become floating promises; Go's
 * select-over-channels becomes Promise.race over the EventChannel receive,
 * the stop signal, the send result, and a cancellable idle sleep re-created
 * each loop iteration (exactly Go's reset-after-event; tools pause it by not
 * arming the sleep while a tool call is in flight).
 *
 * @module dsh-feishu-bridge/engine
 */

import { I18n, langEnglish } from '../i18n/index.js'
import {
  MsgAgentProcessExited,
  MsgAskQuestionMulti,
  MsgAskQuestionTitle,
  MsgError,
  MsgFailedToStartAgentSession,
  MsgMessageQueued,
  MsgPermissionDenied,
  MsgPermissionExpired,
  MsgPermissionHint,
  MsgPermissionPrompt,
  MsgPermBtnAllow,
  MsgPermBtnAllowAll,
  MsgPermBtnDeny,
  MsgPermCardBody,
  MsgPermCardTitle,
  MsgPermDenyReasonPlaceholder,
  MsgProcessing,
  MsgPreviousProcessing,
  MsgQueueFull,
  MsgSessionResumeDegraded,
  MsgSilentReply,
  MsgStallRetry,
  MsgStallTimeout,
  MsgTurnCompleted,
} from '../i18n/index.js'
import type { Language } from '../i18n/index.js'
import type {
  Agent,
  AgentSession,
  CardSender,
  Event,
  FileAttachment,
  ImageAttachment,
  InlineButtonSender,
  Message,
  PendingPermission,
  Platform,
  UserQuestion,
} from '../core/types.js'
import { asSessionEnvInjector, asSessionModeInjector } from '../core/types.js'
import {
  isAllowResponse,
  isApproveAllResponse,
  isDenyResponse,
  resolveAskQuestionAnswer as resolveAnswerHelper,
  buildAskQuestionResponse as buildAnswerHelper,
  shouldSurfaceUnsolicitedPermission as shouldSurfaceHelper,
  buildDenyMessage,
} from './permission.js'
import { CardButton, CardCheckOption, newCard } from '../card.js'
import { Session, SessionManager } from './session.js'
import { MaxPlatformMessageLen, splitMessage, stripTrailingSilent } from './message-split.js'
import { defaultStreamPreviewCfg, newStreamPreview, newToolProgressEntry, StreamPreview, type StreamPreviewCfg } from '../streaming.js'
import { newCompactProgressWriter, suppressStandaloneToolResultEvent, type CompactProgressWriter } from '../progress-compact.js'
import { newAsyncSender, type AsyncSender } from '../async-sender.js'
import { readFileSync } from 'node:fs'
import { asCompletionNotifier } from '../core/types.js'

export { MaxPlatformMessageLen, splitMessage, stripTrailingSilent }

/** Default cap for queued messages per session (Go defaultMaxQueuedMessages). */
export const defaultMaxQueuedMessages = 5

/** Default rapid-fire queued-message merge window in ms (Go defaultDebounceInterval). */
export const defaultDebounceInterval = 600

const defaultThinkingMaxLen = 300

/** Default max plan content length before truncation (0 = no truncation, Go defaultPlanMaxLen). */
const defaultPlanMaxLen = 0

/** Default idle timeout before a silent turn is killed (Go defaultEventIdleTimeout = 10min). */
export const defaultEventIdleTimeout = 10 * 60 * 1000

/** Stall retries before the idle kill (Go defaultStallMaxRetries). */
const defaultStallMaxRetries = 1

/** Bounded wait for an agent session to close during cleanup (Go agentCloseTimeout). */
const agentCloseTimeout = 130_000

/** Attachment sends blocked by config (Go ErrAttachmentSendDisabled). */
export class ErrAttachmentSendDisabled extends Error {
  constructor() {
    super('attachment send is disabled by config')
    this.name = 'ErrAttachmentSendDisabled'
  }
}

/** How intermediate messages are surfaced (Go DisplayCfg). */
export interface DisplayCfg {
  thinkingMessages: boolean
  thinkingMaxLen: number
  toolMessages: boolean
  /** In quiet mode, drive one progress card from tool events (Go tool_progress). */
  toolProgress: boolean
  /** Max tool input preview length before truncation (Go ToolMaxLen). */
  toolMaxLen: number
  /** Max plan content length before truncation; 0 disables (Go PlanMaxLen). M3. */
  planMaxLen: number
}

/** A message queued while the session was busy (Go queuedMessage). */
export interface QueuedMessage {
  platform: Platform
  replyCtx: unknown
  messageID: string
  content: string
  images: ImageAttachment[]
  files: FileAttachment[]
  fromVoice: boolean
  isSpawnedGroup: boolean
  userID: string
  userName: string
  msgPlatform: string
  msgSessionKey: string
}

/**
 * A running interactive agent session and its turn state (Go interactiveState,
 * M1 subset). `closing` resolves when cleanup has fully torn the agent down so
 * a new turn for the same key waits instead of concurrently resuming the same
 * agent session id.
 */
export class InteractiveState {
  agentSession: AgentSession | undefined
  platform: Platform | undefined
  replyCtx: unknown
  agent: Agent | undefined
  sessionEnv: string[] = []
  closing: Promise<void> | undefined
  stopped = false
  userStopped = false
  pendingMessages: QueuedMessage[] = []
  inflightMessage: QueuedMessage | undefined
  sideText = ''
  eventsNeedResync = true
  effectiveMode = ''
  effectiveIdleTimeout = 0
  lastActivity = Date.now()
  activeTurns = 0
  lastEventAt = 0
  activeToolCalls = 0
  turnSeq = 0
  fromVoice = false
  lastPrompt = ''
  /** Whether a permission prompt is parked on this state (full object in M3). */
  permissionPending = false
  /** The pending permission/AskUserQuestion prompt (Go state.pending). M3. */
  pending: PendingPermission | undefined
  /** Auto-approve all subsequent permission requests (Go state.approveAll). M3. */
  approveAll = false
  /** Number of auto-compaction events this session (Go state.compactionCount). M3. */
  compactionCount = 0
  /** Per-state async sender serializing platform PATCHes (Go state.sender). */
  sender: AsyncSender | undefined
  /** The turn's active streaming preview (bound for bump routing). */
  preview: StreamPreview | undefined

  private stopWaiters: Array<() => void> = []

  /** The stop signal (Go stopCh): resolves once markStopped fires. */
  stopSignal(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return new Promise((resolve) => { this.stopWaiters.push(resolve) })
  }

  isStopped(): boolean {
    return this.stopped
  }

  isUserStopped(): boolean {
    return this.userStopped
  }

  /** Transition to stopped and wake stopSignal waiters (idempotent). */
  markStopped(): void {
    if (this.stopped) return
    this.stopped = true
    const waiters = this.stopWaiters
    this.stopWaiters = []
    for (const w of waiters) w()
  }

  touchActivity(): void {
    this.lastActivity = Date.now()
  }

  beginTurn(): void {
    this.activeTurns++
    this.touchActivity()
  }

  endTurn(): void {
    this.activeTurns--
    this.touchActivity()
  }

  /** Effective per-turn idle timeout, falling back to the engine default. */
  idleTimeout(fallback: number): number {
    if (this.effectiveIdleTimeout > 0) return this.effectiveIdleTimeout
    return fallback
  }
}

/** Cancellable sleep for the idle slot of the event-loop race. */
function cancellableSleep(ms: number): { promise: Promise<'idle'>; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const promise = new Promise<'idle'>((resolve) => {
    timer = setTimeout(() => { resolve('idle') }, ms)
  })
  return {
    promise,
    cancel(): void {
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}

function plainSleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** Render an unknown send failure as a display string. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** A promise that never resolves, typed as a never-matching race alternative. */
const neverPromise = new Promise<{ kind: 'never' }>((): void => {})

/** A bare NO_REPLY marker (case-insensitive, whitespace-padded). */
export function isSilentReply(text: string): boolean {
  return /^\s*NO_REPLY\s*$/i.test(text)
}

/** Whether the trimmed text is still a case-insensitive prefix of NO_REPLY. */
export function couldBeSilentPrefix(text: string): boolean {
  const t = text.trim()
  if (t === '') return true
  return 'NO_REPLY'.startsWith(t.toUpperCase())
}

function isEllipsisOnly(text: string): boolean {
  const t = text.trim()
  return t === '...' || t === '…'
}

/** Channel ID from "platform:chatID[:userID]" (Go extractChannelID). */
export function extractChannelID(sessionKey: string): string {
  const parts = sessionKey.split(':')
  if (parts.length >= 2) return parts[1] ?? ''
  return ''
}

/** Strip the trailing user ID: "platform:channel:user" → "platform:channel". */
export function stripUserID(sessionKey: string): string {
  const parts = sessionKey.split(':')
  if (parts.length >= 3) return `${parts[0]}:${parts[1]}`
  return sessionKey
}

/** Platform name prefix of a session key. */
export function extractPlatformName(sessionKey: string): string {
  const idx = sessionKey.indexOf(':')
  return idx > 0 ? sessionKey.slice(0, idx) : ''
}

function truncateIf(s: string, maxLen: number): string {
  if (maxLen <= 0) return s
  const runes = Array.from(s)
  if (runes.length <= maxLen) return s
  return `${runes.slice(0, maxLen).join('')}…`
}

/** Media capability surface a platform may expose beyond plain text. */
type MediaPlatform = Platform & {
  sendImage?: (replyCtx: unknown, img: ImageAttachment) => Promise<void>
  sendFile?: (replyCtx: unknown, file: FileAttachment) => Promise<void>
}

/** Reply-context reconstruction a platform may expose for proactive sends. */
type ReconstructingPlatform = Platform & {
  reconstructReplyCtx?: (sessionKey: string) => Promise<unknown>
}

/**
 * Engine routes messages between platforms and the agent for a single
 * project (Go Engine, M1 subset).
 */
export class Engine {
  readonly name: string
  readonly agent: Agent
  readonly platforms: Platform[]
  readonly sessions: SessionManager
  readonly i18n: I18n
  readonly startedAt = Date.now()

  display: DisplayCfg = {
    thinkingMessages: true,
    thinkingMaxLen: defaultThinkingMaxLen,
    toolMessages: true,
    toolProgress: false,
    toolMaxLen: 0,
    planMaxLen: defaultPlanMaxLen,
  }
  /** Streaming preview switches (Go e.streamPreview). */
  streamPreview: StreamPreviewCfg = defaultStreamPreviewCfg()
  /** Quiet window after the last im.chat.updated event before a preview bump (Go var). */
  bumpDebounceInterval = 2000
  injectSender = false
  attachmentSendEnabled = true
  eventIdleTimeout = defaultEventIdleTimeout
  stallMaxRetries = defaultStallMaxRetries
  maxQueuedMessages = defaultMaxQueuedMessages
  debounceInterval = defaultDebounceInterval
  interactiveIdleTimeout = 0

  /** key = sessionKey (interactiveKey; workspace prefixes arrive in a later M). */
  readonly interactiveStates = new Map<string, InteractiveState>()

  /** Command names → alias targets (trigger → command). */
  readonly aliases = new Map<string, string>()

  /** Command table injected by registerSessionCommands (engine/commands.ts). */
  commandHandlers: Map<string, (p: Platform, msg: Message, args: string[]) => boolean> | undefined
  /** Resolves a typed command word to its canonical ID (commands.ts matchPrefix). */
  commandResolver: ((cmd: string) => string) | undefined
  /** Privileged/disabled command gate; true when it replied and handled the line. */
  commandGate: ((cmdID: string, p: Platform, msg: Message) => boolean) | undefined

  /** Persisted per-project state (/dir overrides). */
  projectState: import('./project-state.js').ProjectStateStore | undefined
  /** Directory switch history (/dir). */
  dirHistory: import('./dir-history.js').DirHistory | undefined
  /** Base working directory for /dir reset. */
  baseWorkDir = ''
  /** Comma-separated admin user IDs ('*' = all allowed users; '' = deny). */
  adminFrom = ''
  /** /list etc. only show cc-connect-tracked sessions when true. */
  filterExternalSessions = false

  private reaperTimer: ReturnType<typeof setInterval> | undefined

  constructor(name: string, agent: Agent, platforms: Platform[], sessionStorePath: string, lang: Language = langEnglish) {
    this.name = name
    this.agent = agent
    this.platforms = platforms
    this.sessions = new SessionManager(sessionStorePath)
    this.i18n = new I18n(lang)
    this.sessions.invalidateForAgent(agent.name())
  }

  // ── configuration setters used by ported tests ─────────────────────────

  /** Override intermediate-message display settings. */
  setDisplayConfig(cfg: Partial<DisplayCfg>): void {
    this.display = { ...this.display, ...cfg }
  }

  /** Idle timeout before a silent turn is killed; 0 disables. */
  setEventIdleTimeout(ms: number): void {
    this.eventIdleTimeout = ms
  }

  /** Rapid-fire queued-message merge window in ms; 0 disables. */
  setDebounceInterval(ms: number): void {
    this.debounceInterval = ms
  }

  /** Per-session queue cap. */
  setMaxQueuedMessages(n: number): void {
    this.maxQueuedMessages = n
  }

  /** Toggle side-channel attachment delivery (Go SetAttachmentSendEnabled). */
  setAttachmentSendEnabled(enabled: boolean): void {
    this.attachmentSendEnabled = enabled
  }

  /** Inject the sender identity header into prompts (Go SetInjectSender). */
  setInjectSender(enabled: boolean): void {
    this.injectSender = enabled
  }

  /**
   * Enable the idle reaper: periodically reclaim interactiveStates idle
   * beyond the threshold by closing the agent session. 0 disables.
   */
  setInteractiveIdleTimeout(ms: number): void {
    this.interactiveIdleTimeout = ms
    if (this.reaperTimer !== undefined) {
      clearInterval(this.reaperTimer)
      this.reaperTimer = undefined
    }
    if (ms <= 0) return
    const period = Math.max(1000, Math.min(ms, 60_000))
    this.reaperTimer = setInterval(() => { this.reapIdleInteractiveStates() }, period)
    this.reaperTimer.unref()
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  /** Start every platform with the inbound handler (Go Start, M1 subset). */
  async start(): Promise<void> {
    const startErrs: unknown[] = []
    for (const p of this.platforms) {
      try {
        await p.start((platform, msg) => { this.handleMessage(platform, msg) })
      } catch (error) {
        console.warn(`platform start failed: ${p.name()}: ${String(error)}`)
        startErrs.push(error)
      }
    }
    if (startErrs.length === this.platforms.length && this.platforms.length > 0) {
      throw startErrs[0]
    }
  }

  /** Stop platforms and close all interactive agent sessions (Go Stop). */
  async stop(): Promise<void> {
    for (const p of this.platforms) await p.stop()
    const states = [...this.interactiveStates.values()]
    this.interactiveStates.clear()
    for (const state of states) {
      if (state.agentSession !== undefined) await state.agentSession.close()
    }
    if (this.reaperTimer !== undefined) clearInterval(this.reaperTimer)
    await this.agent.stop()
  }

  /** Deliver a message into the engine (integration-test entry). */
  receiveMessage(p: Platform, msg: Message): void {
    this.handleMessage(p, msg)
  }

  // ── outbound wrappers ───────────────────────────────────────────────────

  /** Reply with error logging (Go reply). */
  reply(p: Platform, replyCtx: unknown, content: string): Promise<void> {
    return p.reply(replyCtx, content).catch((error: unknown) => {
      console.debug(`engine: reply failed (${p.name()}): ${String(error)}`)
    })
  }

  /** Send with error logging (Go send). */
  send(p: Platform, replyCtx: unknown, content: string): Promise<void> {
    return p.send(replyCtx, content).catch((error: unknown) => {
      console.debug(`engine: send failed (${p.name()}): ${String(error)}`)
    })
  }

  // ── inbound routing ─────────────────────────────────────────────────────

  /** Route one inbound message (Go handleMessage, M1 subset). */
  handleMessage(p: Platform, msg: Message): void {
    const content = msg.content.trim()
    if (content === '' && msg.images.length === 0 && msg.files.length === 0) return

    const resolved = this.resolveAlias(content)
    if (msg.extraContent !== '') {
      msg.content = resolved === '' ? msg.extraContent : `${msg.extraContent}\n${resolved}`
    } else {
      msg.content = resolved
    }

    // M3: Route permission responses (allow/deny/allow_all) and AskUserQuestion
    // card-button answers to handlePendingPermission before normal dispatch.
    if (msg.isPermissionAction || msg.isAskqCardAction) {
      if (this.handlePendingPermission(p, msg, content)) return
    }

    const session = this.sessions.getOrCreateActive(msg.sessionKey)
    this.sessions.updateUserMeta(msg.sessionKey, msg.userName, msg.chatName)
    if (msg.userID !== '' && session.getSpawnUserID() !== msg.userID) {
      session.setSpawnUserID(msg.userID)
      this.sessions.save()
    }

    if (msg.images.length === 0 && content.startsWith('/')) {
      if (this.dispatchCommand(p, msg, content)) return
    }

    if (!session.tryLock()) {
      if (this.queueMessageForBusySession(p, msg, msg.sessionKey)) {
        // Race guard: the drain loop may have finished between our TryLock
        // failure and the queue append — retry and drain the orphans.
        if (session.tryLock()) {
          void this.drainOrphanedQueue(session, this.sessions, msg.sessionKey)
        }
      } else {
        void this.reply(p, msg.replyCtx, this.i18n.t(MsgPreviousProcessing))
      }
      return
    }

    this.ensureInteractiveStateForQueueing(msg.sessionKey, p, msg.replyCtx)
    void this.processInteractiveMessageWith(p, msg, session)
  }

  /** Resolve aliases on the content or its first word (Go resolveAlias). */
  resolveAlias(content: string): string {
    if (this.aliases.size === 0) return content
    const exact = this.aliases.get(content)
    if (exact !== undefined) return exact
    const spaceIdx = content.indexOf(' ')
    const first = spaceIdx === -1 ? content : content.slice(0, spaceIdx)
    const cmd = this.aliases.get(first)
    if (cmd === undefined) return content
    if (spaceIdx === -1) return cmd
    return `${cmd} ${content.slice(spaceIdx + 1)}`
  }

  /** Text slash-command dispatch; false lets the message reach the agent. */
  dispatchCommand(p: Platform, msg: Message, raw: string): boolean {
    const parts = raw.trim().split(/\s+/)
    const cmd = (parts.shift() ?? '').replace(/^\//, '').toLowerCase()
    const cmdID = this.commandResolver?.(cmd) ?? (this.commandHandlers?.get(cmd) !== undefined ? cmd : '')
    if (cmdID === '') return false
    if (this.commandGate?.(cmdID, p, msg)) return true
    const handler = this.commandHandlers?.get(cmdID)
    if (handler === undefined) return false
    return handler(p, msg, parts)
  }

  /** Per-chat dir override for an interactive key (Go perChatWorkDir, M1 shape). */
  perChatWorkDir(key: string): string {
    return this.projectState?.workspaceDirOverride(this.dirOverrideKey(key)) ?? ''
  }

  /**
   * Channel-level key for dir overrides: single-workspace strips the trailing
   * user ID so card actions and text messages map to the same slot.
   */
  dirOverrideKey(sessionKey: string): string {
    return stripUserID(sessionKey)
  }

  /** Effective work dir for a command context (agent cwd or process cwd). */
  commandWorkDir(msg: Message): string {
    const switcher = this.agent as { getWorkDir?: () => string }
    if (typeof switcher.getWorkDir === 'function') {
      const wd = switcher.getWorkDir().trim()
      if (wd !== '') return wd
    }
    const override = this.perChatWorkDir(this.dirOverrideKey(msg.sessionKey))
    if (override !== '') return override
    return process.cwd()
  }

  /** Register the persisted project-state store (/dir overrides). */
  setProjectStateStore(store: import('./project-state.js').ProjectStateStore): void {
    this.projectState = store
  }

  /** Register the directory history used by /dir. */
  setDirHistory(history: import('./dir-history.js').DirHistory): void {
    this.dirHistory = history
  }

  /** Set the base work dir restored by /dir reset. */
  setBaseWorkDir(dir: string): void {
    this.baseWorkDir = dir
  }

  /** Set the admin user list for privileged commands. */
  setAdminFrom(adminFrom: string): void {
    this.adminFrom = adminFrom
  }

  // ── queueing (#13) ──────────────────────────────────────────────────────

  /**
   * Queue a message for delivery after the running turn. Only metadata is
   * stored — the event loop sends it after the turn's result (Go
   * queueMessageForBusySession).
   */
  queueMessageForBusySession(p: Platform, msg: Message, interactiveKey: string): boolean {
    const state = this.interactiveStates.get(interactiveKey)
    if (state === undefined) return false
    // Allow queueing while agentSession is still starting (issue #565);
    // reject only a session that was established and died.
    if (state.agentSession !== undefined && !state.agentSession.alive()) {
      void this.cleanupInteractiveState(interactiveKey, state)
      return false
    }
    if (state.pendingMessages.length >= this.maxQueuedMessages) {
      void this.reply(p, msg.replyCtx, this.i18n.tf(MsgQueueFull, state.pendingMessages.length))
      return true
    }
    state.pendingMessages.push({
      platform: p,
      replyCtx: msg.replyCtx,
      messageID: msg.messageID,
      content: msg.content,
      images: msg.images,
      files: msg.files,
      fromVoice: msg.fromVoice,
      isSpawnedGroup: msg.isSpawnedGroup,
      userID: msg.userID,
      userName: msg.userName,
      msgPlatform: msg.platform,
      msgSessionKey: msg.sessionKey,
    })
    void this.reply(p, msg.replyCtx, this.i18n.t(MsgMessageQueued))
    return true
  }

  /** Create a placeholder state so startup-window messages queue (issue #565). */
  ensureInteractiveStateForQueueing(key: string, p: Platform, replyCtx: unknown): void {
    if (!this.interactiveStates.has(key)) {
      const state = new InteractiveState()
      state.platform = p
      state.replyCtx = replyCtx
      state.lastActivity = Date.now()
      state.eventsNeedResync = true
      this.interactiveStates.set(key, state)
    }
  }

  // ── turn processing ─────────────────────────────────────────────────────

  /** Run one user turn end-to-end (Go processInteractiveMessageWith, M1 subset). */
  async processInteractiveMessageWith(p: Platform, msg: Message, session: Session): Promise<void> {
    let unlocked = false
    try {
      this.i18n.detectAndSet(msg.content)
      const historyContent = msg.originalContent !== '' ? msg.originalContent : msg.content
      session.addHistory('user', historyContent)

      const state = await this.getOrCreateInteractiveStateWith(msg.sessionKey, p, msg.replyCtx, session)
      try {
        state.turnSeq++
        state.platform = p
        state.replyCtx = msg.replyCtx

        if (state.agentSession === undefined) {
          await this.reply(p, msg.replyCtx, this.i18n.t(MsgFailedToStartAgentSession))
          return
        }

        // TODO(M3): per-message mode override via LiveModeSwitcher.
        // TODO(M2): typing-indicator transfer to the event loop.

        if (state.eventsNeedResync) state.agentSession.events().drain()

        const promptContent = this.buildSenderPrompt(msg.content, msg.userID, msg.userName, msg.platform, msg.sessionKey)
        state.fromVoice = msg.fromVoice
        state.sideText = ''
        state.lastPrompt = promptContent

        state.lastEventAt = Date.now()
        const sendDone = state.agentSession.send(promptContent, msg.images, msg.files)
          .then((): undefined => undefined, (error: unknown): unknown => error)

        await this.processInteractiveEvents(state, session, this.sessions, msg.sessionKey, msg.messageID, sendDone, msg.replyCtx)
      } finally {
        state.endTurn()
      }

      // A message may have queued between the event loop seeing an empty
      // queue and returning (session still locked) — drain the orphans.
      await this.drainPendingMessages(state, session, this.sessions, msg.sessionKey)
      unlocked = true
    } catch (error) {
      console.error(`engine: turn processing failed (${msg.sessionKey}): ${String(error)}`)
    } finally {
      if (!unlocked) session.unlock()
    }
  }

  /** Sender-injection prompt prefix (Go buildSenderPrompt). */
  buildSenderPrompt(content: string, userID: string, userName: string, platform: string, sessionKey: string): string {
    if (!this.injectSender || userID === '') return content
    const chatID = extractChannelID(sessionKey)
    if (userName !== '') {
      const safeName = userName.replaceAll('"', "'").replaceAll('\n', ' ').replaceAll('\r', '')
      return `[cc-connect sender_id=${userID} sender_name="${safeName}" platform=${platform} chat_id=${chatID}]\n${content}`
    }
    return `[cc-connect sender_id=${userID} platform=${platform} chat_id=${chatID}]\n${content}`
  }

  /**
   * Get or create the interactive state for a session key, recycling a stale
   * agent process whose session ID no longer matches (Go
   * getOrCreateInteractiveStateWith, M1 subset without fork sentinels and
   * workspace overrides).
   */
  async getOrCreateInteractiveStateWith(sessionKey: string, p: Platform, replyCtx: unknown, session: Session): Promise<InteractiveState> {
    // Wait out a concurrent teardown so two agents never resume the same
    // session id concurrently.
    for (;;) {
      const state = this.interactiveStates.get(sessionKey)
      if (state === undefined || state.closing === undefined) break
      await Promise.race([state.closing, cancellableSleep(agentCloseTimeout + 10_000).promise])
    }

    const existing = this.interactiveStates.get(sessionKey)
    if (existing !== undefined && existing.agentSession !== undefined && existing.agentSession.alive()) {
      const wantID = session.getAgentSessionID()
      const currentID = existing.agentSession.currentSessionID()
      const needRecycle = currentID !== '' && (wantID === '' || wantID !== currentID)
      if (!needRecycle) {
        existing.beginTurn()
        return existing
      }
      console.info(`interactive session mismatch, recycling (${sessionKey}): want=${wantID} have=${currentID}`)
      existing.markStopped()
      await this.closeAgentSessionWithTimeout(sessionKey, existing.agentSession)
      this.interactiveStates.delete(sessionKey)
    }

    const agent = this.agent
    const sessionEnv = this.buildSessionEnv(sessionKey, session)

    const startSessionID = session.getAgentSessionID()

    let agentSession: AgentSession | undefined
    try {
      agentSession = await this.startAgentLocked(agent, startSessionID, sessionEnv, '')
    } catch (error) {
      if (startSessionID !== '') {
        console.error(`session resume failed, falling back to fresh session (${sessionKey}): ${String(error)}`)
        try {
          agentSession = await this.startAgentLocked(agent, '', sessionEnv, '')
          void this.reply(p, replyCtx, this.i18n.t(MsgSessionResumeDegraded))
        } catch (freshError) {
          console.error(`failed to start interactive session (${sessionKey}): ${String(freshError)}`)
        }
      } else {
        console.error(`failed to start interactive session (${sessionKey}): ${String(error)}`)
      }
    }

    if (agentSession === undefined) {
      const newState = new InteractiveState()
      newState.platform = p
      newState.replyCtx = replyCtx
      newState.agent = agent
      newState.eventsNeedResync = true
      this.adoptPendingFromPlaceholder(this.interactiveStates.get(sessionKey), newState)
      this.interactiveStates.set(sessionKey, newState)
      return newState
    }

    const newID = agentSession.currentSessionID()
    if (newID !== '') {
      if (session.compareAndSetAgentSessionID(newID, agent.name())) {
        const pendingName = session.getName()
        if (pendingName !== '' && pendingName !== 'session' && pendingName !== 'default') {
          this.sessions.setSessionName(newID, pendingName)
        }
        this.sessions.save()
      }
    }

    const newState = new InteractiveState()
    newState.agentSession = agentSession
    newState.platform = p
    newState.replyCtx = replyCtx
    newState.agent = agent
    newState.sessionEnv = sessionEnv
    newState.eventsNeedResync = true
    newState.effectiveIdleTimeout = this.eventIdleTimeout
    this.adoptPendingFromPlaceholder(this.interactiveStates.get(sessionKey), newState)
    this.interactiveStates.set(sessionKey, newState)

    newState.beginTurn()
    return newState
  }

  /** Carry queued messages from a placeholder state into the live one. */
  private adoptPendingFromPlaceholder(existing: InteractiveState | undefined, fresh: InteractiveState): void {
    if (existing === undefined) return
    if (existing.pendingMessages.length > 0) {
      fresh.pendingMessages = [...existing.pendingMessages, ...fresh.pendingMessages]
      existing.pendingMessages = []
    }
  }

  /**
   * Per-session env (CC_SESSION_KEY, CC_PROJECT). TODO(M3): subtask/chatroom
   * flags and workspace context when those milestones port their consumers.
   */
  buildSessionEnv(ccKey: string, _session: Session): string[] {
    return [`CC_SESSION_KEY=${ccKey}`, `CC_PROJECT=${this.name}`]
  }

  /** SetSessionEnv + StartSession, serialized per engine (Go startAgentLocked). Public for the ported env-injection tests. */
  startAgentLocked(agent: Agent, sessionID: string, env: string[], modeOverride: string): Promise<AgentSession> {
    const inj = asSessionEnvInjector(agent)
    if (inj !== undefined && env.length > 0) inj.setSessionEnv(env)
    const modeInj = asSessionModeInjector(agent)
    if (modeInj !== undefined && modeOverride !== '') modeInj.setSessionMode(modeOverride)
    return agent.startSession(sessionID)
  }

  // ── event loop ──────────────────────────────────────────────────────────

  /**
   * Consume agent events for one turn: accumulate text/thinking, deliver the
   * final reply, drain queued messages, and handle process exit (Go
   * processInteractiveEvents, M1 subset without preview cards and the
   * watchdog).
   */
  async processInteractiveEvents(
    state: InteractiveState,
    session: Session,
    sessions: SessionManager,
    sessionKey: string,
    _msgID: string,
    sendDone: Promise<unknown> | undefined,
    replyCtx: unknown,
  ): Promise<void> {
    let textParts: string[] = []
    let segmentStart = 0
    let toolCount = 0
    let silentHold = false
    let activeToolCalls = 0
    let stallRetries = 0

    const channel = state.agentSession?.events()
    if (channel === undefined) return

    // M2 preview machinery: one streamPreview + compact writer per turn,
    // sharing the state's async sender so PATCHes stay off this loop.
    const platform = state.platform ?? this.platforms[0]
    if (platform === undefined) return
    state.sender ??= newAsyncSender(sessionKey)
    const sender = state.sender
    const sp = newStreamPreview(this.streamPreview, platform, replyCtx, undefined, sender, sessionKey)
    state.preview = sp
    const cp = newCompactProgressWriter(platform, replyCtx, this.agent.name(),
      this.i18n.currentLang(), undefined, sender)
    this.bindActivePreview(sp, sessionKey)
    // Placeholder card so the user sees visual feedback (with push) before
    // the first agent event arrives.
    if (this.display.toolProgress && sp.canPreview()) {
      void sp.showPlaceholder(this.i18n.t(MsgProcessing))
    }
    let thinkingStreamed = false
    let thinkingAccum = ''
    let deltaAccum = ''
    let deltaFlushed = false

    /** Drain queued async PATCHes before a terminal card state. */
    const barrier = (): Promise<void> => sender.barrier()

    let pendingSend = sendDone
    const stopP = state.stopSignal()
    let recvP: Promise<{ done: false; event: Event } | { done: true }> = channel.receive()

    /** One resolved arm of the loop's select (Go's select cases). */
    type LoopOutcome =
      | { kind: 'event'; event: Event }
      | { kind: 'closed' }
      | { kind: 'send'; error: unknown }
      | { kind: 'stop' }
      | { kind: 'idle' }
      | { kind: 'never' }

    for (;;) {
      // Idle timer: re-armed per iteration (Go reset-after-event); not armed
      // while a tool call is in flight (Go stops it on EventToolUse).
      const idleMs = activeToolCalls === 0 ? state.idleTimeout(this.eventIdleTimeout) : 0
      const idleSleep = idleMs > 0 ? cancellableSleep(idleMs) : undefined
      const recvOutcome: Promise<LoopOutcome> = recvP.then(r =>
        r.done ? { kind: 'closed' } : { kind: 'event', event: r.event })
      const sendOutcome: Promise<LoopOutcome> = pendingSend !== undefined
        ? pendingSend.then(e => ({ kind: 'send', error: e }))
        : neverPromise
      const stopOutcome: Promise<LoopOutcome> = stopP.then(() => ({ kind: 'stop' }))
      const idleOutcome: Promise<LoopOutcome> = idleSleep !== undefined
        ? idleSleep.promise.then(() => ({ kind: 'idle' }))
        : neverPromise
      const outcome: LoopOutcome = await Promise.race([recvOutcome, sendOutcome, stopOutcome, idleOutcome])
      idleSleep?.cancel()

      if (outcome.kind === 'stop') {
        await barrier()
        if (state.isUserStopped()) {
          // User stop: stopped terminal card, skipping cp.Finalize(Failed)
          // which would clobber the ⏹ 已停止 card.
          await sp.markStopped()
        } else {
          await sp.markFailed()
        }
        state.eventsNeedResync = true
        return
      }

      if (outcome.kind === 'send') {
        pendingSend = undefined
        if (outcome.error !== undefined) {
          const errText = errorMessage(outcome.error)
          console.error(`failed to send prompt (${sessionKey}): ${errText}`)
          this.notifyDroppedQueuedMessages(state, new Error(errText))
          if (state.agentSession === undefined || !state.agentSession.alive()) {
            await this.cleanupInteractiveState(sessionKey, state)
          }
          const p = state.platform
          if (p !== undefined) {
            await this.send(p, replyCtx, this.i18n.tf(MsgError, errorMessage(outcome.error)))
          }
          return
        }
        continue
      }

      if (outcome.kind === 'idle') {
        // Re-verify against the last event arrival: a fire right after an
        // event resolved is stale — keep waiting (Go stallConfirmed).
        if (!this.stallConfirmed(state, Date.now(), state.idleTimeout(this.eventIdleTimeout))) continue

        stallRetries++
        if (stallRetries <= this.stallMaxRetries) {
          const retry = await this.restartAgentForStallRetry(
            state, state.agent ?? this.agent, sessionKey, channel)
          if (retry !== undefined) {
            const stallPlatform = state.platform
            if (stallPlatform !== undefined) {
              const idleSec = Math.round(state.idleTimeout(this.eventIdleTimeout) / 1000)
              await this.send(stallPlatform, replyCtx,
                this.i18n.tf(MsgStallRetry, idleSec, stallRetries, this.stallMaxRetries))
            }
            textParts = []
            segmentStart = 0
            toolCount = 0
            silentHold = false
            recvP = retry.events().receive()
            const retryChannel = retry
            const nextSend = retryChannel.send('继续', [], [])
              .then((): undefined => undefined, (error: unknown): unknown => error)
            pendingSend = nextSend
            continue
          }
        }

        console.error(`agent session idle timeout: no events for too long, killing session (${sessionKey})`)
        state.eventsNeedResync = true
        const p = state.platform
        if (p !== undefined) {
          await this.send(p, replyCtx,
            this.i18n.tf(MsgStallTimeout, Math.round(state.idleTimeout(this.eventIdleTimeout) / 1000), this.stallMaxRetries))
        }
        await this.cleanupInteractiveState(sessionKey, state)
        return
      }

      if (outcome.kind === 'closed' || outcome.kind === 'never') {
        if (outcome.kind === 'closed') {
          await this.handleChannelClosed(state, session, sessionKey, textParts, segmentStart, toolCount, replyCtx)
        }
        return
      }

      const event = outcome.event
      state.lastEventAt = Date.now()
      recvP = channel.receive()

      if (state.isStopped()) {
        state.eventsNeedResync = true
        return
      }

      const p = state.platform

      switch (event.type) {
        case 'thinking': {
          if (isEllipsisOnly(event.content)) break
          // In quiet mode (thinkingMessages=false), thinking events must not
          // affect the streaming preview — no clearThinking, no
          // completeAndDetach, no text segment flush. Otherwise
          // completeAndDetach sets degraded=true, causing the result handler
          // to fall through to this.send() and duplicate the reply as plain
          // text alongside the already-finalized card.
          if (!this.display.thinkingMessages) {
            thinkingStreamed = false
            thinkingAccum = ''
            break
          }
          // Thinking block complete: drop the streamed 💭 section.
          if (thinkingStreamed && sp.canPreview()) await sp.clearThinking()
          if (textParts.length > segmentStart) {
            if (sp.canPreview()) {
              await sp.completeAndDetach()
              segmentStart = textParts.length
            } else {
              const segment = textParts.slice(segmentStart).join('')
              if (segment !== '' && p !== undefined) {
                for (const chunk of splitMessage(segment, MaxPlatformMessageLen)) {
                  await this.send(p, replyCtx, chunk)
                }
              }
              segmentStart = textParts.length
            }
            if (!sp.inProgressMode()) segmentStart = textParts.length
            silentHold = false
          }
          if (event.content !== '' && p !== undefined) {
            if (textParts.length > segmentStart) {
              if (!sp.canPreview()) {
                const segment = textParts.slice(segmentStart).join('')
                if (segment !== '') {
                  for (const chunk of splitMessage(segment, MaxPlatformMessageLen)) {
                    await this.send(p, replyCtx, chunk)
                  }
                }
              }
              segmentStart = textParts.length
              silentHold = false
            }
            await sp.completeAndDetach()
            const preview = truncateIf(event.content, this.display.thinkingMaxLen)
            const thinkingMsg = this.i18n.tf('thinking', preview)
            if (!await cp.appendEvent('thinking', preview, '', thinkingMsg)) {
              await this.send(p, replyCtx, thinkingMsg)
            }
          }
          thinkingStreamed = false
          thinkingAccum = ''
          break
        }

        case 'text_delta': {
          // Preview-only incremental text; the full block still arrives via
          // EventText and is reconciled at turn end.
          deltaAccum += event.content
          if (couldBeSilentPrefix(deltaAccum)) break
          deltaFlushed = true
          if (sp.canPreview() && sp.inProgressMode()) await sp.appendAnalysisText(deltaAccum)
          else if (sp.canPreview()) await sp.appendText(event.content)
          break
        }

        case 'thinking_delta': {
          // Preview-only: stream thinking into the 💭 section; the full
          // EventThinking block clears it and dedups.
          thinkingAccum += event.content
          thinkingStreamed = true
          if (this.display.thinkingMessages && sp.canPreview()) await sp.appendThinking(thinkingAccum)
          break
        }

        case 'tool_use': {
          toolCount++
          activeToolCalls++
          state.activeToolCalls = activeToolCalls
          if (this.display.toolProgress && sp.canPreview()) {
            await sp.appendProgress(newToolProgressEntry(event.toolName ?? '', event.toolInput ?? '', event.toolID ?? ''))
          }
          break
        }

        case 'tool_result': {
          if (this.display.toolMessages) {
            const result = (event.toolResult ?? '').trim() || event.content.trim()
            if (result !== '' && p !== undefined) {
              const entry = {
                kind: 'tool_result' as const,
                tool: event.toolName ?? '',
                text: result,
              }
              if (!await cp.appendStructured(entry, result)) {
                if (!suppressStandaloneToolResultEvent(p)) {
                  await this.send(p, replyCtx, result)
                }
              }
            }
          } else if (this.display.toolProgress) {
            // Quiet mode: update the last tool entry with its result.
            const result = (event.toolResult ?? '').trim() || event.content.trim()
            if (result !== '' || event.done) {
              await sp.updateToolResult(event.toolID ?? '', result, true)
            }
          }
          activeToolCalls = Math.max(0, activeToolCalls - 1)
          state.activeToolCalls = activeToolCalls
          break
        }

        case 'text': {
          if (isEllipsisOnly(event.content)) break
          // Real text ends the streaming-thinking state (safety net for
          // agents that only emit thinking deltas); empty content carriers
          // (session ids) must not flip 思考中↔执行中.
          if (thinkingStreamed && event.content !== '') {
            await sp.clearThinking()
            thinkingAccum = ''
          }
          const text = event.content
          if (text !== '' && !isSilentReply(text)) {
            textParts.push(text)
            if (deltaFlushed) {
              // This block was already previewed via deltas; textParts (the
              // final-message source of truth) is still updated.
              deltaAccum = ''
              deltaFlushed = false
            } else {
              const segmentText = textParts.slice(segmentStart).join('')
              if (silentHold) {
                if (!couldBeSilentPrefix(segmentText)) {
                  silentHold = false
                  if (sp.canPreview() && sp.inProgressMode()) await sp.appendAnalysisText(segmentText)
                  else if (sp.canPreview()) await sp.appendText(segmentText)
                }
              } else if (couldBeSilentPrefix(segmentText)) {
                silentHold = true
              } else if (sp.canPreview() && sp.inProgressMode()) {
                await sp.appendAnalysisText(text)
              } else if (sp.inProgressMode() && p !== undefined) {
                await this.send(p, replyCtx, text)
              } else if (sp.canPreview()) {
                await sp.appendText(text)
              }
            }
          }
          const eventSessionID = event.sessionID ?? ''
          if (eventSessionID !== '') {
            if (session.compareAndSetAgentSessionID(eventSessionID, this.agent.name())) {
              const pendingName = session.getName()
              if (pendingName !== '' && pendingName !== 'session' && pendingName !== 'default') {
                sessions.setSessionName(eventSessionID, pendingName)
              }
              sessions.save()
            }
          }
          break
        }

        case 'permission_request': {
          const isAskQuestion = event.toolName === 'AskUserQuestion'
          const autoApprove = state.approveAll

          // Auto-approve: approveAll is set and this is not AskUserQuestion
          // and not ExitPlanMode (the user must always review plan changes).
          if (autoApprove && !isAskQuestion && event.toolName !== 'ExitPlanMode') {
            if (state.agentSession !== undefined) {
              const autoInput = event.toolInputRaw ?? {}
              void state.agentSession.respondPermission(event.requestID ?? '', {
                behavior: 'allow',
                updatedInput: autoInput,
              }).catch(() => {})
            }
            break
          }

          // Check if this unsolicited permission should surface to the user.
          // Non-surfaced permissions (background Bash without approveAll) are
          // auto-denied so the agent can continue without hanging.
          if (!this.shouldSurfaceUnsolicitedPermission(event.toolName ?? '', isAskQuestion, false, autoApprove)) {
            if (state.agentSession !== undefined) {
              void state.agentSession.respondPermission(event.requestID ?? '', {
                behavior: 'deny',
                message: buildDenyMessage(''),
              }).catch(() => {})
            }
            break
          }

          // Surface: create pending permission and send card.
          let resolveFn!: () => void
          const resolved = new Promise<void>((r) => { resolveFn = r })
          const pending: PendingPermission = {
            requestID: event.requestID ?? '',
            toolName: event.toolName ?? '',
            toolInput: event.toolInputRaw ?? {},
            inputPreview: event.toolInput ?? '',
            questions: [],
            answers: new Map<number, string>(),
            currentQuestion: 0,
            denied: false,
            resolved,
            resolve: resolveFn,
          }
          state.pending = pending
          state.permissionPending = true

          // Send the appropriate prompt card.
          if (isAskQuestion && p !== undefined) {
            void this.sendAskQuestionPrompt(p, replyCtx, [{
              question: event.content || 'Question',
              header: '',
              options: [],
              multiSelect: false,
            }], 0)
          } else if (p !== undefined) {
            const permLimit = this.display.toolMaxLen
            const rawInput = event.toolInput ?? ''
            const toolInput = permLimit > 0
              ? truncateIf(rawInput, Math.floor(permLimit * 8 / 5))
              : rawInput
            const toolName = event.toolName ?? ''
            const prompt = this.i18n.tf(MsgPermissionPrompt, toolName, toolInput)
            void this.sendPermissionPrompt(p, replyCtx, prompt, toolName, toolInput)
          }

          // Wait for user response or stop signal.
          // Note: in the Go original the event loop blocks here until the
          // user responds. In TS the event loop returns — the user response
          // is handled by handlePendingPermission in a separate call, which
          // resolves the pending and triggers the next turn.
          // DO NOT await resolved here — the test expects the loop to exit
          // after setting pending so the caller can verify state.
          break
        }

        case 'result': {
          const finished = await this.handleResultEvent(
            state, session, sessions, sessionKey, replyCtx, event,
            textParts, segmentStart, toolCount, pendingSend, sp, cp, barrier)
          if (finished.kind === 'queued') {
            // A queued message takes over this loop as a fresh turn (Go
            // in-loop drain): reset per-turn state and continue.
            textParts = []
            segmentStart = 0
            toolCount = 0
            silentHold = false
            activeToolCalls = 0
            state.activeToolCalls = 0
            thinkingStreamed = false
            thinkingAccum = ''
            deltaAccum = ''
            deltaFlushed = false
            pendingSend = finished.sendDone
            if (state.agentSession !== undefined) recvP = state.agentSession.events().receive()
            state.lastEventAt = Date.now()
            continue
          }
          return
        }

        case 'error': {
          state.eventsNeedResync = true
          await sp.markFailed()
          if (event.error !== undefined && p !== undefined) {
            await this.send(p, replyCtx, this.i18n.tf(MsgError, event.error.message))
          }
          if (state.agentSession === undefined || !state.agentSession.alive()) {
            this.notifyDroppedQueuedMessages(state, event.error ?? new Error('agent error'))
          }
          return
        }

        default:
          break
      }
    }
  }

  /** Whether the idle fire reflects a genuine stall (Go stallConfirmed). */
  stallConfirmed(state: InteractiveState, now: number, idle: number): boolean {
    const last = state.lastEventAt
    if (last === 0) return true
    return now - last >= idle
  }

  /**
   * EventResult handling: persist IDs, silent-marker handling, side-channel
   * dedup, final delivery, and the in-loop queued-turn arm.
   */
  private async handleResultEvent(
    state: InteractiveState,
    session: Session,
    sessions: SessionManager,
    _sessionKey: string,
    replyCtx: unknown,
    event: Event,
    textParts: string[],
    segmentStart: number,
    toolCount: number,
    pendingSend: Promise<unknown> | undefined,
    sp: StreamPreview,
    cp: CompactProgressWriter,
    barrier: () => Promise<void>,
  ): Promise<{ kind: 'done' } | { kind: 'queued'; sendDone: Promise<unknown> }> {
    // Persist via the live session id (event.sessionID may be empty).
    if (state.agentSession !== undefined) {
      const currentID = state.agentSession.currentSessionID()
      if (currentID !== '') {
        if (session.compareAndSetAgentSessionID(currentID, this.agent.name())) {
          const pendingName = session.getName()
          if (pendingName !== '' && pendingName !== 'session' && pendingName !== 'default') {
            sessions.setSessionName(currentID, pendingName)
          }
        }
      }
    }
    state.eventsNeedResync = false
    state.permissionPending = false

    let fullResponse = event.content
    const sdkResult = event.content.trim()
    const joined = textParts.length > 0 ? textParts.join('') : ''
    const preferJoined = (textParts.length > 0 && segmentStart === 0 && !this.display.toolMessages)
      || (fullResponse === '' && textParts.length > 0)
      // A bare NO_REPLY final segment does not retroactively swallow earlier
      // substantive text — fall back to the accumulated reply.
      || (textParts.length > 0 && isSilentReply(fullResponse))
    if (preferJoined) fullResponse = joined
    if (fullResponse === '') {
      fullResponse = event.errorText !== undefined && event.errorText !== ''
        ? this.i18n.tf(MsgError, event.errorText)
        : this.i18n.t(MsgSilentReply)
    }

    const baseResponse = fullResponse.replace(/[ \n]+$/, '')
    session.addHistory('assistant', baseResponse)
    if (sdkResult !== '') session.setLastResult(sdkResult)
    sessions.save()

    let isSilent = isSilentReply(baseResponse)
    let cleanResponse = baseResponse
    if (!isSilent) {
      const [stripped, ok] = stripTrailingSilent(baseResponse)
      if (ok) {
        if (stripped.trim() === '') isSilent = true
        else cleanResponse = stripped
      }
    }

    const p = state.platform
    const normalizedBase = baseResponse.trim()
    const suppressDuplicate = normalizedBase !== '' && normalizedBase === state.sideText
    state.sideText = ''

    /** Whether the final card landed; the ✅ notification follows it. */
    let sendCompletionNotification = false
    if (isSilent) {
      await sp.setAnalysisText(this.i18n.t(MsgSilentReply))
      await sp.markCompleted()
      await sp.detachPreview()
      sendCompletionNotification = true
    } else if (p !== undefined) {
      if (suppressDuplicate) {
        // The side channel already delivered this exact text; only the
        // appended metadata (footer) is worth sending.
        await sp.discard()
        const metaOnly = cleanResponse.startsWith(baseResponse)
          ? cleanResponse.slice(baseResponse.length).trim()
          : cleanResponse.trim()
        if (metaOnly !== '') {
          for (const chunk of splitMessage(metaOnly, MaxPlatformMessageLen)) {
            await this.send(p, replyCtx, chunk)
          }
        }
        sendCompletionNotification = true
      } else if (toolCount > 0 && segmentStart > 0 && !sp.inProgressMode()) {
        // Prior segments were already surfaced between tools; deliver only
        // the unsent remainder.
        await sp.discard()
        const unsent = textParts.slice(segmentStart).join('')
        const [uStripped, uOk] = stripTrailingSilent(unsent)
        const deliver = uOk ? uStripped : unsent
        if (deliver !== '') {
          for (const chunk of splitMessage(deliver, MaxPlatformMessageLen)) {
            await this.send(p, replyCtx, chunk)
          }
        }
        sendCompletionNotification = true
      } else if (sp.inProgressMode()) {
        if (sp.isDegraded()) {
          await sp.discard()
          await sp.deliverAnswer(fullResponse)
        } else {
          // Keep 实时播报 on the last streamed segment; only fall back to
          // the full response when nothing was streamed live.
          await sp.setAnalysisTextIfEmpty(fullResponse)
          await sp.markCompleted()
          await sp.detachPreview()
        }
        sendCompletionNotification = true
      } else if (await sp.finish(fullResponse)) {
        // Finalized in place via the stream preview.
        sendCompletionNotification = true
      } else if (cleanResponse !== '') {
        for (const chunk of splitMessage(cleanResponse, MaxPlatformMessageLen)) {
          await this.send(p, replyCtx, chunk)
        }
        sendCompletionNotification = true
      }
    }

    // Guarantee the terminal PATCH has landed before the ✅ notification so
    // the progress card is not still mid-state when the push arrives.
    await barrier()
    void cp
    if (sendCompletionNotification && p !== undefined && state.pendingMessages.length === 0) {
      const notifier = asCompletionNotifier(p)
      if (notifier !== undefined) {
        let usageMsg = this.i18n.t(MsgTurnCompleted)
        const inTok = event.totalInputTokens ?? 0
        const outTok = event.outputTokens ?? 0
        if (inTok > 0 || outTok > 0) usageMsg += ` · tokens ${inTok}+${outTok}`
        try {
          await notifier.sendCompletionNotification(replyCtx, usageMsg)
        } catch (error) {
          console.warn(`completion notification failed: ${String(error)}`)
        }
      }
    }

    // Queued messages take over this loop as a fresh turn (Go in-loop drain).
    const queued = state.pendingMessages.shift()
    if (queued !== undefined) {
      state.platform = queued.platform
      state.replyCtx = queued.replyCtx
      state.fromVoice = queued.fromVoice
      state.turnSeq++
      if (this.debounceInterval > 0) await this.debounceWaitAndMerge(state, queued)

      if (state.agentSession === undefined || !state.agentSession.alive()) {
        state.inflightMessage = undefined
        await this.send(queued.platform, queued.replyCtx, this.i18n.tf(MsgError, 'agent session ended'))
        this.notifyDroppedQueuedMessages(state, new Error('agent session ended'))
        return { kind: 'done' }
      }
      state.agentSession.events().drain()
      if (pendingSend !== undefined) await pendingSend.catch(() => undefined)

      const queuedPrompt = this.buildSenderPrompt(queued.content, queued.userID, queued.userName, queued.msgPlatform, queued.msgSessionKey)
      session.addHistory('user', queued.content)
      state.inflightMessage = queued
      this.i18n.detectAndSet(queued.content)
      const sendDone = state.agentSession.send(queuedPrompt, queued.images, queued.files)
        .then((): undefined => undefined, (error: unknown): unknown => error)
      return { kind: 'queued', sendDone }
    }
    if (pendingSend !== undefined) await pendingSend.catch(() => undefined)
    return { kind: 'done' }
  }

  /** Channel-closed: notify the user and deliver any partial reply (Go channelClosed). */
  private async handleChannelClosed(
    state: InteractiveState,
    session: Session,
    sessionKey: string,
    textParts: string[],
    segmentStart: number,
    toolCount: number,
    replyCtx: unknown,
  ): Promise<void> {
    const unexpectedExit = !state.stopped
    const closedPlatform = state.platform
    state.eventsNeedResync = true
    this.notifyDroppedQueuedMessages(state, new Error('agent process exited'))
    await this.cleanupInteractiveState(sessionKey, state)

    if (unexpectedExit && closedPlatform !== undefined) {
      await this.send(closedPlatform, replyCtx, this.i18n.t(MsgAgentProcessExited))
    }

    if (textParts.length > 0) {
      let fullResponse = textParts.join('')
      session.addHistory('assistant', fullResponse)

      if (isSilentReply(fullResponse)) return
      const [stripped, ok] = stripTrailingSilent(fullResponse)
      if (ok && stripped.trim() === '') return
      if (ok) fullResponse = stripped

      const p = closedPlatform
      if (p === undefined) return
      if (toolCount > 0 && segmentStart > 0) {
        const unsent = textParts.slice(segmentStart).join('')
        const [uStripped, uOk] = stripTrailingSilent(unsent)
        const deliver = uOk ? uStripped : unsent
        if (deliver !== '') {
          for (const chunk of splitMessage(deliver, MaxPlatformMessageLen)) {
            await this.send(p, replyCtx, chunk)
          }
        }
      } else {
        for (const chunk of splitMessage(fullResponse, MaxPlatformMessageLen)) {
          await this.send(p, replyCtx, chunk)
        }
      }
    }
  }

  // ── stall retry ─────────────────────────────────────────────────────────

  /**
   * Kill the stalled agent session and start a fresh resume, re-injecting the
   * per-session env (Go restartAgentForStallRetry, M1 subset without the
   * workDir override — the dsh adapter derives cwd at creation).
   */
  private async restartAgentForStallRetry(
    state: InteractiveState, replyAgent: Agent, _sessionKey: string,
    oldEvents: { drain(): void },
  ): Promise<AgentSession | undefined> {
    const resumeID = state.agentSession?.currentSessionID() ?? ''
    console.info(`stall retry: restarting with re-injected env resume=${resumeID}`)

    try {
      await state.agentSession?.close()
    } catch (error) {
      console.warn(`stall retry: close failed: ${String(error)}`)
    }
    oldEvents.drain()

    const retryEnv = state.sessionEnv
    const retryMode = state.effectiveMode
    try {
      const newSess = await this.startAgentLocked(replyAgent, resumeID, retryEnv, retryMode)
      state.agentSession = newSess
      state.eventsNeedResync = false
      return newSess
    } catch (error) {
      console.error(`stall retry: failed to create new session: ${String(error)}`)
      return undefined
    }
  }

  // ── queue drain ─────────────────────────────────────────────────────────

  /**
   * Process queued messages sequentially; each dispatched turn drains further
   * arrivals inside its own event loop. Returns true when the session lock
   * was released here (Go drainPendingMessages semantics).
   */
  async drainPendingMessages(state: InteractiveState, session: Session, sessions: SessionManager, sessionKey: string): Promise<boolean> {
    for (;;) {
      const queued = state.pendingMessages.shift()
      if (queued === undefined) {
        session.unlock()
        return true
      }
      state.inflightMessage = queued
      state.platform = queued.platform
      state.replyCtx = queued.replyCtx
      state.fromVoice = queued.fromVoice

      if (this.debounceInterval > 0) await this.debounceWaitAndMerge(state, queued)

      this.i18n.detectAndSet(queued.content)
      const prompt = this.buildSenderPrompt(queued.content, queued.userID, queued.userName, queued.msgPlatform, queued.msgSessionKey)

      if (state.agentSession === undefined || !state.agentSession.alive()) {
        state.inflightMessage = undefined
        await this.send(queued.platform, queued.replyCtx, this.i18n.tf(MsgError, 'agent session ended'))
        this.notifyDroppedQueuedMessages(state, new Error('agent session ended'))
        session.unlock()
        return false
      }

      state.agentSession.events().drain()
      session.addHistory('user', queued.content)

      const sendDone = state.agentSession.send(prompt, queued.images, queued.files)
        .then((): undefined => undefined, (error: unknown): unknown => error)
      try {
        await this.processInteractiveEvents(state, session, sessions, sessionKey, '', sendDone, queued.replyCtx)
      } catch (error) {
        console.error(`engine: queued turn failed (${sessionKey}): ${String(error)}`)
      }
      state.inflightMessage = undefined
    }
  }

  /** Drain orphaned queue after the turn processor already exited. */
  async drainOrphanedQueue(session: Session, sessions: SessionManager, interactiveKey: string): Promise<void> {
    let unlocked = false
    try {
      const state = this.interactiveStates.get(interactiveKey)
      if (state === undefined || state.agentSession === undefined || !state.agentSession.alive()) {
        if (state !== undefined) {
          this.notifyDroppedQueuedMessages(state, new Error('agent session ended'))
        }
        session.unlock()
        unlocked = true
        return
      }
      if (await this.drainPendingMessages(state, session, sessions, interactiveKey)) unlocked = true
    } finally {
      if (!unlocked) session.unlock()
    }
  }

  /**
   * Wait up to the debounce interval, merging rapid-fire queued messages
   * into the lead with "\n\n---\n\n" separators; a merge re-arms the window
   * (Go debounceWaitAndMerge).
   */
  private async debounceWaitAndMerge(state: InteractiveState, lead: QueuedMessage): Promise<void> {
    let deadline = Date.now() + this.debounceInterval
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return
      await Promise.race([plainSleep(Math.min(remaining, 10)), Promise.resolve()])
      const next = state.pendingMessages.shift()
      if (next === undefined) continue
      lead.content += `\n\n---\n\n${next.content}`
      lead.images = [...lead.images, ...next.images]
      lead.files = [...lead.files, ...next.files]
      deadline = Date.now() + this.debounceInterval
    }
  }

  /** Tell each queued sender their message will never be processed. */
  notifyDroppedQueuedMessages(state: InteractiveState, reason: Error): void {
    const remaining = state.pendingMessages
    state.pendingMessages = []
    for (const q of remaining) {
      void this.send(q.platform, q.replyCtx, this.i18n.tf(MsgError, reason.message))
    }
  }

  // ── cleanup ─────────────────────────────────────────────────────────────

  /**
   * Remove the interactive state and close its agent session. With an
   * expected state, cleanup is skipped when the map entry was replaced
   * (stale-goroutine guard, Go cleanupInteractiveState). The map entry is
   * deleted only after the agent session finished closing.
   */
  async cleanupInteractiveState(sessionKey: string, expected?: InteractiveState): Promise<void> {
    const state = this.interactiveStates.get(sessionKey)
    if (expected !== undefined && state !== undefined && state !== expected) return

    let agentSession: AgentSession | undefined
    let closingResolve: (() => void) | undefined
    if (state !== undefined) {
      agentSession = state.agentSession
      state.agentSession = undefined
      if (agentSession !== undefined) {
        state.closing = new Promise<void>((resolve) => { closingResolve = resolve })
      }
    }

    try {
      if (state !== undefined) {
        state.markStopped()
        this.notifyDroppedQueuedMessages(state, new Error('session reset'))
      }
      if (agentSession !== undefined) {
        await this.closeAgentSessionWithTimeout(sessionKey, agentSession)
      }
    } finally {
      if (closingResolve !== undefined) closingResolve()
    }

    const current = this.interactiveStates.get(sessionKey)
    if (expected !== undefined && current !== undefined && current !== expected) return
    this.interactiveStates.delete(sessionKey)
  }

  /** Close with a bounded wait so a hung process cannot wedge cleanup. */
  private async closeAgentSessionWithTimeout(sessionKey: string, agentSession: AgentSession): Promise<void> {
    await Promise.race([
      agentSession.close(),
      cancellableSleep(agentCloseTimeout).promise,
    ]).catch((error: unknown) => {
      console.error(`engine: agent session close failed (${sessionKey}): ${String(error)}`)
    })
  }

  /**
   * User-initiated stop (/stop, /new, /switch): flag userStopped, detach the
   * state, resolve queued senders, and close the agent session
   * asynchronously (Go stopInteractiveSession, M1 subset).
   */
  stopInteractiveSession(sessionKey: string): boolean {
    const state = this.interactiveStates.get(sessionKey)
    if (state === undefined) return false

    state.userStopped = true
    state.markStopped()
    this.interactiveStates.delete(sessionKey)
    this.notifyDroppedQueuedMessages(state, new Error('session reset'))
    if (state.agentSession !== undefined) {
      void state.agentSession.close().catch((error: unknown) => {
        console.error(`engine: stop close failed (${sessionKey}): ${String(error)}`)
      })
    }
    return true
  }

  // ── idle reaper ─────────────────────────────────────────────────────────

  /** Reclaim interactiveStates idle beyond the threshold (Go reaper). */
  reapIdleInteractiveStates(): void {
    if (this.interactiveIdleTimeout <= 0) return
    const cutoff = Date.now() - this.interactiveIdleTimeout
    const targets: Array<[string, InteractiveState]> = []
    for (const [key, state] of this.interactiveStates) {
      if (state.activeTurns > 0) continue
      // Skip sessions waiting for a permission response — the user may take
      // a long time to decide, and reaping would lose the pending prompt.
      if (state.pending !== undefined) continue
      if (state.lastActivity !== 0 && state.lastActivity < cutoff) targets.push([key, state])
    }
    for (const [key, state] of targets) {
      console.info(`reaping idle interactive state (${key})`)
      void this.cleanupInteractiveState(key, state)
    }
  }

  // ── proactive sends (cc-connect send tool surface) ──────────────────────

  /** Send text to a session by key (Go SendToSession). */
  async sendToSession(sessionKey: string, message: string): Promise<void> {
    return this.sendToSessionWithAttachments(sessionKey, message, [], [])
  }

  /**
   * Send text/attachments to a session by key, recording sideText for the
   * result-path duplicate suppression (Go SendToSessionWithAttachments,
   * M1 subset: text + raw image/file sends, no card composition).
   */
  async sendToSessionWithAttachments(
    sessionKey: string, message: string,
    images: ImageAttachment[], files: FileAttachment[],
  ): Promise<void> {
    let state: InteractiveState | undefined
    if (sessionKey !== '') {
      state = this.interactiveStates.get(sessionKey)
    } else if (this.interactiveStates.size === 1) {
      state = [...this.interactiveStates.values()][0]
    } else if (this.interactiveStates.size > 1 && (images.length > 0 || files.length > 0)) {
      throw new Error('multiple active sessions; must specify --session to send attachments')
    } else {
      state = [...this.interactiveStates.values()][0]
    }

    let p = state?.platform
    let replyCtx = state?.replyCtx
    if (p === undefined && sessionKey !== '') {
      const platformName = extractPlatformName(sessionKey)
      const target = this.platforms.find(candidate => candidate.name() === platformName)
      if (target !== undefined) {
        const reconstructed = await (target as ReconstructingPlatform).reconstructReplyCtx?.(sessionKey)
        if (reconstructed !== undefined) {
          p = target
          replyCtx = reconstructed
        }
      }
    }
    if (p === undefined) throw new Error(`no active session found (key="${sessionKey}")`)
    if (message === '' && images.length === 0 && files.length === 0) {
      throw new Error('message or attachment is required')
    }
    if ((images.length > 0 || files.length > 0) && !this.attachmentSendEnabled) {
      throw new ErrAttachmentSendDisabled()
    }

    // Capability checks BEFORE any send so a failure delivers nothing.
    const media = p as MediaPlatform
    if (images.length > 0 && typeof media.sendImage !== 'function') {
      throw new Error(`platform ${p.name()}: operation not supported by this platform`)
    }
    if (files.length > 0 && typeof media.sendFile !== 'function') {
      throw new Error(`platform ${p.name()}: operation not supported by this platform`)
    }

    if (message !== '') {
      await p.send(replyCtx, message)
      if (state !== undefined && (images.length > 0 || files.length > 0)) {
        state.sideText = message.trim()
      }
    }
    for (const img of images) await media.sendImage?.(replyCtx, img)
    for (const file of files) await media.sendFile?.(replyCtx, file)
  }

  // ---------------------------------------------------------------------
  // Active-preview bump routing (chat rename/avatar system notices push the
  // preview card off the tail; bump reissues it as the latest message)
  // ---------------------------------------------------------------------

  private activePreview: StreamPreview | undefined
  private activePreviewSession = ''
  private bumpTimer: ReturnType<typeof setTimeout> | undefined

  /** Bind the session's active preview for bump routing (Go bindActivePreview). */
  bindActivePreview(sp: StreamPreview, sessionKey: string): void {
    this.activePreview = sp
    this.activePreviewSession = sessionKey
  }

  /** Reissue the bound preview when it belongs to the given session. */
  bumpActivePreviewForSession(sessionKey: string): void {
    if (this.activePreview === undefined || this.activePreviewSession !== sessionKey) return
    void this.activePreview.bumpToEnd()
  }

  /**
   * Coalesce rapid im.chat.updated events (rename + avatar ~1.4s apart) into
   * one bump after the quiet window; only the last notice matters.
   */
  onChatChanged(sessionKey: string): void {
    if (this.bumpTimer !== undefined) clearTimeout(this.bumpTimer)
    this.bumpTimer = setTimeout(() => {
      this.bumpTimer = undefined
      this.bumpActivePreviewForSession(sessionKey)
    }, this.bumpDebounceInterval)
  }

  // ──────────────────────────────────────────────────────────────
  // M3: Permission / AskUserQuestion / ExitPlanMode
  // ──────────────────────────────────────────────────────────────

  /** Whether an unsolicited permission should surface to the user (Go shouldSurfaceUnsolicitedPermission). */
  shouldSurfaceUnsolicitedPermission(_toolName: string, isAskQuestion: boolean, stallRetried: boolean, autoApprove: boolean): boolean {
    return shouldSurfaceHelper(_toolName, isAskQuestion, stallRetried, autoApprove)
  }

  /** Resolve user input into an AskUserQuestion answer (Go resolveAskQuestionAnswer). */
  resolveAskQuestionAnswer(q: UserQuestion, input: string): string {
    return resolveAnswerHelper(q, input)
  }

  /**
   * Build updated tool input with collected answers (Go
   * buildAskQuestionResponse, package-level).
   */
  static buildAskQuestionResponse(
    originalInput: Record<string, unknown>,
    questions: UserQuestion[],
    collected: Map<number, string>,
  ): Record<string, unknown> {
    return buildAnswerHelper(originalInput, questions, collected)
  }

  /**
   * Read a plan file, truncate to `display.planMaxLen` if configured, and send
   * as plain text (Go sendPlanContent). Returns the (possibly truncated)
   * content string. When `planMaxLen` is 0, no truncation is applied.
   */
  sendPlanContent(
    p: Platform,
    replyCtx: unknown,
    _state: InteractiveState | undefined,
    filePath: string,
    _revision: number,
    _exportKey: string,
  ): string {
    let content = ''
    try {
      content = readFileSync(filePath, 'utf8').trim()
    } catch {
      return ''
    }
    // Plan truncation uses "..." (three ASCII dots) to match the Go plan card
    // rendering, distinct from truncateIf's unicode ellipsis.
    const maxLen = this.display.planMaxLen
    if (maxLen > 0) {
      const runes = Array.from(content)
      if (runes.length > maxLen) {
        content = `${runes.slice(0, maxLen).join('')}...`
      }
    }
    void this.send(p, replyCtx, content)
    return content
  }

  /**
   * Send a permission prompt card with Allow/Deny/AllowAll buttons
   * (Go sendPermissionPrompt). Falls back to inline buttons, then plain text.
   */
  async sendPermissionPrompt(p: Platform, replyCtx: unknown, prompt: string, toolName: string, toolInput: string): Promise<void> {
    // Try inline buttons first (Telegram-style platforms)
    const ibs = p as Platform & InlineButtonSender
    if (typeof ibs.sendWithButtons === 'function') {
      const buttons = [
        [
          { text: this.i18n.t(MsgPermBtnAllow), data: 'perm:allow' },
          { text: this.i18n.t(MsgPermBtnDeny), data: 'perm:deny' },
        ],
        [
          { text: this.i18n.t(MsgPermBtnAllowAll), data: 'perm:allow_all' },
        ],
      ]
      try {
        await ibs.sendWithButtons(replyCtx, prompt, buttons)
        return
      } catch {
        // fall through to card
      }
    }

    // Try card with buttons (Feishu-style platforms)
    const cs = p as Platform & CardSender
    if (typeof cs.sendWithCard === 'function') {
      const body = this.i18n.tf(MsgPermCardBody, toolName, toolInput)
      const allowBtn: CardButton = { text: this.i18n.t(MsgPermBtnAllow), type: 'primary', value: 'perm:allow', name: 'perm_allow', actionType: 'form_submit', extra: { perm_label: `✅ ${this.i18n.t(MsgPermBtnAllow)}`, perm_color: 'green', perm_body: body } }
      const denyBtn: CardButton = { text: this.i18n.t(MsgPermBtnDeny), type: 'danger', value: 'perm:deny', name: 'perm_deny', actionType: 'form_submit', extra: { perm_label: `❌ ${this.i18n.t(MsgPermBtnDeny)}`, perm_color: 'red', perm_body: body } }
      const allowAllBtn: CardButton = { text: this.i18n.t(MsgPermBtnAllowAll), type: 'default', value: 'perm:allow_all', name: 'perm_allow_all', actionType: 'form_submit', extra: { perm_label: `✅ ${this.i18n.t(MsgPermBtnAllowAll)}`, perm_color: 'green', perm_body: body } }

      const card = newCard()
        .title(`‼️ ${this.i18n.t(MsgPermCardTitle)}`, 'red')
        .form('perm_form',
          { kind: 'markdown', content: body },
          { kind: 'input', name: 'deny_reason', placeholder: this.i18n.t(MsgPermDenyReasonPlaceholder), maxLength: 1000 },
          { kind: 'actions', buttons: [allowBtn, allowAllBtn, denyBtn], layout: 'equal_columns' },
        )
        .build()
      card.permBody = body
      try {
        await cs.sendWithCard(replyCtx, card)
        return
      } catch {
        // fall through to plain text
      }
    }

    // Plain text fallback
    await this.send(p, replyCtx, prompt)
  }

  /**
   * Send an AskUserQuestion prompt card with option buttons
   * (Go sendAskQuestionPrompt). Falls back to inline buttons, then plain text.
   */
  async sendAskQuestionPrompt(p: Platform, replyCtx: unknown, questions: UserQuestion[], qIdx: number): Promise<void> {
    if (qIdx >= questions.length) return
    const q = questions[qIdx]
    if (q === undefined) return
    const total = questions.length
    const titleSuffix = total > 1 ? ` (${qIdx + 1}/${total})` : ''

    // Build option buttons for single-select
    const optionButtons: CardButton[] = q.options.map((opt, i) => ({
      text: opt.label,
      type: 'default',
      value: `askq:${qIdx}:${i + 1}`,
      extra: { askq_label: opt.label, askq_question: q.question },
    }))

    // Try card (Feishu-style platforms)
    const cs = p as Platform & CardSender
    if (typeof cs.sendWithCard === 'function') {
      const cardTitle = q.header !== '' ? q.header : this.i18n.t(MsgAskQuestionTitle)
      const cb = newCard().title(`‼️ ${cardTitle}${titleSuffix}`, 'blue')

      if (q.multiSelect) {
        // Multi-select: use checker + form for native checkbox experience
        const opts: CardCheckOption[] = q.options.map((opt, i) => ({
          label: opt.label,
          description: opt.description,
          value: String(i + 1),
        }))
        cb.checkOptions(q.question, opts, `askq_multi:${qIdx}`, { askq_question: q.question })
      } else {
        // Single-select: markdown question + option buttons
        cb.markdown(q.question)
        cb.buttonsEqual(...optionButtons)
      }

      try {
        await cs.sendWithCard(replyCtx, cb.build())
        return
      } catch {
        // fall through to inline buttons
      }
    }

    // Try inline buttons
    const ibs = p as Platform & InlineButtonSender
    if (typeof ibs.sendWithButtons === 'function') {
      const questionText = total > 1 ? `${q.question} (${qIdx + 1}/${total})` : q.question
      const buttons = optionButtons.map(b => [{ text: b.text, data: b.value }])
      try {
        await ibs.sendWithButtons(replyCtx, questionText, buttons)
        return
      } catch {
        // fall through to plain text
      }
    }

    // Plain text fallback
    const lines = [q.question]
    if (q.multiSelect) lines.push(this.i18n.t(MsgAskQuestionMulti))
    for (let i = 0; i < q.options.length; i++) {
      const opt = q.options[i]
      if (opt === undefined) continue
      lines.push(`${i + 1}) ${opt.label}${opt.description !== '' ? ` — ${opt.description}` : ''}`)
    }
    await this.send(p, replyCtx, lines.join('\n'))
  }

  /**
   * Route a permission response (allow/deny/approveAll/AskUserQuestion answer)
   * from the user or card callback (Go handlePendingPermission). Returns true
   * if the message was consumed as a permission response. Synchronous like the
   * Go original — async side-effects (reply, respondPermission) fire as
   * floating promises.
   */
  handlePendingPermission(p: Platform, msg: Message, content: string): boolean {
    // Parse optional deny reason: feishu encodes as "deny\x00<reason>"
    let denyReason = ''
    const nulIdx = content.indexOf('\x00')
    if (nulIdx >= 0) {
      denyReason = content.slice(nulIdx + 1).trim()
      content = content.slice(0, nulIdx)
    }

    const iKey = msg.sessionKey
    const state = this.interactiveStates.get(iKey)
    if (state === undefined) {
      if (msg.isPermissionAction) {
        const lower = content.toLowerCase().trim()
        if (isAllowResponse(lower) || isDenyResponse(lower) || isApproveAllResponse(lower)) {
          void this.reply(p, msg.replyCtx, this.i18n.t(MsgPermissionExpired))
          return true
        }
      }
      return false
    }

    const pending = state.pending
    if (pending === undefined) {
      if (msg.isPermissionAction) {
        const lower = content.toLowerCase().trim()
        if (isAllowResponse(lower) || isDenyResponse(lower) || isApproveAllResponse(lower)) {
          void this.reply(p, msg.replyCtx, this.i18n.t(MsgPermissionExpired))
          return true
        }
      }
      return false
    }

    // AskUserQuestion: interpret user response as an answer, not a permission decision
    if (pending.questions.length > 0) {
      if (content === '' && (msg.files.length > 0 || msg.images.length > 0)) {
        return false
      }

      const curIdx = pending.currentQuestion
      const q = pending.questions[curIdx]
      if (q === undefined) return false
      const answer = this.resolveAskQuestionAnswer(q, content)
      pending.answers.set(curIdx, answer)

      // More questions remaining — advance to next
      if (curIdx + 1 < pending.questions.length) {
        pending.currentQuestion = curIdx + 1
        if (!msg.isAskqCardAction) {
          void this.reply(p, msg.replyCtx, `✅ ${q.question}: **${answer}**`)
        }
        void this.sendAskQuestionPrompt(p, msg.replyCtx, pending.questions, curIdx + 1)
        return true
      }

      // All questions answered — build response and resolve
      const updatedInput = buildAnswerHelper(pending.toolInput, pending.questions, pending.answers)
      if (state.agentSession !== undefined) {
        void state.agentSession.respondPermission(pending.requestID, { behavior: 'allow', updatedInput }).catch(() => {})
      }
      if (!msg.isAskqCardAction) {
        void this.reply(p, msg.replyCtx, `✅ ${q.question}: **${answer}**`)
      }

      state.pending = undefined
      pending.resolve()
      state.lastEventAt = Date.now()
      return true
    }

    const lower = content.toLowerCase().trim()

    if (isApproveAllResponse(lower)) {
      state.approveAll = true
      if (state.agentSession !== undefined) {
        void state.agentSession.respondPermission(pending.requestID, { behavior: 'allow', updatedInput: pending.toolInput }).catch(() => {})
      }
    } else if (isAllowResponse(lower)) {
      // ExitPlanMode approval grants blanket approval for the rest of the turn
      if (pending.toolName === 'ExitPlanMode') {
        state.approveAll = true
        state.effectiveMode = 'default'
      }
      if (state.agentSession !== undefined) {
        void state.agentSession.respondPermission(pending.requestID, { behavior: 'allow', updatedInput: pending.toolInput }).catch(() => {})
      }
    } else if (isDenyResponse(lower)) {
      pending.denied = true
      const denyMessage = buildDenyMessage(denyReason)
      if (state.agentSession !== undefined) {
        void state.agentSession.respondPermission(pending.requestID, { behavior: 'deny', message: denyMessage }).catch(() => {})
      }
      // Denying ExitPlanMode resets approveAll
      if (pending.toolName === 'ExitPlanMode') {
        state.approveAll = false
      }
      // Card button deny: header already shows "❌ 已拒绝"; only send text for non-card deny
      if (!msg.isPermissionAction) {
        void this.reply(p, msg.replyCtx, this.i18n.t(MsgPermissionDenied))
      }
    } else {
      void this.reply(p, msg.replyCtx, this.i18n.t(MsgPermissionHint))
      return true
    }

    state.pending = undefined
    pending.resolve()
    state.lastEventAt = Date.now()
    return true
  }
}
