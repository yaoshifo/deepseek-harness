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

import { randomBytes } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  ContinueSession,
  EventChannel,
  ForkAtSessionPrefix,
  ForkSessionPrefix,
} from '../core/types.js'
import { locateForkCut } from './fork-at.js'
import {
  buildChatroomSystemPrompt,
  subtaskAgentSystemPrompt,
  subtaskNoReportAgentSystemPrompt,
  subtaskResearchAssistantPrompt,
} from '../engine/chatroom-persona.js'
import { appendFileRefs, saveFilesToDisk, saveImagesToDisk } from '../engine/attachments.js'
import type {
  AgentSession,
  AgentSessionInfo,
  FileAttachment,
  ImageAttachment,
  PermissionResult,
  ProviderConfig,
} from '../core/types.js'

/** Minimal structural member of a dsh Agent the adapter drives. */
export interface DshAgentLike {
  readonly id: unknown
  readonly status: 'idle' | 'running'
  /** The agent's durable session log (fork seeds slice its completed turns). */
  readonly session: { readonly events: readonly SessionEvent[]; readonly header?: { readonly parentSession?: unknown } }
  followup(message: unknown): void
  steer(message: unknown): void
  cancel(cause: { kind: string }, options?: { keepInbox?: boolean }): void
}

/** Generated native session id for a NEW engine session (Go cc-... parity). */
function freshNativeSessionId(): string {
  const now = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `cc-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
    + `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
    + `-${randomBytes(6).toString('hex')}`
}

/** Structural slice of dsh AskUserQuestion items (M3 userQuestions provider). */
interface RawAskQuestionItem {
  id?: string
  question: string
  header?: string
  detail?: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
  intent?: { kind?: string; approve?: string }
}

/** Ask request the userQuestions service passes to the provider (M3). */
interface UserQuestionsAskRequest {
  questions: unknown[]
  agent?: { session?: { id?: string } }
  signal?: AbortSignal
}

/** Ask result the provider returns to the userQuestions service (M3). */
interface UserQuestionsAskResult {
  answers: Array<{ id: string; selected: string[]; custom?: string }>
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
  meta?: { cwd?: string; parentSession?: unknown; seedLength?: number }
  /** Fork seed: the parent's completed-turn prefix (see startSession). */
  seed?: readonly SessionEvent[]
  agentOptions?: { provider?: string; model?: string; reasoningEffort?: string }
  /**
   * Creation-time composition hook (plan D3): registers the chatroom bare
   * persona as a `complete: true` system-prompt section on the agent's
   * scoped context (the Go --bare DSH_CC_SYSTEM_PROMPT_COMPLETE equivalent).
   * Typed as the real dsh AgentSetup so a production Context typechecks.
   */
  setup?: import('@deepseek-ai/dsh-agent').AgentSetup
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
  get(name: string): unknown
}

/**
 * Structural slice of the `sessionPersistence` service the fork-at path
 * consumes: read the source log and persist the truncated copy. The profile's
 * jsonl backend (same on-disk format as Go's session root) satisfies it.
 */
export interface DshPersistenceLike {
  /** Immutable header plus current logical event log (live snapshot for a live session). */
  inspect(id: unknown): Promise<{ meta: SessionHeader; events: readonly SessionEvent[] }>
  /** Register a new session's metadata (lazy until the first append). */
  create(meta: SessionHeader): Promise<void>
  /** Durably persist a contiguous event batch. */
  append(id: unknown, events: readonly SessionEvent[]): Promise<void>
}

/** One named provider route (plan D2: one llm route per provider). */
export interface ProviderRoute {
  name: string
  provider: string
  model: string
  reasoningEffort?: string
  /** Context window in tokens; 0/unset = the project-level window (Go ContextWindow, #12). */
  contextWindow?: number
}

/** Adapter construction config. */
/**
 * Process-wide userQuestions routing shared by every project's adapter: the
 * singleton `userQuestions` service accepts exactly one provider, so one
 * adapter registers it lazily and asks dispatch to the adapter owning the
 * session (plan D4's caller-routing pattern, applied to questions).
 */
export interface QuestionRouting {
  /** Adapters created by this plugin application, in creation order. */
  adapters: DshAgentAdapter[]
  /** Whether the shared provider has been registered (lazily, on first session). */
  registered: boolean
}

/** Per-project constructor options for the DSH agent adapter. */
export interface DshAdapterConfig {
  agentName: string
  cwd: string
  /** Named routes; the active one supplies create/resume agentOptions. */
  providers: ProviderRoute[]
  activeProvider: string
  /** Shared routing for multi-project daemons; absent = single-adapter fallback. */
  questionRouting?: QuestionRouting
}

/**
 * Strip the "[1m]" model alias: it is fingerprint-gated to genuine Claude
 * Code clients on some gateways (bigmodel coding plan); the plain name
 * accepts any client and carries the same window (Go dshSession).
 *
 * @param model - the model name, possibly carrying the "[1m]" alias suffix.
 * @returns the model name with the "[1m]" suffix removed.
 */
export function stripModelAlias(model: string): string {
  if (model.endsWith('[1m]')) return model.slice(0, -'[1m]'.length)
  return model
}

/**
 * The balanced completed-turn prefix of a live parent agent's session log:
 * every event up to and including the last `turn/end` (the in-flight turn is
 * unbalanced and cannot replay as a child session). The /fork child is seeded
 * with exactly this prefix, mirroring Go's copyForkSession on-disk copy.
 * Because live sequence numbers equal array indexes, the slice stays a valid
 * seed contiguous from seq 0.
 */
function completedTurnPrefix(parent: DshAgentLike): SessionEvent[] {
  return trimCompletedTurnPrefix(parent.session.events)
}

/**
 * Every event up to and including the last `turn/end` of an event log (the
 * in-flight turn is unbalanced and cannot replay as a child session). Valid
 * for both live registry views and persisted logs — sequence numbers equal
 * array indexes in both, so the slice stays a seed contiguous from seq 0.
 *
 * @param events - the source session's event log.
 * @returns the balanced completed-turn prefix; empty when no turn ended yet.
 */
function trimCompletedTurnPrefix(events: readonly SessionEvent[]): SessionEvent[] {
  const lastEnd = events.findLast(e => e.type === 'turn/end')
  if (lastEnd === undefined) return []
  return events.slice(0, lastEnd.seq + 1)
}

/** Read an env-flag value ("1") from the injected env list. */
function envHasFlag(env: string[], name: string): boolean {
  return env.includes(`${name}=1`)
}

/** Read a plain env value ('' when absent). */
function envValue(env: string[], name: string): string {
  return env.find(e => e.startsWith(`${name}=`))?.slice(name.length + 1) ?? ''
}

/**
 * Whether the session env flags mark it unattended, the sessions Go's
 * effectiveMode elevates to bypassPermissions: agent-delegated subtask
 * children without a human in the group, and chatroom role / direct-role
 * personas — approval prompts there stall on nobody who can answer. An
 * attended subtask (a human has spoken in the child group) and a moderator
 * keep the normal approval path.
 *
 * @param env - The session env built by the engine's buildSessionEnv.
 * @returns True when tool-permission requests auto-approve for this session.
 */
export function sessionBypassesPermissions(env: string[]): boolean {
  const unattendedSubtask = envHasFlag(env, 'CC_SUBTASK') && !envHasFlag(env, 'CC_SUBTASK_ATTENDED')
  return unattendedSubtask || envHasFlag(env, 'CC_CHATROOM_ROLE') || envHasFlag(env, 'CC_CHATROOM_DIRECT_ROLE')
}

/**
 * The #18 workspace routing section: CC_FEISHU_* env entries the engine
 * attached to the session become a system-prompt section naming the bot's
 * default Feishu workspace (the D3 setup-hook replacement for Go's
 * subprocess env the feishu-search/lark-guide skills read).
 *
 * @param env - The session env built by the engine's buildSessionEnv.
 * @returns The prompt section text; '' when no workspace is configured.
 */
