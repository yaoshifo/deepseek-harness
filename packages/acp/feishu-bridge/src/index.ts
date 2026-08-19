/**
 * Feishu bridge plugin: cc-connect's engine + Feishu platform orchestration
 * migrated into one long-lived dsh process (see ./docs/MIGRATION.md). M0
 * ships only the plugin skeleton and pure-logic foundations; the engine and
 * Feishu wiring land in M1+.
 *
 * @module dsh-feishu-bridge
 */

import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { DshAgentAdapter } from './agent-dsh/adapter.js'
import type { ProviderRoute as AdapterProviderRoute } from './agent-dsh/adapter.js'
import { FeishuPlatform } from './feishu/platform.js'
import { Engine } from './engine/engine.js'
import { ProjectStateStore } from './engine/project-state.js'
import { registerSessionCommands } from './engine/commands.js'
import { agentIDOf, registerSubtaskTool, type SubtaskRoute } from './tools/subtask.js'

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
  /** Show the animated progress spinner. */
  progressSpinner?: boolean
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
  }).description('Display defaults'),
  dataDir: Schema.string().description('Root directory for per-project session stores'),
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
  /** One live project: its engine plus the adapter that owns its agents. */
  const live: Array<{ engine: Engine; adapter: DshAgentAdapter }> = []
  for (const project of config.projects) {
    const { engine, adapter } = buildProjectAssembly(ctx, config, project, dataRoot)
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
        ...(config.display.progressSpinner !== undefined ? { progressSpinner: config.display.progressSpinner } : {}),
      })
    }

    void engine.start().catch((error: unknown) => {
      ctx.logger.error(`feishu-bridge: project ${project.name} failed to start: ${String(error)}`)
    })
    ctx.effect(() => {
      return () => { void engine.stop() }
    })
  }

  // Plan D4: one process-wide feishu_bridge_subtask tool routes each call by
  // its CALLER agent back to the engine + engine session that agent belongs
  // to — the Go CLI's CC_PROJECT/CC_SESSION_KEY env contract, without env.
  registerSubtaskTool(ctx, (caller): SubtaskRoute | undefined => {
    const id = agentIDOf(caller)
    if (id === '') return undefined
    for (const { engine, adapter } of live) {
      const sessionKey = adapter.engineKeyForAgentID(id)
      if (sessionKey !== undefined) return { engine, sessionKey }
    }
    return undefined
  })
}

/**
 * Assemble one project's adapter + platform + engine with its disk stores
 * wired (Go wire.go per-project wiring): the project state store carries
 * the per-chat workdir overrides (without it /spawn --dir and /dir resolve
 * nothing), and the platform dataDir persists the spawned-chat registry and
 * tag cache across restarts. Extracted from apply() so the wiring is
 * testable without booting Cordis.
 * @param ctx - Plugin context (the structural agents + on + get slice).
 * @param config - Validated plugin config.
 * @param project - The project row to assemble.
 * @param dataRoot - Root directory holding per-project state.
 * @returns The engine and the adapter owning its agents.
 */
export function buildProjectAssembly(
  ctx: Context,
  config: FeishuBridgeConfig,
  project: ProjectConfig,
  dataRoot: string,
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
    ...(project.feishu.notifyOnComplete !== undefined ? { notifyOnComplete: project.feishu.notifyOnComplete } : {}),
    ...(project.feishu.reactionEmoji !== undefined ? { reactionEmoji: project.feishu.reactionEmoji } : {}),
    ...(project.feishu.doneEmoji !== undefined ? { doneEmoji: project.feishu.doneEmoji } : {}),
    ...(project.feishu.cancelEmoji !== undefined ? { cancelEmoji: project.feishu.cancelEmoji } : {}),
    ...(project.feishu.topNoticeFirstMessage !== undefined ? { topNoticeFirstMessage: project.feishu.topNoticeFirstMessage } : {}),
    ...(project.feishu.pinUserMessages !== undefined ? { pinUserMessages: project.feishu.pinUserMessages } : {}),
    dataDir: projectDataDir,
  })

  const engine = new Engine(project.name, adapter, [platform], join(projectDataDir, 'sessions.json'), '')
  engine.setProjectStateStore(new ProjectStateStore(join(projectDataDir, 'state.json')))
  registerSessionCommands(engine)
  wireGroupName(engine, project)
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
