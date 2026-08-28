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
import { stat } from 'node:fs/promises'
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
import type { HistoryEntry } from '../core/types.js'
import { locateForkCut } from './fork-at.js'
import { bareBridgeDispatch, type BridgeDispatch } from '../bridge-service.js'
import { agentConventionsPrompt } from '../engine/agent-conventions.js'
import {
  subtaskAgentSystemPrompt,
  subtaskNoReportAgentSystemPrompt,
  subtaskResearchAssistantPrompt,
} from '../engine/subtask-prompts.js'
import { appendFileRefs, saveFilesToDisk, saveImagesToDisk } from '../engine/attachments.js'
import type {
  AgentSession,
  AgentSessionInfo,
  AskDelegate,
  AskDecision,
  ContinuableChildStart,
  FileAttachment,
  ImageAttachment,
  ProviderConfig,
  SessionStartOptions,
} from '../core/types.js'

/** Minimal structural member of a dsh Agent the adapter drives. */
export interface DshAgentLike {
  readonly id: unknown
  readonly status: 'idle' | 'running'
  /** The agent's durable session log (fork seeds slice its completed turns). */
  readonly session: {
    readonly events: readonly SessionEvent[]
    readonly header?: { readonly parentSession?: unknown; readonly cwd?: unknown }
  }
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
  options?: Array<{ label: string; description?: string; recommended?: boolean }>
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
  meta?: { cwd?: string; parentSession?: unknown; seedLength?: number; origin?: 'subagent' | 'oneshot' }
  /** Fork seed: the parent's completed-turn prefix (see startSession). */
  seed?: readonly SessionEvent[]
  agentOptions?: { provider?: string; model?: string; reasoningEffort?: string }
  /**
   * Creation-time composition hook (plan D3): registers a bare persona as
   * a `complete: true` system-prompt section on the agent's
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
  /** Lightweight listing from metadata, without a full-log parse. */
  list(signal?: AbortSignal): Promise<SessionHeader[]>
  /** Absolute log-file path for a header without touching the filesystem (jsonl backend `locate`); absent on backends without files. */
  locate?(meta: SessionHeader): { path: string }
}

/**
 * Structural slice of the `subagents` service the native continuable-child
 * delegation surface uses. Loose id/message types: the real service's branded
 * parameters are erased by the service-side cast, exactly like
 * {@link DshPersistenceLike}.
 */