export function feishuWorkspaceSection(env: string[]): string {
  const wikiSpaceId = envValue(env, 'CC_FEISHU_WIKI_SPACE_ID')
  const folderToken = envValue(env, 'CC_FEISHU_FOLDER_TOKEN')
  const wikiNodeToken = envValue(env, 'CC_FEISHU_WIKI_NODE_TOKEN')
  const description = envValue(env, 'CC_FEISHU_WORKSPACE_DESC')
  if (wikiSpaceId === '' && folderToken === '' && wikiNodeToken === '' && description === '') return ''
  const lines: string[] = ['\n### 默认飞书工作空间（本 bot 的文档路由）']
  if (description !== '') lines.push(description)
  if (wikiSpaceId !== '') lines.push(`- CC_FEISHU_WIKI_SPACE_ID=${wikiSpaceId}`)
  if (folderToken !== '') lines.push(`- CC_FEISHU_FOLDER_TOKEN=${folderToken}`)
  if (wikiNodeToken !== '') lines.push(`- CC_FEISHU_WIKI_NODE_TOKEN=${wikiNodeToken}`)
  lines.push('')
  lines.push('这是本 bot 的默认 Wiki 空间/知识库路由：搜索和创建飞书文档时优先圈定到这里。创建落位优先级 wiki_node_token > wiki_space_id > folder_token，有值直接用、不要 fallback。')
  return `${lines.join('\n')}\n`
}

/**
 * Build the agents.create/resume setup hook for the env-flagged persona
 * (Go isChatroomBareSession + buildChatroomSystemPrompt): chatroom role /
 * direct-role / moderator sessions replace the whole system prompt. A
 * subtask child (Go buildAppendSystemPrompt's CC_SUBTASK branch) appends the
 * report / no-report preamble as a normal section — research assistants add
 * their contract on top. Plain sessions with a configured Feishu workspace
 * get only the #18 routing section.
 */
function buildSessionSetup(env: string[], workDir: string): import('@deepseek-ai/dsh-agent').AgentSetup | undefined {
  const isRole = envHasFlag(env, 'CC_CHATROOM_ROLE')
  const isDirect = envHasFlag(env, 'CC_CHATROOM_DIRECT_ROLE')
  const isModerator = envHasFlag(env, 'CC_CHATROOM_MODERATOR')
  const isSubtask = envHasFlag(env, 'CC_SUBTASK')
  const isResearchAssistant = envHasFlag(env, 'CC_RESEARCH_ASSISTANT')
  const isNoReport = envHasFlag(env, 'CC_SUBTASK_NO_REPORT')
  const workspaceText = feishuWorkspaceSection(env)
  if (!isRole && !isDirect && !isModerator) {
    if (!isSubtask) {
      // No persona and no workspace: no setup hook at all.
      if (workspaceText === '') return undefined
      return (agentCtx) => {
        const promptSvc = agentCtx.get('systemPrompt') as
          | { section(section: { name: string; order: number; text: string; complete?: boolean }): () => void }
          | undefined
        promptSvc?.section({ name: 'feishu-bridge-workspace', order: 110, text: workspaceText })
      }
    }
    const preamble = isNoReport
      ? subtaskNoReportAgentSystemPrompt()
      : `${subtaskAgentSystemPrompt()}${isResearchAssistant ? subtaskResearchAssistantPrompt() : ''}`
    return (agentCtx) => {
      const promptSvc = agentCtx.get('systemPrompt') as
        | { section(section: { name: string; order: number; text: string; complete?: boolean }): () => void }
        | undefined
      if (promptSvc === undefined) return
      if (workspaceText !== '') {
        promptSvc.section({ name: 'feishu-bridge-workspace', order: 110, text: workspaceText })
      }
      promptSvc.section({ name: 'feishu-bridge-subtask-preamble', order: 120, text: preamble })
    }
  }

  return (agentCtx) => {
    const promptSvc = agentCtx.get('systemPrompt') as
      | { section(section: { name: string; order: number; text: string; complete?: boolean }): () => void }
      | undefined
    if (promptSvc === undefined) return
    const text = buildChatroomSystemPrompt({
      workDir,
      isRole,
      isDirect,
      isModerator,
      research: envHasFlag(env, 'CC_CHATROOM_RESEARCH'),
      researchAssistantChild: envValue(env, 'CC_RESEARCH_ASSISTANT_CHILD'),
      ledgerDir: envValue(env, 'CC_CHATROOM_LEDGER'),
      platformPrompt: '',
    })
    if (text !== '') {
      promptSvc.section({ name: 'feishu-bridge-chatroom-persona', order: 0, text, complete: true })
    }
  }
}

/** Default one-shot budget (Go oneShotQuery default timeout). */
const oneShotDefaultTimeoutMs = 10 * 60_000

/** Cap on parentSession links walked when attributing a subagent child to
 * a live bridge session — guards against a corrupted lineage cycle. */
const subagentLineageMaxDepth = 8

/** Lightweight-query budget (Go LightweightQuery: 90s). */
export const lightweightQueryTimeoutMs = 90_000

/** Render-session fork budget (Go dsh RenderQuery: 15 minutes). */
export const renderQueryTimeoutMs = 15 * 60_000

/**
 * Map a claudecode-style effort alias onto the dsh per-session reasoning
 * effort (Go renderReasoningLevel). Render one-shots default to 'low' — deep
 * reasoning only burns the fork budget. 'off'/'none' omits the reasoning
 * option entirely (no thinking field on the wire); MODEL-DEPENDENT ceiling:
 * always-thinking models (e.g. glm-5.3 via mify) reject the omitted thinking
 * field with 400 — configure effort 'low' or higher for those. A rejected
 * effort is swallowed by the engine and falls back to the markdown card.
 *
 * @param effort - the claudecode-style effort alias to map.
 * @returns the dsh reasoning effort level; unknown aliases map to 'low'.
 */
export function renderReasoningLevel(effort: string): string {
  switch (effort.toLowerCase().trim()) {
    case 'off':
    case 'none':
      return 'off'
    case 'medium':
    case 'med':
      return 'medium'
    case 'high':
      return 'high'
    case 'max':
      return 'high'
    default:
      return 'low'
  }
}

/**
 * Creation-time setup hook registering a complete-replacement system prompt
 * (the same `complete: true` section mechanism as the chatroom bare persona).
 */
function buildCompletePromptSetup(systemPrompt: string): import('@deepseek-ai/dsh-agent').AgentSetup {
  return (agentCtx) => {
    const promptSvc = agentCtx.get('systemPrompt') as
      | { section(section: { name: string; order: number; text: string; complete?: boolean }): () => void }
      | undefined
    if (promptSvc === undefined) return
    promptSvc.section({ name: 'feishu-bridge-render-session', order: 0, text: systemPrompt, complete: true })
  }
}

/** Adapter configuration (providers + active route). */
export class DshAgentAdapter {
  private readonly ctx: DshContextLike
  private readonly cfg: DshAdapterConfig
  private readonly sessionsByEngineKey = new Map<string, DshAgentSession>()
  private readonly liveSessions = new Map<string, DshAgentSession>()
  private env: string[] = []
  private modeOverride = ''
  /** Project-level default session mode ('' = no default; 'plan' starts every session in plan mode). */
  private defaultMode = ''
  /** Raw plan_render.effort alias consumed by {@link renderQuery} (Go renderEffort). */
  private renderEffort = ''
  /** Mutable work dir: the engine's per-chat override switches it around StartSession (Go WorkDirSwitcher). */
  private workDir: string
  private readonly disposers: Array<() => void> = []
  /** Whether the userQuestions provider has been registered (lazy, M3). */
  private uqRegistered = false

