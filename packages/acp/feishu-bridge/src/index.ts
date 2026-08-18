/**
 * Feishu bridge plugin: cc-connect's engine + Feishu platform orchestration
 * migrated into one long-lived dsh process (see ./docs/MIGRATION.md). M0
 * ships only the plugin skeleton and pure-logic foundations; the engine and
 * Feishu wiring land in M1+.
 *
 * @module dsh-feishu-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'feishu-bridge'

/** Feishu app credentials for one bot. Each app gets its own WS client (MIGRATION.md D5). */
export interface FeishuAppConfig {
  /** Feishu open-platform app id (`cli_...`). */
  appId: string
  /** Feishu open-platform app secret. */
  appSecret: string
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
}

export const Config: Schema<FeishuBridgeConfig> = Schema.object({
  projects: Schema.array(Schema.object({
    name: Schema.string().required().description('Unique project name'),
    workdir: Schema.string().required().description('Agent working directory'),
    feishu: Schema.object({
      appId: Schema.string().required().description('Feishu app id'),
      appSecret: Schema.string().required().role('secret').description('Feishu app secret'),
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
})

/**
 * Start the bridge: one Engine + one Feishu WS platform per configured
 * project. TODO(M1, docs/MIGRATION.md §4): read config, create agent
 * sessions via `ctx.agents`, open the Feishu long connections, and register
 * the `feishu_bridge_*` tools.
 *
 * @param ctx - Plugin context.
 * @param config - Validated plugin config.
 */
export function apply(_ctx: Context, _config: FeishuBridgeConfig): void {
  // TODO(M1, docs/MIGRATION.md §4): per-project Engine + Feishu platform startup.
}
