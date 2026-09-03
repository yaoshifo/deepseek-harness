/**
 * The chatroom plugin's own configuration: the `defaults` section and the
 * per-project `projects` map (keyed by bridge project name), plus the
 * per-engine resolution the migrated modules read through
 * {@link chatroomConfig}. Replaces the bridge's old ChatroomConfig schema,
 * engine setters, and wireChatroom — the fields, defaults, and clamps are
 * identical (Go [chatroom] wiring).
 *
 * @module dsh-feishu-bridge-chatroom/chatroom-config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import type { Engine } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { defaultChatroomRolesDir } from './engine/chatroom-roles.ts'
import {
  defaultChatroomGatherTimeout,
  defaultChatroomResearchTimeout,
  defaultMaxChatroomResearchRounds,
  defaultMaxChatroomRoles,
  maxChatroomResearchTimeout,
  maxChatroomResearchRounds,
  minChatroomResearchTimeout,
  minChatroomResearchRounds,
} from './engine/chatroom.ts'

/** One chatroom tuning section (Go [chatroom]; same shape the bridge carried). */
export interface ChatroomProjectConfig {
  /** Whether the chatroom mounts for this project; default true (per-project gating). */
  enabled?: boolean
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
  /** User-background file injected into every chatroom persona; '' opts out (Go user_profile). */
  userProfile?: string
}

const chatroomSection = Schema.object({
  enabled: Schema.boolean().description('Whether the /chatroom command family and chatroom tool are enabled for this project (default true)'),
  rolesDir: Schema.string().description('Root directory holding one persona subdirectory per role'),
  maxRoles: Schema.natural().description('Cap on role agents per chatroom (default 5)'),
  moderatorDir: Schema.string().description('Moderator data dir holding per-chatroom ledgers'),
  gatherTimeoutSec: Schema.natural().description('Gather barrier fallback timeout in seconds (default 1200)'),
  endTimeoutSec: Schema.natural().description('End barrier drain timeout in seconds (default 600)'),
  researchTimeoutSec: Schema.natural().description('Research gather round timeout in seconds, clamped to [60, 86400]'),
  maxResearchRounds: Schema.natural().description('Auto-mode research iteration cap, clamped to [1, 20]'),
  defaultResearchMode: Schema.union(['auto', 'manual']).description('Default research driver when --mode is omitted'),
  researchWorkspace: Schema.string().description('Shared research-assistant workdir (default <projectDataDir>/chatroom-research)'),
  researchPythonEnv: Schema.boolean().description('Pre-provision the shared uv venv for research; default true'),
  userProfile: Schema.string().description('User-background file injected into every chatroom persona (roles, moderator, direct-role)'),
})

/**
 * The chatroom plugin config: `defaults` applies to every project, and each
 * `projects` entry (keyed by the bridge project's name) overrides per field.
 */
export const Config = Schema.object({
  defaults: chatroomSection.description('Multi-role chatroom tuning applied to every project (Go [chatroom]; per-project sections override)'),
  projects: Schema.dict(chatroomSection).description('Per-project chatroom tuning, keyed by the bridge project name'),
})

/** Expand a leading ~ in a config path so the config stays portable across machines (Go expandHome). */
function expandHome(path: string): string {
  const trimmed = path.trim()
  const home = homedir()
  if (trimmed === '~') return home
  if (trimmed.startsWith('~/')) return join(home, trimmed.slice(2))
  return trimmed
}

/**
 * One engine's resolved chatroom configuration. Field overrides keep the old
 * engine-setter semantics (clamped at apply time, effective getters fall
 * back to the Go defaults); the raw values are frozen after the plugin's
 * startup sweep.
 */
class ChatroomEngineConfig {
  /** Whether the chatroom is enabled for this engine; undefined = true. */
  enabledFlag: boolean | undefined = undefined
  /** Roles root override; '' = the default under the Claude config home. */
  rolesDirOverride = ''
  /** Per-chatroom role cap override; 0 = default 5. */
  maxRolesOverride = 0
  /** Moderator data dir (per-chatroom ledgers); '' disables the ledger. */
  moderatorDirValue = ''
  /** Gather barrier fallback timeout override in ms; 0 = the 20m default. */
  gatherTimeoutMs = 0
  /** End-barrier drain timeout override in ms; 0 = half the gather default. */
  endTimeoutMs = 0
  /** Research gather round timeout override in ms; 0 = the 60m default. */
  researchTimeoutMs = 0
  /** Auto-mode research iteration cap override; 0 = default 3. */
  maxResearchRoundsOverride = 0
  /** Default research iteration driver; '' behaves as 'auto'. */
  defaultResearchModeValue = ''
  /** Shared research-assistant workdir override; '' = <projectDataDir>/chatroom-research. */
  researchWorkspaceCfg = ''
  /** Whether the shared uv venv is pre-provisioned for research assistants. */
  researchPythonEnv = false
  /** User-background file injected into chatroom personas; '' = none. */
  userProfileCfg = ''