  constructor(ctx: DshContextLike, cfg: DshAdapterConfig) {
    this.ctx = ctx
    this.cfg = cfg
    this.workDir = cfg.cwd
    cfg.questionRouting?.adapters.push(this)
    // session/event projection: route each durable event to the live
    // engine session sharing the agent/session id. Sessions outside
    // liveSessions fall through to subagent-lineage attribution: a
    // delegated child session's events project into its bridge ancestor's
    // channel so the tool-process card shows the child's activity.
    const onSessionEvent = (session: { id: unknown; header?: { parentSession?: unknown } }, event: Record<string, unknown>): void => {
      const target = this.liveSessions.get(String(session.id))
      if (target !== undefined) {
        target.projectSessionEvent(event)
        return
      }
      const ancestor = this.resolveSubagentAncestor(session)
      if (ancestor !== undefined) ancestor.projectSubagentEvent(String(session.id), event)
    }
    this.disposers.push(ctx.on('session/event', onSessionEvent))
    // A disposed agent is the Go "process exited" signal: close the channel.
    const onAgentDisposed = (payload: { agent: DshAgentLike }): void => {
      const target = this.liveSessions.get(String(payload.agent.id))
      if (target !== undefined) target.markDisposed()
    }
    this.disposers.push(ctx.on('agent/disposed', onAgentDisposed))
    // M3: Register the approval answerer. When dsh asks for tool permission,
    // emit a permission_request event into the engine's EventChannel and wait
    // for the engine's handlePendingPermission to call respondPermission.
    this.disposers.push(ctx.on('approval/request', async (req: never, _next: never): Promise<string> => {
      const r = req as { agent?: { session?: { id?: string } }; toolName?: string; callId?: string; reason?: string; signal?: AbortSignal }
      const sessionID = r.agent?.session?.id ?? ''
      const target = this.liveSessions.get(sessionID)
      if (target === undefined) return 'unavailable'
      // Go autoApprove: an unattended session approves directly — questions
      // (AskUserQuestion / ExitPlanMode) ride the separate userQuestions
      // channel and still surface as cards (#15).
      if (target.bypassPermissions) return 'allowed-once'
      const requestID = r.callId ?? sessionID
      const toolInputRaw = r.reason !== undefined ? { reason: r.reason } : {}
      target.emitPermissionRequest({
        requestID,
        toolName: r.toolName ?? '',
        toolInput: r.reason ?? '',
        toolInputRaw,
      })
      const decision = await target.awaitPermissionResponse(requestID, r.signal)
      return decision.outcome
    }))
  }

  /**
   * Lazily register the userQuestions provider on first agent creation
   * (M3). At constructor time the user-questions service may not be
   * composed yet; by the first session creation the plugin tree is fully
   * loaded and ctx.get('userQuestions') resolves. With shared question
   * routing the singleton service's one provider slot is taken exactly once
   * per plugin application and asks dispatch to the owning adapter
   * (multi-project daemons); without it the adapter registers for itself
   * alone (single-adapter deployments and tests).
   */
  private ensureUserQuestionsProvider(): void {
    const routing = this.cfg.questionRouting
    if (routing !== undefined) {
      if (routing.registered) return
      routing.registered = true
    } else {
      if (this.uqRegistered) return
      this.uqRegistered = true
    }
    type UserQuestionsService = {
      registerProvider(p: {
        ask(req: UserQuestionsAskRequest): Promise<UserQuestionsAskResult>
      }): () => void
    }
    const uq = this.ctx.get('userQuestions') as UserQuestionsService | undefined
    if (uq === undefined) return
    this.disposers.push(uq.registerProvider({
      ask: async (request) => {
        const adapters = routing?.adapters ?? [this]
        for (const adapter of adapters) {
          const result = await adapter.handleUserQuestion(request)
          if (result !== undefined) return result
        }
        return { answers: [] }
      },
    }))
  }

  /**
   * Handle one userQuestions ask for a session owned by this adapter.
   *
   * @param request - The ask request carrying the agent session id.
   * @returns The answer result, or undefined when no live session of this
   * adapter matches (the shared provider then tries the next adapter).
   */
  async handleUserQuestion(request: UserQuestionsAskRequest): Promise<UserQuestionsAskResult | undefined> {
    const sessionID = request.agent?.session?.id ?? ''
    const target = this.liveSessions.get(sessionID)
    if (target === undefined) return undefined
    const qs = request.questions as RawAskQuestionItem[]
    // Plan-review asks (exit_plan_mode) are permission decisions, not
    // option menus: route them through the ExitPlanMode plan card and
    // map the allow/deny verdict back to answer semantics (Go
    // planReviewItem).
    const review = qs.find(q => q.intent?.kind === 'plan-review')
    if (review !== undefined) {
      return target.answerPlanReview(review, request.signal)
    }
    const requestID = `askq-${Date.now()}`
    const questions = qs.map(q => ({
      question: q.question,
      header: q.header ?? '',
      options: (q.options ?? []).map(o => ({
        label: o.label, description: o.description ?? '',
      })),
      multiSelect: q.multiSelect ?? false,
    }))
    target.emitPermissionRequest({
      requestID,
      toolName: 'AskUserQuestion',
      toolInput: '',
      toolInputRaw: { questions },
    })
    // Await the ANSWER TEXT (not the approval outcome): the engine's
    // handlePendingPermission stores the collected answers and settles
    // them through awaitPermissionResponse as the answer string for
    // AskUserQuestion flows.
    const answer = await target.awaitQuestionAnswer(
      requestID, request.signal, qs.length,
    )
    const items = qs.map((q, i) => ({
      id: q.id ?? q.question,
      selected: [answer[i] ?? ''],
    }))
    return { answers: items }
  }

  /**
   * Agent display name (engine /status, /list headers).
   *
   * @returns the configured agent display name.
   */
  name(): string {
    return this.cfg.agentName
  }

  /**
   * The active named route.
   *
   * @returns the route whose name matches the active provider, when one is configured.
   */
  activeRoute(): ProviderRoute | undefined {
    return this.cfg.providers.find(p => p.name === this.cfg.activeProvider)
  }

  /**
   * ModelSwitcher (Go ModelSwitcher): the active route's model, for the
   * status footer's 🤖 line. The [1m] alias stays stripped for display.
   *
   * @returns the active route's model with the [1m] alias stripped.
   */
  getModel(): string {
    return stripModelAlias(this.activeRoute()?.model ?? '')
  }

  /**
   * The active route's reasoning effort, for the reply footer (Go GetReasoningEffort).
   *
   * @returns the active route's reasoning effort, or '' when unset.
   */
  getReasoningEffort(): string {
    return this.activeRoute()?.reasoningEffort ?? ''
  }

  /** agentOptions for the active route (with the [1m] alias stripped). */
  private routeAgentOptions(): { provider: string; model: string; reasoningEffort?: string } {
    return this.agentOptionsForQuery('', '')
  }

  /**
   * agentOptions for a one-shot query (Go spawnConfigFor): a named provider
   * route when it matches, else the active route; `reasoning` (when
   * non-empty) overrides the route's configured effort.
   */
  private agentOptionsForQuery(providerName: string, reasoning: string): { provider: string; model: string; reasoningEffort?: string } {
    const route = providerName !== ''
      ? (this.cfg.providers.find(p => p.name === providerName) ?? this.activeRoute())
      : this.activeRoute()
    return {
      provider: route?.provider ?? '',
      model: stripModelAlias(route?.model ?? ''),
      ...(reasoning !== ''
        ? { reasoningEffort: reasoning }
        : (route?.reasoningEffort !== undefined && route.reasoningEffort !== '' ? { reasoningEffort: route.reasoningEffort } : {})),
    }
  }

  /**
   * SessionEnvInjector: per-session env captured for the next startSession.
   *
   * @param env - the KEY=value entries captured for the next startSession.
   */
  setSessionEnv(env: string[]): void {
    this.env = [...env]
  }

