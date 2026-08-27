/**
 * Feishu-bridge chatroom plugin: the multi-role chatroom orchestration
 * (role groups, the moderator, the `/chatroom` command family, the
 * `feishu_bridge_chatroom` tool) extracted from the feishu-bridge engine
 * into its own package, mounted beside `@deepseek-ai/dsh-feishu-bridge`
 * through its service face. The engine seam halves ride the
 * `feishuBridge/*` events; the per-engine configuration and commands apply
 * in the startup sweep below.
 *
 * @module dsh-feishu-bridge-chatroom
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { registerFeatureStateCodec, registerMessages } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { chatroomFeatureStateCodec } from './chatroom-state.js'
import { applyChatroomEngineConfig, Config, type ChatroomProjectConfig } from './chatroom-config.js'
import { chatroomMessages } from './i18n.js'
import { registerChatroomPolicyListeners } from './engine/chatroom-policy.js'
import { recoverChatroomBarriers } from './engine/chatroom.js'
import { registerChatroomCommands } from './engine/chatroom-cmd.js'
import { registerChatroomTool } from './tools/chatroom.js'

/** Cordis plugin name for the chatroom row mounted by the bundle patch. */
export const name = 'feishu-bridge-chatroom'

/** The bridge service face (live projects, routing, dispatch) plus the tool registry. */
export const inject = ['feishuBridge', 'tools']

/** Deployment config for the chatroom plugin. */
export interface ChatroomConfig {
  /** Chatroom tuning applied to every project (Go [chatroom] defaults). */
  defaults?: ChatroomProjectConfig
  /** Per-project chatroom tuning, keyed by the bridge project name. */
  projects?: Record<string, ChatroomProjectConfig>
}

/**
 * Mount the package-bundled `skills/` directory as an isolated skill
 * provider, so deployments get the chatroom-moderator skill without
 * hand-wiring `customSkillDirs` (same shape as the bridge's own bundled
 * skills mount).
 * @param ctx - Plugin context; the `skills` service is provided by the host
 *   composition (dsh-base), not mounted here.
 * @returns The mounted plugin fiber; disposing it unregisters the provider.
 */
function mountBundledSkills(ctx: Context): Fiber {
  // Package-relative on purpose: both source runs (src/) and the bundled
  // lib/index.js sit one level below the package root.
  const skillsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
  return ctx.plugin(SkillFileSystem, {
    providerName: 'feishu-bridge-chatroom-skills',
    includeDefaultRoots: false,
    customSkillDirs: [skillsDir],
  })
}

/**
 * Start the chatroom: register the process-level halves (feature-state
 * codec, i18n subtable), the policy listeners and the tool, then — once the
 * bridge reports readiness — sweep its live projects applying each engine's
 * configuration and the `/chatroom` command family, and recover armed
 * barriers for engines whose platforms are already live (the rest recover
 * through the `feishuBridge/platforms-ready` event). Every contribution is
 * a reversible effect.
 *
 * @param ctx - Plugin context.
 * @param config - Validated plugin config.
 */
export async function apply(ctx: Context, config: ChatroomConfig): Promise<void> {
  // Process-level, engine-independent registrations first: the codec must
  // project the chatroom section before the first save, and the subtable
  // before any lookup.
  ctx.effect(() => registerFeatureStateCodec(chatroomFeatureStateCodec))
  ctx.effect(() => registerMessages(chatroomMessages))
  const service = ctx.get('feishuBridge')
  if (service === undefined) {
    throw new Error('feishu-bridge-chatroom: the feishuBridge service is unavailable')
  }
  // One process-wide policy/tool registration — the listeners are payload
  // functions, so per-project wiring would double-fire them.
  ctx.effect(() => registerChatroomPolicyListeners(ctx))
  ctx.effect(() => registerChatroomTool(ctx, caller => service.route(caller)))
  mountBundledSkills(ctx)
  // Deterministic project list: the bridge registers every project before
  // its apply resolves readiness.
  await service.whenReady()
  const liveNames = new Set(service.projects.map(({ engine }) => engine.name))
  for (const projectName of Object.keys(config.projects ?? {})) {
    if (!liveNames.has(projectName)) {
      throw new Error(
        `feishu-bridge-chatroom: config names project '${projectName}', but the feishu-bridge config has no project by that name — align the chatroom projects keys with the bridge projects`,
      )
    }
  }
  for (const { engine } of service.projects) {
    applyChatroomEngineConfig(engine, config.defaults ?? {}, config.projects?.[engine.name])
    ctx.effect(() => registerChatroomCommands(engine))
    // Engines whose platforms beat the plugin to readiness missed the
    // platforms-ready emit; recover their barriers here (idempotent: the
    // persisted snapshots are consumed on first recovery).
    if (engine.platformsStarted) recoverChatroomBarriers(engine)
  }
}

export { Config }
