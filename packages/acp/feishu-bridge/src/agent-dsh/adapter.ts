/**
 * DshAgentAdapter: the cc-connect Agent interface implemented over dsh's
 * `ctx.agents` registry (plan D1), replacing Go agent/dsh + the stdio
 * JSON-RPC bridge. Every engine session is a native dsh agent:
 * `ctx.agents.create({sessionId, meta:{cwd}, agentOptions})` for a fresh
 * session, `ctx.agents.resume({resumeSessionId, agentOptions})` to pick a
 * persisted one back up. Provider switching = dispose + resume with new
 * agentOptions (transcript preserved).
 *
 * dsh session events (`session/event`) project into the engine's Event
 * stream; `agent/disposed` closes the channel (the Go process-exit path).
 *
 * Structural context surface: the adapter only needs `ctx.agents` and
 * `ctx.on`, so unit tests inject fakes without booting Cordis.
 *
 * @module dsh-feishu-bridge/agent-dsh
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  ContinueSession,
  EventChannel,
} from '../core/types.js'
import type {
  AgentSession,
  AgentSessionInfo,
  FileAttachment,
  ImageAttachment,
  PermissionResult,
} from '../core/types.js'

/** Minimal structural member of a dsh Agent the adapter drives. */
export interface DshAgentLike {
  readonly id: unknown
  readonly status: 'idle' | 'running'
  followup(message: unknown): void
  cancel(cause: { kind: string }, options?: { keepInbox?: boolean }): void
}

/** Handle returned by ctx.agents.create/resume. */
export interface DshAgentHandleLike {
  agent: DshAgentLike
  dispose(): Promise<void>
}

/** Create options accepted by the registry subset the adapter uses. */
export interface DshCreateOptionsLike {
  sessionId?: unknown
  resumeSessionId?: unknown
  meta?: { cwd?: string }
  agentOptions?: { provider?: string; model?: string; reasoningEffort?: string }
}

/** Minimal ctx.agents registry surface (structural slice of AgentRegistry). */
export interface DshAgentsRegistryLike {
  create(options: DshCreateOptionsLike): Promise<DshAgentHandleLike>
  resume(options: DshCreateOptionsLike): Promise<DshAgentHandleLike>
  get(id: unknown): DshAgentLike | undefined
}

/** Minimal ctx surface: event subscription with disposer return. */
export interface DshContextLike {
  agents: DshAgentsRegistryLike
  on(event: string, listener: (...args: never[]) => unknown): () => void
}

/** One named provider route (plan D2: one llm route per provider). */
export interface ProviderRoute {
  name: string
  provider: string
  model: string
  reasoningEffort?: string
}

/** Adapter construction config. */
export interface DshAdapterConfig {
  agentName: string
  cwd: string
  /** Named routes; the active one supplies create/resume agentOptions. */
  providers: ProviderRoute[]
  activeProvider: string
}

/**
 * Strip the "[1m]" model alias: it is fingerprint-gated to genuine Claude
 * Code clients on some gateways (bigmodel coding plan); the plain name
 * accepts any client and carries the same window (Go dshSession).
 */
export function stripModelAlias(model: string): string {
  if (model.endsWith('[1m]')) return model.slice(0, -'[1m]'.length)
  return model
}

/** Adapter configuration (providers + active route). */
export class DshAgentAdapter {
  private readonly ctx: DshContextLike
  private readonly cfg: DshAdapterConfig
  private readonly sessionsByEngineKey = new Map<string, DshAgentSession>()
  private readonly liveSessions = new Map<string, DshAgentSession>()
  private env: string[] = []
  private modeOverride = ''
  private readonly disposers: Array<() => void> = []

  constructor(ctx: DshContextLike, cfg: DshAdapterConfig) {
    this.ctx = ctx
    this.cfg = cfg
    // session/event projection: route each durable event to the live
    // engine session sharing the agent/session id.
    const onSessionEvent = (session: { id: unknown }, event: Record<string, unknown>): void => {
      const target = this.liveSessions.get(String(session.id))
      if (target !== undefined) target.projectSessionEvent(event)
    }
    this.disposers.push(ctx.on('session/event', onSessionEvent))
    // A disposed agent is the Go "process exited" signal: close the channel.
    const onAgentDisposed = (payload: { agent: DshAgentLike }): void => {
      const target = this.liveSessions.get(String(payload.agent.id))
      if (target !== undefined) target.markDisposed()
    }
    this.disposers.push(ctx.on('agent/disposed', onAgentDisposed))
  }

