/**
 * Feishu bridge plugin: cc-connect's engine + Feishu platform orchestration
 * migrated into one long-lived dsh process (see ./docs/MIGRATION.md). M0
 * ships only the plugin skeleton and pure-logic foundations; the engine and
 * Feishu wiring land in M1+.
 *
 * @module dsh-feishu-bridge
 */

import { homedir } from 'node:os'
import { mkdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { DshAgentAdapter } from './agent-dsh/adapter.js'
import type { ProviderRoute as AdapterProviderRoute } from './agent-dsh/adapter.js'
import { FeishuPlatform } from './feishu/platform.js'
import { Engine } from './engine/engine.js'
import { ProjectStateStore } from './engine/project-state.js'
import { DirHistory } from './engine/dir-history.js'
import { registerSessionCommands } from './engine/commands.js'
import { agentIDOf, registerSubtaskTool, type SubtaskRoute } from './tools/subtask.js'
import { registerChatroomTool } from './tools/chatroom.js'
import { registerChatroomCommands } from './engine/chatroom-cmd.js'
import { langAuto, langChinese, langEnglish, langJapanese, langSpanish, langTraditionalChinese, type Language } from './i18n/index.js'
import type { StreamPreviewCfg } from './streaming.js'

export const name = 'feishu-bridge'

// ctx.agents is required from apply() onward (every engine session start).
// Without this declaration Cordis refuses ctx.agents access with "cannot get
// property without inject" — observed live on the M1 记账驴 cut-over.
// ctx.tools carries the feishu_bridge_subtask tool family (plan D4).
export const inject = ['agents', 'tools']

/** Feishu app credentials for one bot. Each app gets its own WS client (MIGRATION.md D5). */
export interface FeishuAppConfig {
  /** Feishu open-platform app id (`cli_...`). */
  appId: string
  /** Feishu open-platform app secret. */
  appSecret: string
  /** ✅ push notification after in-place completion (Go notify_on_complete). */
  notifyOnComplete?: boolean
  /** Emoji reaction on the user's message; '' or 'none' disables (Go reaction_emoji). */
  reactionEmoji?: string
  /** Emoji reaction on the completion card; '' or 'none' disables (Go done_emoji). */
  doneEmoji?: string
  /** Emoji reaction when a turn is stopped; '' or 'none' disables (Go cancel_emoji). */
  cancelEmoji?: string
  /** Top-notice banner on the first turn's message (Go topnotice_first_message). */
  topNoticeFirstMessage?: boolean
  /** Accumulate messages into the chat's pin panel (Go pin_user_messages). */
  pinUserMessages?: boolean
}

/** Agent assembly options for one project (MIGRATION.md D1/D3). */
export interface AgentOptions {
  /** Key into the top-level `providers` map (MIGRATION.md D2). */
  provider?: string
  /** Model override for the provider route. */
  model?: string
  /** Reasoning effort passed through to `ctx.agents` agent options. */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'
}

/** Per-project feature switches (subset grown per milestone; MIGRATION.md §4). */
export interface FeatureSwitches {
  /** Feishu chats this bot answers in; false = chats must @-mention (MIGRATION.md #27). */
  allowChat?: boolean
  /** Suppress intermediate thinking/tool messages for this project. */
  quiet?: boolean
  /** Append the Codex-style reply footer (model/reasoning/usage/workdir). */
  replyFooter?: boolean
  /** Prepend sender identity (platform + user id) to each agent message. */
  injectSender?: boolean
  /** Append the `[ctx: ~N%]` context indicator to replies. */
  showContextIndicator?: boolean
}

/** LLM group-name generation + Lucide icon avatars for one project (Go [projects.group_name], #49/#52). */
export interface GroupNameConfig {
  /** LLM naming on; default true (the dsh agent always supports it). */
  enabled?: boolean
  /** Named provider route the naming queries run on (default: the active route). */
  provider?: string
  /** LLM naming timeout in seconds (default 30). */
  timeoutSec?: number
  /** Naming prompt override (default: the built-in two-line name+icon prompt). */
  prompt?: string
  /** Set a Lucide group icon avatar after rename; default true (#52). */
  setAvatar?: boolean
}

/** One bound project: an agent working dir plus the Feishu bot serving it. */
export interface ProjectConfig {
  /** Unique project name used in routing, logs, and tool output. */
  name: string
  /** Working directory for agent sessions created in this project. */
  workdir: string
  /** Feishu app this project's messages arrive on. */
  feishu: FeishuAppConfig
  /** Agent assembly defaults for sessions in this project. */
  agent?: AgentOptions
  /** Feature switches for this project. */
  features?: FeatureSwitches
  /** LLM group-name generation (#49) + icon avatars (#52). */
  groupName?: GroupNameConfig
  /** Multi-role chatroom tuning (Go [chatroom]). */
  chatroom?: ChatroomConfig
  /** Comma-separated user IDs allowed to run privileged commands; '*' = all (Go admin_from). */
  adminFrom?: string
  /** Minutes before an idle interactive session is reaped (Go interactive_idle_timeout_mins). */
  interactiveIdleTimeoutMins?: number
}

/** A named LLM route reference: the route itself lives in the profile's provider config (MIGRATION.md D2). */
export interface ProviderRoute {
  /** Route name registered on the LLM service by the profile. */
  route: string
  /** Model override applied when sessions use this route. */
  model?: string
}

/** How intermediate messages (thinking, tool output) are shown (MIGRATION.md M2/M3). */
export interface DisplayConfig {
  /** Show model thinking messages. */
  thinkingMessages?: boolean
  /** Truncate thinking previews to this many characters. */
  thinkingMaxLen?: number
  /** Truncate tool output previews to this many characters. */
  toolMaxLen?: number
  /** Truncate plan-card content to this many characters. */
  planMaxLen?: number
  /** Show tool-use messages. */
  toolMessages?: boolean
  /** Show merged tool progress on the streaming card. */
  toolProgress?: boolean
  /** Show the animated progress spinner (forwarded to the platform, Go progress_spinner). */
  progressSpinner?: boolean
  /** Minimum ms between card PATCH calls (forwarded to the platform, Go patch_rate_interval_ms). */
  patchRateIntervalMs?: number
  /** Seconds before a silent turn is treated as stalled (Go stall_timeout_secs). */
  stallTimeoutSecs?: number
  /** Stall retries before the idle kill (Go stall_max_retries). */
  stallMaxRetries?: number
}

/** Per-session inbound message queue cap (Go [queue]). */
export interface QueueConfig {
  /** Max queued messages per session. */
  maxDepth?: number
}

/** Recursive subtask delegation caps (Go [subtask]). */
export interface SubtaskConfig {
  /** Max recursive delegation depth. */
  maxDepth?: number
  /** Hard timeout for subtask sessions in seconds; 0 inherits the event idle timeout. */
  timeoutSec?: number
  /** Gather-barrier fallback timeout in seconds. */
  gatherTimeoutSec?: number
}

/** /spawn //fork isolation defaults (Go [spawn]). */
export interface SpawnConfig {
  /** Default worktree isolation: 'auto' | 'on' | 'off'. */
  worktree?: 'auto' | 'on' | 'off'
  /** RAM% above which a warning card is sent; 0 disables the tier (default 80). */
  memoryWarnPct?: number
  /** RAM% above which spawn is declined; 0 disables the tier (default 90). */
  memoryBlockPct?: number
}

/** Multi-role chatroom tuning (Go [chatroom], applied per project). */
export interface ChatroomConfig {
  /** Root directory holding one persona subdirectory per role; ~ expanded. */
  rolesDir?: string
  /** Cap on role agents per chatroom; 0 = default 5 (Go max_roles). */
  maxRoles?: number
  /** Moderator data dir holding per-chatroom ledgers; '' disables the ledger (Go moderator_dir). */
  moderatorDir?: string
  /** Gather barrier fallback timeout in seconds (Go gather_timeout_sec). */
  gatherTimeoutSec?: number
  /** End barrier drain timeout in seconds (Go end_timeout_sec). */
  endTimeoutSec?: number
  /** Research-mode gather round timeout in seconds, clamped to [60, 86400] (Go research_timeout_sec). */
  researchTimeoutSec?: number
  /** Auto-mode research iteration cap, clamped to [1, 20] (Go max_research_rounds). */
  maxResearchRounds?: number
  /** Default research iteration driver when --mode is omitted (Go default_research_mode). */
  defaultResearchMode?: 'auto' | 'manual'
  /** Shared research-assistant workdir; empty falls back to <moderatorDir>/research (Go research_workspace). */
  researchWorkspace?: string
  /** Pre-provision the shared uv venv for research assistants; default true (Go research_python_env). */
  researchPythonEnv?: boolean
}

/** Deployment config for the feishu-bridge plugin. */
export interface FeishuBridgeConfig {
  /** Projects bound to Feishu apps. */
  projects: ProjectConfig[]
  /** Named LLM routes projects may reference. */
  providers: Record<string, ProviderRoute>
  /** Display defaults shared by all projects. */
  display?: DisplayConfig
  /** Root directory for per-project session stores. */
  dataDir?: string
  /** Reply language: 'zh' | 'zh-TW' | 'ja' | 'es' | 'en'; anything else auto-detects (Go language). */
  language?: string
  /** Max minutes between agent events; 0 disables the stall kill (Go idle_timeout_mins). */
  idleTimeoutMins?: number
  /** Allow side-channel image/file delivery; default true (Go attachment_send). */
  attachmentSend?: boolean
  /** Inbound message queue cap (Go [queue]). */
  queue?: QueueConfig
  /** Subtask delegation caps (Go [subtask]). */
  subtask?: SubtaskConfig
  /** /spawn //fork isolation defaults (Go [spawn]). */
  spawn?: SpawnConfig
  /** Multi-role chatroom tuning shared as the per-project default (Go [chatroom]). */
  chatroom?: ChatroomConfig
  /** Streaming preview tuning merged over the defaults (Go [stream_preview]). */
  streamPreview?: Partial<StreamPreviewCfg>
}

export const Config: Schema<FeishuBridgeConfig> = Schema.object({
  projects: Schema.array(Schema.object({
    name: Schema.string().required().description('Unique project name'),
    workdir: Schema.string().required().description('Agent working directory'),
    feishu: Schema.object({
      appId: Schema.string().required().description('Feishu app id'),
      appSecret: Schema.string().required().role('secret').description('Feishu app secret'),
      notifyOnComplete: Schema.boolean().description('✅ notification after in-place completion'),
      reactionEmoji: Schema.string().description('Reaction emoji on user message'),
      doneEmoji: Schema.string().description('Reaction emoji on completion card'),
      cancelEmoji: Schema.string().description('Reaction emoji on stopped card'),
      topNoticeFirstMessage: Schema.boolean().description('Top-notice banner on first turn'),
      pinUserMessages: Schema.boolean().description('Pin panel accumulation'),
    }).required(),
    agent: Schema.object({
      provider: Schema.string().description('Key into providers'),
      model: Schema.string().description('Model override'),
      reasoningEffort: Schema.union(['minimal', 'low', 'medium', 'high']).description('Reasoning effort'),
    }),
    features: Schema.object({
      allowChat: Schema.boolean().description('Answer without @-mention'),
      quiet: Schema.boolean().description('Suppress intermediate messages'),
      replyFooter: Schema.boolean().description('Append reply footer'),
      injectSender: Schema.boolean().description('Prepend sender identity'),
      showContextIndicator: Schema.boolean().description('Append [ctx: ~N%]'),
    }),
    groupName: Schema.object({
      enabled: Schema.boolean().description('LLM group naming (#49); default true'),
      provider: Schema.string().description('Named provider route for naming queries (default: active)'),
      timeoutSec: Schema.natural().description('Naming LLM timeout in seconds (default 30)'),
      prompt: Schema.string().description('Naming prompt override'),
      setAvatar: Schema.boolean().description('Set a Lucide group icon avatar (#52); default true'),
    }).description('LLM group naming and icon avatars (#49/#52)'),
    chatroom: Schema.object({
      rolesDir: Schema.string().description('Root directory holding one persona subdirectory per role'),
      maxRoles: Schema.natural().description('Cap on role agents per chatroom (default 5)'),
      moderatorDir: Schema.string().description('Moderator data dir holding per-chatroom ledgers'),
      gatherTimeoutSec: Schema.natural().description('Gather barrier fallback timeout in seconds (default 1200)'),
      endTimeoutSec: Schema.natural().description('End barrier drain timeout in seconds (default 600)'),
      researchTimeoutSec: Schema.natural().description('Research gather round timeout in seconds, clamped to [60, 86400]'),
      maxResearchRounds: Schema.natural().description('Auto-mode research iteration cap, clamped to [1, 20]'),
      defaultResearchMode: Schema.union(['auto', 'manual']).description('Default research driver when --mode is omitted'),
      researchWorkspace: Schema.string().description('Shared research-assistant workdir (default <moderatorDir>/research)'),
      researchPythonEnv: Schema.boolean().description('Pre-provision the shared uv venv for research; default true'),
    }).description('Multi-role chatroom tuning (Go [chatroom])'),
    adminFrom: Schema.string().description('Comma-separated admin user IDs; * = all'),
    interactiveIdleTimeoutMins: Schema.natural().description('Idle reaper threshold in minutes'),
  })).default([]).description('Projects bound to Feishu apps'),
  providers: Schema.dict(Schema.object({
    route: Schema.string().required().description('LLM service route name from the profile'),
    model: Schema.string().description('Model override'),
  })).default({}).description('Named LLM routes (MIGRATION.md D2)'),
  display: Schema.object({
    thinkingMessages: Schema.boolean().description('Show thinking messages'),
    thinkingMaxLen: Schema.natural().description('Thinking preview truncation'),
    toolMaxLen: Schema.natural().description('Tool output truncation'),
    planMaxLen: Schema.natural().description('Plan card truncation'),
    toolMessages: Schema.boolean().description('Show tool messages'),
    toolProgress: Schema.boolean().description('Show merged tool progress'),
    progressSpinner: Schema.boolean().description('Show progress spinner'),
    patchRateIntervalMs: Schema.natural().description('Minimum ms between card PATCH calls'),
    stallTimeoutSecs: Schema.natural().description('Stall detection window in seconds'),
    stallMaxRetries: Schema.natural().description('Stall retries before the idle kill'),
  }).description('Display defaults'),
  dataDir: Schema.string().description('Root directory for per-project session stores'),
  language: Schema.string().description('Reply language (zh/zh-TW/ja/es/en; else auto-detect)'),
  idleTimeoutMins: Schema.number().description('Max minutes between agent events; 0 disables'),
  attachmentSend: Schema.boolean().description('Allow side-channel image/file delivery'),
  queue: Schema.object({
    maxDepth: Schema.natural().description('Max queued messages per session'),
  }).description('Inbound queue cap'),
  subtask: Schema.object({
    maxDepth: Schema.natural().description('Max recursive delegation depth'),
    timeoutSec: Schema.natural().description('Subtask hard timeout in seconds'),
    gatherTimeoutSec: Schema.natural().description('Gather barrier fallback timeout in seconds'),
  }).description('Subtask delegation caps'),
  spawn: Schema.object({
    worktree: Schema.union(['auto', 'on', 'off']).description('Default worktree isolation'),
    memoryWarnPct: Schema.natural().description('RAM% warning threshold; 0 disables'),
    memoryBlockPct: Schema.natural().description('RAM% block threshold; 0 disables'),
  }).description('/spawn //fork isolation defaults'),
  chatroom: Schema.object({
    rolesDir: Schema.string().description('Root directory holding one persona subdirectory per role'),
    maxRoles: Schema.natural().description('Cap on role agents per chatroom (default 5)'),
    moderatorDir: Schema.string().description('Moderator data dir holding per-chatroom ledgers'),
    gatherTimeoutSec: Schema.natural().description('Gather barrier fallback timeout in seconds (default 1200)'),
    endTimeoutSec: Schema.natural().description('End barrier drain timeout in seconds (default 600)'),
    researchTimeoutSec: Schema.natural().description('Research gather round timeout in seconds, clamped to [60, 86400]'),
    maxResearchRounds: Schema.natural().description('Auto-mode research iteration cap, clamped to [1, 20]'),
    defaultResearchMode: Schema.union(['auto', 'manual']).description('Default research driver when --mode is omitted'),
    researchWorkspace: Schema.string().description('Shared research-assistant workdir (default <moderatorDir>/research)'),
    researchPythonEnv: Schema.boolean().description('Pre-provision the shared uv venv for research; default true'),
  }).description('Multi-role chatroom tuning (Go [chatroom]; per-project sections override)'),
  streamPreview: Schema.object({
    enabled: Schema.boolean().description('Enable streaming preview'),
    intervalMs: Schema.natural().description('Minimum ms between updates'),
    minDeltaChars: Schema.natural().description('Minimum new chars before an update'),
    maxChars: Schema.natural().description('Max preview length'),
    disabledPlatforms: Schema.array(Schema.string()).description('Platforms without preview'),
  }).description('Streaming preview tuning'),
})

/**
 * Start the bridge: one Engine + one Feishu WS platform per configured
 * project (MIGRATION.md §1), plus the process-wide feishu_bridge_subtask
 * tool routed by caller agent (plan D4). An empty projects list idles
 * gracefully — the M0 smoke behavior. TODO(M6+): cron/relay tools and the
 * liveness watchdog arrive with their milestones.
 *
 * @param ctx - Plugin context (provides ctx.agents, ctx.tools, and event dispatch).
 * @param config - Validated plugin config.
 */
export function apply(ctx: Context, config: FeishuBridgeConfig): void {
  const dataRoot = config.dataDir ?? join(homedir(), '.dsh', 'feishu-bridge')
  // One dir history for every project (Go main shares NewDirHistory(cfg.DataDir)
  // across engines so /dir MRU entries land in a single store file).
  const dirHistory = new DirHistory(dataRoot)
  /** One live project: its engine plus the adapter that owns its agents. */
  const live: Array<{ engine: Engine; adapter: DshAgentAdapter }> = []
  for (const project of config.projects) {
    const { engine, adapter } = buildProjectAssembly(ctx, config, project, dataRoot, dirHistory)
    live.push({ engine, adapter })
    if (project.features?.injectSender === true) engine.setInjectSender(true)
    if (project.features?.quiet === true) {
      engine.setDisplayConfig({ thinkingMessages: false, toolMessages: false })
    }
    if (config.display !== undefined) {
      engine.setDisplayConfig({
        ...(config.display.thinkingMessages !== undefined ? { thinkingMessages: config.display.thinkingMessages } : {}),
        ...(config.display.thinkingMaxLen !== undefined ? { thinkingMaxLen: config.display.thinkingMaxLen } : {}),
        ...(config.display.toolMaxLen !== undefined ? { toolMaxLen: config.display.toolMaxLen } : {}),
        ...(config.display.planMaxLen !== undefined ? { planMaxLen: config.display.planMaxLen } : {}),
        ...(config.display.toolMessages !== undefined ? { toolMessages: config.display.toolMessages } : {}),
        ...(config.display.toolProgress !== undefined ? { toolProgress: config.display.toolProgress } : {}),
      })
    }

    void engine.start().catch((error: unknown) => {
      ctx.logger.error(`feishu-bridge: project ${project.name} failed to start: ${String(error)}`)
    })
    ctx.effect(() => {
      return () => { void engine.stop() }
    })
  }

  // Plan D4: one process-wide tool family routes each call by its CALLER
  // agent back to the engine + engine session that agent belongs to — the
  // Go CLI's CC_PROJECT/CC_SESSION_KEY env contract, without env.
  const routeByCaller = (caller: unknown): SubtaskRoute | undefined => {
    const id = agentIDOf(caller)
    if (id === '') return undefined
    for (const { engine, adapter } of live) {
      const sessionKey = adapter.engineKeyForAgentID(id)
      if (sessionKey !== undefined) return { engine, sessionKey }
    }
    return undefined
  }
  registerSubtaskTool(ctx, routeByCaller)
  registerChatroomTool(ctx, routeByCaller)
}

/**
 * Map a config language string to the engine i18n language (Go wire.go's
 * switch over cfg.Language): recognized values pin the language, anything
 * else falls back to auto-detection.
 * @param value - Raw config string ('' or undefined allowed).
 * @returns The pinned language, or the auto-detect sentinel.
 */
function languageOf(value: string | undefined): Language {
  switch (value) {
    case 'zh': case 'chinese': return langChinese
    case 'zh-TW': case 'zh_TW': case 'zhtw': return langTraditionalChinese
    case 'ja': case 'japanese': return langJapanese
    case 'es': case 'spanish': return langSpanish
    case 'en': case 'english': return langEnglish
    default: return langAuto
  }
}

/**
 * Resolve the effective work dir at startup (Go applyProjectStateOverride):
 * a persisted project-wide override from the project state store wins over
 * the configured workdir when it still points at an existing directory.
 * @param adapter - The agent adapter whose workdir may be switched.
 * @param configured - The project's configured workdir.
 * @param projectState - The persisted per-project state store.
 * @returns The effective workdir for the engine's base work dir.
 */
function applyProjectStateOverride(adapter: DshAgentAdapter, configured: string, projectState: ProjectStateStore): string {
  const override = projectState.workDirOverride()
  if (override === '') return configured
  const abs = resolve(override)
  try {
    if (statSync(abs).isDirectory()) {
      adapter.setWorkDir(abs)
      return abs
    }
  } catch {
    // Missing directory: fall through to the configured workdir (Go logs and ignores).
  }
  return configured
}

/**
 * Assemble one project's adapter + platform + engine with its disk stores
 * and config knobs wired (Go wire.go per-project wiring): the project state
 * store carries the per-chat workdir overrides (without it /spawn --dir and
 * /dir resolve nothing), the dir history backs /dir's MRU list, and the
 * engine setters receive every config-sourced tunable. Extracted from
 * apply() so the wiring is testable without booting Cordis.
 * @param ctx - Plugin context (the structural agents + on + get slice).
 * @param config - Validated plugin config.
 * @param project - The project row to assemble.
 * @param dataRoot - Root directory holding per-project state.
 * @param sharedDirHistory - Dir history shared across projects (Go shares one store).
 * @returns The engine and the adapter owning its agents.
 */
export function buildProjectAssembly(
  ctx: Context,
  config: FeishuBridgeConfig,
  project: ProjectConfig,
  dataRoot: string,
  sharedDirHistory?: DirHistory,
): { engine: Engine; adapter: DshAgentAdapter; platform: FeishuPlatform } {
  const routeNames = Object.keys(config.providers)
  const activeProvider = project.agent?.provider ?? routeNames[0] ?? ''
  const routes: AdapterProviderRoute[] = routeNames.flatMap((routeName) => {
    const route = config.providers[routeName]
    if (route === undefined) return []
    return [{
      name: routeName,
      provider: route.route,
      model: route.model ?? '',
      ...(routeName === activeProvider && project.agent?.reasoningEffort !== undefined
        ? { reasoningEffort: project.agent.reasoningEffort }
        : {}),
    }]
  })

  // The structural slice (agents + on + get) is exactly what the real
  // Cordis context provides; the adapter consumes it structurally.
  const adapter = new DshAgentAdapter(ctx, {
    agentName: 'dsh',
    cwd: project.workdir,
    providers: routes,
    activeProvider,
  })

  const projectDataDir = join(dataRoot, project.name)
  // The engine/platform stores assume the data dirs exist (Go main created
  // cfg.DataDir upfront); without this the spawned-chat registry save ENOENTs.
  mkdirSync(join(projectDataDir, 'sessions'), { recursive: true })
  const platform = new FeishuPlatform({
    appID: project.feishu.appId,
    appSecret: project.feishu.appSecret,
    groupReplyAll: project.features?.allowChat === true,
    projectName: project.name,
    workDir: project.workdir,
    ...(config.display?.progressSpinner !== undefined ? { progressSpinner: config.display.progressSpinner } : {}),
    ...(config.display?.patchRateIntervalMs !== undefined && config.display.patchRateIntervalMs > 0
      ? { patchRateIntervalMs: config.display.patchRateIntervalMs }
      : {}),
    ...(project.feishu.notifyOnComplete !== undefined ? { notifyOnComplete: project.feishu.notifyOnComplete } : {}),
    ...(project.feishu.reactionEmoji !== undefined ? { reactionEmoji: project.feishu.reactionEmoji } : {}),
    ...(project.feishu.doneEmoji !== undefined ? { doneEmoji: project.feishu.doneEmoji } : {}),
    ...(project.feishu.cancelEmoji !== undefined ? { cancelEmoji: project.feishu.cancelEmoji } : {}),
    ...(project.feishu.topNoticeFirstMessage !== undefined ? { topNoticeFirstMessage: project.feishu.topNoticeFirstMessage } : {}),
    ...(project.feishu.pinUserMessages !== undefined ? { pinUserMessages: project.feishu.pinUserMessages } : {}),
    dataDir: projectDataDir,
  })

  const engine = new Engine(project.name, adapter, [platform], join(projectDataDir, 'sessions.json'), languageOf(config.language))
  const projectState = new ProjectStateStore(join(projectDataDir, 'state.json'))
  engine.setProjectStateStore(projectState)
  const effectiveWorkDir = applyProjectStateOverride(adapter, project.workdir, projectState)
  engine.setBaseWorkDir(effectiveWorkDir)
  const dirHistory = sharedDirHistory ?? new DirHistory(dataRoot)
  engine.setDirHistory(dirHistory)
  // Seed the MRU with the startup dir (Go main ensures the initial workdir
  // is in history so /dir <n> can return to it).
  if (effectiveWorkDir !== '' && !dirHistory.contains(project.name, effectiveWorkDir)) {
    dirHistory.add(project.name, effectiveWorkDir)
  }
  registerSessionCommands(engine)
  registerChatroomCommands(engine)
  wireGroupName(engine, project)
  wireChatroom(engine, config.chatroom, project.chatroom, dataRoot)

  // Stall detection (Go [display] stall_*): wired first, then
  // idle_timeout_mins below overrides it, matching wire.go's order.
  if (config.display?.stallTimeoutSecs !== undefined) {
    engine.setEventIdleTimeout(config.display.stallTimeoutSecs * 1000)
  }
  if (config.display?.stallMaxRetries !== undefined) {
    engine.setStallMaxRetries(config.display.stallMaxRetries)
  }
  if (config.idleTimeoutMins !== undefined) {
    engine.setEventIdleTimeout(config.idleTimeoutMins > 0 ? config.idleTimeoutMins * 60_000 : 0)
  }
  if (config.queue?.maxDepth !== undefined && config.queue.maxDepth > 0) {
    engine.setMaxQueuedMessages(config.queue.maxDepth)
  }
  if (config.subtask?.maxDepth !== undefined && config.subtask.maxDepth > 0) {
    engine.setSubtaskMaxDepth(config.subtask.maxDepth)
  }
  if (config.subtask?.timeoutSec !== undefined && config.subtask.timeoutSec > 0) {
    engine.setSubtaskTimeout(config.subtask.timeoutSec * 1000)
  }
  if (config.subtask?.gatherTimeoutSec !== undefined && config.subtask.gatherTimeoutSec > 0) {
    engine.setSubtaskGatherTimeout(config.subtask.gatherTimeoutSec * 1000)
  }
  if (config.spawn?.worktree !== undefined) {
    engine.setSpawnWorktreeMode(config.spawn.worktree)
  }
  // RAM guard always wired with the 80/90 defaults so configs without the
  // keys still get protection (Go EffectiveSpawnMemoryGuard).
  engine.setSpawnMemoryGuard(config.spawn?.memoryWarnPct ?? 80, config.spawn?.memoryBlockPct ?? 90)
  if (project.adminFrom !== undefined) {
    engine.setAdminFrom(project.adminFrom)
  }
  if (project.interactiveIdleTimeoutMins !== undefined) {
    engine.setInteractiveIdleTimeout(project.interactiveIdleTimeoutMins * 60_000)
  }
  engine.setAttachmentSendEnabled(config.attachmentSend !== false)
  if (config.streamPreview !== undefined) {
    engine.setStreamPreviewCfg(config.streamPreview)
  }
  return { engine, adapter, platform }
}

/**
 * Configure LLM group-name generation + icon avatars (Go wireGroupName):
 * enabled defaults ON — Go keyed the default on the claudecode agent, and
 * this plugin's agent is always dsh, whose adapter implements the
 * lightweight-query capability naming needs. Timeout defaults to 30s and
 * setAvatar to true; an explicit groupName section overrides each field.
 * @param engine - The project's engine.
 * @param project - The project row carrying the optional groupName section.
 */
function wireGroupName(engine: Engine, project: ProjectConfig): void {
  const g = project.groupName
  if (g?.enabled === false) {
    engine.setGroupNameConfig(false, '', 0, '')
    engine.setGroupNameAvatarEnabled(false)
    return
  }
  const timeoutSec = g?.timeoutSec !== undefined && g.timeoutSec > 0 ? g.timeoutSec : 30
  engine.setGroupNameConfig(true, g?.provider ?? '', timeoutSec * 1000, g?.prompt ?? '')
  // #52: default on; only an explicit setAvatar=false disables it.
  engine.setGroupNameAvatarEnabled(g?.setAvatar !== false)
}

/** Expand a leading ~ in a config path so the config stays portable across machines (Go expandHome). */
function expandHome(path: string): string {
  const trimmed = path.trim()
  const home = homedir()
  if (trimmed === '~') return home
  if (trimmed.startsWith('~/')) return join(home, trimmed.slice(2))
  return trimmed
}

/**
 * Configure the chatroom domain (Go wire.go's [chatroom] wiring): the
 * project section overrides the shared top-level default per field. An
 * empty moderatorDir stays EMPTY — unlike Go's configHome fallback, the
 * ledger is opt-in here so default assemblies stay clean; explicit values
 * (~ expanded) enable it.
 */
function wireChatroom(
  engine: Engine,
  shared: ChatroomConfig | undefined,
  project: ChatroomConfig | undefined,
  _dataRoot: string,
): void {
  const cfg: ChatroomConfig = { ...shared, ...project }
  if (cfg.rolesDir !== undefined && cfg.rolesDir.trim() !== '') {
    engine.setChatroomRolesDir(expandHome(cfg.rolesDir))
  }
  if (cfg.maxRoles !== undefined && cfg.maxRoles > 0) {
    engine.setMaxChatroomRoles(cfg.maxRoles)
  }
  if (cfg.moderatorDir !== undefined) {
    engine.setChatroomModeratorDir(expandHome(cfg.moderatorDir))
  }
  if (cfg.gatherTimeoutSec !== undefined && cfg.gatherTimeoutSec > 0) {
    engine.setChatroomGatherTimeout(cfg.gatherTimeoutSec * 1000)
  }
  if (cfg.endTimeoutSec !== undefined && cfg.endTimeoutSec > 0) {
    engine.setChatroomEndTimeout(cfg.endTimeoutSec * 1000)
  }
  if (cfg.researchTimeoutSec !== undefined && cfg.researchTimeoutSec > 0) {
    engine.setChatroomResearchTimeout(cfg.researchTimeoutSec * 1000)
  }
  if (cfg.maxResearchRounds !== undefined && cfg.maxResearchRounds > 0) {
    engine.setMaxChatroomResearchRounds(cfg.maxResearchRounds)
  }
  if (cfg.defaultResearchMode !== undefined) {
    engine.setDefaultChatroomResearchMode(cfg.defaultResearchMode)
  }
  if (cfg.researchWorkspace !== undefined && cfg.researchWorkspace.trim() !== '') {
    engine.setChatroomResearchWorkspace(expandHome(cfg.researchWorkspace))
  }
  // Research venv provisioning defaults ON (Go wire.go: nil → enabled).
  engine.setChatroomResearchPythonEnv(cfg.researchPythonEnv !== false)
}
