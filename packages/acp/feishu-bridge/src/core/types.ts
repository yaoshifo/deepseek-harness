/**
 * Core interface model ported from cc-connect core/interfaces.go and
 * core/message.go: Platform, Agent, AgentSession, Message, Event. M1 carries
 * the base set only; optional capability interfaces arrive with the
 * milestones that port their tests (cards → M2, approval → M3, …).
 *
 * Go's optional-capability interface checks (`if cs, ok := p.(CardSender)`)
 * become structural checks on optional methods (`isCardSender(p)` guards in
 * engine code).
 *
 * @module dsh-feishu-bridge/core-types
 */

/** Sentinel AgentSessionID telling the agent to resume the most recent session. */
export const ContinueSession = '__continue__'

/** Marks an AgentSessionID that should resume with a forked transcript. */
export const ForkSessionPrefix = '__fork__'

/** Marks a session resuming from a truncated (rollback) transcript. */
export const ForkAtSessionPrefix = '__forkat__'

/** Platform operation not supported by this implementation. */
export class ErrNotSupported extends Error {
  constructor(operation = 'operation not supported by this platform') {
    super(operation)
    this.name = 'ErrNotSupported'
  }
}

/** Image attachment bytes sent by the user. */
export interface ImageAttachment {
  mimeType: string
  data: Uint8Array
  fileName?: string
}

/** File attachment bytes sent by the user. */
export interface FileAttachment {
  mimeType: string
  data: Uint8Array
  fileName: string
}

/** One turn in a conversation history (timestamp is an ISO string, like Go time.Time's JSON form). */
export interface HistoryEntry {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

/** A session as reported by the agent backend (for /list, /switch). */
export interface AgentSessionInfo {
  id: string
  summary: string
  messageCount: number
  modifiedAt: number
  gitBranch?: string
}

/** Permission decision sent back to the agent. */
export interface PermissionResult {
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
}

/** Unified incoming message from any platform (Go core.Message). */
export interface Message {
  sessionKey: string
  platform: string
  messageID: string
  userID: string
  userName: string
  chatName: string
  chatType: string
  content: string
  originalContent: string
  images: ImageAttachment[]
  files: FileAttachment[]
  extraContent: string
  replyCtx: unknown
  fromVoice: boolean
  isSpawnedGroup: boolean
  isPermissionAction: boolean
  isAskqCardAction: boolean
  parentMessageID: string
  quotedText: string
}

/** Agent output event kinds (Go EventType). M1 handles text/thinking/tool/result/error/permission. */
export type EventKind =
  | 'text'
  | 'text_delta'
  | 'thinking_delta'
  | 'tool_use'
  | 'tool_result'
  | 'result'
  | 'error'
  | 'permission_request'
  | 'thinking'

/** A single piece of agent output streamed to the engine (Go Event). */
export interface Event {
  type: EventKind
  content: string
  toolName?: string
  toolInput?: string
  toolInputRaw?: Record<string, unknown>
  toolResult?: string
  toolID?: string
  sessionID?: string
  requestID?: string
  done: boolean
  error?: Error
  errorText?: string
  inputTokens?: number
  totalInputTokens?: number
  outputTokens?: number
  numTurns?: number
  arrivedAt?: number
}

/**
 * Push channel replacing Go's `<-chan Event`: buffered push, explicit close,
 * and async receive. The event loop awaits `receive()`; `drain()` discards
 * buffered events the way Go's drainEvents did.
 */
export class EventChannel {
  private queue: Event[] = []
  private closed = false
  private waiters: Array<(r: { done: false; event: Event } | { done: true }) => void> = []

  /** Push one buffered event; resolves a waiting receiver immediately. */
  push(event: Event): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter({ done: false, event })
    else this.queue.push(event)
  }

  /** Close the channel; pending receivers observe done once the buffer drains. */
  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.queue.length === 0) {
      for (const waiter of this.waiters) waiter({ done: true })
      this.waiters = []
    }
  }

  /**
   * Receive the next event, or done once closed and drained. Resolving is
   * FIFO across competing receivers, mirroring Go channel semantics.
   */
  receive(): Promise<{ done: false; event: Event } | { done: true }> {
    if (this.queue.length > 0) {
      return Promise.resolve({ done: false, event: this.queue.shift() as Event })
    }
    if (this.closed) return Promise.resolve({ done: true } as const)
    return new Promise((resolve) => { this.waiters.push(resolve) })
  }

  /** Discard all buffered events without waiting (Go drainEvents). */
  drain(): void {
    this.queue = []
    if (this.closed) {
      for (const waiter of this.waiters) waiter({ done: true })
      this.waiters = []
    }
  }
}

/** Called by platforms when a new message arrives (Go MessageHandler). */
export type MessageHandler = (p: Platform, msg: Message) => void

/** A messaging platform (Go Platform base interface). */
export interface Platform {
  name(): string
  start(handler: MessageHandler): Promise<void>
  reply(replyCtx: unknown, content: string): Promise<void>
  send(replyCtx: unknown, content: string): Promise<void>
  stop(): Promise<void>
}

/** A running agent session with a persistent process (Go AgentSession). */
export interface AgentSession {
  send(prompt: string, images: ImageAttachment[], files: FileAttachment[]): Promise<void>
  respondPermission(requestID: string, result: PermissionResult): Promise<void>
  events(): EventChannel
  currentSessionID(): string
  alive(): boolean
  close(): Promise<void>
}

/** An AI coding assistant backend (Go Agent). */
export interface Agent {
  name(): string
  startSession(sessionID: string): Promise<AgentSession>
  listSessions(): Promise<AgentSessionInfo[]>
  stop(): Promise<void>
}

/** Optional: agent accepts per-session env vars (CC_PROJECT, …). */
export interface SessionEnvInjector {
  setSessionEnv(env: string[]): void
}

/** Optional: agent accepts a one-shot mode override consumed by the next startSession. */
export interface SessionModeInjector {
  setSessionMode(mode: string): void
}

/** Structural checks replacing Go's interface type assertions. */
export function asSessionEnvInjector(a: Agent): SessionEnvInjector | undefined {
  const candidate = a as Partial<SessionEnvInjector>
  return typeof candidate.setSessionEnv === 'function' ? (candidate as SessionEnvInjector) : undefined
}

export function asSessionModeInjector(a: Agent): SessionModeInjector | undefined {
  const candidate = a as Partial<SessionModeInjector>
  return typeof candidate.setSessionMode === 'function' ? (candidate as SessionModeInjector) : undefined
}