  /** Agent display name (engine /status, /list headers). */
  name(): string {
    return this.cfg.agentName
  }

  /** The active named route. */
  activeRoute(): ProviderRoute | undefined {
    return this.cfg.providers.find(p => p.name === this.cfg.activeProvider)
  }

  /** agentOptions for the active route (with the [1m] alias stripped). */
  private routeAgentOptions(): { provider: string; model: string; reasoningEffort?: string } {
    const route = this.activeRoute()
    const provider = route?.provider ?? ''
    const model = stripModelAlias(route?.model ?? '')
    const reasoningEffort = route?.reasoningEffort
    return {
      provider,
      model,
      ...(reasoningEffort !== undefined && reasoningEffort !== '' ? { reasoningEffort } : {}),
    }
  }

  /** SessionEnvInjector: per-session env captured for the next startSession. */
  setSessionEnv(env: string[]): void {
    this.env = [...env]
  }

  /** SessionModeInjector: one-shot mode override consumed by startSession. */
  setSessionMode(mode: string): void {
    this.modeOverride = mode
  }

  /**
   * Start (or resume) the agent session the engine identified. An empty id
   * (or the ContinueSession sentinel) creates a fresh native session keyed
   * by the engine session key; a concrete id resumes that persisted session.
   */
  async startSession(sessionID: string): Promise<AgentSession> {
    const envKey = this.env.find(e => e.startsWith('CC_SESSION_KEY='))?.slice('CC_SESSION_KEY='.length) ?? ''
    const key = envKey !== '' ? envKey : sessionID
    const isResume = sessionID !== '' && sessionID !== ContinueSession

    const existing = this.sessionsByEngineKey.get(key)
    if (existing !== undefined && existing.alive()) return existing

    let handle: DshAgentHandleLike
    if (isResume) {
      handle = await this.ctx.agents.resume({
        resumeSessionId: SessionId(sessionID),
        agentOptions: this.routeAgentOptions(),
      })
    } else {
      handle = await this.ctx.agents.create({
        sessionId: SessionId(key),
        meta: { cwd: this.cfg.cwd },
        agentOptions: this.routeAgentOptions(),
      })
    }
    const session = new DshAgentSession(key, handle)
    if (this.modeOverride !== '') {
      // TODO(M3): map onto ctx.get('planMode').set(agent, mode) once the
      // permission-mode milestone lands; the override is consumed here.
      this.modeOverride = ''
    }
    this.sessionsByEngineKey.set(key, session)
    this.liveSessions.set(session.currentSessionID(), session)
    return session
  }

  /**
   * TODO(M7 usage): dsh has no native "list persisted sessions" API on the
   * registry yet; /sessions relies on this returning what the backend knows.
   * M1 reports none — the parent session verifies the real surface.
   */
  listSessions(): Promise<AgentSessionInfo[]> {
    return Promise.resolve([...this.liveSessions.values()].map(s => ({
      id: s.currentSessionID(),
      summary: s.lastAssistantText().slice(0, 40),
      messageCount: 0,
      modifiedAt: s.lastActivityAt,
    })))
  }

  /** Dispose every live agent (engine shutdown). */
  async stop(): Promise<void> {
    const all = [...this.liveSessions.values()]
    this.liveSessions.clear()
    this.sessionsByEngineKey.clear()
    await Promise.all(all.map(s => s.close()))
  }

  /** Tear down event subscriptions. */
  dispose(): void {
    for (const d of this.disposers) d()
  }
}

