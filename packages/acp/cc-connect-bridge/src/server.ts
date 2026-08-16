/**
 * cc-connect bridge server over one booted harness context and JSON-RPC
 * transport peer. Extends the stock SDK server's responsibilities with the
 * three things cc-connect needs that the SDK wire lacks: session create with
 * resume, turn cancel, and the two server-to-client decision requests that
 * bridge dsh's approval and user-questions capability seams to the client.
 *
 * The surrounding context owns plugins, persistence, and configured adapters;
 * this class only translates between the wire and the seams:
 * - `ctx.agents` create/resume + `agent.followup`/`agent.cancel`
 * - `ctx.on('approval/request')` answerer → `approval/ask` request
 * - `ctx.userQuestions` provider → `question/ask` request (carries both
 *   ask_user_question and plan-mode's exit_plan_mode review)
 * - `ctx.planMode`/`ctx.approval` runtime switches via `session/configure`
 *
 * @module dsh-cc-connect-bridge/server
 */

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import type {
  ApprovalAskParams,
  ApprovalAskResult,
  InitializeParams,
  InitializeResult,
  QuestionAskParams,
  QuestionAskResult,
  SessionCancelParams,
  SessionCommandParams,
  SessionCommandResult,
  SessionConfigureParams,
  SessionCreateParams,
  SessionCreateResult,
  SessionPromptParams,
  SessionPromptResult,
} from './types.js'

/** Outbound peer surface the server needs (request with optional abort signal + notify). */
export interface BridgeTransport {
  request(method: string, params: object, signal?: AbortSignal): Promise<unknown>
  notify(method: string, params?: object): void
}

/** One live bridge-owned session. */
interface SessionRecord {
  handle: AgentHandle
  /** Last-known runtime overrides, replayed onto a recovered agent. */
  overrides: Pick<SessionConfigureParams, 'planMode' | 'approvalPolicy'>
  /** In-flight recovery; concurrent prompts share one resume. */
  recovery?: Promise<AgentHandle> | undefined
}

/**
 * Bridge server over one booted harness context and transport peer.
 * Construction subscribes to session and agent lifecycle events and claims
 * the approval answerer / user-questions provider roles until shutdown.
 */
export class CcConnectBridgeServer {
  private cwd = process.cwd()
  private provider = 'deepseek-official'
  private model = 'deepseek-v4-flash'
  private maxTokens: number | undefined
  private reasoningEffort: string | undefined
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly sessionCreations = new Map<string, Promise<SessionCreateResult>>()
  private readonly disposers: (() => void)[] = []
  private shutdownTask: Promise<Record<string, never>> | undefined
  private shuttingDown = false