  /**
   * WorkDirSwitcher: the dir used for the next agents.create (Go SetWorkDir).
   *
   * @param dir - the working directory for the next agents.create.
   */
  setWorkDir(dir: string): void {
    this.workDir = dir
  }

  /**
   * WorkDirSwitcher: current work dir (Go GetWorkDir).
   *
   * @returns the current working directory.
   */
  getWorkDir(): string {
    return this.workDir
  }

  /**
   * SessionModeInjector: one-shot mode override consumed by startSession.
   *
   * @param mode - the mode name armed for the next startSession ('plan' or a non-plan mode).
   */
  setSessionMode(mode: string): void {
    this.modeOverride = mode
  }

  /**
   * Project default mode applied at every startSession when no one-shot override is armed (Go agent options mode).
   *
   * @param mode - the project default mode name ('plan' or a non-plan mode).
   */
  setDefaultMode(mode: string): void {
    this.defaultMode = mode
  }

  /**
   * ForkSessionPreparer (Go PrepareForkSession): verify the fork source is
   * reachable BEFORE the child group exists, so the engine's guard fails
   * fast. Reachability = live in the registry OR present in the persisted
   * log (Go reads disk, so a merely-persisted source forks too; the workDir
   * arguments stay unused — the persistence service resolves ids globally,
   * with none of Claude Code's per-cwd projects-dir locality).
   *
   * @param origID - the native id of the fork source session.
   * @param _parentWorkDir - unused: the seed source resolves live-first, then globally by id.
   * @param _childWorkDir - unused: seeding happens at startSession, not here.
   */
  async prepareForkSession(origID: string, _parentWorkDir: string, _childWorkDir: string): Promise<void> {
    if (this.ctx.agents.get(SessionId(origID)) !== undefined) return
    const seed = await this.persistedForkSeed(origID)
    if (seed === undefined) {
      throw new Error(`dsh: fork source session "${origID}" not found`)
    }
  }

  /**
   * The completed-turn prefix of a session that lives only in persistence
   * (daemon restart, idle-reaped parent) — the /fork seed fallback Go gets
   * for free by reading the on-disk transcript.
   *
   * @param origID - the native id of the fork source session.
   * @returns the persisted seed (possibly empty when the source has no
   * completed turn), or undefined when the service is absent or the session
   * is not in persistence.
   */
  private async persistedForkSeed(origID: string): Promise<SessionEvent[] | undefined> {
    const persistence = this.ctx.get('sessionPersistence') as DshPersistenceLike | undefined
    if (persistence === undefined) return undefined
    let events: readonly SessionEvent[]
    try {
      events = (await persistence.inspect(SessionId(origID))).events
    } catch {
      // The backend rejects unknown ids; that rejection is the only error
      // path (inspect of an existing session resolves), and it means "no
      // persisted seed".
      return undefined
    }
    return trimCompletedTurnPrefix(events)
  }

  /**
   * ForkAtPreparer (Go PrepareForkAtSession): copy the source transcript
   * through the sessionPersistence service, truncated to the turn the quoted
   * message belongs to, and persist the copy under a fresh id whose header
   * records childWorkDir — the engine starts the child with the
   * `__forkat__<newID>` sentinel, which startSession resumes directly. Unlike
   * Go (raw log-file copy) this needs no filesystem reachability: the service
   * resolves ids globally, and the source may be live or merely persisted.
   *
   * @param origID - the native id of the fork source session.
   * @param childWorkDir - the directory the copy's header records as cwd.
   * @param quotedText - the quoted-message text as the platform delivered it.
   * @param quotedSenderType - 'app' or 'user' sender of the quoted message.
   * @param quotedTimeMs - update time of the quoted message in unix ms; 0 = unknown.
   * @returns the fresh native id of the persisted truncated copy.
   */
  async prepareForkAtSession(
    origID: string,
    childWorkDir: string,
    quotedText: string,
    quotedSenderType: string,
    quotedTimeMs: number,
  ): Promise<string> {
    const persistence = this.ctx.get('sessionPersistence') as DshPersistenceLike | undefined
    if (persistence === undefined) {
      throw new Error('dsh: sessionPersistence service unavailable for fork-at')
    }
    let inspection: { meta: SessionHeader; events: readonly SessionEvent[] }
    try {
      inspection = await persistence.inspect(SessionId(origID))
    } catch (error) {
      throw new Error(`dsh: fork-at source session "${origID}" not found: ${String(error instanceof Error ? error.message : error)}`)
    }
    const keep = locateForkCut(inspection.events, {
      quotedText,
      senderType: quotedSenderType,
      quotedTimeMs,
    })
    const newID = freshNativeSessionId()
    // Go writeForkedLog parity: the copy's header rewrites only id and cwd,
    // keeping the lineage fields (createdAt, parentSession, …). seedLength is
    // re-stamped to the kept prefix — the whole copied log is inherited
    // history, and the boundary lets replay tell it from the child's own
    // turns (the fork-child-replay-seed-boundary Agent Note's rule).
    await persistence.create({
      ...inspection.meta,
      id: SessionId(newID),
      ...(childWorkDir !== '' ? { cwd: childWorkDir } : {}),
      seedLength: keep,
    })
    await persistence.append(SessionId(newID), inspection.events.slice(0, keep))
    return newID
  }

  /**
   * The engine session key owning a live native agent id, when this adapter
   * owns it. Routes feishu_bridge_subtask tool calls from the caller agent
   * back to its engine session (plan D4 — caller-agent routing, no env).
   * One-shot side-query sessions are deliberately excluded: they own no
   * engine session, so their agents are foreign callers.
   *
   * @param nativeID - the native dsh agent id to resolve.
   * @returns the owning engine session key, or undefined when this adapter owns no live session with that id.
   */
  engineKeyForAgentID(nativeID: string): string | undefined {
    const session = this.liveSessions.get(nativeID)
    if (session === undefined) return undefined
    return this.sessionsByEngineKey.get(session.sessionKey()) === session ? session.sessionKey() : undefined
  }

  /**
   * ForkQuerierWithProvider: a standalone one-shot turn without resuming
   * anything (Go LightweightQuery — group naming, predict-next): the context
   * lives in the prompt itself. Light text output needs no deep reasoning
   * (and thinking would eat most of the 90s budget), so the query runs at
   * reasoningEffort 'low'.
   *
   * @param prompt - the standalone question; all context lives in the prompt itself.
   * @param providerName - the named provider route to run on.
   * @param signal - caller abort; rejects the wait and still disposes the session.
   * @returns the turn's final text.
   */
  async lightweightQuery(prompt: string, providerName: string, signal?: AbortSignal): Promise<string> {
    return this.oneShotQuery({
      prompt,
      providerName,
      reasoning: 'low',
      ...(signal !== undefined ? { signal } : {}),
      timeoutMs: lightweightQueryTimeoutMs,
    })
  }

  /**
   * ForkQuerier: a side question against the full context of an existing
   * session without affecting the main conversation (Go ForkQuery — the
   * persisted-log copy becomes a completed-turn seed from the live parent).
   *
   * @param sessionID - the native id of the live parent session to seed from.
   * @param question - the side question asked against the parent's context.
   * @param workDir - the working directory for the one-shot session.
   * @returns the answer text.
   */
  async forkQuery(sessionID: string, question: string, workDir: string): Promise<string> {
    return this.oneShotQuery({ prompt: question, workDir, seed: this.seedForLiveParent(sessionID) })
  }

  /**
   * ForkQuerierWithProvider: {@link forkQuery} on a named provider route.
   *
   * @param sessionID - the native id of the live parent session to seed from.
   * @param question - the side question asked against the parent's context.
   * @param providerName - the named provider route to run on.
   * @param workDir - the working directory for the one-shot session.
   * @returns the answer text.
   */
  async forkSessionWithProvider(sessionID: string, question: string, providerName: string, workDir: string): Promise<string> {
    return this.oneShotQuery({
      prompt: question,
      providerName,
      workDir,
      seed: this.seedForLiveParent(sessionID),
    })
  }