/** Stringify an unknown wire value safely (branded ids, raw JSON strings). */
function toStr(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** Text content of a block list, joined in order. */
function textOfBlocks(blocks: readonly ContentBlock[] | undefined): string {
  if (blocks === undefined) return ''
  let out = ''
  for (const block of blocks) {
    if (block.type === 'text') out += block.text
  }
  return out
}

/** Reasoning content of a block list (M1 preview surface). */
function thinkingOfBlocks(blocks: readonly ContentBlock[] | undefined): string {
  if (blocks === undefined) return ''
  let out = ''
  for (const block of blocks) {
    if (block.type === 'reasoning') out += block.text
  }
  return out
}

/** One live engine session backed by a native dsh agent. */
export class DshAgentSession implements AgentSession {
  private readonly key: string
  private handle: DshAgentHandleLike
  private readonly channel = new EventChannel()
  private disposed = false
  private turnText = ''
  private lastText = ''
  private usage: { inputTokens?: number; totalInputTokens?: number; outputTokens?: number } = {}
  lastActivityAt = Date.now()

  constructor(key: string, handle: DshAgentHandleLike) {
    this.key = key
    this.handle = handle
  }

  /** The engine-side session key (diagnostics). */
  sessionKey(): string {
    return this.key
  }

  currentSessionID(): string {
    return String(this.handle.agent.id)
  }

  alive(): boolean {
    return !this.disposed
  }

  /** Most recent assistant text (listSessions summaries). */
  lastAssistantText(): string {
    return this.lastText
  }

  /**
   * Send one user turn: a followup message carrying the prompt text plus
   * attachment references (M1: paths are not staged yet — named attachments
   * ride along as a note; media staging arrives with the media milestone).
   */
  send(prompt: string, images: ImageAttachment[], files: FileAttachment[]): Promise<void> {
    this.lastActivityAt = Date.now()
    let content = prompt
    const names = [
      ...images.map(i => i.fileName).filter(n => n !== undefined),
      ...files.map(f => f.fileName),
    ]
    if (names.length > 0) {
      content = `${content}\n\n(attachments: ${names.join(', ')})`
    }
    this.handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: content }],
      source: { kind: 'user' },
    }))
    return Promise.resolve()
  }

  /**
   * TODO(M3): permission decisions route through the approval service's
   * answerer. M1 agents never emit permission_request, so this is a no-op.
   */
  respondPermission(_requestID: string, _result: PermissionResult): Promise<void> {
    return Promise.resolve()
  }

  events(): EventChannel {
    return this.channel
  }

  /** Dispose the native agent; buffered events drain as channel-closed. */
  async close(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.channel.close()
    try {
      await this.handle.dispose()
    } catch (error) {
      console.error(`agent-dsh: dispose failed (${this.key}): ${String(error)}`)
    }
  }

  /** The agent vanished underneath (agent/disposed): Go process-exit path. */
  markDisposed(): void {
    if (this.disposed) return
    this.disposed = true
    this.channel.close()
  }

  /** Cancel the in-flight turn (user stop; Go Interrupt semantics). */
  cancelTurn(): void {
    this.handle.agent.cancel({ kind: 'user' }, { keepInbox: false })
  }

  /** Project one durable session event into the engine Event stream. */
  projectSessionEvent(event: Record<string, unknown>): void {
    this.lastActivityAt = Date.now()
    switch (toStr(event.type)) {
      case 'turn/start': {
        this.turnText = ''
        break
      }
      case 'assistant/chunk': {
        const chunk = event.chunk as { type?: string; text?: string } | undefined
        if (chunk?.type === 'text-delta') {
          this.channel.push({ type: 'text_delta', content: chunk.text ?? '', done: false })
        } else if (chunk?.type === 'reasoning-delta') {
          this.channel.push({ type: 'thinking_delta', content: chunk.text ?? '', done: false })
        }
        break
      }
      case 'assistant/message': {
        const message = event.message as { content?: ContentBlock[] } | undefined
        const text = textOfBlocks(message?.content)
        const thinking = thinkingOfBlocks(message?.content)
        if (text !== '') {
          this.turnText = text
          this.channel.push({ type: 'text', content: text, done: false })
        }
        if (thinking !== '') {
          this.channel.push({ type: 'thinking', content: thinking, done: false })
        }
        const usage = event.usage as
          | { inputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number; outputTokens?: number }
          | undefined
        if (usage !== undefined) {
          const input = usage.inputTokens ?? 0
          const cached = (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0)
          this.usage = {
            inputTokens: input,
            totalInputTokens: input + cached,
            ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
          }
        }
        break
      }
      case 'tool/call': {
        this.channel.push({
          type: 'tool_use',
          toolName: toStr(event.name),
          toolInput: toStr(event.arguments),
          toolID: toStr(event.callId),
          content: '',
          done: false,
        })
        break
      }
      case 'tool/result': {
        const message = event.message as { content?: ContentBlock[] } | undefined
        this.channel.push({
          type: 'tool_result',
          toolResult: textOfBlocks(message?.content),
          content: '',
          done: false,
        })
        break
      }
      case 'turn/end': {
        // The turn's final reply is its last assistant text (the Go SDK
        // `result` field equivalent); carry the turn's usage with it.
        this.lastText = this.turnText
        this.channel.push({
          type: 'result',
          content: this.turnText,
          done: true,
          ...this.usage,
        })
        this.usage = {}
        break
      }
      default:
        break
    }
  }
}
