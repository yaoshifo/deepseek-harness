/**
 * Feishu bridge plugin: cc-connect's engine + Feishu platform orchestration
 * migrated into one long-lived dsh process (see MIGRATION.md). M0
 * ships only the plugin skeleton and pure-logic foundations; the engine and
 * Feishu wiring land in M1+.
 *
 * @module dsh-feishu-bridge
 */

import { homedir } from 'node:os'
import { mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { SkillRegistry } from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
// Type-only: pulls the 'subagent/start' / 'subagent/end' event-map
// declaration merging the settlement listener types against (the runtime
// itself is mounted by dsh-base, not here).
import type { SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import Schema from '@deepseek-ai/schemastery'
import { DshAgentAdapter } from './agent-dsh/adapter.js'
import type { ProviderRoute as AdapterProviderRoute, QuestionRouting } from './agent-dsh/adapter.js'
import { installLogTimestamps } from './log-timestamps.js'
import { FeishuBridgeService, type BridgeDispatch } from './bridge-service.js'
import { FeishuPlatform } from './feishu/platform.js'
import { Engine } from './engine/engine.js'
import { ProjectStateStore } from './engine/project-state.js'
import { DirHistory } from './engine/dir-history.js'
import { HintUsage } from './engine/hint-usage.js'
import { registerSessionCommands } from './engine/commands.js'
import { registerShellCommands } from './engine/shell-commands.js'
import { registerReloadCommands, completePendingReload } from './engine/reload-commands.js'
import { registerSpawnFamilyCommands } from './engine/spawn-family-commands.js'
import { registerMiscCommands } from './engine/misc-commands.js'
import { registerSkillsMcpCommands } from './engine/skills-mcp-commands.js'
import { registerContextCommands } from './engine/context-commands.js'
import { CronScheduler, CronStore } from './engine/cron.js'
import { registerCronCommands } from './engine/cron-commands.js'
import { RelayManager } from './engine/relay.js'
import { registerRelayCommands } from './engine/relay-commands.js'
import { MonitorExampleStore, type MonitorDirEntry, type MonitorRuleEntry } from './engine/monitor.js'
import { registerMonitorCommands } from './engine/monitor-commands.js'
import { registerSubtaskTool, type SubtaskRoute } from './tools/subtask.js'
import { registerMcpHealthContext } from './core/mcp-health.js'
import { createUsageProvider, type UsageProvider } from './engine/usage.js'
import { registerCronTool } from './tools/cron.js'
import { registerRelayTool } from './tools/relay.js'
import { registerSendTool } from './tools/send.js'
import { registerLarkTool, type LarkRoute } from './tools/lark.js'
import { registerProviderCommands } from './engine/provider-commands.js'
import { registerPredictCommands } from './engine/predict.js'
import { registerSessionMiscCommands } from './engine/session-misc.js'
import { getProviderModel } from './engine/provider.js'
import { renderSkillName } from './engine/plan-render.js'
import { langAuto, langChinese, langEnglish, langJapanese, langSpanish, langTraditionalChinese, type Language } from './i18n/index.js'
import type { StreamPreviewCfg } from './streaming.js'

export const name = 'feishu-bridge'

// ctx.agents is required from apply() onward (every engine session start).
// Without this declaration Cordis refuses ctx.agents access with "cannot get
// property without inject" — observed live on the M1 记账驴 cut-over.
// ctx.tools carries the feishu_bridge_subtask tool family (plan D4).
// ctx.systemPrompt carries the opt-in mcpHealth runtime context.
// ctx.sessionProjections backs the /context card's snapshot read (the
// adapter reaches it through ctx.get); dsh-base mounts the registry, and the
// declaration orders this plugin after it.
export const inject = ['agents', 'tools', 'systemPrompt', 'sessionProjections']

/** Feishu app credentials for one bot. Each app gets its own WS client (MIGRATION.md D5). */
export interface FeishuAppConfig {
  /** Feishu open-platform app id (`cli_...`). */
  appId: string
  /** Feishu open-platform app secret. */
  appSecret: string
  /** Session-key prefix and platform name; unique per project in multi-bot deployments (Go tag). */
  tag?: string
  /** Comma-separated user IDs allowed to talk to this bot; '*' or '' = everyone (Go allow_from). */
  allowFrom?: string
  /** Only answer group chats, drop p2p messages (Go group_only). */
  groupOnly?: boolean
  /** Share one session per chat instead of per user+chat (Go share_session_in_channel). */
  shareSessionInChannel?: boolean
  /** Isolate each message thread into its own session (Go thread_isolation). */
  threadIsolation?: boolean
  /** Reply to the triggering message instead of posting new; default true (Go reply_to_trigger). */
  replyToTrigger?: boolean
  /** Also answer @所有人/@所有人中提及本机器人 (Go respond_to_at_everyone_and_here). */
  respondToAtEveryoneAndHere?: boolean
  /** Interactive cards; default true (Go enable_feishu_card). */
  enableFeishuCard?: boolean
  /** Progress rendering: 'legacy' | 'compact' | 'card' (Go progress_style). */
  progressStyle?: string
  /** Explicit active-tag name override (Go active_tag_name). */
  activeTagName?: string
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
  /** Default session mode: 'plan' starts every session in plan mode (Go agent options mode). */
  mode?: string
  /**
   * Reasoning effort passed through to `ctx.agents` agent options; also the
   * status footer's 🤖 line display source. Ids must exist in some adapter's
   * advertised set: no adapter offers 'minimal'.
   */
  reasoningEffort?: 'off' | 'low' | 'medium' | 'high' | 'max'
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
  /** Suppress settlement cards for unattended native subtasks; the parent-agent wake is always delivered. */
  subtaskQuiet?: boolean
  /** Post a live per-child panel card while a settled parent turn has unreported native subtasks; default true. */
  subtaskLivePanel?: boolean
  /** Panel refresh interval in ms (default 15000; 0 disables the panel). */
  subtaskLivePanelIntervalMs?: number
  /** Silence window in ms after which a panel row flags a child as stalled (default 120000). */
  subtaskLivePanelStallMs?: number
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

/** Plan/reply HTML rendering for one project (Go [projects.plan_render], #47/#48). */
export interface PlanRenderConfig {
  /** Async-render plan/reply to HTML; opt-in, default off. */
  enabled?: boolean
  /** Named provider route the render sessions run on (default: the active route). */
  provider?: string
  /** Render-session thinking effort alias: low/medium/high/max/off (default low). */
  effort?: string
  /** HTML→PNG renderer script (absolute path). Empty = deliver the .html file instead of an image. */
  renderPngScript?: string
  /** Render-session fork timeout in seconds (default 600; speculative pre-render caps at 360). */
  timeoutSec?: number
}

/** Next-message prediction after each turn (Go [projects.predict_next], #33). */
export interface PredictNextConfig {
  /** Prediction on; default false. */
  enabled?: boolean
  /** Named provider route the prediction fork runs on. */
  provider?: string
  /** Prediction timeout in seconds (default 120). */
  timeoutSec?: number
  /** Prediction prompt override (default: the built-in Chinese prompt). */
  prompt?: string
  /** 'resume' forks the live transcript; default 'lightweight' one-shot query. */
  mode?: string
}

/** One-line turn summary appended to the insight card (Go [projects.turn_summary]). */
export interface TurnSummaryConfig {
  /** Summary on; default false. */
  enabled?: boolean
  /** Named provider route the summary fork runs on. */
  provider?: string
  /** Summary timeout in seconds (default 30). */
  timeoutSec?: number
  /** Summary prompt override (default: the built-in Chinese prompt). */
  prompt?: string
}

/** Automatic context compression (Go [projects.auto_compress]). */
export interface AutoCompressConfig {
  /** Compression on; default false. */
  enabled?: boolean
  /** Token estimate threshold that arms compression. */
  maxTokens?: number
  /** Minimum minutes between compressions (default 30). */
  minGapMins?: number
}

/** Unsolicited-reader budgets for engine-woken turns (Go unsolicited_* config). */
export interface UnsolicitedConfig {
  /** Quiet seconds before the reader disarms (default 60; 0 = never). */
  idleSec?: number
  /** Quiet seconds an in-flight tool on a background turn keeps the reader alive (default 1800). */
  toolInFlightSec?: number
  /** Seconds pending background tasks keep the reader alive (default 1800). */
  backgroundGraceSec?: number
  /** Seconds after a foreground completion where duplicate frames relay as plain text (default 30; 0 = disabled). */
  spilloverSec?: number
}

/** The bot's default Feishu Wiki/Drive location (Go FeishuWorkspaceConfig, #18). */
export interface FeishuWorkspaceConfig {
  /** Wiki space id surfaced as CC_FEISHU_WIKI_SPACE_ID. */
  wikiSpaceId?: string
  /** Drive folder token surfaced as CC_FEISHU_FOLDER_TOKEN. */
  folderToken?: string
  /** Wiki parent node token surfaced as CC_FEISHU_WIKI_NODE_TOKEN. */
  wikiNodeToken?: string
  /** Natural-language description surfaced as CC_FEISHU_WORKSPACE_DESC. */
  description?: string
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
  /** Plan/reply HTML rendering (#47/#48). */
  planRender?: PlanRenderConfig
  /** Plans directory for presented-plan persistence; '' disables (default ~/.claude/plans). */
  planDir?: string

  /** Next-message prediction after each turn (#33). */
  predictNext?: PredictNextConfig
  /** One-line turn summary on the insight card. */
  turnSummary?: TurnSummaryConfig
  /** Automatic context compression (Go [projects.auto_compress]). */
  autoCompress?: AutoCompressConfig
  /** Quick provider commands: /strong → provider name (Go provider_shortcuts). */
  providerShortcuts?: Record<string, string>
  /** Rotate the chat to a fresh session after N idle minutes (Go reset_on_idle_mins). */
  resetOnIdleMins?: number
  /** Prune sessions idle beyond N days on the next full save (Go session_cleanup_days; 0 keeps everything). */
  sessionCleanupDays?: number
  /** Bounded seconds to wait for an agent session to close during cleanup and stall retry (Go agentCloseTimeout; default 130). */
  agentCloseSec?: number
  /** Unsolicited-reader budgets for engine-woken turns (Go unsolicited_* config). */
  unsolicited?: UnsolicitedConfig
  /**
   * Residue guard: chatroom tuning moved to the chatroom plugin's own
   * config (packages/acp/feishu-bridge-chatroom). The key stays in the
   * schema only so apply can fail loud on a cordis.patch.yml whose chatroom
   * section was not migrated (schemastery strips unknown keys silently).
   */
  chatroom?: unknown
  /** Monitor-group mode (#53): observe + triage + auto-spawn subgroups. */
  monitor?: MonitorConfig
  /** Model context window in tokens; 0 = the 200k default (Go context_window). */
  contextWindow?: number

  /** Parent dirs whose subdirs are auto-listed in /dir (Go dir_scan_paths, #3). */
  dirScanPaths?: string[]
  /**
   * MCP server-name allowlist for this project's sessions. Present = sessions
   * (chats, resumes, forks, chatroom personas, subtask children, one-shot
   * queries) only see `mcp__<server>__*` tools of the listed servers; every
   * other MCP server's tools are masked out of the model request. Absent =
   * unrestricted. A listed server with no live tools (not mounted, or down at
   * boot) is silently invisible — a typo and an outage are indistinguishable
   * here, and fail-loud would let one dead server break other projects'
   * sessions.
   */
  mcpServers?: string[]
  /** The bot's default Feishu Wiki/Drive location (Go feishu_workspace, #18). */
  feishuWorkspace?: FeishuWorkspaceConfig
  /** Comma-separated user IDs allowed to run privileged commands; '*' = all (Go admin_from). */
  adminFrom?: string
  /** Minutes before an idle interactive session is reaped; default 120; 0 disables (Go interactive_idle_timeout_mins). */
  interactiveIdleTimeoutMins?: number
}

/** A named LLM route reference: the route itself lives in the profile's provider config (MIGRATION.md D2). */
export interface ProviderRoute {
  /** Route name registered on the LLM service by the profile. */
  route: string
  /** Model override applied when sessions use this route. */
  model?: string
  /** Context window in tokens for this route's models; 0/unset = the project-level context_window (Go ContextWindow, #12). */
  contextWindow?: number
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
  /** Per-turn wall-clock cap in seconds; unset = 2× idle, 0 disables (Go absolute_turn_timeout_secs). */
  absoluteTurnTimeoutSecs?: number
  /** Editor base URL linked from status footers (Go editor_url; '' disables). */
  editorUrl?: string
}

/** Per-session inbound message queue cap (Go [queue]). */
export interface QueueConfig {
  /** Max queued messages per session. */
  maxDepth?: number
}

/** Per-session inbound rate limit (Go [rate_limit]). */
export interface RateLimitConfig {
  /** Messages allowed per window; 0 disables limiting. */
  maxMessages?: number
  /** Sliding window length in seconds. */
  windowSecs?: number
}

/** Recursive subtask delegation caps (Go [subtask]). */
export interface SubtaskConfig {
  /** Max recursive delegation depth. */
  maxDepth?: number
  /** Gather-barrier fallback timeout in seconds. */
  gatherTimeoutSec?: number
}

/** /spawn //fork isolation defaults (Go [spawn]). */
export interface SpawnConfig {
  /** Default worktree isolation: 'auto' | 'on' | 'off'. */
  worktree?: 'auto' | 'on' | 'off'
  /** Override for /done merged auto-removal's containment target (e.g. 'dev'); unset uses each worktree's recorded base branch. */
  integrateBranch?: string
  /** RAM% above which a warning card is sent; 0 disables the tier (default 80). */
  memoryWarnPct?: number
  /** RAM% above which spawn is declined; 0 disables the tier (default 90). */
  memoryBlockPct?: number
}

/** Cron job behavior defaults, shared by every project (Go [cron]). */
export interface CronConfig {
  /** Suppress cron start notifications by default (Go cron.silent). */
  silent?: boolean
  /** Default session mode: 'reuse' (default) or 'new_per_run' (Go cron.session_mode). */
  sessionMode?: string
}

/** Bot-to-bot relay behavior, shared by every project (Go [relay]). */
export interface RelayConfig {
  /** Max seconds to wait for a relay response; 0 disables; default 120 (Go relay.timeout_secs). */
  timeoutSecs?: number
}

/** One entry in the monitor dir menu (Go MonitorDirCfg). */
export interface MonitorDirConfig {
  /** Directory path the LLM routes to. */
  path: string
  /** One-line description the LLM matches against. */
  description?: string
}

/** A deterministic monitor rule: regex → dir (Go MonitorRuleCfg). */
export interface MonitorRuleConfig {
  /** Regex matched against the message text. */
  pattern: string
  /** Directory the matching message spawns into. */
  dir: string
  /** First-instruction template; {{message}} = the message text. */
  task?: string
  /** Fire-and-forget: the child never reports back to the hub (Go no_report). */
  noReport?: boolean
}

/**
 * Monitor-group mode (#53, Go [projects.monitor]): the bot observes the
 * listed chats, triages each message (rules first, then an LLM side query
 * with /learn few-shot examples), and spawns an isolated subgroup in a
 * configured directory for actionable ones.
 */
export interface MonitorConfig {
  /** Master switch. */
  enabled?: boolean
  /** Comma-separated chat IDs to monitor, or "*" for every group the bot is in. */
  chats?: string
  /** Recent messages fed to LLM triage as context; 0 = single-message triage. */
  contextWindow?: number
  /** Post a heads-up card when a subgroup is spawned; default true. */
  spawnNotice?: boolean
  /** Cap on active (not /done) subgroups per monitored chat; default 5. */
  maxConcurrent?: number
  /** Named provider route for the LLM triage fork; empty = active provider. */
  triageProvider?: string
  /** Triage prompt override; empty = the built-in mode default. */
  triagePrompt?: string
  /** Directory menu the LLM picks from. */
  dirs?: MonitorDirConfig[]
  /** Deterministic fast-path rules. */
  rules?: MonitorRuleConfig[]
  /** /learn teaching mechanism; default true. */
  learnEnabled?: boolean
  /** Cap on learned examples injected into the triage prompt; default 20. */
  learnMaxExamples?: number
  /** Emoji reacted on acted-on messages; 'none' disables; default 'Get'. */
  reactEmoji?: string
  /** Poll each chat for messages that never arrive as events; default 30; 0 = off. */
  pollIntervalSec?: number
  /** open_id owning subgroups spawned for sender-less webhook cards. */
  fallbackUser?: string
  /** 'monitor' (alert triage, default) or 'dispatch' (hub dispatcher). */
  mode?: string
  /** Route same-dir alerts into the existing active subgroup; default true. */
  coalesceEnabled?: boolean
  /** Coalescing window in seconds; default 300; 0 = no age limit. */
  coalesceWindowSec?: number
}

/**
 * Process-wide services every project's engine registers into (Go main
 * wiring): one CronStore + CronScheduler and one RelayManager per daemon.
 */
export interface SharedProcessServices {
  cronScheduler?: CronScheduler
  relayManager?: RelayManager
}

/** One watched MCP server for the `mcpHealth` runtime context. */
export interface McpHealthServerConfig {
  /** mcp-client row's serverName; its tools register as `mcp__<serverName>__<rawName>`. */
  serverName: string
  /** Fix hint appended to that server's degradation line (e.g. the token-renewal command). */
  fixHint?: string
}

/** Opt-in MCP degradation runtime-context config; absent = no context registered. */
export interface McpHealthConfig {
  /** Watched servers; an empty list registers nothing. */
  servers: McpHealthServerConfig[]
  /** Grace seconds after plugin start before a missing server is reported; default 180. */
  startupGraceSecs?: number
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
  /** Per-session inbound rate limit; defaults 20 messages / 60 s, maxMessages 0 disables (Go [rate_limit]). */
  rateLimit?: RateLimitConfig
  /** Subtask delegation caps (Go [subtask]). */
  subtask?: SubtaskConfig
  /** /spawn //fork isolation defaults (Go [spawn]). */
  spawn?: SpawnConfig
  /** Cron job behavior defaults (Go [cron]). */
  cron?: CronConfig
  /** Bot-to-bot relay behavior (Go [relay]). */
  relay?: RelayConfig
  /**
   * Residue guard: chatroom tuning moved to the chatroom plugin's own
   * config (packages/acp/feishu-bridge-chatroom); apply fails loud when set.
   */
  chatroom?: unknown
  /** Streaming preview tuning merged over the defaults (Go [stream_preview]). */
  streamPreview?: Partial<StreamPreviewCfg>
  /** Provider quota displays appended to the completion footer (Go usage_providers). */
  usageProviders?: UsageProviderConfig[]
  /** Compact hint commands on status footers and /hint (Go hints). */
  hints?: string[]
  /** Hints whose input field value appends to the command (Go hints_with_param). */
  hints_with_param?: string[]
  /** Always-visible hint commands (Go hints_common). */
  hints_common?: string[]
  /** MCP degradation runtime context; absent = disabled (zero behavior change). */
  mcpHealth?: McpHealthConfig
}

/** One provider quota display entry (Go UsageProviderConfig). */
export interface UsageProviderConfig {
  /** Provider type key: 'glm' or 'minimax'. */
  type: string
  /** Provider-specific options (e.g. api_key, region). */
  options?: Record<string, unknown>
}

export const Config: Schema<FeishuBridgeConfig> = Schema.object({
  projects: Schema.array(Schema.object({
    name: Schema.string().required().description('Unique project name'),
    workdir: Schema.string().required().description('Agent working directory'),
    feishu: Schema.object({
      appId: Schema.string().required().description('Feishu app id'),
      appSecret: Schema.string().required().role('secret').description('Feishu app secret'),
      tag: Schema.string().description('Session-key prefix and platform name; unique per project in multi-bot deployments'),
      allowFrom: Schema.string().description('Comma-separated user allowlist; * or empty = everyone'),
      groupOnly: Schema.boolean().description('Only answer group chats (drop p2p)'),
      shareSessionInChannel: Schema.boolean().description('One session per chat instead of per user+chat'),
      threadIsolation: Schema.boolean().description('Isolate each message thread into its own session'),
      replyToTrigger: Schema.boolean().description('Reply to the triggering message (default true)'),
      respondToAtEveryoneAndHere: Schema.boolean().description('Answer @所有人 mentions of this bot'),
      enableFeishuCard: Schema.boolean().description('Interactive cards (default true)'),
      progressStyle: Schema.string().description("Progress rendering: 'legacy' | 'compact' | 'card'"),
      activeTagName: Schema.string().description('Explicit active-tag name override'),
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
      mode: Schema.string().description("Default session mode ('plan' = review before execution)"),
      reasoningEffort: Schema.union(['off', 'low', 'medium', 'high', 'max']).description('Reasoning effort'),
    }),
    features: Schema.object({
      allowChat: Schema.boolean().description('Answer without @-mention'),
      quiet: Schema.boolean().description('Suppress intermediate messages'),
      replyFooter: Schema.boolean().description('Append reply footer'),
      injectSender: Schema.boolean().description('Prepend sender identity'),
      showContextIndicator: Schema.boolean().description('Append [ctx: ~N%]'),
      subtaskQuiet: Schema.boolean().description('Suppress settlement cards for unattended native subtasks (wake-only delivery)'),
      subtaskLivePanel: Schema.boolean().description('Live per-child panel card while a settled parent turn has unreported native subtasks; default true'),
      subtaskLivePanelIntervalMs: Schema.natural().description('Panel refresh interval in ms (default 15000; 0 disables the panel)'),
      subtaskLivePanelStallMs: Schema.natural().description('Silence window in ms before a panel row flags a child as stalled (default 120000)'),
    }),
    groupName: Schema.object({
      enabled: Schema.boolean().description('LLM group naming (#49); default true'),
      provider: Schema.string().description('Named provider route for naming queries (default: active)'),
      timeoutSec: Schema.natural().description('Naming LLM timeout in seconds (default 30)'),
      prompt: Schema.string().description('Naming prompt override'),
      setAvatar: Schema.boolean().description('Set a Lucide group icon avatar (#52); default true'),
    }).description('LLM group naming and icon avatars (#49/#52)'),
    planRender: Schema.object({
      enabled: Schema.boolean().description('Async-render plan/reply to HTML (#47/#48); default off'),
      provider: Schema.string().description('Named provider route for render sessions (default: active)'),
      effort: Schema.string().description('Render-session thinking effort alias: low/medium/high/max/off (default low)'),
      renderPngScript: Schema.string().description('HTML→PNG renderer script, absolute path; empty = send the .html file'),
      timeoutSec: Schema.natural().description('Render fork timeout in seconds (default 600, pre-render cap 360)'),
    }).description('Plan/reply HTML rendering (Go [projects.plan_render], #47/#48)'),
    planDir: Schema.string().description('Directory presented plans are persisted to as .md; empty string disables (default ~/.claude/plans)'),

    predictNext: Schema.object({
      enabled: Schema.boolean().description('Predict the next user message after each turn (#33); default false'),
      provider: Schema.string().description('Named provider route for the prediction fork'),
      timeoutSec: Schema.natural().description('Prediction timeout in seconds (default 120)'),
      prompt: Schema.string().description('Prediction prompt override'),
      mode: Schema.string().description('resume (fork the live transcript) or lightweight (default)'),
    }).description('Next-message prediction (#33, Go [projects.predict_next])'),
    turnSummary: Schema.object({
      enabled: Schema.boolean().description('One-line turn summary on the insight card; default false'),
      provider: Schema.string().description('Named provider route for the summary fork'),
      timeoutSec: Schema.natural().description('Summary timeout in seconds (default 30)'),
      prompt: Schema.string().description('Summary prompt override'),
    }).description('Turn summary (Go [projects.turn_summary])'),
    autoCompress: Schema.object({
      enabled: Schema.boolean().description('Compress the context when the token estimate crosses the cap; default false'),
      maxTokens: Schema.natural().description('Token estimate threshold that arms compression'),
      minGapMins: Schema.natural().description('Minimum minutes between compressions (default 30)'),
    }).description('Automatic context compression (Go [projects.auto_compress])'),
    providerShortcuts: Schema.dict(Schema.string()).description('Quick provider commands: /strong → provider name (Go provider_shortcuts)'),
    resetOnIdleMins: Schema.natural().description('Rotate the chat to a fresh session after N idle minutes; 0 disables'),
    sessionCleanupDays: Schema.natural().description('Prune sessions idle beyond N days (cron new-per-run records accumulate otherwise); 0 keeps everything'),
    agentCloseSec: Schema.natural().description('Bounded seconds to wait for an agent session to close during cleanup and stall retry (default 130)'),
    unsolicited: Schema.object({
      idleSec: Schema.natural().description('Quiet seconds before the unsolicited reader disarms (default 60; 0 = never)'),
      toolInFlightSec: Schema.natural().description('Quiet seconds a background turn\'s in-flight tool keeps the reader alive (default 1800)'),
      backgroundGraceSec: Schema.natural().description('Seconds pending background tasks keep the reader alive (default 1800)'),
      spilloverSec: Schema.natural().description('Seconds after a foreground completion where duplicate frames relay as plain text (default 30; 0 = disabled)'),
    }).description('Unsolicited-reader budgets for engine-woken turns (Go unsolicited_* config)'),
    chatroom: Schema.any().description('Residue guard: chatroom config moved to the chatroom plugin (@deepseek-ai/dsh-feishu-bridge-chatroom); setting it fails at startup'),
    monitor: Schema.object({
      enabled: Schema.boolean().description('Monitor-group mode master switch (#53)'),
      chats: Schema.string().description('Comma-separated monitored chat IDs, or * for all groups'),
      contextWindow: Schema.natural().description('Recent messages fed to LLM triage as context; 0 = single-message'),
      spawnNotice: Schema.boolean().description('Heads-up card when a subgroup is spawned; default true'),
      maxConcurrent: Schema.natural().description('Cap on active subgroups per monitored chat; default 5'),
      triageProvider: Schema.string().description('Named provider route for the LLM triage fork (default: active)'),
      triagePrompt: Schema.string().description('Triage prompt override (default: built-in mode default)'),
      dirs: Schema.array(Schema.object({
        path: Schema.string().required().description('Directory path the LLM routes to'),
        description: Schema.string().description('One-line description the LLM matches against'),
      })).description('Directory menu the LLM picks from (Go [[projects.monitor.dirs]])'),
      rules: Schema.array(Schema.object({
        pattern: Schema.string().required().description('Regex matched against the message text'),
        dir: Schema.string().required().description('Directory the matching message spawns into'),
        task: Schema.string().description('First-instruction template; {{message}} = the message text'),
        noReport: Schema.boolean().description('Fire-and-forget: the child never reports back (no_report)'),
      })).description('Deterministic fast-path rules (Go [[projects.monitor.rules]])'),
      learnEnabled: Schema.boolean().description('/learn teaching mechanism; default true'),
      learnMaxExamples: Schema.natural().description('Cap on learned examples in the triage prompt; default 20'),
      reactEmoji: Schema.string().description('Emoji reacted on acted-on messages; none disables; default Get'),
      pollIntervalSec: Schema.natural().description('Poll chats for event-less messages in seconds; default 30; 0 = off'),
      fallbackUser: Schema.string().description('open_id owning subgroups spawned for sender-less webhook cards'),
      mode: Schema.string().description('monitor (alert triage, default) or dispatch (hub dispatcher)'),
      coalesceEnabled: Schema.boolean().description('Route same-dir alerts into the existing active subgroup; default true'),
      coalesceWindowSec: Schema.natural().description('Coalescing window in seconds; default 300; 0 = no age limit'),
    }).description('Monitor-group mode (#53)'),
    contextWindow: Schema.natural().description('Model context window in tokens; 0 = 200k default (Go context_window)'),
    adminFrom: Schema.string().description('Comma-separated admin user IDs; * = all'),
    dirScanPaths: Schema.array(Schema.string()).description('Parent dirs whose subdirs are auto-listed in /dir (Go dir_scan_paths, #3)'),
    mcpServers: Schema.array(Schema.string()).description('MCP server-name allowlist: present = this project\'s sessions only see these servers\' mcp__ tools; absent = unrestricted'),
    feishuWorkspace: Schema.object({
      wikiSpaceId: Schema.string().description('Default wiki space id (CC_FEISHU_WIKI_SPACE_ID)'),
      folderToken: Schema.string().description('Default Drive folder token (CC_FEISHU_FOLDER_TOKEN)'),
      wikiNodeToken: Schema.string().description('Default wiki parent node token (CC_FEISHU_WIKI_NODE_TOKEN)'),
      description: Schema.string().description('Natural-language description of this workspace'),
    }).description("The bot's default Feishu Wiki/Drive location (#18)"),
    interactiveIdleTimeoutMins: Schema.natural().default(120).description('Idle reaper threshold in minutes; default 120; 0 disables'),
  })).default([]).description('Projects bound to Feishu apps'),
  providers: Schema.dict(Schema.object({
    route: Schema.string().required().description('LLM service route name from the profile'),
    model: Schema.string().description('Model override'),
    contextWindow: Schema.natural().description('Context window in tokens for this route; 0 = project context_window / 200k default (#12)'),
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
    absoluteTurnTimeoutSecs: Schema.natural().description('Per-turn wall-clock cap seconds; unset = 2× idle, 0 disables'),
    editorUrl: Schema.string().description('Editor base URL linked from status footers (Go editor_url)'),
  }).description('Display defaults'),
  dataDir: Schema.string().description('Root directory for per-project session stores'),
  language: Schema.string().description('Reply language (zh/zh-TW/ja/es/en; else auto-detect)'),
  idleTimeoutMins: Schema.number().description('Max minutes between agent events; 0 disables'),
  attachmentSend: Schema.boolean().description('Allow side-channel image/file delivery'),
  queue: Schema.object({
    maxDepth: Schema.natural().description('Max queued messages per session'),
  }).description('Inbound queue cap'),
  rateLimit: Schema.object({
    maxMessages: Schema.natural().description('Messages allowed per window (default 20; 0 disables)'),
    windowSecs: Schema.natural().description('Sliding window seconds (default 60)'),
  }).description('Per-session inbound rate limit'),
  subtask: Schema.object({
    maxDepth: Schema.natural().description('Max recursive delegation depth'),
    gatherTimeoutSec: Schema.natural().description('Gather barrier fallback timeout in seconds'),
  }).description('Subtask delegation caps'),
  spawn: Schema.object({
    worktree: Schema.union(['auto', 'on', 'off']).description('Default worktree isolation'),
    integrateBranch: Schema.string().description("Override containment target for /done merged auto-removal (e.g. 'dev'); unset uses each worktree's creation-time base branch"),
    memoryWarnPct: Schema.natural().description('RAM% warning threshold; 0 disables'),
    memoryBlockPct: Schema.natural().description('RAM% block threshold; 0 disables'),
  }).description('/spawn //fork isolation defaults'),
  cron: Schema.object({
    silent: Schema.boolean().description('Suppress cron start notifications by default (Go cron.silent)'),
    sessionMode: Schema.string().description('Default session mode: reuse (default) or new_per_run (Go cron.session_mode)'),
  }).description('Cron job defaults (Go [cron])'),
  relay: Schema.object({
    timeoutSecs: Schema.natural().description('Max seconds to wait for a relay response; 0 disables (default 120)'),
  }).description('Bot-to-bot relay (Go [relay])'),
  chatroom: Schema.any().description('Residue guard: chatroom config moved to the chatroom plugin (@deepseek-ai/dsh-feishu-bridge-chatroom); setting it fails at startup'),
  streamPreview: Schema.object({
    enabled: Schema.boolean().description('Enable streaming preview'),
    intervalMs: Schema.natural().description('Minimum ms between updates'),
    minDeltaChars: Schema.natural().description('Minimum new chars before an update'),
    maxChars: Schema.natural().description('Max preview length'),
    disabledPlatforms: Schema.array(Schema.string()).description('Platforms without preview'),
  }).description('Streaming preview tuning'),
  usageProviders: Schema.array(Schema.object({
    type: Schema.string().required().description('Provider type: glm | minimax'),
    options: Schema.dict(Schema.any()).description('Provider options (api_key, region)'),
  })).description('Provider quota displays appended to the completion footer (Go usage_providers)'),
  hints: Schema.array(Schema.string()).description('Compact hint commands shown on status footers and /hint (Go hints)'),
  hints_with_param: Schema.array(Schema.string()).description('Hints that append their input field value (Go hints_with_param)'),
  hints_common: Schema.array(Schema.string()).description('Always-visible hint commands (Go hints_common)'),
  mcpHealth: Schema.object({
    servers: Schema.array(Schema.object({
      serverName: Schema.string().required().description('mcp-client serverName to watch (its tools register as mcp__<serverName>__*)'),
      fixHint: Schema.string().description('Fix hint appended to this server\'s degradation line (e.g. the token-renewal command)'),
    })).default([]).description('Watched MCP servers; empty = no health context registered'),
    startupGraceSecs: Schema.natural().default(180).description('Grace seconds after plugin start before a missing server is reported (guards the connection race at boot)'),
  }).description('MCP degradation runtime context (opt-in): state missing servers into each prompt assembly'),
})

/**
 * Mount the package-bundled `skills/` directory as an isolated skill
 * provider, so deployments get the bridge skills without hand-wiring
 * `customSkillDirs` (an omission observed on the dev server). The isolated
 * provider sees only its explicit root — project `.dsh/skills` entries keep
 * their lower rank and still override bundled names.
 * @param ctx - Plugin context; the `skills` service is provided by the host
 *   composition (dsh-base), not mounted here.
 * @returns The mounted plugin fiber; disposing it unregisters the provider.
 */
export function mountBundledSkills(ctx: Context): Fiber {
  // Package-relative on purpose: both source runs (src/) and the bundled
  // lib/index.js sit one level below the package root, and per-deployment
  // profile paths cannot express this directory portably.
  const skillsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
  return ctx.plugin(SkillFileSystem, {
    providerName: 'feishu-bridge-skills',
    includeDefaultRoots: false,
    customSkillDirs: [skillsDir],
  })
}

/**
 * Start the bridge: the {@link FeishuBridgeService} (live projects, caller
 * routing, the `feishuBridge/*` dispatch face), then one Engine + one Feishu
 * WS platform per configured project
 * (MIGRATION.md §1), plus the process-wide feishu_bridge_subtask /
 * feishu_bridge_cron / feishu_bridge_relay tools routed by caller agent
 * (plan D4) and the shared cron scheduler + relay manager (Go main wiring:
 * one CronStore at `<dataDir>/crons/jobs.json`, one RelayManager at
 * `<dataDir>/relay_bindings.json`, every engine registered into both). An
 * empty projects list idles gracefully — the M0 smoke behavior.
 *
 * @param ctx - Plugin context (provides ctx.agents, ctx.tools, and event dispatch).
 * @param config - Validated plugin config.
 */
export async function apply(ctx: Context, config: FeishuBridgeConfig): Promise<void> {
  // launchd captures stdout/stderr without timing; every later log line
  // (ours and the vendored SDK's) carries a wall-clock prefix.
  installLogTimestamps()
  mountBundledSkills(ctx)
  // The service owns the live project registry and the feishuBridge/*
  // dispatch; mounting it before any engine is built lets engines dispatch
  // through it from their first decision point.
  await ctx.plugin(FeishuBridgeService)
  const service = ctx.get('feishuBridge')
  if (service === undefined) {
    throw new Error('feishu-bridge: the feishuBridge service failed to mount')
  }
  // The chatroom config moved to its own plugin (feishu-bridge-chatroom);
  // a leftover section here means the deployment's cordis.patch.yml was not
  // migrated — fail loud instead of silently dropping the tuning (the schema
  // keeps the key only because schemastery strips unknown keys).
  if (config.chatroom !== undefined) {
    throw new Error('feishu-bridge: chatroom config moved to the chatroom plugin — move the [chatroom] section to the feishu-bridge-chatroom plugin config (packages/acp/feishu-bridge-chatroom)')
  }
  for (const project of config.projects) {
    if (project.chatroom !== undefined) {
      throw new Error(`feishu-bridge: project '${project.name}' still carries a chatroom section — move it to the feishu-bridge-chatroom plugin config (packages/acp/feishu-bridge-chatroom)`)
    }
  }
  // Duplicate names would silently share state/sessions files under
  // join(dataRoot, name) and cross-wire lark-cli credentials (the router
  // picks the first name match) — fail loud at load.
  const seen = new Set<string>()
  for (const project of config.projects) {
    if (seen.has(project.name)) {
      throw new Error(`feishu-bridge: duplicate project name '${project.name}' — project names must be unique (they key the per-project data dir and lark-cli credential routing)`)
    }
    seen.add(project.name)
  }
  const dataRoot = config.dataDir ?? join(homedir(), '.dsh', 'feishu-bridge')
  // One dir history for every project (Go main shares NewDirHistory(cfg.DataDir)
  // across engines so /dir MRU entries land in a single store file).
  const dirHistory = new DirHistory(dataRoot)
  // One hint click-count store for every project (Go main shares
  // NewHintUsage(cfg.DataDir) across engines so buttons reorder globally).
  const hintUsage = new HintUsage(dataRoot)
  // Process-wide cron + relay (Go main: cfg.Cron → scheduler defaults,
  // cfg.Relay → timeout; engines register into both).
  const cronScheduler = new CronScheduler(new CronStore(dataRoot))
  const relayManager = new RelayManager(dataRoot)
  const shared: SharedProcessServices = { cronScheduler, relayManager }
  if (config.cron?.silent === true) cronScheduler.setDefaultSilent(true)
  if (config.cron?.sessionMode !== undefined && config.cron.sessionMode !== '') {
    cronScheduler.setDefaultSessionMode(config.cron.sessionMode)
  }
  if (config.relay?.timeoutSecs !== undefined) {
    relayManager.setTimeoutMs(config.relay.timeoutSecs > 0 ? config.relay.timeoutSecs * 1000 : 0)
  }
  // Opt-in MCP degradation context: every configured server still missing
  // from the tool registry after the startup grace surfaces as a
  // runtime-context line in each prompt assembly (core/mcp-health.ts).
  // Schemastery materializes an empty mcpHealth default, so the servers list
  // is the on/off switch.
  if (config.mcpHealth !== undefined && config.mcpHealth.servers.length > 0) {
    registerMcpHealthContext(ctx, config.mcpHealth)
  }
  // Engine starts are collected and awaited together after the loop, so the
  // /reload completion notice runs exactly once per daemon start, after
  // every platform is live (reload-commands.ts).
  const starts: Array<Promise<void>> = []
  // The singleton userQuestions service takes one provider per application:
  // every adapter shares this routing so the second+ project's first session
  // does not collide (questions dispatch to the adapter owning the session).
  const questionRouting: QuestionRouting = { adapters: [], registered: false }
  for (const project of config.projects) {
    const { engine, adapter } = buildProjectAssembly(
      ctx, config, project, dataRoot, dirHistory, shared, hintUsage, questionRouting, service,
    )
    service.registerProject({ engine, adapter })
    // Service-denied tool masks (a sibling plugin disabled on this project,
    // e.g. chatroom's enabled: false) apply through the adapter's
    // create-time restrict; the closure reads the live registry so a
    // registration after assembly — the chatroom sweep runs once the bridge
    // reports readiness — still masks every later session.
    adapter.setDeniedTools(() => service.deniedToolsOf(engine))
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

    starts.push(engine.start().catch((error: unknown) => {
      ctx.logger.error(`feishu-bridge: project ${project.name} failed to start: ${String(error)}`)
    }))
    // Return the promise so Cordis unloading awaits the stop notices and
    // terminal-card PATCHes; a `void` disposer let profile-boot exit first
    // and froze running cards on the 2026-08-23 fb-envfix restart.
    ctx.effect(() => {
      return () => engine.stop()
    })
  }

  // Every live project is registered: sibling plugins awaiting readiness
  // (the chatroom package) can now sweep the full project list.
  service.markReady()

  // The daemon is up: settle a /reload that restarted this process (each
  // start already carries its own catch, so this always runs).
  void Promise.all(starts).then(() => { void completePendingReload(service.projects.map(({ engine }) => engine)) })

  // Start the cron scheduler after every engine registered (Go main).
  cronScheduler.start()
  ctx.effect(() => {
    return () => { cronScheduler.stop() }
  })

  // Plan D4: one process-wide tool family per domain, each routed by its
  // CALLER agent back to the engine + engine session that agent belongs to
  // — the Go CLI's CC_PROJECT/CC_SESSION_KEY env contract, without env.
  const route = (caller: unknown): SubtaskRoute | undefined => service.route(caller)
  // Native continuable children (de-baggage B4) own no engine session: their
  // tool calls route to the engine that spawned them, keyed by the native
  // child id. Only the subtask family consumes this — a native child calling
  // cron/relay/chatroom/send has no engine chat to act on.
  const nativeRoute = (caller: unknown): SubtaskRoute | undefined => service.nativeRoute(caller)
  registerSubtaskTool(ctx, route, nativeRoute)
  registerCronTool(ctx, route)
  registerRelayTool(ctx, route)
  registerSendTool(ctx, route)
  registerNativeSettlementListener(ctx, service.projects)
  // The lark passthrough routes to the caller's project BOT credentials
  // (plan D4): bot mode mints a TAT in-process, --as user prepends the
  // project's --profile (Go `cc-connect lark` wrapper semantics).
  const larkRoute = (caller: unknown): LarkRoute | undefined => {
    const target = route(caller)
    if (target === undefined) return undefined
    const project = config.projects.find(p => p.name === target.engine.name)
    if (project === undefined) return undefined
    return { ...target, creds: { appId: project.feishu.appId, appSecret: project.feishu.appSecret } }
  }
  registerLarkTool(ctx, larkRoute, undefined, dataRoot)
}

/**
 * Wire the native settlement fallback (de-baggage B4): each continuable
 * epoch that ends without an explicit report delivers its final assistant
 * output and terminal outcome through the owning engine — Go
 * maybeAutoReportSubtask's native counterpart. The paired `subagent/start`
 * listener re-arms every owned child before its epoch runs: a follow-up may
 * arrive through channels the engine cannot observe (the runtime's own
 * send_message tool), and without the re-arm that epoch's answer would be
 * dropped by the settlement listener's reported guard. `live` is captured by
 * reference so entries added after registration (none today; apply() builds
 * all projects first) still route.
 *
 * @param ctx - Plugin context carrying the event bus.
 * @param live - Live project entries whose engines may own native children.
 * @returns The event disposer.
 */
export function registerNativeSettlementListener(ctx: Context, live: ReadonlyArray<{ engine: Engine }>): () => void {
  const disposers = [
    ctx.on('subagent/start', (info: SubagentRunInfo) => {
      for (const { engine } of live) {
        if (engine.ownsNativeChild(info.id)) {
          engine.rearmNativeChild(info.id)
          return
        }
      }
    }),
    ctx.on('subagent/end', (info: SubagentRunEndInfo) => {
      const output = (info.lastAssistantMessage ?? [])
        .map(block => block.type === 'text' ? block.text : '')
        .join('')
      for (const { engine } of live) {
        if (engine.ownsNativeChild(info.id)) {
          // The terminal outcome rides along so the settlement composes
          // failure semantics instead of reporting failed work as a result.
          engine.settleNativeChild(info.id, output, info.stopReason, info.diagnostic ?? '')
          return
        }
      }
    }),
  ]
  return () => { for (const dispose of disposers) dispose() }
}

/**
 * Create the configured usage providers, skipping entries whose factory
 * rejects (Go main.go buildUsageProviders warns and continues).
 * @param entries - The usage_providers config rows.
 * @returns The live providers for one engine's completion footer.
 */
function buildUsageProviders(entries: UsageProviderConfig[]): UsageProvider[] {
  const providers: UsageProvider[] = []
  for (const entry of entries) {
    try {
      providers.push(createUsageProvider(entry.type, entry.options ?? {}))
    } catch (error) {
      console.warn(`usage provider init failed (type=${entry.type}): ${String(error)}`)
    }
  }
  return providers
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
 * @param shared - Process-wide cron scheduler and relay manager the engine registers into.
 * @param sharedHintUsage - Hint click counts shared across projects (Go shares one store).
 * @param sharedQuestionRouting - userQuestions routing shared across projects (one provider per application).
 * @param bridge - The feishuBridge dispatch face the engine and adapter dispatch through (undefined = bare, listener-less).
 * @returns The engine and the adapter owning its agents.
 */
export function buildProjectAssembly(
  ctx: Context,
  config: FeishuBridgeConfig,
  project: ProjectConfig,
  dataRoot: string,
  sharedDirHistory?: DirHistory,
  shared?: SharedProcessServices,
  sharedHintUsage?: HintUsage,
  sharedQuestionRouting?: QuestionRouting,
  bridge?: BridgeDispatch,
): { engine: Engine; adapter: DshAgentAdapter; platform: FeishuPlatform } {
  const routeNames = Object.keys(config.providers)
  const projectDataDir = join(dataRoot, project.name)
  // The engine/platform stores assume the data dirs exist (Go main created
  // cfg.DataDir upfront); without this the spawned-chat registry save ENOENTs.
  mkdirSync(join(projectDataDir, 'sessions'), { recursive: true })
  // Shared tag-id cache directory for every project's bot (Go's single
  // sessions dir): the sibling-cache lookup resolves a tenant tag id created
  // by another bot when this bot's own create hits 402-without-id.
  const sharedTagCacheDir = join(dataRoot, 'sessions')
  mkdirSync(sharedTagCacheDir, { recursive: true })
  const projectState = new ProjectStateStore(join(projectDataDir, 'state.json'))
  // A runtime /provider switch persists into the project state; it wins over
  // the config default on restart (Go writes config.toml, this runtime is
  // read-only — the same override pattern the monitor chats use). A name the
  // operator has since deleted from config.providers would resolve to no
  // route at all (silently empty agent options) — warn and fall back to the
  // config default; the runtime setProviders switch self-heals the same way.
  const configDefaultProvider = project.agent?.provider || routeNames[0] || ''
  const persistedProvider = projectState.activeProvider()
  let activeProvider = configDefaultProvider
  if (persistedProvider !== '') {
    if (routeNames.includes(persistedProvider)) activeProvider = persistedProvider
    else console.warn(`feishu-bridge: project '${project.name}' persisted provider '${persistedProvider}' is no longer in config.providers; falling back to '${configDefaultProvider}'`)
  }
  const routes: AdapterProviderRoute[] = routeNames.flatMap((routeName) => {
    const route = config.providers[routeName]
    if (route === undefined) return []
    return [{
      name: routeName,
      provider: route.route,
      model: route.model ?? '',
      ...(route.contextWindow !== undefined ? { contextWindow: route.contextWindow } : {}),
      // The project-level effort rides every route: a runtime /provider
      // switch only repoints cfg.activeProvider, so baking it on the
      // construction-time active route alone lost the effort label (and the
      // explicit agent-creation effort) after a switch.
      ...(project.agent?.reasoningEffort !== undefined
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
    ...(project.agentCloseSec !== undefined ? { closeTimeoutMs: project.agentCloseSec * 1000 } : {}),
    ...(project.mcpServers !== undefined && project.mcpServers.length > 0 ? { mcpServers: project.mcpServers } : {}),
    ...(sharedQuestionRouting !== undefined ? { questionRouting: sharedQuestionRouting } : {}),
  })

  const platform = new FeishuPlatform({
    appID: project.feishu.appId,
    appSecret: project.feishu.appSecret,
    ...(project.feishu.tag !== undefined ? { tag: project.feishu.tag } : {}),
    groupReplyAll: project.features?.allowChat === true,
    projectName: project.name,
    workDir: project.workdir,
    tagCacheDir: sharedTagCacheDir,
    ...(config.display?.progressSpinner !== undefined ? { progressSpinner: config.display.progressSpinner } : {}),
    ...(config.display?.patchRateIntervalMs !== undefined && config.display.patchRateIntervalMs > 0
      ? { patchRateIntervalMs: config.display.patchRateIntervalMs }
      : {}),
    ...(project.feishu.notifyOnComplete !== undefined ? { notifyOnComplete: project.feishu.notifyOnComplete } : {}),
    ...(project.feishu.allowFrom !== undefined ? { allowFrom: project.feishu.allowFrom } : {}),
    ...(project.feishu.groupOnly !== undefined ? { groupOnly: project.feishu.groupOnly } : {}),
    ...(project.feishu.shareSessionInChannel !== undefined ? { shareSessionInChannel: project.feishu.shareSessionInChannel } : {}),
    ...(project.feishu.threadIsolation !== undefined ? { threadIsolation: project.feishu.threadIsolation } : {}),
    ...(project.feishu.replyToTrigger === false ? { noReplyToTrigger: true } : {}),
    ...(project.feishu.respondToAtEveryoneAndHere !== undefined
      ? { respondToAtEveryoneAndHere: project.feishu.respondToAtEveryoneAndHere }
      : {}),
    ...(project.feishu.enableFeishuCard !== undefined ? { useInteractiveCard: project.feishu.enableFeishuCard } : {}),
    ...(project.feishu.progressStyle !== undefined ? { progressStyle: project.feishu.progressStyle } : {}),
    ...(project.feishu.activeTagName !== undefined ? { activeTagOverride: project.feishu.activeTagName } : {}),
    ...(project.feishu.reactionEmoji !== undefined ? { reactionEmoji: project.feishu.reactionEmoji } : {}),
    ...(project.feishu.doneEmoji !== undefined ? { doneEmoji: project.feishu.doneEmoji } : {}),
    ...(project.feishu.cancelEmoji !== undefined ? { cancelEmoji: project.feishu.cancelEmoji } : {}),
    ...(project.feishu.topNoticeFirstMessage !== undefined ? { topNoticeFirstMessage: project.feishu.topNoticeFirstMessage } : {}),
    ...(project.feishu.pinUserMessages !== undefined ? { pinUserMessages: project.feishu.pinUserMessages } : {}),
    dataDir: projectDataDir,
  })

  const engine = new Engine(project.name, adapter, [platform], join(projectDataDir, 'sessions.json'), languageOf(config.language), bridge)

  // B2: native approval asks and userQuestions asks delegate card rendering
  // and decision waiting to the engine's askUser.
  adapter.setAskDelegate(engine)
  // The session-start policy waterfalls dispatch through the same face.
  if (bridge !== undefined) adapter.setBridgeEvents(bridge)


  // #18: the bot's default Feishu workspace → the typed start options,
  // surfaced to the agent through the adapter's setup hook.
  if (project.feishuWorkspace !== undefined) {
    engine.setFeishuWorkspace({
      wikiSpaceId: project.feishuWorkspace.wikiSpaceId ?? '',
      folderToken: project.feishuWorkspace.folderToken ?? '',
      wikiNodeToken: project.feishuWorkspace.wikiNodeToken ?? '',
      description: project.feishuWorkspace.description ?? '',
    })
  }
  engine.setProjectStateStore(projectState)
  const effectiveWorkDir = applyProjectStateOverride(adapter, project.workdir, projectState)
  engine.setBaseWorkDir(effectiveWorkDir)
  const dirHistory = sharedDirHistory ?? new DirHistory(dataRoot)
  engine.setDirHistory(dirHistory)
  // Global hint groups + the shared click-count store (Go wire.go SetHints*,
  // main.go SetHintUsage).
  engine.setHints(config.hints ?? [])
  engine.setHintsWithParam(config.hints_with_param ?? [])
  engine.setHintsCommon(config.hints_common ?? [])
  if (sharedHintUsage !== undefined) engine.setHintUsage(sharedHintUsage)
  // Live-scan roots for /dir's bare-name resolution and suggestion list
  // (Go main: dir_scan_paths with ~ expanded, #3).
  if (project.dirScanPaths !== undefined && project.dirScanPaths.length > 0) {
    dirHistory.setScanPaths(project.name, project.dirScanPaths.map(p => expandHome(p)))
  }
  // Seed the MRU with the startup dir (Go main ensures the initial workdir
  // is in history so /dir <n> can return to it).
  if (effectiveWorkDir !== '' && !dirHistory.contains(project.name, effectiveWorkDir)) {
    dirHistory.add(project.name, effectiveWorkDir)
  }
  // Registrations are effects: every command family unregisters with the
  // fiber (HMR/plugin reload), not only with process exit.
  ctx.effect(() => registerSessionCommands(engine))
  // M8 前: /shell + "!" prefix shortcut (Go cmdShell).
  ctx.effect(() => registerShellCommands(engine))
  // M8 前: /reload — detached-spawn reload.sh (TS 原生，无 Go 对应)。
  ctx.effect(() => registerReloadCommands(engine))
  // M8 前: /tag /untag /undone /notify /board (Go spawn family) + /help /ps.
  ctx.effect(() => registerSpawnFamilyCommands(engine))
  ctx.effect(() => registerMiscCommands(engine))
  // TS 原生: /skills + /mcp — 运行时 skill 目录与 MCP 工具注册表查询（无 Go 对应）。
  {
    const skills = ctx.get('skills')
    ctx.effect(() => registerSkillsMcpCommands(engine, {
      listSkills: skills === undefined ? undefined : cwd => skills.list({ cwd }),
      toolNames: () => ctx.tools.schemas().map(schema => schema.name),
      healthServers: config.mcpHealth?.servers,
      allowlist: project.mcpServers,
    }))
  }
  // TS 原生: /context — 会话投影的上下文洞察卡（构成/趋势/事件 + 刷新按钮；无 Go 对应）。
  ctx.effect(() => registerContextCommands(engine))
  // M7-c: /provider family + shortcuts, /btw + insight forks, /compress.
  ctx.effect(() => registerProviderCommands(engine))
  ctx.effect(() => registerPredictCommands(engine))
  ctx.effect(() => registerSessionMiscCommands(engine))
  engine.setProviderSaveFunc((name) => {
    projectState.setActiveProvider(name)
    projectState.save()
  })
  if (project.providerShortcuts !== undefined) {
    engine.setProviderShortcuts(project.providerShortcuts)
  }
  wireGroupName(engine, project)
  if (project.agent?.mode !== undefined && project.agent.mode !== '') {
    adapter.setDefaultMode(project.agent.mode)
  }
  wirePlanRender(ctx, engine, adapter, project)
  if (project.planDir !== undefined) {
    engine.setPlanDir(expandHome(project.planDir))
  }

  wirePredictNext(engine, project, config.providers)
  wireTurnSummary(engine, project)
  wireSessionMisc(engine, project)
  // M6b: monitor domain (#53) — config block → engine MonitorCore + the
  // /monitor command family + runtime persistence via the project state.
  wireMonitor(ctx, engine, project, projectDataDir, projectState)

  // M6: process-wide cron + relay services (Go main registers every engine
  // into the shared CronScheduler / RelayManager and attaches both).
  if (shared?.cronScheduler !== undefined) {
    shared.cronScheduler.registerEngine(project.name, engine)
    engine.setCronScheduler(shared.cronScheduler)
    ctx.effect(() => registerCronCommands(engine))
  }
  if (shared?.relayManager !== undefined) {
    shared.relayManager.registerEngine(project.name, engine)
    engine.setRelayManager(shared.relayManager)
    ctx.effect(() => registerRelayCommands(engine))
  }

  // Stall detection (Go [display] stall_*): wired first, then
  // idle_timeout_mins below overrides it, matching wire.go's order.
  if (config.display?.stallTimeoutSecs !== undefined) {
    engine.setEventIdleTimeout(config.display.stallTimeoutSecs * 1000)
  }
  if (config.display?.stallMaxRetries !== undefined) {
    engine.setStallMaxRetries(config.display.stallMaxRetries)
  }
  if (config.display?.absoluteTurnTimeoutSecs !== undefined) {
    engine.setAbsoluteTurnTimeoutSecs(config.display.absoluteTurnTimeoutSecs)
  }
  if (config.idleTimeoutMins !== undefined) {
    engine.setEventIdleTimeout(config.idleTimeoutMins > 0 ? config.idleTimeoutMins * 60_000 : 0)
  }
  if (config.queue?.maxDepth !== undefined && config.queue.maxDepth > 0) {
    engine.setMaxQueuedMessages(config.queue.maxDepth)
  }
  // Go wire.go always arms the limiter with 20/60 defaults unless max_messages=0.
  {
    const maxMessages = config.rateLimit?.maxMessages ?? 20
    const windowSecs = config.rateLimit?.windowSecs ?? 60
    engine.setRateLimitCfg(maxMessages, windowSecs * 1000)
  }
  if (config.subtask?.maxDepth !== undefined && config.subtask.maxDepth > 0) {
    engine.setSubtaskMaxDepth(config.subtask.maxDepth)
  }
  if (config.subtask?.gatherTimeoutSec !== undefined && config.subtask.gatherTimeoutSec > 0) {
    engine.setSubtaskGatherTimeout(config.subtask.gatherTimeoutSec * 1000)
  }
  if (config.spawn?.worktree !== undefined) {
    engine.setSpawnWorktreeMode(config.spawn.worktree)
  }
  if (config.spawn?.integrateBranch !== undefined) {
    engine.setSpawnIntegrateBranch(config.spawn.integrateBranch)
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

  if (config.display?.editorUrl !== undefined) {
    engine.setDisplayConfig({ editorUrl: config.display.editorUrl })
  }

  // M7 usage domain (Go wire.go): ctx indicator + context window + provider
  // quota displays + the Codex-style reply footer.
  if (project.features?.showContextIndicator !== undefined) {
    engine.setShowContextIndicator(project.features.showContextIndicator)
  }
  if (project.contextWindow !== undefined) {
    engine.setContextWindow(project.contextWindow)
  }
  engine.applyActiveProviderContextWindow()
  if (project.features?.replyFooter !== undefined) {
    engine.setReplyFooterEnabled(project.features.replyFooter)
  }
  if (project.features?.subtaskQuiet === true) {
    engine.setSubtaskQuiet(true)
  }
  engine.setSubtaskPanelConfig({
    enabled: project.features?.subtaskLivePanel !== false,
    intervalMs: project.features?.subtaskLivePanelIntervalMs ?? 15_000,
    ...(project.features?.subtaskLivePanelStallMs !== undefined
      ? { stallMs: project.features.subtaskLivePanelStallMs }
      : {}),
  })
  engine.setUsageProviders(buildUsageProviders(config.usageProviders ?? []))
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

/**
 * Wire the plan/reply HTML render domain (Go wire.go plan_render block,
 * #47/#48): engine switches + provider/timeout/PNG-script overrides, and the
 * effort alias onto the adapter (Go SetRenderEffort — the channel that makes
 * the effort config reach the render session's reasoning level). The
 * render-session prompts inline the feishu-bridge-render skill body resolved
 * from the dsh skill registry — resolved lazily at fork time so provider
 * registration order across plugins cannot race the lookup; an unresolvable
 * skill makes the fork throw with registration guidance (fails loud, the
 * markdown card remains the fallback delivery).
 */
function wirePlanRender(ctx: Context, engine: Engine, adapter: DshAgentAdapter, project: ProjectConfig): void {
  const r = project.planRender
  if (r?.enabled !== true) {
    engine.setPlanRenderConfig({ enabled: false })
    return
  }
  engine.setPlanRenderConfig({
    enabled: true,
    ...(r.provider !== undefined && r.provider !== '' ? { provider: r.provider } : {}),
    ...(r.timeoutSec !== undefined && r.timeoutSec > 0 ? { timeoutMs: r.timeoutSec * 1000 } : {}),
    ...(r.renderPngScript !== undefined && r.renderPngScript !== '' ? { pngScript: expandHome(r.renderPngScript) } : {}),
  })
  engine.setPlanRenderSkillSource(async () => {
    const skills: SkillRegistry | undefined = ctx.get('skills')
    return (await skills?.get(renderSkillName))?.content
  })
  if (r.effort !== undefined && r.effort !== '') adapter.setRenderEffort(r.effort)
}

/**
 * Configure predict-next (Go wirePredictNext): the model label resolves from
 * the provider route table; timeout defaults to 120s.
 */
function wirePredictNext(engine: Engine, project: ProjectConfig, providers: FeishuBridgeConfig['providers']): void {
  const p = project.predictNext
  if (p?.enabled !== true) {
    engine.setPredictNextConfig(false, '', '', 0, '', '')
    return
  }
  const timeoutSec = p.timeoutSec !== undefined && p.timeoutSec > 0 ? p.timeoutSec : 120
  const model = getProviderModel(
    Object.entries(providers).flatMap(([name, route]) =>
      route.model !== undefined ? [{ name, model: route.model }] : []),
    p.provider ?? '',
    '',
  )
  engine.setPredictNextConfig(true, p.provider ?? '', model, timeoutSec * 1000, p.prompt ?? '', p.mode ?? '')
}

/** Configure turn-summary (Go wireTurnSummary): timeout defaults to 30s. */
function wireTurnSummary(engine: Engine, project: ProjectConfig): void {
  const t = project.turnSummary
  if (t?.enabled !== true) {
    engine.setTurnSummaryConfig(false, '', 0, '')
    return
  }
  const timeoutSec = t.timeoutSec !== undefined && t.timeoutSec > 0 ? t.timeoutSec : 30
  engine.setTurnSummaryConfig(true, t.provider ?? '', timeoutSec * 1000, t.prompt ?? '')
}

/**
 * Configure the session misc domain (Go wire.go): reset_on_idle rotation,
 * auto_compress thresholds, and the unsolicited-reader budgets.
 */
function wireSessionMisc(engine: Engine, project: ProjectConfig): void {
  if (project.resetOnIdleMins !== undefined) {
    engine.setResetOnIdle(project.resetOnIdleMins * 60_000)
  }
  engine.sessions.setCleanupDays(project.sessionCleanupDays ?? 30)
  if (project.agentCloseSec !== undefined) {
    engine.setAgentCloseTimeout(project.agentCloseSec * 1000)
  }
  const a = project.autoCompress
  if (a?.enabled === true) {
    engine.setAutoCompressConfig(true, a.maxTokens ?? 0, (a.minGapMins ?? 0) * 60_000)
  }
  // Spillover grace defaults ON at the assembly layer like Go's wire.go (the
  // engine-level default is 0 so unit tests construct it disabled).
  const u = project.unsolicited
  engine.setUnsolicitedConfig({
    idleTimeoutMs: u?.idleSec !== undefined ? u.idleSec * 1000 : undefined,
    toolInFlightTimeoutMs: u?.toolInFlightSec !== undefined ? u.toolInFlightSec * 1000 : undefined,
    backgroundGraceMs: u?.backgroundGraceSec !== undefined ? u.backgroundGraceSec * 1000 : undefined,
    spilloverGraceMs: u?.spilloverSec !== undefined ? u.spilloverSec * 1000 : 30_000,
  })
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
 * Configure the monitor domain (#53, Go main.go wireMonitor): compile the
 * deterministic rules (an invalid pattern is skipped with a warning), apply
 * the Go defaults (spawn_notice 5/…), persist /monitor runtime edits through
 * the project state store (Go rewrote config.toml; the profile's cordis.yml
 * is read-only at runtime here, so state.json carries the override), and
 * register the /monitor command family.
 * @param ctx - Plugin context owning the registration's lifetime.
 * @param engine - The project's engine.
 * @param project - The project row carrying the optional monitor section.
 * @param projectDataDir - The project's data directory (examples store).
 * @param projectState - The persisted per-project state store.
 */
function wireMonitor(ctx: Context, engine: Engine, project: ProjectConfig, projectDataDir: string, projectState: ProjectStateStore): void {
  ctx.effect(() => registerMonitorCommands(engine))
  const m = project.monitor
  if (m === undefined || m.enabled !== true) {
    engine.monitor.setConfig({
      enabled: false, chats: '', contextWindow: 0, spawnNotice: false, maxConcurrent: 0,
      triageProvider: '', triagePrompt: '', dirs: [], rules: [], learnEnabled: false, learnMax: 0,
      reactEmoji: '', pollIntervalMs: 0, fallbackUser: '', examples: undefined, mode: '',
    })
    engine.monitor.setCoalesce(false, 0)
    return
  }

  const dirs: MonitorDirEntry[] = (m.dirs ?? []).map(d => ({ path: d.path, description: d.description ?? '' }))
  const rules: MonitorRuleEntry[] = []
  for (const r of m.rules ?? []) {
    try {
      rules.push({ pattern: new RegExp(r.pattern), dir: r.dir, task: r.task ?? '', noReport: r.noReport === true })
    } catch (error) {
      console.error(`monitor: invalid rule pattern, skipping (pattern=${r.pattern} dir=${r.dir}): ${String(error)}`)
    }
  }

  const pollIntervalSec = m.pollIntervalSec ?? 30
  // A persisted /monitor edit wins over the configured chats/mode so the
  // runtime toggle survives restarts (Go rewrote config.toml instead).
  const chats = projectState.monitorChats() !== '' ? projectState.monitorChats() : (m.chats ?? '')
  const mode = projectState.monitorMode() !== '' ? projectState.monitorMode() : (m.mode ?? '')

  engine.monitor.saveChats = (c: string) => {
    projectState.setMonitorChats(c)
    projectState.save()
  }
  engine.monitor.saveMode = (v: string) => {
    projectState.setMonitorMode(v)
    projectState.save()
  }
  engine.monitor.setConfig({
    enabled: true,
    chats,
    contextWindow: m.contextWindow ?? 0,
    spawnNotice: m.spawnNotice ?? true,
    maxConcurrent: m.maxConcurrent ?? 5,
    triageProvider: m.triageProvider ?? '',
    triagePrompt: m.triagePrompt ?? '',
    dirs,
    rules,
    learnEnabled: m.learnEnabled ?? true,
    learnMax: m.learnMaxExamples ?? 20,
    reactEmoji: m.reactEmoji === 'none' ? '' : (m.reactEmoji ?? 'Get'),
    pollIntervalMs: pollIntervalSec > 0 ? pollIntervalSec * 1000 : 0,
    fallbackUser: m.fallbackUser ?? '',
    examples: new MonitorExampleStore(join(projectDataDir, 'monitor_examples.json')),
    mode,
  })
  engine.monitor.setCoalesce(m.coalesceEnabled ?? true, (m.coalesceWindowSec ?? 300) * 1000)
}
