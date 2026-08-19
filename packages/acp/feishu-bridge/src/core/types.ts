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
  /** Deny reason message forwarded to the agent (Go PermissionResult.Message). */
  message?: string
}

/** One choice in a UserQuestion (Go UserQuestionOption). */
export interface UserQuestionOption {
  label: string
  description: string
  /** Optional preview text shown below the option (Go Preview). */
  preview?: string
}

/** A structured question from AskUserQuestion (Go UserQuestion). */
export interface UserQuestion {
  question: string
  header: string
  options: UserQuestionOption[]
  multiSelect: boolean
}

/**
 * A pending permission prompt parked on an InteractiveState (Go
 * pendingPermission). `resolved` replaces Go's `chan struct{}` — call
 * `resolve()` to settle; `isResolved()` checks.
 */
export interface PendingPermission {
  requestID: string
  toolName: string
  toolInput: Record<string, unknown>
  inputPreview: string
  /** Non-empty when ToolName === "AskUserQuestion". */
  questions: UserQuestion[]
  /** Collected answers keyed by question index. */
  answers: Map<number, string>
  /** Index of the question currently being asked. */
  currentQuestion: number
  /** Set true when user denies. */
  denied: boolean
  /** Resolved promise; settled when user responds. */
  resolved: Promise<void>
  /** Internal resolve function paired with `resolved`. */
  resolve(): void
}

/** Card button callback action types for permission and askq flows. */
export type PermissionAction = 'perm:allow' | 'perm:deny' | 'perm:allow_all'

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

/** Optional: platform can update a previously sent message in place (PATCH). */
export interface MessageUpdater {
  updateMessage(replyCtx: unknown, content: string): Promise<void>
}

/**
 * Optional: platform can start a streaming preview message and return a
 * handle for subsequent in-place edits.
 */
export interface PreviewStarter {
  sendPreviewStart(replyCtx: unknown, content: string): Promise<unknown>
}

/** Optional: platform can delete a preview message when the final reply is sent separately. */
export interface PreviewCleaner {
  deletePreviewMessage(previewHandle: unknown): Promise<void>
}

/** Optional: platform wants the preview kept as the final delivered message. */
export interface PreviewFinishPreference {
  keepPreviewOnFinish(): boolean
}

/**
 * Optional: platform streaming-preview cards have content limits beyond the
 * core character cap (e.g. Feishu's 5-table card limit, API error 11310).
 */
export interface PreviewOverflowReporter {
  previewOverflow(content: string): boolean
}

/** Optional: platform classifies PATCH failures as transient (rate limit). */
export interface TransientPatchErrorChecker {
  isTransientPatchError(err: unknown): boolean
}

/** Optional: platform renders a terminal "stopped" card in place on user stop. */
export interface StoppedCardRenderer {
  renderStoppedCard(replyCtx: unknown, previewMsgID: unknown): Promise<void>
}

/** Optional: platform can deliver file attachments. */
export interface FileSender {
  sendFile(replyCtx: unknown, file: FileAttachment): Promise<void>
}

/** Optional: platform can send interactive cards (Go CardSender). */
export interface CardSender {
  sendCard(replyCtx: unknown, card: unknown): Promise<void>
  replyCard(replyCtx: unknown, card: unknown): Promise<void>
}

/** Optional: platform can send inline buttons (Go InlineButtonSender). */
export interface InlineButtonSender {
  sendWithButtons(replyCtx: unknown, content: string, buttonRows: ButtonOption[][]): Promise<void>
}

/** Clickable inline button (Go ButtonOption, re-exported from card.ts shape). */
export interface ButtonOption {
  text: string
  data: string
}

/** Optional: platform sends a brief notification after the final in-place delivery. */
export interface CompletionNotifier {
  sendCompletionNotification(replyCtx: unknown, usageMsg: string): Promise<void>
}

/** Structural checks for the M2 card capability interfaces. */
function withMethod<T>(obj: object, method: keyof T & string): T | undefined {
  return typeof (obj as Partial<T>)[method] === 'function' ? (obj as T) : undefined
}

export function asMessageUpdater(p: Platform): MessageUpdater | undefined {
  return withMethod<MessageUpdater>(p, 'updateMessage')
}

export function asPreviewStarter(p: Platform): PreviewStarter | undefined {
  return withMethod<PreviewStarter>(p, 'sendPreviewStart')
}

export function asPreviewCleaner(p: Platform): PreviewCleaner | undefined {
  return withMethod<PreviewCleaner>(p, 'deletePreviewMessage')
}

export function asPreviewFinishPreference(p: Platform): PreviewFinishPreference | undefined {
  return withMethod<PreviewFinishPreference>(p, 'keepPreviewOnFinish')
}

export function asPreviewOverflowReporter(p: Platform): PreviewOverflowReporter | undefined {
  return withMethod<PreviewOverflowReporter>(p, 'previewOverflow')
}

export function asTransientPatchErrorChecker(p: Platform): TransientPatchErrorChecker | undefined {
  return withMethod<TransientPatchErrorChecker>(p, 'isTransientPatchError')
}

export function asStoppedCardRenderer(p: Platform): StoppedCardRenderer | undefined {
  return withMethod<StoppedCardRenderer>(p, 'renderStoppedCard')
}

export function asFileSender(p: Platform): FileSender | undefined {
  return withMethod<FileSender>(p, 'sendFile')
}

export function asCardSender(p: Platform): CardSender | undefined {
  return withMethod<CardSender>(p, 'sendCard')
}

export function asInlineButtonSender(p: Platform): InlineButtonSender | undefined {
  return withMethod<InlineButtonSender>(p, 'sendWithButtons')
}

export function asCompletionNotifier(p: Platform): CompletionNotifier | undefined {
  return withMethod<CompletionNotifier>(p, 'sendCompletionNotification')
}