  /**
   * Store the project's plan_render.effort alias (Go SetRenderEffort): the
   * engine's effort config reaches the render session's reasoning level
   * instead of being silently dropped. Raw alias; {@link renderQuery} maps
   * it (see renderReasoningLevel for the model-dependent "off" ceiling).
   *
   * @param effort - the raw effort alias from the project's plan_render config.
   */
  setRenderEffort(effort: string): void {
    this.renderEffort = effort
  }

  /**
   * RenderQuerier (Go dsh RenderQuery): an isolated render session — fresh
   * session (no resume), whole-prompt replacement via the setup hook, full
   * tools, explicit sessionEnv so concurrent renders don't crosstalk. The
   * render one-shot does not need deep reasoning, so an unset effort
   * defaults to 'low' (an unset effort once made renders burn ~21k thinking
   * chars for an 84-char artifact). The 15m budget mirrors the Go fork.
   *
   * @param prompt - the render task prompt.
   * @param providerName - the named provider route to run on.
   * @param systemPrompt - the complete-replacement system prompt for the render session.
   * @param sessionEnv - accepted for Go parity; dsh one-shots spawn in-process, so it is unused.
   * @param signal - caller abort; rejects the wait and still disposes the session.
   * @returns the session's trimmed stdout.
   */
  async renderQuery(
    prompt: string,
    providerName: string,
    systemPrompt: string,
    sessionEnv: string[],
    signal?: AbortSignal,
  ): Promise<string> {
    void sessionEnv // dsh one-shots spawn in-process (no subprocess env; Go env is claudecode-specific)
    return this.oneShotQuery({
      prompt,
      providerName,
      systemPromptComplete: systemPrompt,
      reasoning: renderReasoningLevel(this.renderEffort),
      ...(signal !== undefined ? { signal } : {}),
      timeoutMs: renderQueryTimeoutMs,
    })
  }

  /**
   * ProviderSwitcher (Go dsh ProviderSwitcher): the named-route registry and
   * its active pointer. Route DETAIL (service route name, model) stays owned
   * by the plugin config — the switcher surface only owns membership and the
   * active pointer, so an engine-side rebuild keeps detail for known names
   * and carries none for freshly introduced ones.
   *
   * @param providers - the new provider name set; known names keep their configured route detail.
   */
  setProviders(providers: ProviderConfig[]): void {
    const byName = new Map(this.cfg.providers.map(r => [r.name, r]))
    this.cfg.providers = providers.map(pc => byName.get(pc.name) ?? { name: pc.name, provider: '', model: '' })
    if (!providers.some(pc => pc.name === this.cfg.activeProvider)) {
      this.cfg.activeProvider = providers[0]?.name ?? ''
    }
  }

  /**
   * ProviderSwitcher: point the active route at a known name.
   *
   * @param name - the route name to activate, or '' to clear the selection.
   * @returns whether the name exists in the registry; clearing always succeeds.
   */
  setActiveProvider(name: string): boolean {
    // '' clears the selection (Go SetActiveProvider("") semantics): the
    // next startSession falls back to the dsh default route.
    if (name === '') {
      this.cfg.activeProvider = ''
      return true
    }
    if (!this.cfg.providers.some(r => r.name === name)) return false
    this.cfg.activeProvider = name
    return true
  }

  /**
   * ProviderSwitcher: the active route as a name-only config plus its
   * context window, which the engine re-resolves on every switch (Go
   * ProviderConfig.ContextWindow).
   *
   * @returns the active provider, or undefined when the selection is empty or unknown.
   */
  getActiveProvider(): ProviderConfig | undefined {
    const name = this.cfg.activeProvider
    if (name === '' || !this.cfg.providers.some(r => r.name === name)) return undefined
    const route = this.cfg.providers.find(r => r.name === name)
    return { name, ...(route?.contextWindow !== undefined ? { contextWindow: route.contextWindow } : {}) }
  }

  /**
   * ProviderSwitcher: the registry's routes as name-only configs.
   *
   * @returns the configured routes.
   */
  listProviders(): ProviderConfig[] {
    return this.cfg.providers.map(r => ({ name: r.name }))
  }

  /**
   * The completed-turn seed for a one-shot side query against a live parent
   * (Go copies the persisted log; the registry requires a balanced prefix,
   * so an in-flight parent turn is excluded).
   */
  private seedForLiveParent(sessionID: string): readonly SessionEvent[] {
    const parent = this.ctx.agents.get(SessionId(sessionID))
    return parent !== undefined ? completedTurnPrefix(parent) : []
  }

  /**
   * Run one standalone turn on a fresh native session and dispose it (Go
   * oneShotQuery): create (optionally seeded, on the named route), send the
   * prompt, collect the turn's final text, then close. A failed turn
   * surfaces its error text; the timeout (or caller signal) aborts the wait
   * and still disposes the session.
   */
  private async oneShotQuery(opts: {
    prompt: string
    providerName?: string
    reasoning?: string
    workDir?: string
    seed?: readonly SessionEvent[]
    signal?: AbortSignal
    timeoutMs?: number
    systemPromptComplete?: string
  }): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? oneShotDefaultTimeoutMs
    const ctl = new AbortController()
    const onCallerAbort = (): void => { ctl.abort() }
    opts.signal?.addEventListener('abort', onCallerAbort, { once: true })
    const timer = setTimeout(() => { ctl.abort() }, timeoutMs)

