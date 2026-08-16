/**
 * Named wire types for the cc-connect bridge runtime protocol: the extension
 * of the stock DeepSeek Harness SDK JSON-RPC stdio protocol with the methods
 * cc-connect needs (session create-with-resume, cancel, runtime configure)
 * and the two server-to-client requests that carry dsh's approval and
 * user-questions capability seams across the process boundary.
 *
 * The vocabulary deliberately stays cc-connect-neutral (session ids, plain
 * content blocks, generic approval outcomes) so a future native messaging
 * surface inside dsh could speak the same shapes.
 *
 * @module dsh-cc-connect-bridge/types
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
} from '@deepseek-ai/dsh-user-questions/types'

/** Parameters for the process-wide handshake. */
export interface InitializeParams {
  /** Working directory recorded on every bridge-created session's header. */
  cwd: string
  /** Provider route every bridge-created agent runs on. */
  provider: string
  /** Model name every bridge-created agent runs on. */
  model: string
  /** Optional positive output-token cap inherited by bridge-created agents. */
  maxTokens?: number
  /**
   * Optional per-session reasoning effort inherited by bridge-created agents
   * (AgentOptions.reasoningEffort). Absent = the route's configured default.
   */
  reasoningEffort?: string
}

/** Wire-stable server identity returned by initialization. */
export interface InitializeResult {
  serverInfo: { name: string; version: string }
}

/** Per-session creation/resume parameters. */
export interface SessionCreateParams {
  /** The bridge-side session id; determines the persisted session identity. */
  sessionId: string
  /** When set, resume the persisted session with this id instead of creating fresh. */
  resumeSessionId?: string
  /** Working directory for the session (defaults to the initialize cwd). */
  cwd?: string
  /** Whether plan mode should be active from the first step. */
  planMode?: boolean
  /** Session approval policy override ('ask' | 'never'); absent keeps the deployment default. */
  approvalPolicy?: 'ask' | 'never'
}

/** Session creation result: the live session identity. */
export interface SessionCreateResult {
  sessionId: string
}

/** One user turn on one bridge session. */
export interface SessionPromptParams {
  sessionId: string
  /** Prompt content blocks, sent verbatim as the user message. */
  contentBlocks: ContentBlock[]
}

/** Durable enqueue receipt for one prompt. */
export interface SessionPromptResult {
  messageId: string
}

/** Cancel the active turn on one bridge session. */
export interface SessionCancelParams {
  sessionId: string
  /** Preserve queued and steering inbox items instead of discarding them. */
  keepInbox?: boolean
}

/** Dispatch one slash-command line on the session's agent (dsh command registry). */
export interface SessionCommandParams {
  sessionId: string
  /** Complete command line, e.g. "/compact". */
  line: string
}

/** Command dispatch outcome. */
export interface SessionCommandResult {
  /** Whether a registered command handled the line (false = unknown, send as prompt). */
  dispatched: boolean
  /** The command's settled text result, when it produced one. */
  text?: string
}

/** Runtime per-session reconfiguration. */
export interface SessionConfigureParams {
  sessionId: string
  /** Switch plan mode on/off (applies between turns immediately). */
  planMode?: boolean
  /** Switch the session approval policy. */
  approvalPolicy?: 'ask' | 'never'
}

/** `approval/ask` server-to-client request: one approval decision is needed. */
export interface ApprovalAskParams {
  /** Session the ask belongs to. */
  sessionId: string
  /** Opaque id pairing this ask with its response. */
  id: string
  /** The tool the question is about (already mapped to the client's vocabulary). */
  toolName: string
  /** The exact tool call being decided, when the asker has one. */
  callId?: string
  /** The asker's human-readable explanation of why it is asking. */
  reason?: string
}

/** Response to `approval/ask`. */
export interface ApprovalAskResult {
  outcome: 'allowed-once' | 'rejected' | 'cancelled'
}

/** `question/ask` server-to-client request: a human answer is needed. */
export interface QuestionAskParams {
  /** Session the question belongs to ('' when agentless). */
  sessionId: string
  /** Questions to display, verbatim from the dsh user-questions seam. */
  questions: AskUserQuestionItem[]
}

/** Response to `question/ask`. */
export interface QuestionAskResult {
  answers: AskUserQuestionAnswerItem[]
}

/** `session.event` notification: one session-log event, streamed as recorded. */
export interface SessionEventNotification {
  sessionId: string
  event: SessionEvent
}

/** `session.status` notification: whole-agent lifecycle state. */
export interface SessionStatusNotification {
  sessionId: string
  status: 'idle' | 'running'
}

/** Server-to-client notifications by JSON-RPC method name. */
export interface BridgeNotificationMap {
  'session.event': SessionEventNotification
  'session.status': SessionStatusNotification
}

/** Server-to-client requests by JSON-RPC method name. */
export interface BridgeServerRequestMap {
  'approval/ask': { params: ApprovalAskParams; result: ApprovalAskResult }
  'question/ask': { params: QuestionAskParams; result: QuestionAskResult }
}

/** Client-to-server request methods with their param and result shapes. */
export interface BridgeRequestMap {
  'initialize': { params: InitializeParams; result: InitializeResult }
  'session/create': { params: SessionCreateParams; result: SessionCreateResult }
  'session/prompt': { params: SessionPromptParams; result: SessionPromptResult }
  'session/cancel': { params: SessionCancelParams; result: Record<string, never> }
  'session/configure': { params: SessionConfigureParams; result: Record<string, never> }
  'session/command': { params: SessionCommandParams; result: SessionCommandResult }
  'shutdown': { params: undefined; result: Record<string, never> }
}