  constructor(
    private readonly ctx: Context,
    private readonly transport: BridgeTransport,
  ) {
    this.disposers.push(ctx.on('session/event', (session, event) => {
      this.transport.notify('session.event', { sessionId: String(session.id), event })
    }))
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      this.transport.notify('session.status', { sessionId: String(agent.session.id), status })
    }))
    this.disposers.push(ctx.on('approval/request', async (req, _next): Promise<ApprovalOutcome> => {
      const sessionId = String(req.agent.session.id)
      const id = randomUUID()
      const params: ApprovalAskParams = {
        sessionId,
        id,
        toolName: req.toolName,
        ...(req.callId === undefined ? {} : { callId: String(req.callId) }),
        ...(req.reason === undefined ? {} : { reason: req.reason }),
      }
      try {
        const result = await this.transport.request('approval/ask', params, req.signal) as ApprovalAskResult
        return result.outcome
      } catch {
        // Transport closed or the ask was aborted/withdrawn. The fail-closed
        // default ('unavailable') is applied by the approval service when an
        // answerer throws; mirror it explicitly for clarity.
        return 'unavailable'
      }
    }))
    const questions = ctx.get('userQuestions')
    if (questions !== undefined) {
      const unregister = questions.registerProvider({
        ask: async (request): Promise<AskUserQuestionAnswer> => {
          const params: QuestionAskParams = {
            sessionId: request.agent === undefined ? '' : String(request.agent.session.id),
            questions: [...request.questions],
          }
          const result = await this.transport.request('question/ask', params, request.signal) as QuestionAskResult
          return { answers: [...result.answers] }
        },
      })
      this.disposers.push(unregister)
    }
  }

  /**
   * Configure the bridge route defaults applied to every created session.
   * @param params - bridge handshake parameters.
   * @returns server identity for the handshake.
   */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    if (params.maxTokens !== undefined
      && (!Number.isSafeInteger(params.maxTokens) || params.maxTokens <= 0)) {
      throw new TypeError('initialize maxTokens must be a positive safe integer')
    }
    this.cwd = resolve(params.cwd)
    this.provider = params.provider
    this.model = params.model
    this.maxTokens = params.maxTokens
    this.reasoningEffort = params.reasoningEffort
    return { serverInfo: { name: 'dsh-cc-connect-bridge', version: '0.1.0' } }
  }

  /**
   * Create a fresh session (or resume a persisted one) with the given bridge
   * session id, applying the optional plan-mode and approval-policy overrides
   * before the first turn.
   * @param params - identity, resume target, and per-session overrides.
   * @returns the live session identity.
   */
  async createSession(params: SessionCreateParams): Promise<SessionCreateResult> {
    if (this.shuttingDown) throw new Error('bridge server is shutting down')
    if (typeof params.sessionId !== 'string' || params.sessionId === '') {
      throw new TypeError('session/create requires a non-empty sessionId')
    }
    const existing = this.sessions.get(params.sessionId)
    if (existing !== undefined) return { sessionId: params.sessionId }
    const pending = this.sessionCreations.get(params.sessionId)
    if (pending !== undefined) return pending

    const creation = this.doCreateSession(params)
    this.sessionCreations.set(params.sessionId, creation)
    void creation.then(
      () => { this.sessionCreations.delete(params.sessionId) },
      () => { this.sessionCreations.delete(params.sessionId) },
    )
    return creation
  }

  private async doCreateSession(params: SessionCreateParams): Promise<SessionCreateResult> {
    let handle: AgentHandle
    if (params.resumeSessionId !== undefined && params.resumeSessionId !== '') {
      handle = await this.ctx.agents.resume({
        resumeSessionId: SessionId(params.resumeSessionId),
        agentOptions: this.routeAgentOptions(),
      })
    } else {
      const cwd = resolve(params.cwd ?? this.cwd)
      handle = await this.ctx.agents.create({
        sessionId: SessionId(params.sessionId),
        meta: { cwd },
        agentOptions: this.routeAgentOptions(),
      })
    }
    const record: SessionRecord = {
      handle,
      overrides: {
        ...params.planMode === undefined ? {} : { planMode: params.planMode },
        ...params.approvalPolicy === undefined ? {} : { approvalPolicy: params.approvalPolicy },
      },
    }
    this.sessions.set(params.sessionId, record)
    this.applySessionOverrides(handle.agent, params)
    return { sessionId: params.sessionId }
  }

  /** Route defaults applied to every agent this bridge creates or recovers. */
  private routeAgentOptions() {
    return {
      provider: this.provider,
      model: this.model,
      ...this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens },
      ...this.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(this.reasoningEffort) },
    }
  }

  /**
   * Return a live handle for the session. A Cordis HMR loop-only reload (a
   * profile cordis.patch.yml edit) disposes the loop's agents while the
   * bridge record survives; recover by resuming the persisted session under
   * the same id and replaying the last-known overrides. Mid-turn disposals
   * are not covered here — the client's stall watchdog owns that path.
   */
  private async ensureLive(sessionId: string, rec: SessionRecord): Promise<AgentHandle> {
    if (this.ctx.agents.get(rec.handle.agent.id) === rec.handle.agent) return rec.handle
    if (this.shuttingDown) {
      throw new Error(`session agent was disposed outside the bridge: ${sessionId}`)
    }
    rec.recovery ??= (async () => {
      try {
        const handle = await this.ctx.agents.resume({
          resumeSessionId: SessionId(sessionId),
          agentOptions: this.routeAgentOptions(),
        })
        rec.handle = handle
        this.applySessionOverrides(handle.agent, rec.overrides)
        return handle
      } catch (error) {
        throw new Error(`failed to recover disposed session agent ${sessionId}: ${String(error)}`)
      } finally {
        rec.recovery = undefined
      }
    })()
    return rec.recovery
  }

  /**
   * Queue one identified prompt without assigning later activity to it.
   * @param params - target session and user content.
   * @returns the durable message identity.
   */
  async prompt(params: SessionPromptParams): Promise<SessionPromptResult> {
    const rec = this.requireRecord(params.sessionId)
    const handle = await this.ensureLive(params.sessionId, rec)
    const message = createUserMessage({ content: params.contentBlocks, source: { kind: 'user' } })
    handle.agent.followup(message)
    return { messageId: message.id }
  }

  /**
   * Cancel the active turn on one session (user-initiated stop).
   * @param params - target session and inbox disposition.
   * @returns empty result.
   */
  async cancel(params: SessionCancelParams): Promise<Record<string, never>> {
    const rec = this.requireRecord(params.sessionId)
    rec.handle.agent.cancel({ kind: 'user' }, { keepInbox: params.keepInbox ?? false })
    return {}
  }

  /**
   * Dispatch one slash-command line through the dsh command registry on the
   * session's agent. Unknown commands report dispatched:false so the caller
   * can fall back to sending the line as an ordinary prompt.
   * @param params - target session and command line.
   * @returns whether a command handled the line, plus its settled text.
   */
  async command(params: SessionCommandParams): Promise<SessionCommandResult> {
    const rec = this.requireRecord(params.sessionId)
    const commands = this.ctx.get('commands')
    if (commands === undefined) return { dispatched: false }
    const controller = new AbortController()
    const execution = await commands.execute(rec.handle.agent, params.line, controller.signal)
    if (execution === undefined) return { dispatched: false }
    return {
      dispatched: true,
      ...typeof execution.result?.text === 'string' ? { text: execution.result.text } : {},
    }
  }

  /**
   * Apply runtime per-session configuration switches.
   * @param params - target session and the switches to apply.
   * @returns empty result.
   */
  async configure(params: SessionConfigureParams): Promise<Record<string, never>> {
    const rec = this.requireRecord(params.sessionId)
    const handle = await this.ensureLive(params.sessionId, rec)
    if (params.planMode !== undefined) rec.overrides.planMode = params.planMode
    if (params.approvalPolicy !== undefined) rec.overrides.approvalPolicy = params.approvalPolicy
    this.applySessionOverrides(handle.agent, params)
    return {}
  }

  /**
   * Dispose bridge-owned agents and subscriptions to quiescence. The
   * surrounding context remains running (the plugin entry owns process exit).
   * @returns empty JSON-RPC result.
   */
  shutdown(): Promise<Record<string, never>> {
    this.shutdownTask ??= this.performShutdown()
    return this.shutdownTask
  }

  private async performShutdown(): Promise<Record<string, never>> {
    this.shuttingDown = true
    const pendingCreations = [...this.sessionCreations.values()]
    await Promise.allSettled(pendingCreations)
    this.sessionCreations.clear()
    const records = [...this.sessions.values()]
    this.sessions.clear()
    const failures: unknown[] = []
    while (this.disposers.length > 0) {
      try {
        this.disposers.pop()?.()
      } catch (error) {
        failures.push(error)
      }
    }
    const teardownResults = await Promise.allSettled(
      records.map(rec => Promise.resolve().then(() => rec.handle.dispose())),
    )
    failures.push(...teardownResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason as unknown))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'bridge server teardown failed')
    return {}
  }

  /**
   * Dispatch one incoming JSON-RPC request to its typed handler. Throws (→ a
   * JSON-RPC error response) on an unknown method.
   * @param method - the JSON-RPC method name.
   * @param params - the raw params object from the wire.
   * @returns the handler's result, to be serialized as the response.
   */
  async handleRequest(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize(params as unknown as InitializeParams)
      case 'session/create':
        return this.createSession(params as unknown as SessionCreateParams)
      case 'session/prompt':
        return this.prompt(params as unknown as SessionPromptParams)
      case 'session/cancel':
        return this.cancel(params as unknown as SessionCancelParams)
      case 'session/configure':
        return this.configure(params as unknown as SessionConfigureParams)
      case 'session/command':
        return this.command(params as unknown as SessionCommandParams)
      case 'shutdown':
        return this.shutdown()
      default:
        throw new Error(`unknown cc-connect bridge method: ${method}`)
    }
  }

  private requireRecord(sessionId: string): SessionRecord {
    const rec = this.sessions.get(sessionId)
    if (rec === undefined) throw new Error(`unknown bridge session: ${sessionId}`)
    return rec
  }

  private applySessionOverrides(agent: Agent, params: Pick<SessionConfigureParams, 'planMode' | 'approvalPolicy'>): void {
    if (params.planMode !== undefined) {
      const planMode = this.ctx.get('planMode')
      if (planMode === undefined) throw new Error('plan-mode plugin is not composed in this deployment')
      planMode.set(agent, params.planMode)
    }
    if (params.approvalPolicy !== undefined) {
      const approval = this.ctx.get('approval')
      if (approval === undefined) throw new Error('user-approval plugin is not composed in this deployment')
      approval.setPolicy(agent, params.approvalPolicy as ApprovalPolicy)
    }
  }
}