    // A complete-replacement system prompt rides the creation-time setup hook
    // (plan D3, same mechanism as the chatroom bare persona): the render
    // session's prompt replaces the whole system prompt, not a section.
    const setup = opts.systemPromptComplete !== undefined
      ? buildCompletePromptSetup(opts.systemPromptComplete)
      : undefined
    const handle = await this.ctx.agents.create({
      sessionId: SessionId(freshNativeSessionId()),
      meta: { cwd: opts.workDir !== undefined && opts.workDir !== '' ? opts.workDir : this.cfg.cwd },
      ...(opts.seed !== undefined && opts.seed.length > 0 ? { seed: opts.seed } : {}),
      ...(setup !== undefined ? { setup } : {}),
      agentOptions: this.agentOptionsForQuery(opts.providerName ?? '', opts.reasoning ?? ''),
    })
    const session = new DshAgentSession(`oneshot-${Date.now()}`, handle)
    this.liveSessions.set(session.currentSessionID(), session)
    const aborted = new Promise<'aborted'>((resolve) => {
      ctl.signal.addEventListener('abort', () => { resolve('aborted') }, { once: true })
    })
    try {
      void session.send(opts.prompt, [], [])
      let answer = ''
      let errorText = ''
      for (;;) {
        if (ctl.signal.aborted) {
          throw new Error(opts.signal?.aborted === true
            ? 'dsh one-shot: aborted by caller'
            : `dsh one-shot: timeout after ${String(timeoutMs)}ms`)
        }
        const received = await Promise.race([session.events().receive(), aborted])
        if (received === 'aborted') {
          throw new Error(opts.signal?.aborted === true
            ? 'dsh one-shot: aborted by caller'
            : `dsh one-shot: timeout after ${String(timeoutMs)}ms`)
        }
        if (received.done) break
        const evt = received.event
        if (evt.type === 'result') {
          answer = evt.content
          if (evt.errorText !== undefined && evt.errorText !== '') errorText = evt.errorText
          break
        }
        if (evt.type === 'error') {
          errorText = evt.errorText ?? String(evt.error)
          break
        }
      }
      if (errorText !== '') throw new Error(`dsh one-shot: ${errorText}`)
      return answer.trim()
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onCallerAbort)
      this.liveSessions.delete(session.currentSessionID())
      await session.close()
    }
  }

  /**
   * Start (or resume) the agent session the engine identified. An empty id
   * (or the ContinueSession sentinel) creates a fresh native session keyed
   * by the engine session key; a concrete id resumes that persisted session;
   * a `__fork__<origID>` sentinel creates a new session seeded with the
   * parent's completed-turn prefix (Go /fork semantics); a
   * `__forkat__<newID>` sentinel resumes the persisted truncated copy a
   * rollback fork prepared (Go /fork on a quoted message).
   *
   * Chatroom bare sessions (role / direct-role / moderator, flagged through
   * the injected env) carry a setup hook that replaces the whole system
   * prompt with the flattened persona (Go isChatroomBareSession +
   * buildChatroomSystemPrompt via DSH_CC_SYSTEM_PROMPT_COMPLETE; here the
   * D3 `complete: true` prompt section). Research assistants get their
   * preamble appended as a normal section instead.
   *
   * @param sessionID - the engine-provided id: '' or the ContinueSession
   * sentinel creates fresh, a concrete id resumes, `__fork__<origID>`
   * seeds from the parent, and `__forkat__<newID>` resumes the truncated
   * rollback copy.
   * @returns the live session bound to the engine session key.
   */
  async startSession(sessionID: string): Promise<AgentSession> {
    const envKey = this.env.find(e => e.startsWith('CC_SESSION_KEY='))?.slice('CC_SESSION_KEY='.length) ?? ''
    const key = envKey !== '' ? envKey : sessionID
    const isFork = sessionID.startsWith(ForkSessionPrefix)
    const isForkAt = sessionID.startsWith(ForkAtSessionPrefix)
    const isResume = !isFork && !isForkAt && sessionID !== '' && sessionID !== ContinueSession
    const setup = buildSessionSetup(this.env, this.workDir)

    const existing = this.sessionsByEngineKey.get(key)
    if (existing !== undefined && existing.alive()) return existing

    let handle: DshAgentHandleLike
    if (isForkAt) {
      // Rollback fork: the truncated copy already exists in persistence under
      // a fresh id written by prepareForkAtSession; resume it directly (Go
      // agent/dsh/session.go resume branch — no seed, no cross-id copy).
      handle = await this.ctx.agents.resume({
        resumeSessionId: SessionId(sessionID.slice(ForkAtSessionPrefix.length)),
        agentOptions: this.routeAgentOptions(),
        ...(setup !== undefined ? { setup } : {}),
      })
    } else if (isFork) {
      // Fork: copy the parent's completed turns into a fresh native session
      // (seed), so the child inherits the conversation without appending to
      // the parent's log. The seed source resolves live-first — the registry's
      // in-memory log is fresher than the write-behind persisted one — then
      // falls back to the persisted log, so a merely-persisted parent (daemon
      // restart, idle-reaped) still forks (Go reads the transcript file).
      // When the source is gone this degrades to a fresh session.
      const origID = sessionID.slice(ForkSessionPrefix.length)
      const parent = this.ctx.agents.get(SessionId(origID))
      let seeded: SessionEvent[] | undefined
      if (parent !== undefined) {
        seeded = completedTurnPrefix(parent)
      } else {
        seeded = await this.persistedForkSeed(origID)
      }
      const seed = seeded ?? []
      if (seeded === undefined || seed.length === 0) {
        console.warn(`agent-dsh: fork source has no seedable turns, starting fresh (orig=${origID})`)
      }
      handle = await this.ctx.agents.create({
        sessionId: SessionId(freshNativeSessionId()),
        meta: {
          cwd: this.workDir,
          ...(seeded !== undefined ? { parentSession: SessionId(origID), seedLength: seed.length } : {}),
        },
        ...(seed.length > 0 ? { seed } : {}),
        agentOptions: this.routeAgentOptions(),
        ...(setup !== undefined ? { setup } : {}),
      })
    } else if (isResume) {
      handle = await this.ctx.agents.resume({
        resumeSessionId: SessionId(sessionID),
        agentOptions: this.routeAgentOptions(),
        ...(setup !== undefined ? { setup } : {}),
      })
    } else {
      // Go parity: a NEW engine session gets a generated native session id
      // (cc-YYYYMMDD-HHMMSS-hex). Creating under the engine key collides
      // with the persisted log of any earlier session bound to the same
      // chat — the live "id collision" failure observed right after /new.
      handle = await this.ctx.agents.create({
        sessionId: SessionId(freshNativeSessionId()),
        meta: { cwd: this.workDir },
        agentOptions: this.routeAgentOptions(),
        ...(setup !== undefined ? { setup } : {}),
      })
    }
    const bypass = sessionBypassesPermissions(this.env)
    const session = new DshAgentSession(key, handle, this.workDir, this.ctx, bypass)

    // Lazily register the userQuestions provider now that the plugin tree
    // is fully loaded (at constructor time it may not be available yet).
    this.ensureUserQuestionsProvider()
    // Go effectiveMode: an unattended session overrides ANY configured or
    // overridden mode with bypassPermissions — which also means plan mode
    // stays off (a delegated child nobody can approve must not stall on an
    // ExitPlanMode card).
    const mode = bypass ? 'bypassPermissions' : (this.modeOverride !== '' ? this.modeOverride : this.defaultMode)
    if (mode !== '') {
      // Apply the mode onto the native plan-mode controller (Go /mode +
      // config mode=plan): plan → active, others off. The one-shot override
      // clears; the project default persists for every subsequent session.
      const planMode = this.ctx.get('planMode') as
        | { set(agent: unknown, active: boolean): string }
        | undefined
      if (planMode !== undefined) {
        planMode.set(handle.agent, mode === 'plan')
      }
      this.modeOverride = ''
    }
    this.sessionsByEngineKey.set(key, session)
    this.liveSessions.set(session.currentSessionID(), session)
    return session
  }

  /**
   * Resolve the live bridge session that owns a non-bridge session's
   * subagent lineage: walk `parentSession` links upward through the live
   * agent registry until a bridge session matches. Grandchildren attribute
   * to the same ancestor as direct children; a broken chain (mid-lineage
   * session no longer live) drops the event, matching the pre-attribution
   * behavior of invisible child activity.
   *
   * @param session - the emitting session carrying a `parentSession` header.
   * @returns the owning live bridge session, or undefined when the lineage
   *   does not reach one.
   */
  private resolveSubagentAncestor(session: { header?: { parentSession?: unknown } }): DshAgentSession | undefined {
    let parent: unknown = session.header?.parentSession
    for (let depth = 0; depth < subagentLineageMaxDepth; depth++) {
      // Session ids (branded strings) key both maps; a non-string link is
      // corrupt lineage and ends the walk.
      if (typeof parent !== 'string') return undefined
      const live = this.liveSessions.get(parent)
      if (live !== undefined) return live
      const agent = this.ctx.agents.get(parent)
      const next = agent?.session.header?.parentSession
      if (next === undefined) return undefined
      parent = next
    }
    return undefined
  }

  /**
   * TODO(M7 usage): dsh has no native "list persisted sessions" API on the
   * registry yet; /sessions relies on this returning what the backend knows.
   * M1 reports none — the parent session verifies the real surface.
   *
   * @returns the live sessions with native ids and last-activity timestamps.
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
    // Live tool results wrap their output in tool-result blocks whose inner
    // content carries the text (dsh-llm ToolResultBlock).
    else if (block.type === 'tool-result') out += textOfBlocks(block.content)
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

/** Call id of a durable tool-result message, or '' when absent.
 *
 * The durable ToolMessage carries it on `source.callId`; the wire fallback is
 * the `tool-result` content block's `toolCallId`. The engine keys tool-time
 * intervals by this id (Go EventToolResult ToolID).
 */
function toolResultCallIdOf(message: { source?: { callId?: unknown }; content?: ContentBlock[] } | undefined): string {
  const fromSource = toStr(message?.source?.callId)
  if (fromSource !== '') return fromSource
  for (const block of message?.content ?? []) {
    if (block.type === 'tool-result') return toStr(block.toolCallId)
  }
  return ''
}