export interface DshSubagentsLike {
  startContinuable(spec: {
    provider: string
    label: string
    request: {
      prompt: Array<Record<string, unknown>>
      parent: unknown
      maxDepth?: number
      persona?: string
      cwd?: string
      /** Child tool mask (fork/spawn both declare the toolFilter capability). */
      toolFilter?: { allow?: readonly string[]; deny?: readonly string[] }
    }
    signal: AbortSignal
  }): Promise<{ childId: unknown }>
  followup(
    parent: unknown,
    childId: unknown,
    content: Array<Record<string, unknown>>,
    options: { source: Record<string, unknown>; signal: AbortSignal },
  ): Promise<unknown>
  interrupt(targetSessionId: unknown, authority: Record<string, unknown>): void
  reportFrom(child: unknown, content: Array<Record<string, unknown>>, options: { delivery: string; signal: AbortSignal }): Promise<unknown>
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

/**
 * Structural slice of the `tools` service the adapter consumes: the live
 * schema view (`schemas`), presence lookup, and the agent-scoped visibility
 * mask. `restrict` requires the calling context to be the agent's scoped
 * context (a plain-context restriction would mask every agent).
 */
export interface DshToolsLike {
  /** Tool schemas the calling scope currently sees (name/description/fields). */
  schemas(): Array<{ name: string }>
  /** Look up one visible tool as the calling scope sees it. */
  get(name: string): unknown
  /** Mask global tools for the calling agent scope; returns the lift disposer. */
  restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void
}

/** Per-project constructor options for the DSH agent adapter. */
export interface DshAdapterConfig {
  agentName: string
  cwd: string
  /** Named routes; the active one supplies create/resume agentOptions. */
  providers: ProviderRoute[]
  activeProvider: string
  /**
   * Bounded wait in ms for one agent session's close during engine shutdown
   * (Go agentCloseTimeout; default 130000). A close exceeding it is
   * abandoned: shutdown completes and the agent fiber is left to process
   * exit.
   */
  closeTimeoutMs?: number
  /**
   * MCP server-name allowlist for this project (ProjectConfig.mcpServers).
   * Present = every session and subtask child this adapter creates denies the
   * `mcp__*` tools of servers outside the list; absent = unrestricted.
   */
  mcpServers?: readonly string[]
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

/**
 * Cap on the per-session recent-turn window the adapter keeps — the read
 * window size of the retired 100-entry bridge-side history copy.
 */
const recentTurnsWindowCap = 100

/** Whether a text is only an ellipsis placeholder the engine never counts as reply text. */
function isEllipsisOnly(text: string): boolean {
  const t = text.trim()
  return t === '...' || t === '…'
}

/**
 * Fold a session event log into the bridge's conversation window: one user
 * entry per human `user/message` (synthetic plugin injections stay out) and
 * one assistant entry per turn, joining that turn's assistant message texts —
 * the shape the retired bridge-side history copy kept. Valid for live
 * registry views and persisted logs alike.
 *
 * @param events - the source session's event log.
 * @param cap - trailing-entry bound on the folded window.
 * @returns the trailing window entries, oldest first.
 */
export function foldRecentTurns(events: readonly SessionEvent[], cap = recentTurnsWindowCap): HistoryEntry[] {
  const out: HistoryEntry[] = []
  let turnParts: string[] = []
  for (const event of events) {
    if (event.type === 'user/message') {
      if (event.data.source.kind !== 'user') continue
      const content = textOfBlocks(event.data.content)
      if (content !== '') out.push({ role: 'user', content, timestamp: new Date(event.time).toISOString() })
    } else if (event.type === 'assistant/message') {
      const text = textOfBlocks(event.data.message.content)
      if (text !== '' && !isEllipsisOnly(text)) turnParts.push(text)
    } else if (event.type === 'turn/end') {
      const content = turnParts.join('')
      turnParts = []
      if (content !== '') out.push({ role: 'assistant', content, timestamp: new Date(event.time).toISOString() })
    }
  }
  return cap > 0 && out.length > cap ? out.slice(out.length - cap) : out
}

/** Trailing slice of a window; limit <= 0 returns all (Go Session.getHistory). */
function windowSlice(entries: readonly HistoryEntry[], limit: number): HistoryEntry[] {
  if (limit <= 0 || limit >= entries.length) return [...entries]
  return entries.slice(entries.length - limit)
}

/**
 * Whether the session-start options mark an unattended subtask child — the
 * built-in base of the `feishuBridge/permission-policy` waterfall
 * (Go effectiveMode elevates these to bypassPermissions: approval prompts
 * there stall on nobody who can answer). Persona sessions join via the
 * waterfall's listeners; an attended subtask (a human has spoken in the
 * child group) keeps the normal approval path.
 *
 * @param options - The session-start options built by the engine's buildSessionStartOptions.
 * @returns True when the unattended subtask base auto-approves tool permissions.
 */
export function unattendedSubtaskBypassesPermissions(options: SessionStartOptions | undefined): boolean {
  return options?.subtask !== undefined && !options.subtask.attended
}

/**
 * The #18 workspace routing section: the engine's workspace fields become a
 * system-prompt section naming the bot's default Feishu workspace (the D3
 * setup-hook replacement for Go's subprocess env the feishu-search/lark-guide
 * skills read; the CC_FEISHU_* line names are the model-visible contract).
 *
 * @param options - The session-start options built by the engine's buildSessionStartOptions.
 * @returns The prompt section text; '' when no workspace is configured.
 */
export function feishuWorkspaceSection(options: SessionStartOptions | undefined): string {
  const wikiSpaceId = options?.feishuWorkspace?.wikiSpaceId ?? ''
  const folderToken = options?.feishuWorkspace?.folderToken ?? ''
  const wikiNodeToken = options?.feishuWorkspace?.wikiNodeToken ?? ''
  const description = options?.feishuWorkspace?.description ?? ''
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
 * Compose the persona a native continuable subtask child runs under (de-baggage
 * B4): the same text the group-path child receives as prompt sections — the
 * workspace routing section plus the subtask report preamble (subtask children
 * deliberately omit the agent-conventions section: its closing
 * ask_user_question findings card addresses a user chat this child does not
 * have) — joined as one persona that shadows the deployment persona for this
 * child.
 *
 * @param workspaceText - The #18 workspace routing section; '' omits it.
 * @returns The composed persona text.
 */
export function unattendedSubtaskPersona(workspaceText: string): string {
  const parts: string[] = []
  if (workspaceText !== '') parts.push(workspaceText)
  parts.push(subtaskAgentSystemPrompt())
  return parts.join('\n\n')
}

/**
 * Deny list masking the MCP tools of servers outside a project's allowlist:
 * every live `mcp__`-prefixed name that belongs to no allowed server.
 * Ownership follows the mcp-client naming contract — public name
 * `mcp__<serverName>__<rawName>`, with an identity suffix appended when
 * normalization collides — and the prefix match tolerates that suffix.
 * Ceiling: two live servers whose names collide on a `mcp__<a>__<b>__` prefix
 * (the serverName charset allows `_`) mis-attribute each other's tools; only
 * those tools are mis-masked. This is visibility composition, not an
 * authority boundary (the dsh tools README states the scope security
 * non-goal).
 *
 * @param names - live tool names from the tools schema view.
 * @param allow - the project's allowed MCP server names.
 * @returns the names to deny; empty when nothing qualifies.
 */
export function mcpDenyList(names: readonly string[], allow: readonly string[]): string[] {
  if (allow.length === 0) return []
  return names.filter(name =>
    name.startsWith('mcp__') && !allow.some(server => name.startsWith(`mcp__${server}__`)))
}

/**
 * Wrap a creation-time setup hook with the project's MCP visibility mask
 * (per-project MCP tool visibility): after the wrapped setup composes its
 * prompt sections, deny the tools of every MCP server outside the project's
 * allowlist. The deny list is computed inside the hook from the agent scope's
 * own schema view — at setup time no restriction is registered yet, so the
 * view holds every global tool, and `restrict` validates the names against
 * that same view. An empty deny list (no mcp-client mounted, every server
 * down, or all tools already allowed) skips the call; an empty filter throws
 * by design. Ceiling: a server that revives after this session started adds
 * its tools unnamed in the deny set, and deny masks admit later unnamed
 * globals — the revived tools stay visible until the next session start or
 * resume recomputes the mask. Upgrade path: pattern-based restriction in core
 * tools.
 *
 * @param setup - the wrapped setup hook, or undefined.
 * @param allow - the project's allowed MCP server names; undefined/empty = no mask.
 * @returns the wrapped setup hook, or the original when no mask applies.
 */
function withMcpMask(
  setup: import('@deepseek-ai/dsh-agent').AgentSetup | undefined,
  allow: readonly string[] | undefined,
): import('@deepseek-ai/dsh-agent').AgentSetup | undefined {
  if (allow === undefined || allow.length === 0) return setup
  return async (agentCtx) => {
    // Propagate the wrapped setup's publication commit: the registry invokes
    // it immediately before publication, and swallowing it here would drop
    // the inner setup's validation.
    const commit = await setup?.(agentCtx)
    const toolsSvc = agentCtx.get('tools') as DshToolsLike | undefined
    if (toolsSvc !== undefined) {
      const deny = mcpDenyList(toolsSvc.schemas().map(schema => schema.name), allow)
      if (deny.length > 0) toolsSvc.restrict({ deny })
    }
    return commit
  }
}

/**
 * Build the agents.create/resume setup hook for the typed start options:
 * a session carrying a `persona` (Go isChatroomBareSession) replaces the
 * whole system prompt with the precomputed persona text. A subtask child
 * (Go buildAppendSystemPrompt's CC_SUBTASK branch) appends the report /
 * no-report preamble as a normal section — research assistants add their
 * contract on top. Plain sessions always get the agent conventions section
 * (order 10) and, when a Feishu workspace is configured, the #18 routing
 * section on top.
 */
function buildSessionSetup(options: SessionStartOptions | undefined): import('@deepseek-ai/dsh-agent').AgentSetup | undefined {
  const persona = options?.persona
  const isSubtask = options?.subtask !== undefined
  const isResearchAssistant = options?.subtask?.researchAssistant === true
  const isNoReport = options?.subtask?.noReport === true
  const workspaceText = feishuWorkspaceSection(options)
  if (persona === undefined) {
    if (!isSubtask) {
      return (agentCtx) => {
        const promptSvc = agentCtx.get('systemPrompt') as
          | { section(section: { name: string; order: number; text: string; complete?: boolean }): () => void }
          | undefined
        promptSvc?.section({ name: 'feishu-bridge-agent-conventions', order: 10, text: agentConventionsPrompt() })
        if (workspaceText !== '') {
          promptSvc?.section({ name: 'feishu-bridge-workspace', order: 110, text: workspaceText })
        }
      }
    }
    // Reaching here requires isSubtask, which implies options is defined.
    const venvPython = options.venv !== undefined ? `${options.venv.virtualEnv}/bin/python` : ''
    const preamble = isNoReport
      ? subtaskNoReportAgentSystemPrompt()
      : `${subtaskAgentSystemPrompt()}${isResearchAssistant ? subtaskResearchAssistantPrompt(venvPython) : ''}`
    return (agentCtx) => {
      // Research assistants are coding agents: their workspace lives under
      // the project data dir, off every persona's ancestor chain, so they
      // keep cwd instruction discovery like any other subtask child.
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
    // Go --bare parity: a bare-persona session replaces the assembled system
    // prompt AND forgoes workspace-instruction injection (AGENTS.md/CLAUDE.md
    // reminders), so cwd ancestors cannot smuggle foreign contracts in.
    const instructionSvc = agentCtx.get('agentInstructions') as { suppress(): () => void } | undefined
    instructionSvc?.suppress()
    // A persona that is not a coding agent also loses the skill catalog and
    // its loader: denying the global `skill` tool is dsh's designed lever —
    // tool-skill skips the `<available_skills>` publication with it. Ceiling:
    // a future role shipping its own skill would need this revisited.
    const toolsSvc = agentCtx.get('tools') as DshToolsLike | undefined
    if (toolsSvc?.get('skill') !== undefined) {
      toolsSvc.restrict({ deny: ['skill'] })
    }
    if (persona.prompt !== '') {
      promptSvc?.section({ name: 'feishu-bridge-persona', order: 0, text: persona.prompt, complete: true })
    }
  }
}

/** Default one-shot budget (Go oneShotQuery default timeout). */
const oneShotDefaultTimeoutMs = 10 * 60_000

/** Default bounded wait for one agent session's close during shutdown (Go agentCloseTimeout). */
const defaultAgentCloseTimeoutMs = 130_000

/** Continuable start/report admission budget: covers validation and inbox acceptance, not the turn. */
const startContinuableTimeoutMs = 30_000

/** Max runes of a native child's durable creation label (first line of the brief). */
const nativeChildLabelMaxRunes = 60

/** Durable creation label for a native child: the brief's first non-empty line, capped. */
function labelOfBrief(brief: string): string {
  const line = brief.split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
  const chars = Array.from(line)
  return chars.length > nativeChildLabelMaxRunes ? `${chars.slice(0, nativeChildLabelMaxRunes - 1).join('')}…` : line
}

/** Cap on parentSession links walked when attributing a subagent child to
 * a live bridge session — guards against a corrupted lineage cycle. */
const subagentLineageMaxDepth = 8

/** Lightweight-query budget (Go LightweightQuery: 90s). */
export const lightweightQueryTimeoutMs = 90_000

/**
 * Complete-replacement system prompt for bare lightweight queries (group
 * naming, predict-next, turn summary, monitor triage): the query's whole
 * contract lives in its prompt, so the assembled baseline (tool-usage
 * discipline, memory strategy) is replaced by this single line.
 */
const bareQuerySystemPrompt = '你是严格按照用户消息本身完成任务的助手：只依据消息内给出的规则与内容作答，只输出该消息要求的内容。'

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
 * (the same `complete: true` section mechanism as the bare persona).
 * Workspace-instruction injection is suppressed alongside it — a complete-
 * prompt session is a fresh fork whose task facts arrive only in its prompt,
 * so AGENTS.md/CLAUDE.md reminders carry no task information. A future
 * complete-prompt caller that does want instructions should move the
 * suppression into its own call site. An optional tool filter masks the
 * session's global tools: `deny: ['skill']` drops the skill catalog and its
 * loader with it, `allow: []` masks every tool for text-only queries.
 */
function buildCompletePromptSetup(
  systemPrompt: string,
  opts: { name?: string; toolFilter?: { allow?: readonly string[]; deny?: readonly string[] } } = {},
): import('@deepseek-ai/dsh-agent').AgentSetup {
  return (agentCtx) => {
    const instructionSvc = agentCtx.get('agentInstructions') as { suppress(): () => void } | undefined
    instructionSvc?.suppress()
    const toolsSvc = agentCtx.get('tools') as DshToolsLike | undefined
    const filter = opts.toolFilter
    if (toolsSvc !== undefined && filter !== undefined) {
      // restrict() throws on names unknown to this scope, so absent deny
      // entries (e.g. `skill` without the skill plugin composed) drop out
      // instead of failing session creation.
      const deny = filter.deny?.filter(name => toolsSvc.get(name) !== undefined) ?? []
      if (filter.allow !== undefined || deny.length > 0) {
        toolsSvc.restrict({
          ...(filter.allow !== undefined ? { allow: filter.allow } : {}),
          ...(deny.length > 0 ? { deny } : {}),
        })
      }
    }
    const promptSvc = agentCtx.get('systemPrompt') as
      | { section(section: { name: string; order: number; text: string; complete?: boolean }): () => void }
      | undefined
    if (promptSvc === undefined) return
    promptSvc.section({ name: opts.name ?? 'feishu-bridge-render-session', order: 0, text: systemPrompt, complete: true })
  }
}

/** Adapter configuration (providers + active route). */
export class DshAgentAdapter {
  private readonly ctx: DshContextLike
  private readonly cfg: DshAdapterConfig
  private readonly sessionsByEngineKey = new Map<string, DshAgentSession>()
  private readonly liveSessions = new Map<string, DshAgentSession>()
  /**
   * Liveness of delegated child sessions (last event time, tool-call count),
   * keyed by child session id. Fed from `session/event` regardless of the
   * ancestor projection's liveness — the background-subtask panel reads it
   * while the parent turn is detached, where projection drops the events.
   */
  private readonly subagentActivity = new Map<string, { lastEventAt: number; toolCalls: number }>()
  /** Folded recent-turn windows of cold (not-live) sessions, keyed by native id. */
  private readonly recentTurnsCache = new Map<string, HistoryEntry[]>()
  /** Staged fork-at seeds keyed by the sentinel id, consumed by startSession. */
  private readonly forkAtSeeds = new Map<string, { seed: SessionEvent[]; parentID: string; childWorkDir: string }>()
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
  /** Engine-side ask delegate (B2): renders ask cards and awaits decisions. */
  private askDelegate: AskDelegate | undefined
  /**
   * The `feishuBridge/*` dispatch face: the mounted service in production,
   * or the bare listener-less face when wired outside a Cordis tree.
   */
  private bridgeEvents: BridgeDispatch = bareBridgeDispatch()

  /**
   * Inject the engine-side ask delegate the native approval answerer and
   * userQuestions provider route through (B2). Assembly wires it right after
   * the Engine is constructed; without it native asks fail closed.
   * @param d - The engine's ask surface.
   */
  setAskDelegate(d: AskDelegate): void {
    this.askDelegate = d
  }

  /**
   * Inject the bridge event face the session-start policy decisions
   * (`feishuBridge/permission-policy`, `feishuBridge/mode-policy`) dispatch
   * through. Assembly wires the mounted service; without it the built-in
   * bases run with no listener.
   * @param bridge - The bridge dispatch face.
   */
  setBridgeEvents(bridge: BridgeDispatch): void {
    this.bridgeEvents = bridge
  }

  constructor(ctx: DshContextLike, cfg: DshAdapterConfig) {
    this.ctx = ctx
    this.cfg = cfg
    this.workDir = cfg.cwd
    cfg.questionRouting?.adapters.push(this)
    // session/event projection: route each durable event to the live
    // engine session sharing the agent/session id. Sessions outside
    // liveSessions fall through to subagent-lineage attribution: a
    // delegated child session's events project into its bridge ancestor's
    // channel so the tool-process card shows the child's activity. The
    // ancestor lookup dies once the parent turn detaches, so a delegated
    // child also feeds the activity recorder — the background-subtask panel
    // reads it and does not depend on projection liveness.
    const onSessionEvent = (session: { id: unknown; header?: { parentSession?: unknown } }, event: Record<string, unknown>): void => {
      const target = this.liveSessions.get(String(session.id))
      if (target !== undefined) {
        target.projectSessionEvent(event)
        return
      }
      if (session.header?.parentSession !== undefined) this.recordSubagentActivity(String(session.id), event)
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
    // B2: the approval answerer. When dsh asks for tool permission, delegate
    // "render one card and await the decision" to the engine's askUser and
    // return the decision as the native ApprovalAnswer — the note rides the
    // approval/decided audit pair and the tools layer folds it into the
    // rejection text.
    this.disposers.push(ctx.on('approval/request', async (req: never, _next: never): Promise<string | AskDecision> => {
      const r = req as {
        agent?: { session?: { id?: string } }
        toolName?: string
        callId?: string
        reason?: string
        toolInput?: string
        signal?: AbortSignal
      }
      const sessionID = r.agent?.session?.id ?? ''
      const target = this.liveSessions.get(sessionID)
      if (target === undefined) return 'unavailable'
      // Go autoApprove: an unattended session approves directly — questions
      // (AskUserQuestion / ExitPlanMode) ride the separate userQuestions
      // channel and still surface as cards (#15).
      if (target.bypassPermissions) return 'allowed-once'
      if (this.askDelegate === undefined) return 'unavailable'
      const decision = await this.askDelegate.askUser(target.askSlotKey(), {
        kind: 'permission',
        toolName: r.toolName ?? '',
        // The asker's bounded UI preview (ApprovalRequest.toolInput) wins;
        // the reason is the fallback.
        preview: r.toolInput !== undefined && r.toolInput !== '' ? r.toolInput : (r.reason ?? ''),
      }, r.signal)
      if (decision.outcome === undefined) return 'cancelled'
      return decision.note !== undefined && decision.note !== ''
        ? { outcome: decision.outcome, note: decision.note }
        : decision.outcome
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
        console.warn(`agent-dsh: user question matched no live session (${request.agent?.session?.id ?? ''}), answering empty`)
        return { answers: [] }
      },
    }))
  }

  /**
   * Handle one userQuestions ask for a session owned by this adapter:
   * delegate "render one card and await the decision" to the engine's
   * askUser and map the decision onto the native answer structure —
   * selections in `selected`, free text in `custom`.
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
    // option menus: route them through the plan card + permission card and
    // map the verdict back to answer semantics (Go planReviewItem).
    const review = qs.find(q => q.intent?.kind === 'plan-review')
    if (review !== undefined) {
      return this.answerPlanReview(target, review, request.signal)
    }
    if (this.askDelegate === undefined) {
      console.warn(`agent-dsh: user question without ask delegate (${sessionID}), answering empty`)
      return { answers: [] }
    }
    const decision = await this.askDelegate.askUser(target.askSlotKey(), {
      kind: 'questions',
      questions: qs.map(q => ({
        id: q.id ?? q.question,
        question: q.question,
        header: q.header ?? '',
        options: (q.options ?? []).map(o => ({
          label: o.label, description: o.description ?? '',
          ...o.recommended !== undefined ? { recommended: o.recommended } : {},
        })),
        multiSelect: q.multiSelect ?? false,
      })),
    }, request.signal)
    return { answers: decision.answers ?? [] }
  }

  /**
   * Answer a plan-review ask: render it as the plan card plus the
   * permission card — the card heading is the plan's first line, falling
   * back to the question — then map the user's verdict to answer semantics.
   * Allow selects the intent's approve label; deny declines with the note as
   * feedback so the model keeps planning (Go planReviewItem). An allow-side
   * note is the user's supplement to the approved plan: it cannot ride in
   * the answer (plan-mode treats any `custom` as keep-planning feedback), so
   * it is steered as a user message consumed at the next step boundary,
   * right after the approval tool result.
   *
   * @param target - The live session the plan review belongs to.
   * @param item - The plan-review ask rendered onto the plan card.
   * @param signal - Abort; settles as a deny with no feedback message.
   * @returns The ask result with the approved or declined answer selected.
   */
  private async answerPlanReview(
    target: DshAgentSession, item: RawAskQuestionItem, signal?: AbortSignal,
  ): Promise<UserQuestionsAskResult> {
    const plan = item.detail ?? ''
    let heading = item.question
    const newline = plan.indexOf('\n')
    if (newline > 0) heading = plan.slice(0, newline).trim()
    if (this.askDelegate === undefined) {
      console.warn(`agent-dsh: plan review without ask delegate (${target.sessionKey()}), declining`)
      return { answers: [{ id: item.id ?? item.question, selected: [], custom: '' }] }
    }
    const decision = await this.askDelegate.askUser(target.askSlotKey(), {
      kind: 'plan-review',
      heading,
      plan,
    }, signal)
    const approve = item.intent?.approve ?? ''
    if (decision.outcome === 'allowed-once' || decision.outcome === 'allowed-always') {
      const supplement = (decision.note ?? '').trim()
      if (supplement !== '') target.steer(supplement)
      return {
        answers: [{
          id: item.id ?? item.question,
          selected: [approve !== '' ? approve : 'Approve'],
        }],
      }
    }
    // A cancelled/withdrawn review declines without feedback.
    const feedback = decision.outcome === 'rejected' ? (decision.note ?? '') : ''
    return {
      answers: [{
        id: item.id ?? item.question,
        selected: [],
        custom: feedback,
      }],
    }
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
   * ForkAtPreparer (Go PrepareForkAtSession): truncate the source transcript
   * (live snapshot or persisted log, resolved globally by the
   * sessionPersistence service) to the turn the quoted message belongs to and
   * stage the prefix under a fresh id; the engine starts the child with the
   * `__forkat__<newID>` sentinel, which startSession consumes as one seeded
   * `agents.create` — no persisted pre-copy (Go wrote a truncated log file
   * only because its agent was an external `--resume` process). A daemon
   * restart between prepare and start drops the staged seed; the sentinel
   * then degrades to a fresh session with a warn.
   *
   * @param origID - the native id of the fork source session.
   * @param childWorkDir - the directory the child session records as cwd.
   * @param quotedText - the quoted-message text as the platform delivered it.
   * @param quotedSenderType - 'app' or 'user' sender of the quoted message.
   * @param quotedTimeMs - update time of the quoted message in unix ms; 0 = unknown.
   * @returns the fresh native id the sentinel references.
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
    this.forkAtSeeds.set(newID, { seed: [...inspection.events.slice(0, keep)], parentID: origID, childWorkDir })
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

  /** Resolve the subagents service slice, or fail loud when unmounted. */
  private requireSubagents(): DshSubagentsLike {
    const subagents = this.ctx.get('subagents') as DshSubagentsLike | undefined
    if (subagents === undefined) {
      throw new Error('dsh adapter: continuable subtasks require the subagents service (mounted by dsh-base)')
    }
    return subagents
  }

  /**
   * ContinuableDelegator: establish one native continuable child under the
   * live parent agent (de-baggage B4). The runtime validates and gates the
   * request (cwd absolute, provider capabilities) and persists the child's
   * lineage; settlement stays external — the engine learns of the child's
   * epochs through `subagent/end`. Children do not inherit the parent's
   * restrictions (the dsh agent-scope design), so a project MCP allowlist is
   * forwarded as the child's `toolFilter`; the runtime applies it in the
   * child's creation window and persists it in the child's descriptor, so a
   * resumed child keeps the same mask.
   *
   * @param request - provider, brief, cwd, persona, depth cap, and the live parent id.
   * @returns the durable native child session id.
   */
  async startContinuableChild(request: ContinuableChildStart): Promise<{ childId: string; label: string }> {
    const subagents = this.requireSubagents()
    const parent = this.ctx.agents.get(SessionId(request.parentAgentSessionID))
    if (parent === undefined) {
      throw new Error('subtask: the parent agent session is not live; start it before delegating')
    }
    const label = labelOfBrief(request.prompt)
    const toolsSvc = this.ctx.get('tools') as DshToolsLike | undefined
    const mcpDeny = toolsSvc === undefined || this.cfg.mcpServers === undefined
      ? []
      : mcpDenyList(toolsSvc.schemas().map(schema => schema.name), this.cfg.mcpServers)
    const started = await subagents.startContinuable({
      provider: request.provider,
      label,
      request: {
        prompt: [{ type: 'text', text: request.prompt }],
        parent,
        maxDepth: request.maxDepth,
        persona: unattendedSubtaskPersona(feishuWorkspaceSection(
          request.workspace === undefined ? undefined : { sessionKey: '', feishuWorkspace: request.workspace },
        )),
        // '' means "no override" — the runtime rejects a non-absolute cwd, and
        // the child then inherits the parent's working directory.
        ...(request.cwd !== '' ? { cwd: request.cwd } : {}),
        ...(mcpDeny.length > 0 ? { toolFilter: { deny: mcpDeny } } : {}),
      },
      signal: AbortSignal.timeout(startContinuableTimeoutMs),
    })
    return { childId: String(started.childId), label }
  }

  /**
   * ContinuableDelegator: deliver a parent follow-up as the child's next FIFO
   * turn. Native semantics queue behind a running turn — the deliberate
   * deviation from Go's busy-reject, recorded in the B4 Agent Note.
   *
   * @param parentAgentSessionID - native id of the live direct parent.
   * @param childId - the durable native child session id.
   * @param message - the follow-up text.
   */
  async followupChild(parentAgentSessionID: string, childId: string, message: string): Promise<void> {
    const subagents = this.requireSubagents()
    const parent = this.ctx.agents.get(SessionId(parentAgentSessionID))
    if (parent === undefined) {
      throw new Error('subtask: the parent agent session is not live; cannot deliver the follow-up')
    }
    // The signal is mandatory: the cold-resume arm of the runtime's followup
    // (a child that already settled to storage) dereferences it — omitting it
    // crashed every follow-up to a settled child (2026-08-27 oc_56801302: two
    // environment-hint sends failed with "Cannot read properties of undefined
    // (reading 'throwIfAborted')" and the hints were never delivered).
    await subagents.followup(parent, SessionId(childId), [{ type: 'text', text: message }], {
      source: { kind: 'coordinator', form: 'relay', senderSessionId: SessionId(parentAgentSessionID) },
      signal: AbortSignal.timeout(startContinuableTimeoutMs),
    })
  }

  /**
   * ContinuableDelegator: interrupt one native child's current turn. An
   * absent or idle target is an accepted no-op (runtime semantics).
   *
   * @param parentAgentSessionID - native id of the live direct parent (the authority).
   * @param childId - the durable native child session id.
   */
  interruptChild(parentAgentSessionID: string, childId: string): void {
    const subagents = this.requireSubagents()
    const parent = this.ctx.agents.get(SessionId(parentAgentSessionID))
    if (parent === undefined) {
      throw new Error('subtask: the parent agent session is not live; cannot interrupt the child')
    }
    subagents.interrupt(SessionId(childId), { kind: 'ancestor', agent: parent })
  }

  /**
   * ContinuableDelegator: push one native child's content to its durable
   * direct parent through the runtime's report path — the parent is itself a
   * native child, so the delivery target is the native inbox, not a Feishu
   * chat. The live child agent is the authority credential.
   *
   * @param childId - the durable native child session id.
   * @param content - the report text.
   */
  async reportChildToNativeParent(childId: string, content: string): Promise<void> {
    const subagents = this.requireSubagents()
    const child = this.ctx.agents.get(SessionId(childId))
    if (child === undefined) {
      throw new Error('subtask: the reporting child agent is not live')
    }
    await subagents.reportFrom(child, [{ type: 'text', text: content }], {
      delivery: 'next-step',
      signal: AbortSignal.timeout(startContinuableTimeoutMs),
    })
  }

  /**
   * ContinuableDelegator: whether one native child has a live agent. Restart
   * recovery relies on this to leave a still-running child (an HMR rebuild
   * that kept the runtime alive) out of its interrupted set.
   *
   * @param childId - the durable native child session id.
   */
  childLive(childId: string): boolean {
    return this.ctx.agents.get(SessionId(childId)) !== undefined
  }

  /**
   * ContinuableDelegator: the recorded working directory of one native child
   * ('' without a live agent or a recorded cwd). A native child spawning its
   * own child resolves its inheritance base from this.
   *
   * @param childId - the durable native child session id.
   */
  childCwd(childId: string): string {
    const agent = this.ctx.agents.get(SessionId(childId))
    const cwd = agent?.session.header?.cwd
    return typeof cwd === 'string' ? cwd : ''
  }

  /**
   * ForkQuerierWithProvider: a standalone one-shot turn without resuming
   * anything (Go LightweightQuery — group naming, predict-next): the context
   * lives in the prompt itself. The query runs bare — session origin
   * `oneshot` keeps memory-index injection and LLM title generation off, the
   * complete-prompt replacement drops the assembled system prompt and
   * workspace instructions, and `allow: []` masks every tool (no tool is
   * needed, and the skill catalog goes with them) — so cwd-derived context
   * cannot leak into or skew the answer. Light text output needs no deep
   * reasoning (and thinking would eat most of the 90s budget), so the query
   * runs at reasoningEffort 'low'.
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
      origin: 'oneshot',
      systemPromptComplete: bareQuerySystemPrompt,
      systemPromptName: 'feishu-bridge-lightweight-query',
      toolFilter: { allow: [] },
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
   * tools except the global `skill` tool (the render skill body is baked into
   * the system prompt, so the `<available_skills>` catalog and its loader are
   * dropped instead), and no workspace-instruction injection (suppressed with
   * the prompt replacement; the render facts travel only in the prompt).
   * Session origin `oneshot` also keeps memory-index injection and LLM title
   * generation off. The render one-shot does not need deep reasoning, so an
   * unset effort defaults to 'low' (an unset effort once made renders burn
   * ~21k thinking chars for an 84-char artifact). The 15m budget mirrors the
   * Go fork.
   *
   * @param prompt - the render task prompt.
   * @param providerName - the named provider route to run on.
   * @param systemPrompt - the complete-replacement system prompt for the render session.
   * @param signal - caller abort; rejects the wait and still disposes the session.
   * @returns the session's trimmed stdout.
   */
  async renderQuery(
    prompt: string,
    providerName: string,
    systemPrompt: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.oneShotQuery({
      prompt,
      providerName,
      systemPromptComplete: systemPrompt,
      origin: 'oneshot',
      toolFilter: { deny: ['skill'] },
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
    /** Section name for the complete-replacement prompt (default: render). */
    systemPromptName?: string
    /** Tool filter applied by the setup hook alongside the prompt replacement. */
    toolFilter?: { allow?: readonly string[]; deny?: readonly string[] }
    /** Marks the session as a self-contained side query: no ambient context injection, no LLM title. */
    origin?: 'oneshot'
  }): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? oneShotDefaultTimeoutMs
    const ctl = new AbortController()
    const onCallerAbort = (): void => { ctl.abort() }
    opts.signal?.addEventListener('abort', onCallerAbort, { once: true })
    const timer = setTimeout(() => { ctl.abort() }, timeoutMs)

    // A complete-replacement system prompt rides the creation-time setup hook
    // (plan D3, same mechanism as the bare persona): the session's
    // prompt replaces the whole system prompt, not a section, and the hook
    // carries the caller's tool filter with it.
    const innerSetup = opts.systemPromptComplete !== undefined
      ? buildCompletePromptSetup(opts.systemPromptComplete, {
        ...(opts.systemPromptName !== undefined ? { name: opts.systemPromptName } : {}),
        ...(opts.toolFilter !== undefined ? { toolFilter: opts.toolFilter } : {}),
      })
      : undefined
    // A tool filter with an empty allow list already masks every tool (MCP
    // servers included), so the MCP mask wrap would add a redundant second
    // restriction on the same scope.
    const denyAll = opts.toolFilter?.allow !== undefined && opts.toolFilter.allow.length === 0
    const setup = denyAll ? innerSetup : withMcpMask(innerSetup, this.cfg.mcpServers)
    const handle = await this.ctx.agents.create({
      sessionId: SessionId(freshNativeSessionId()),
      meta: {
        cwd: opts.workDir !== undefined && opts.workDir !== '' ? opts.workDir : this.cfg.cwd,
        ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
      },
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
   * `__forkat__<newID>` sentinel consumes the staged truncated prefix a
   * rollback fork prepared (Go /fork on a quoted message) as one seeded
   * create.
   *
   * Persona sessions (flagged through the session-start options) carry a
   * setup hook that replaces the whole system prompt with the feature's
   * precomputed persona text (Go isChatroomBareSession; the D3
   * `complete: true` prompt section). Research assistants get their
   * preamble appended as a normal section instead.
   *
   * @param sessionID - the engine-provided id: '' or the ContinueSession
   * sentinel creates fresh, a concrete id resumes, `__fork__<origID>`
   * seeds from the parent, and `__forkat__<newID>` consumes the staged
   * rollback prefix.
   * @param options - typed per-session start metadata; a non-empty
   * sessionKey overrides the sessionID as the engine session key the live
   * session is bound by.
   * @returns the live session bound to the engine session key.
   */
  async startSession(sessionID: string, options?: SessionStartOptions): Promise<AgentSession> {
    const key = options !== undefined && options.sessionKey !== '' ? options.sessionKey : sessionID
    const isFork = sessionID.startsWith(ForkSessionPrefix)
    const isForkAt = sessionID.startsWith(ForkAtSessionPrefix)
    const isResume = !isFork && !isForkAt && sessionID !== '' && sessionID !== ContinueSession
    const setup = withMcpMask(buildSessionSetup(options), this.cfg.mcpServers)

    const existing = this.sessionsByEngineKey.get(key)
    if (existing !== undefined && existing.alive()) return existing

    let handle: DshAgentHandleLike
    if (isForkAt) {
      // Rollback fork: consume the staged truncated prefix as one seeded
      // create (the native replacement for Go's persisted pre-copy + resume).
      // A missing entry means a daemon restart dropped the seed between
      // prepare and start — degrade to a fresh session, like a sourceless
      // plain fork.
      const forkID = sessionID.slice(ForkAtSessionPrefix.length)
      const prepared = this.forkAtSeeds.get(forkID)
      this.forkAtSeeds.delete(forkID)
      if (prepared === undefined) {
        console.warn(`agent-dsh: fork-at staged seed lost (restart?), starting fresh (id=${forkID})`)
      }
      handle = await this.ctx.agents.create({
        sessionId: SessionId(forkID),
        meta: {
          cwd: prepared !== undefined && prepared.childWorkDir !== '' ? prepared.childWorkDir : this.workDir,
          ...(prepared !== undefined ? { parentSession: SessionId(prepared.parentID), seedLength: prepared.seed.length } : {}),
        },
        ...(prepared !== undefined && prepared.seed.length > 0 ? { seed: prepared.seed } : {}),
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
    const bypass = this.bridgeEvents.waterfall('feishuBridge/permission-policy', { options }, () => unattendedSubtaskBypassesPermissions(options))
    const session = new DshAgentSession(
      key, handle, this.workDir, this.ctx, bypass,
      options?.interactiveSlotKey ?? '',
    )
    // Seed the recent-turn window from the log the agent carries (empty for a
    // fresh session, the resumed/forked history otherwise) and drop any cold
    // fold of this id — the live window is authoritative from here on.
    session.seedRecentTurns(handle.agent.session.events)
    this.recentTurnsCache.delete(session.currentSessionID())

    // Lazily register the userQuestions provider now that the plugin tree
    // is fully loaded (at constructor time it may not be available yet).
    this.ensureUserQuestionsProvider()
    // Go effectiveMode: an unattended session overrides ANY configured or
    // overridden mode with bypassPermissions — which also means plan mode
    // stays off (a delegated child nobody can approve must not stall on an
    // ExitPlanMode card).
    let mode = bypass ? 'bypassPermissions' : (this.modeOverride !== '' ? this.modeOverride : this.defaultMode)
    // A moderator drives a running discussion, never an implementation: an
    // inherited plan default (project agent.mode) would re-arm plan mode on
    // every recycled start and stall the discussion on an ExitPlanMode
    // approval nobody needs to give (listener side of the mode-policy
    // waterfall; the built-in base returns the adapter-computed mode).
    mode = this.bridgeEvents.waterfall('feishuBridge/mode-policy', { options, mode }, () => mode)
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

  /** Update one delegated child's liveness record from a durable event. */
  private recordSubagentActivity(childId: string, event: Record<string, unknown>): void {
    const current = this.subagentActivity.get(childId)
    const toolCalls = (current?.toolCalls ?? 0) + (event.type === 'tool/call' ? 1 : 0)
    this.subagentActivity.set(childId, { lastEventAt: Date.now(), toolCalls })
  }

  /**
   * SubagentActivitySource: liveness of delegated child sessions, keyed by
   * child id. Only sessions that emitted at least one event appear; callers
   * treat a missing entry as "no activity seen".
   * @returns the live activity map (read-only by convention).
   */
  subagentActivitySnapshot(): ReadonlyMap<string, { lastEventAt: number; toolCalls: number }> {
    return this.subagentActivity
  }

  /**
   * SubagentActivitySource: drop the activity records of settled children so
   * the map does not grow with the daemon's lifetime. The panel calls this
   * when a parent's background set fully settles.
   * @param childIds - the child session ids to forget.
   */
  forgetSubagentActivity(childIds: readonly string[]): void {
    for (const id of childIds) this.subagentActivity.delete(id)
  }

  /**
   * RecentTurnsReader: a session's trailing conversation window. Live
   * sessions read the incrementally maintained in-memory window (seeded from
   * the resumed/forked log at startSession); cold sessions fold the persisted
   * log once and cache the result in-process. Unknown ids and a missing
   * persistence service yield [] — window readers are advisory surfaces
   * (estimates, summaries), never turn-taking logic.
   *
   * @param agentSessionID - the native session id to read; '' returns [].
   * @param limit - trailing-entry bound; <= 0 returns the whole window.
   * @returns the trailing window entries, oldest first.
   */
  async recentTurns(agentSessionID: string, limit: number): Promise<HistoryEntry[]> {
    if (agentSessionID === '') return []
    const live = this.liveSessions.get(agentSessionID)
    if (live !== undefined) return live.recentTurns(limit)
    const cached = this.recentTurnsCache.get(agentSessionID)
    if (cached !== undefined) return windowSlice(cached, limit)
    const persistence = this.ctx.get('sessionPersistence') as DshPersistenceLike | undefined
    if (persistence === undefined) return []
    let events: readonly SessionEvent[]
    try {
      events = (await persistence.inspect(SessionId(agentSessionID))).events
    } catch {
      // The backend rejects unknown ids; that rejection is the only error
      // path here and means "no window".
      return []
    }
    const folded = foldRecentTurns(events)
    // Cold sessions never change; bound the cache so a long-lived daemon's
    // /list enrichment cannot grow it without end.
    if (this.recentTurnsCache.size >= 512) {
      const oldest = this.recentTurnsCache.keys().next().value
      if (oldest !== undefined) this.recentTurnsCache.delete(oldest)
    }
    this.recentTurnsCache.set(agentSessionID, folded)
    return windowSlice(folded, limit)
  }

  /**
   * Live sessions plus persisted ones from the session store (exclusive to
   * this daemon): top-level sessions under this project's directory tree,
   * newest first. Summaries/message counts arrive engine-side from the
   * adapter's recent-turn window (`enrichSessionSummaries`); sessions from
   * per-chat `/dir` overrides outside the tree stay unlisted, matching the
   * Go per-cwd store semantics. Persisted recency is the JSONL log file's
   * mtime (SessionHeader has no updatedAt); a backend without `locate` falls
   * back to createdAt.
   *
   * @returns the known sessions with native ids and timestamps.
   */
  async listSessions(): Promise<AgentSessionInfo[]> {
    const live = [...this.liveSessions.values()].map(s => ({
      id: s.currentSessionID(),
      summary: s.lastAssistantText().slice(0, 40),
      messageCount: 0,
      modifiedAt: s.lastActivityAt,
    }))
    const persistence = this.ctx.get('sessionPersistence') as DshPersistenceLike | undefined
    if (persistence === undefined) return live
    const liveIDs = new Set(live.map(s => s.id))
    const base = this.cfg.cwd
    const headers = await persistence.list()
    const persisted: AgentSessionInfo[] = []
    for (const h of headers) {
      if (liveIDs.has(String(h.id))) continue
      if (h.parentSession !== undefined) continue
      if (h.cwd === undefined || !(h.cwd === base || h.cwd.startsWith(`${base}/`))) continue
      persisted.push({ id: String(h.id), summary: '', messageCount: 0, modifiedAt: await this.logMtimeMs(persistence, h) })
    }
    return [...persisted, ...live].sort((a, b) => b.modifiedAt - a.modifiedAt)
  }

  /**
   * Recency of a persisted session: the mtime of its log file when the
   * backend can locate it, else the header's createdAt.
   */
  private async logMtimeMs(persistence: DshPersistenceLike, h: SessionHeader): Promise<number> {
    const located = persistence.locate?.(h)
    if (located !== undefined) {
      try {
        return (await stat(located.path)).mtimeMs
      } catch {
        // Materialization is lazy; a listed-but-unwritten log falls back.
      }
    }
    return h.createdAt
  }

  /** Dispose every live agent (engine shutdown). */
  async stop(): Promise<void> {
    const all = [...this.liveSessions.values()]
    this.liveSessions.clear()
    this.sessionsByEngineKey.clear()
    if (all.length === 0) return
    const bound = this.cfg.closeTimeoutMs ?? defaultAgentCloseTimeoutMs
    // Boxed so the timer callback's assignment escapes literal-type narrowing.
    const timeout = { hit: false }
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => { timeout.hit = true; resolve() }, bound)
    })
    try {
      await Promise.race([Promise.all(all.map(s => s.close())), deadline])
    } finally {
      clearTimeout(timer)
    }
    if (timeout.hit) {
      console.warn(`agent-dsh: agent session close timed out after ${String(bound)}ms, abandoning ${String(all.length)} session(s) to process exit`)
    }
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

/**
 * Whether a durable tool/call's arguments request background execution: the
 * JSON `arguments` blob carrying `run_in_background: true` (the Bash-class
 * background parameter). Unparseable arguments are foreground.
 * @param argumentsValue - Raw `arguments` payload of a tool/call event.
 * @returns The `toolBackground: true` event spread, or an empty spread.
 */
function toolBackgroundOf(argumentsValue: unknown): { toolBackground?: boolean } {
  if (typeof argumentsValue !== 'string' || argumentsValue === '') return {}
  try {
    const parsed = JSON.parse(argumentsValue) as { run_in_background?: unknown }
    return parsed.run_in_background === true ? { toolBackground: true } : {}
  } catch {
    return {}
  }
}

/** Parsed tool arguments as a record, for engine consumers that need typed fields (plan-file path tracking).
 *
 * @param argumentsValue - The JSON-stringified tool arguments.
 * @returns the parsed record, or {} when the input is not a JSON object.
 */
function toolInputRawOf(argumentsValue: unknown): { toolInputRaw?: Record<string, unknown> } {
  if (typeof argumentsValue !== 'string' || argumentsValue === '') return {}
  try {
    const parsed: unknown = JSON.parse(argumentsValue)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return { toolInputRaw: parsed as Record<string, unknown> }
  } catch {
    return {}
  }
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
  /** Where Send stages image/file bytes (Go dshSession.workDir). */
  private readonly workDir: string
  /** Auto-approve tool permissions (Go permMode bypassPermissions / autoApprove). */
  readonly bypassPermissions: boolean
  /** Child sessions that ever ran a turn (cumulative subagent count on the card). */
  private readonly seenChildren = new Set<string>()
  /** Recent conversation window, bounded to recentTurnsWindowCap (the retired bridge history copy). */
  private recentTurnsWindow: HistoryEntry[] = []
  /** Assistant texts of the in-flight turn, joined into one window entry at turn/end. */
  private turnWindowParts: string[] = []
  /** Interactive-state slot key when it differs from `key` (cron `#cron:` slots); '' = same as `key`. */
  private readonly interactiveSlotKey: string

  constructor(
    key: string,
    handle: DshAgentHandleLike,
    workDir = '',
    ctx?: DshContextLike,
    bypassPermissions = false,
    interactiveSlotKey = '',
  ) {
    this.key = key
    this.handle = handle
    this.workDir = workDir
    this.ctx = ctx
    this.bypassPermissions = bypassPermissions
    this.interactiveSlotKey = interactiveSlotKey
  }

  /**
   * The engine-side session key (diagnostics).
   *
   * @returns the engine-side session key.
   */
  sessionKey(): string {
    return this.key
  }

  /**
   * The interactive-state slot key ask surfaces render and route under:
   * cron new-per-run sessions park their state under a `#cron:` slot the
   * bare session key cannot find (Go separates the two the same way).
   *
   * @returns the interactive-state slot key, or the session key when the
   *   session owns its slot outright.
   */
  askSlotKey(): string {
    return this.interactiveSlotKey !== '' ? this.interactiveSlotKey : this.key
  }

  currentSessionID(): string {
    return String(this.handle.agent.id)
  }

  alive(): boolean {
    return !this.disposed
  }

  /** AgentSession.lastStreamActivity: newest projected-event timestamp. */
  lastStreamActivity(): number {
    return this.lastActivityAt
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
   * Seed the recent-turn window from the agent's current event log (resumed
   * or forked history); called once at startSession before any live event
   * arrives, so window readers see pre-start turns immediately.
   *
   * @param events - the agent's session log at startSession time.
   */
  seedRecentTurns(events: readonly SessionEvent[]): void {
    this.recentTurnsWindow = foldRecentTurns(events)
  }

  /**
   * The session's trailing conversation window (RecentTurnsReader delegate).
   *
   * @param limit - trailing-entry bound; <= 0 returns the whole window.
   * @returns the trailing window entries, oldest first.
   */
  recentTurns(limit: number): HistoryEntry[] {
    return windowSlice(this.recentTurnsWindow, limit)
  }

  /** Append one window entry, bounding the window to recentTurnsWindowCap. */
  private pushRecentTurn(entry: HistoryEntry): void {
    this.recentTurnsWindow.push(entry)
    if (this.recentTurnsWindow.length > recentTurnsWindowCap) {
      this.recentTurnsWindow = this.recentTurnsWindow.slice(this.recentTurnsWindow.length - recentTurnsWindowCap)
    }
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
        this.turnWindowParts = []
        break
      }
      case 'user/message': {
        // Human prompts enter the recent-turn window; synthetic injections
        // (plugin context, notices) stay out, matching the retired
        // bridge-side history's contents.
        const source = data.source as { kind?: string } | undefined
        if (source?.kind === 'user') {
          const content = textOfBlocks(data.content as ContentBlock[] | undefined)
          if (content !== '') {
            const time = typeof event.time === 'number' ? event.time : Date.now()
            this.pushRecentTurn({ role: 'user', content, timestamp: new Date(time).toISOString() })
          }
        }
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
        const usage = data.usage as
          | { inputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number; outputTokens?: number }
          | undefined
        // Per-request usage rides the event that projects the message (the
        // text event, or the thinking event of a text-less message); the
        // turn sum still rides the result event.
        const requestUsage = usage === undefined ? undefined : {
          inputTokens: usage.inputTokens ?? 0,
          totalInputTokens: (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0),
          outputTokens: usage.outputTokens ?? 0,
        }
        if (text !== '') {
          this.turnText = text
          this.channel.push({ type: 'text', content: text, done: false, ...(requestUsage ?? {}) })
        }
        if (text !== '' && !isEllipsisOnly(text)) this.turnWindowParts.push(text)
        if (thinking !== '') {
          // A text-less message projects its usage on the thinking event.
          const thinkingUsage = text === '' ? requestUsage : undefined
          this.channel.push({ type: 'thinking', content: thinking, done: false, ...(thinkingUsage ?? {}) })
        }
        // Fold this request's usage into the turn sum (Go accumulateUsage);
        // the result event carries the sum, not the last request's slice.
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
          ...toolInputRawOf(data.arguments),
          content: '',
          done: false,
          ...toolBackgroundOf(data.arguments),
        })
        break
      }
      case 'tool/result': {
        const message = data.message as { source?: { callId?: unknown }; content?: ContentBlock[] } | undefined
        const callId = toolResultCallIdOf(message)
        this.channel.push({
          type: 'tool_result',
          toolResult: textOfBlocks(message?.content),
          // The native event carries failure identity as `error`; the result
          // text already describes the failure to the model, so the bridge
          // only forwards success for the 🔴 marker.
          ...(data.error !== undefined ? { toolSuccess: false } : {}),
          ...(callId !== '' ? { toolID: callId } : {}),
          content: '',
          done: false,
        })
        break
      }
      case 'todo/write': {
        // Whole-list snapshot from any todo producer; the engine treats it
        // like a todo_write tool call (both may arrive — last write wins).
        const todos = data.todos as Array<{ content?: unknown; status?: unknown; activeForm?: unknown }> | undefined
        if (Array.isArray(todos)) {
          const items = todos
            .map((t) => {
              const activeForm = toStr(t.activeForm)
              return {
                content: toStr(t.content),
                status: toStr(t.status),
                ...(activeForm !== '' ? { activeForm } : {}),
              }
            })
            .filter(t => t.content !== '')
          this.channel.push({ type: 'todo_update', todos: items, content: '', done: false })
        }
        break
      }
      case 'compaction/start': {
        this.channel.push({ type: 'compaction', content: '', done: false })
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
        const turnContent = this.turnWindowParts.join('')
        this.turnWindowParts = []
        if (turnContent !== '') {
          const time = typeof event.time === 'number' ? event.time : Date.now()
          this.pushRecentTurn({ role: 'assistant', content: turnContent, timestamp: new Date(time).toISOString() })
        }
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