  /**
   * Apply one config section's overrides (Go wireChatroom: the project
   * section overrides the shared default per field; ~ expanded; research
   * values clamped to the Go ranges).
   * @param cfg - The merged defaults+project section.
   */
  applySection(cfg: ChatroomProjectConfig): void {
    if (cfg.enabled !== undefined) {
      this.enabledFlag = cfg.enabled
    }
    if (cfg.rolesDir !== undefined && cfg.rolesDir.trim() !== '') {
      this.rolesDirOverride = expandHome(cfg.rolesDir)
    }
    if (cfg.maxRoles !== undefined && cfg.maxRoles > 0) {
      this.maxRolesOverride = cfg.maxRoles
    }
    if (cfg.moderatorDir !== undefined) {
      this.moderatorDirValue = expandHome(cfg.moderatorDir).trim()
    }
    if (cfg.gatherTimeoutSec !== undefined && cfg.gatherTimeoutSec > 0) {
      this.gatherTimeoutMs = cfg.gatherTimeoutSec * 1000
    }
    if (cfg.endTimeoutSec !== undefined && cfg.endTimeoutSec > 0) {
      this.endTimeoutMs = cfg.endTimeoutSec * 1000
    }
    if (cfg.researchTimeoutSec !== undefined && cfg.researchTimeoutSec > 0) {
      this.researchTimeoutMs = Math.min(maxChatroomResearchTimeout, Math.max(minChatroomResearchTimeout, cfg.researchTimeoutSec * 1000))
    }
    if (cfg.maxResearchRounds !== undefined && cfg.maxResearchRounds > 0) {
      this.maxResearchRoundsOverride = Math.min(maxChatroomResearchRounds, Math.max(minChatroomResearchRounds, cfg.maxResearchRounds))
    }
    if (cfg.defaultResearchMode !== undefined) {
      this.defaultResearchModeValue = cfg.defaultResearchMode
    }
    if (cfg.researchWorkspace !== undefined && cfg.researchWorkspace.trim() !== '') {
      this.researchWorkspaceCfg = expandHome(cfg.researchWorkspace)
    }
    // Like moderatorDir, '' is a meaningful value: a project section opting
    // out of a shared default profile.
    if (cfg.userProfile !== undefined) {
      this.userProfileCfg = expandHome(cfg.userProfile).trim()
    }
    // Research venv provisioning defaults ON (Go wire.go: nil → enabled);
    // the production sweep always passes the resolved value, so a per-field
    // test call never flips the switch by accident.
    if (cfg.researchPythonEnv !== undefined) {
      this.researchPythonEnv = cfg.researchPythonEnv
    }
  }

  /** Whether the chatroom is enabled for this engine (default true). */
  enabled(): boolean {
    return this.enabledFlag !== false
  }

  /** Effective roles root (the configured override, or the config-home default). */
  rolesDir(): string {
    return this.rolesDirOverride !== '' ? this.rolesDirOverride : defaultChatroomRolesDir()
  }

  /** Effective per-chatroom role cap (the override, or the default of 5). */
  maxRoles(): number {
    return this.maxRolesOverride > 0 ? this.maxRolesOverride : defaultMaxChatroomRoles
  }

  /** The moderator dir and whether the ledger feature is enabled. */
  moderatorDir(): { dir: string; ok: boolean } {
    return { dir: this.moderatorDirValue, ok: this.moderatorDirValue !== '' }
  }

  /** Effective gather barrier timeout (the override, or the 20m default). */
  gatherTimeoutDuration(): number {
    return this.gatherTimeoutMs > 0 ? this.gatherTimeoutMs : defaultChatroomGatherTimeout
  }

  /**
   * Effective end drain timeout: end waits for replies already generating,
   * so it defaults to half the gather timeout rather than gather's full
   * headroom.
   */
  endTimeoutDuration(): number {
    return this.endTimeoutMs > 0 ? this.endTimeoutMs : defaultChatroomGatherTimeout / 2
  }

  /** Effective research gather timeout (the override, or the 60m default). */
  researchTimeoutDuration(): number {
    return this.researchTimeoutMs > 0 ? this.researchTimeoutMs : defaultChatroomResearchTimeout
  }

  /** Effective auto-mode research round cap (the override, or the default of 3). */
  maxResearchRounds(): number {
    return this.maxResearchRoundsOverride > 0 ? this.maxResearchRoundsOverride : defaultMaxChatroomResearchRounds
  }

  /** Effective default research mode; unknown values behave as 'auto'. */
  defaultResearchMode(): string {
    return this.defaultResearchModeValue === 'manual' ? 'manual' : 'auto'
  }

  /** Effective user-background file injected into chatroom personas; '' = none. */
  userProfile(): string {
    return this.userProfileCfg
  }
}

const engineConfigs = new WeakMap<Engine, ChatroomEngineConfig>()

/**
 * The resolved chatroom configuration of one engine. Engines the startup
 * sweep has not reached (the tiny window before whenReady resolves) get a
 * default-valued configuration — the structural cost of the move, recorded
 * in the README's Known Limitations.
 * @param e - The engine whose chatroom configuration is addressed.
 * @returns the engine's resolved chatroom configuration.
 */
export function chatroomConfig(e: Engine): ChatroomEngineConfig {
  let cfg = engineConfigs.get(e)
  if (cfg === undefined) {
    cfg = new ChatroomEngineConfig()
    engineConfigs.set(e, cfg)
  }
  return cfg
}

/**
 * Apply the plugin config's merged section to one engine during the startup
 * sweep (the old wireChatroom, on the package's own per-engine store).
 * @param e - The engine the configuration applies to.
 * @param defaults - The plugin-level defaults section.
 * @param project - The per-project section, overriding per field.
 */
export function applyChatroomEngineConfig(e: Engine, defaults: ChatroomProjectConfig, project: ChatroomProjectConfig | undefined): void {
  const merged: ChatroomProjectConfig = { ...defaults, ...project }
  // Go wire.go always armed the research-venv switch (nil → enabled).
  merged.researchPythonEnv = merged.researchPythonEnv !== false
  chatroomConfig(e).applySection(merged)
}