/** One live engine session backed by a native dsh agent. */
export class DshAgentSession implements AgentSession {
  private readonly key: string
  private handle: DshAgentHandleLike
  private readonly ctx: DshContextLike | undefined
  private readonly channel = new EventChannel()
  private disposed = false
  private turnText = ''
  private lastText = ''
  /** Turn-wide usage sums, reset on turn/start (Go accumulateUsage counters). */
  private turnUsage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0 }
  /** Assistant messages seen this turn (Go turnSteps → result numTurns). */
  private turnSteps = 0
  /** Last-activity timestamp (ms), updated on send and every projected event. */
  lastActivityAt = Date.now()
  /** Pending permission responses: requestID → settle function (M3). */
  private readonly pendingPermissions = new Map<string, (decision: { outcome: string; behavior: 'allow' | 'deny'; message?: string }) => void>()
  /** Pending AskUserQuestion answers: requestID → settle + count (M3). */
  private readonly pendingQuestionAnswers = new Map<string, { settle: (answers: string[]) => void; count: number }>()
  /** Where Send stages image/file bytes (Go dshSession.workDir). */
  private readonly workDir: string
  /** Auto-approve tool permissions (Go permMode bypassPermissions / autoApprove). */
  readonly bypassPermissions: boolean
  /** Child sessions that ever ran a turn (cumulative subagent count on the card). */
  private readonly seenChildren = new Set<string>()

  constructor(key: string, handle: DshAgentHandleLike, workDir = '', ctx?: DshContextLike, bypassPermissions = false) {
    this.key = key
    this.handle = handle
    this.workDir = workDir
    this.ctx = ctx
    this.bypassPermissions = bypassPermissions
  }

  /**
   * The engine-side session key (diagnostics).
   *
   * @returns the engine-side session key.
   */
  sessionKey(): string {
    return this.key
  }

  currentSessionID(): string {
    return String(this.handle.agent.id)
  }

  alive(): boolean {
    return !this.disposed
  }

  /**
   * SessionCompressor (Go ContextCompressor "/compact"): trigger dsh's
   * native manual compaction on this session's agent. Throws when the
   * compaction service is not loaded in the runtime tree.
   *
   * @param signal - abort forwarded to the compaction service.
   */
  async compress(signal?: AbortSignal): Promise<void> {
    const compaction = this.ctx?.get('compaction') as
      | { compactNow(agent: unknown, signal: AbortSignal, sourceCommandId?: unknown): Promise<unknown> }
      | undefined
    if (compaction === undefined) {
      throw new Error('compaction service not available')
    }
    await compaction.compactNow(this.handle.agent, signal ?? new AbortController().signal)
  }

  /**
   * Most recent assistant text (listSessions summaries).
   *
   * @returns the last completed turn's final text ('' before the first turn ends).
   */
  lastAssistantText(): string {
    return this.lastText
  }

  /**
   * Send one user turn: a followup message carrying the prompt text. Image
   * bytes are staged to workDir/.feishu-bridge/attachments and referenced by
   * path in the prompt text (Go dshSession.Send) — the agent reads them with
   * its own read/read_image tools; the model never receives raw image bytes.
   */
  send(prompt: string, images: ImageAttachment[], files: FileAttachment[]): Promise<void> {
    this.lastActivityAt = Date.now()
    let content = prompt
    const imagePaths = saveImagesToDisk(this.workDir, images)
    if (imagePaths.length > 0) {
      content += `\n(Images saved locally, please read them: ${imagePaths.join(', ')})`
    }
    content = appendFileRefs(content, saveFilesToDisk(this.workDir, files))
    this.handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: content }],
      source: { kind: 'user' },
    }))
    return Promise.resolve()
  }

  /**
   * AgentSession.steer: append mid-turn text to the agent's next-step inbox
   * (agent-loop steer) — the driver claims it between steps, so the text
   * reaches the model inside the running turn. Text only; neither caller
   * (/ps, a plan-review approval supplement) carries attachments.
   */
  steer(prompt: string): void {
    this.lastActivityAt = Date.now()
    this.handle.agent.steer(createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }))
  }

  /**
   * Emit a permission_request event into the engine's EventChannel (M3).
   * The engine's event loop receives it, sends a permission card, and waits.
   * The approval answerer awaits {@link awaitPermissionResponse}.
   *
   * @param req - the permission request fields forwarded onto the event stream.
   */
  emitPermissionRequest(req: { requestID: string; toolName: string; toolInput: string; toolInputRaw: Record<string, unknown> }): void {
    this.channel.push({
      type: 'permission_request',
      content: '',
      toolName: req.toolName,
      toolInput: req.toolInput,
      toolInputRaw: req.toolInputRaw,
      requestID: req.requestID,
      done: false,
    })
  }

  /**
   * Wait for the engine to call {@link respondPermission} with the user's
   * decision (M3). Returns the decision as both the dsh approval outcome
   * string and the raw verdict the plan-review mapping reads.
   *
   * @param requestID - the id matching the emitted permission_request event.
   * @param signal - abort; settles as a cancelled/deny decision.
   * @returns the user's decision as a dsh outcome string plus the allow/deny verdict.
   */
  awaitPermissionResponse(requestID: string, signal?: AbortSignal): Promise<{ outcome: string; behavior: 'allow' | 'deny'; message?: string }> {
    return new Promise((resolve) => {
      const settle = (decision: { outcome: string; behavior: 'allow' | 'deny'; message?: string }): void => {
        this.pendingPermissions.delete(requestID)
        resolve(decision)
      }
      this.pendingPermissions.set(requestID, settle)
      if (signal !== undefined) {
        signal.addEventListener('abort', () => { settle({ outcome: 'cancelled', behavior: 'deny' }) }, { once: true })
      }
    })
  }

  /**
   * Answer a plan-review ask (M3): render it as the ExitPlanMode permission
   * card — the card heading is the plan's first line, falling back to the
   * question — then map the user's verdict to answer semantics. Allow
   * selects the intent's approve label; deny declines with the deny message
   * as feedback so the model keeps planning (Go planReviewItem +
   * RespondPermission). An allow-side note is the user's supplement to the
   * approved plan: it cannot ride in the answer (plan-mode treats any
   * `custom` as keep-planning feedback), so it is steered as a user message
   * consumed at the next step boundary, right after the approval tool
   * result.
   *
   * @param item - the plan-review ask rendered onto the ExitPlanMode card.
   * @param signal - abort; settles as a deny with no feedback message.
   * @returns the ask result with the approved or declined answer selected.
   */
  answerPlanReview(item: RawAskQuestionItem, signal?: AbortSignal): Promise<UserQuestionsAskResult> {
    const plan = item.detail ?? ''
    let heading = item.question
    const newline = plan.indexOf('\n')
    if (newline > 0) heading = plan.slice(0, newline).trim()
    const requestID = `askq-${Date.now()}`
    this.emitPermissionRequest({
      requestID,
      toolName: 'ExitPlanMode',
      toolInput: heading,
      toolInputRaw: { plan },
    })
    const approve = item.intent?.approve ?? ''
    return this.awaitPermissionResponse(requestID, signal).then((decision) => {
      const supplement = decision.behavior === 'allow' ? (decision.message ?? '').trim() : ''
      if (supplement !== '') this.steer(supplement)
      return {
        answers: [{
          id: item.id ?? item.question,
          ...(decision.behavior === 'allow'
            ? { selected: [approve !== '' ? approve : 'Approve'] }
            : { selected: [], custom: decision.message ?? '' }),
        }],
      }
    })
  }

  /**
   * Wait for the engine to deliver AskUserQuestion answers (M3). The
   * engine's handlePendingPermission collects answers per question index
   * and delivers them here as one array; entries stay empty strings until
   * collected. Returns exactly `count` answer strings in question order.
   *
   * @param requestID - the id of the pending question request.
   * @param signal - abort; settles with empty answers.
   * @param count - the number of questions whose answers to wait for.
   * @returns the collected answer strings, in question order.
   */
  awaitQuestionAnswer(requestID: string, signal: AbortSignal | undefined, count: number): Promise<string[]> {
    return new Promise((resolve) => {
      const settle = (answers: string[]): void => {
        this.pendingQuestionAnswers.delete(requestID)
        resolve(answers)
      }
      this.pendingQuestionAnswers.set(requestID, { settle, count })
      if (signal !== undefined) {
        signal.addEventListener('abort', () => { settle(new Array<string>(count).fill('')) }, { once: true })
      }
    })
  }

  /**
   * Deliver collected AskUserQuestion answers for a pending request (M3).
   *
   * @param requestID - the id of the pending request to settle.
   * @param answers - the collected answer strings.
   */
  deliverQuestionAnswers(requestID: string, answers: string[]): void {
    const entry = this.pendingQuestionAnswers.get(requestID)
    if (entry !== undefined) {
      entry.settle(answers)
    }
  }

  /**
   * Resolve a pending permission request with the user's decision (M3).
   * Called by the engine's handlePendingPermission after the user responds.
   */
  respondPermission(requestID: string, result: PermissionResult): Promise<void> {
    const settle = this.pendingPermissions.get(requestID)
    if (settle !== undefined) {
      const behavior = result.behavior === 'allow' ? 'allow' as const : 'deny' as const
      settle({
        outcome: behavior === 'allow' ? 'allowed-once' : 'rejected',
        behavior,
        ...(result.message !== undefined ? { message: result.message } : {}),
      })
    }
    // AskUserQuestion flows ride the same request id: deliver the updated
    // input's answers so the question waiter (if any) also settles.
    const answers = (result.updatedInput?.answers) as Record<string, string> | undefined
    if (answers !== undefined) {
      this.deliverQuestionAnswers(requestID, Object.values(answers))
    }
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

  /**
   * Project one durable session event into the engine Event stream.
   *
   * @param event - the durable session event ({type, seq, time, data}).
   */
  projectSessionEvent(event: Record<string, unknown>): void {
    this.lastActivityAt = Date.now()
    // Durable session events carry their payload under `data` (SessionEvent
    // = {type, seq, time, data}); every field read below comes from the
    // unwrapped payload. Reading the flat shape silently produced empty
    // results in production while flat-shaped harness emissions kept the
    // tests green — the harness now emits the wrapped shape too.
    const data = (event.data ?? {}) as Record<string, unknown>
    switch (toStr(event.type)) {
      case 'turn/start': {
        this.turnText = ''
        this.turnUsage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0 }
        this.turnSteps = 0
        break
      }
      case 'assistant/chunk': {
        const chunk = data.chunk as { type?: string; text?: string } | undefined
        if (chunk?.type === 'text-delta') {
          this.channel.push({ type: 'text_delta', content: chunk.text ?? '', done: false })
        } else if (chunk?.type === 'reasoning-delta') {
          this.channel.push({ type: 'thinking_delta', content: chunk.text ?? '', done: false })
        }
        break
      }
      case 'assistant/message': {
        const message = data.message as { content?: ContentBlock[] } | undefined
        const text = textOfBlocks(message?.content)
        const thinking = thinkingOfBlocks(message?.content)
        if (text !== '') {
          this.turnText = text
          this.channel.push({ type: 'text', content: text, done: false })
        }
        if (thinking !== '') {
          this.channel.push({ type: 'thinking', content: thinking, done: false })
        }
        // Fold this request's usage into the turn sum (Go accumulateUsage);
        // the result event carries the sum, not the last request's slice.
        const usage = data.usage as
          | { inputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number; outputTokens?: number }
          | undefined
        this.turnUsage.inputTokens += usage?.inputTokens ?? 0
        this.turnUsage.cachedTokens += (usage?.cacheReadTokens ?? 0) + (usage?.cacheCreationTokens ?? 0)
        this.turnUsage.outputTokens += usage?.outputTokens ?? 0
        this.turnSteps += 1
        break
      }
      case 'tool/call': {
        this.channel.push({
          type: 'tool_use',
          toolName: toStr(data.name),
          toolInput: toStr(data.arguments),
          toolID: toStr(data.callId),
          content: '',
          done: false,
        })
        break
      }
      case 'tool/result': {
        const message = data.message as { source?: { callId?: unknown }; content?: ContentBlock[] } | undefined
        const callId = toolResultCallIdOf(message)
        this.channel.push({
          type: 'tool_result',
          toolResult: textOfBlocks(message?.content),
          ...(callId !== '' ? { toolID: callId } : {}),
          content: '',
          done: false,
        })
        break
      }
      case 'turn/end': {
        // The turn's final reply is its last assistant text (the Go SDK
        // `result` field equivalent); carry the turn's usage with it. An
        // error-reasoned turn surfaces its message as errorText so the engine
        // reports the failure instead of degrading to the silent-reply hint
        // (observed live: "No API key for provider" showed as 🤫).
        this.lastText = this.turnText
        const reason = data.reason as { kind?: unknown; error?: { message?: unknown } } | undefined
        const errorText = reason !== undefined && reason.kind === 'error' && reason.error?.message !== undefined
          ? toStr(reason.error.message)
          : undefined
        this.channel.push({
          type: 'result',
          content: this.turnText,
          ...(errorText !== undefined ? { errorText } : {}),
          done: true,
          inputTokens: this.turnUsage.inputTokens,
          totalInputTokens: this.turnUsage.inputTokens + this.turnUsage.cachedTokens,
          outputTokens: this.turnUsage.outputTokens,
          numTurns: this.turnSteps,
        })
        this.turnUsage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0 }
        this.turnSteps = 0
        break
      }
      default:
        break
    }
  }

  /**
   * Project one delegated subagent child session's durable event into the
   * engine Event stream. Only tool calls, tool results, and the first
   * turn edge flow through — a child's assistant text and reasoning stay on
   * the child's own card-less transcript. Tool ids are namespaced with the
   * child session id so a result matches its own call even while parent
   * calls interleave.
   *
   * @param childSessionId - the emitting child session's id.
   * @param event - the durable session event ({type, seq, time, data}).
   */
  projectSubagentEvent(childSessionId: string, event: Record<string, unknown>): void {
    this.lastActivityAt = Date.now()
    const data = (event.data ?? {}) as Record<string, unknown>
    switch (toStr(event.type)) {
      case 'turn/start': {
        // Cumulative count: every child session that ever ran a turn counts
        // once. Set.add returns the Set, not a boolean — gate on has() so a
        // duplicate turn edge does not re-emit the count.
        if (!this.seenChildren.has(childSessionId)) {
          this.seenChildren.add(childSessionId)
          this.emitSubagentCount()
        }
        break
      }
      case 'tool/call': {
        this.channel.push({
          type: 'tool_use',
          toolName: toStr(data.name),
          toolInput: toStr(data.arguments),
          toolID: `${childSessionId}:${toStr(data.callId)}`,
          content: '',
          done: false,
          fromSubagent: true,
        })
        break
      }
      case 'tool/result': {
        const message = data.message as { source?: { callId?: unknown }; content?: ContentBlock[] } | undefined
        const callId = toolResultCallIdOf(message)
        this.channel.push({
          type: 'tool_result',
          toolResult: textOfBlocks(message?.content),
          ...(callId !== '' ? { toolID: `${childSessionId}:${callId}` } : {}),
          content: '',
          done: false,
          fromSubagent: true,
        })
        break
      }
      default:
        break
    }
  }

  /** Push the current seen-children count onto the channel (on change). */
  private emitSubagentCount(): void {
    this.channel.push({ type: 'subagent_status', content: String(this.seenChildren.size), done: false })
  }
}
