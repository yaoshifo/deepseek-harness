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
  defaultChatroomAssistantStallSec,
  defaultChatroomGatherRearm,
  defaultChatroomGatherTimeout,
  defaultChatroomPollConcurrent,
  defaultChatroomPollTimeout,
  defaultChatroomResearchTimeout,
  defaultMaxChatroomRoles,
  maxChatroomResearchTimeout,
  minChatroomAssistantStallSec,
  minChatroomResearchTimeout,
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
  /**
   * Re-arm window after a gather timeout in seconds: one more window for
   * the still-missing roles before the barrier degrades to free relay
   * (0 = the 20m default).
   */
  gatherRearmSec?: number
  /** End barrier drain timeout in seconds (Go end_timeout_sec). */
  endTimeoutSec?: number
  /** Research-mode gather round timeout in seconds, clamped to [60, 86400] (Go research_timeout_sec). */
  researchTimeoutSec?: number
  /** Default research iteration driver when --mode is omitted (Go default_research_mode). */
  defaultResearchMode?: 'auto' | 'manual'
  /** Shared research-assistant workdir; empty falls back to <moderatorDir>/research (Go research_workspace). */
  researchWorkspace?: string
  /** Pre-provision the shared uv venv for research assistants; default true (Go research_python_env). */
  researchPythonEnv?: boolean
  /** Base packages installed into the shared research venv; unset or empty = the akshare base list with pandas pinned <3. */
  researchVenvPackages?: string[]
  /** Persistent research-playbook file surfaced to research assistants; '' or unset opts out. */
  researchPlaybook?: string
  /**
   * Research-assistant stall deadline in seconds: a hub↔steward relation
   * quiet this long gets a supervision wake; 0 disables the supervisor.
   * Non-zero values below 600 are rejected at apply.
   */
  assistantStallSec?: number
  /** Lightning-round poll timeout in seconds; 0 = the 10m default. */
  pollTimeoutSec?: number
  /** Lightning-round concurrent one-shot query cap; 0 = the default of 4. */
  pollMaxConcurrent?: number
  /** Named provider route for lightning-round statements; '' = the default route. */
  pollProvider?: string
}

const chatroomSection = Schema.object({
  enabled: Schema.boolean().description('Whether the /chatroom command family and chatroom tool are enabled for this project (default true)'),
  rolesDir: Schema.string().description('Root directory holding one persona subdirectory per role'),
  maxRoles: Schema.natural().description('Cap on role agents per chatroom (default 5)'),
  moderatorDir: Schema.string().description('Moderator data dir holding per-chatroom ledgers'),
  gatherTimeoutSec: Schema.natural().description('Gather barrier fallback timeout in seconds (default 1200)'),
  gatherRearmSec: Schema.natural().description('Re-arm window after a gather timeout in seconds — one more window for late replies before the barrier degrades to free relay (default 1200)'),
  endTimeoutSec: Schema.natural().description('End barrier drain timeout in seconds (default 600)'),
  researchTimeoutSec: Schema.natural().description('Research gather round timeout in seconds, clamped to [60, 86400]'),
  defaultResearchMode: Schema.union(['auto', 'manual']).description('Default research driver when --mode is omitted'),
  researchWorkspace: Schema.string().description('Shared research-assistant workdir (default <projectDataDir>/chatroom-research)'),
  researchPythonEnv: Schema.boolean().description('Pre-provision the shared uv venv for research; default true'),
  researchVenvPackages: Schema.array(Schema.string()).description('Base packages installed into the shared research venv (default akshare, pandas<3, numpy, requests)'),
  researchPlaybook: Schema.string().description('Persistent playbook file read/appended by research assistants (default off)'),
  assistantStallSec: Schema.natural().description('Research-assistant stall deadline in seconds; a quiet hub↔steward relation past it gets a supervision wake (default 1800, 0 disables, minimum 600)'),
  pollTimeoutSec: Schema.natural().description('Lightning-round poll timeout in seconds — one-shot persona statements degrade after this window (default 600)'),
  pollMaxConcurrent: Schema.natural().description('Lightning-round concurrent one-shot query cap, protecting the LLM gateway from the full role fan-out (default 4)'),
  pollProvider: Schema.string().description('Named provider route for lightning-round statements (default: the default route)'),
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
  /** Re-arm window after a gather timeout override in ms; 0 = the 20m default. */
  gatherRearmMs = 0
  /** End-barrier drain timeout override in ms; 0 = half the gather default. */
  endTimeoutMs = 0
  /** Research gather round timeout override in ms; 0 = the 60m default. */
  researchTimeoutMs = 0
  /** Default research iteration driver; '' behaves as 'auto'. */
  defaultResearchModeValue = ''
  /** Shared research-assistant workdir override; '' = <projectDataDir>/chatroom-research. */
  researchWorkspaceCfg = ''
  /** Whether the shared uv venv is pre-provisioned for research assistants. */
  researchPythonEnv = false
  /** Base packages for the shared research venv; undefined = the pinned akshare base list. */
  private researchVenvPackagesValue: string[] | undefined = undefined
  /** Persistent research-playbook file surfaced to research assistants; '' = none. */
  private researchPlaybookCfg = ''
  /** Research-assistant stall deadline override in ms; 0 = the 30m default. */
  private assistantStallMs = 0
  /** Whether the supervisor is explicitly disabled for this engine. */
  private assistantStallOff = false
  /** Lightning-round poll timeout override in ms; 0 = the 10m default. */
  private pollTimeoutMs = 0
  /** Lightning-round concurrency cap override; 0 = the default of 4. */
  private pollMaxConcurrentCfg = 0
  /** Named provider route for lightning-round statements; '' = default. */
  private pollProviderCfg = ''

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
    if (cfg.gatherRearmSec !== undefined && cfg.gatherRearmSec > 0) {
      this.gatherRearmMs = cfg.gatherRearmSec * 1000
    }
    if (cfg.endTimeoutSec !== undefined && cfg.endTimeoutSec > 0) {
      this.endTimeoutMs = cfg.endTimeoutSec * 1000
    }
    if (cfg.researchTimeoutSec !== undefined && cfg.researchTimeoutSec > 0) {
      this.researchTimeoutMs = Math.min(maxChatroomResearchTimeout, Math.max(minChatroomResearchTimeout, cfg.researchTimeoutSec * 1000))
    }
    if (cfg.defaultResearchMode !== undefined) {
      this.defaultResearchModeValue = cfg.defaultResearchMode
    }
    if (cfg.researchWorkspace !== undefined && cfg.researchWorkspace.trim() !== '') {
      this.researchWorkspaceCfg = expandHome(cfg.researchWorkspace)
    }
    // Research venv provisioning defaults ON (Go wire.go: nil → enabled);
    // the production sweep always passes the resolved value, so a per-field
    // test call never flips the switch by accident.
    if (cfg.researchPythonEnv !== undefined) {
      this.researchPythonEnv = cfg.researchPythonEnv
    }
    if (cfg.researchVenvPackages !== undefined && cfg.researchVenvPackages.length > 0) {
      this.researchVenvPackagesValue = cfg.researchVenvPackages
    }
    // Like researchWorkspace, only a non-empty path engages the feature.
    if (cfg.researchPlaybook !== undefined && cfg.researchPlaybook.trim() !== '') {
      this.researchPlaybookCfg = expandHome(cfg.researchPlaybook)
    }
    if (cfg.assistantStallSec !== undefined) {
      if (cfg.assistantStallSec === 0) {
        this.assistantStallOff = true
      } else {
        // Below the floor a supervisor would nag through every legitimate
        // quiet stretch (the gather barrier alone waits up to 20 minutes);
        // fail loud at apply instead of arming a noisy loop.
        if (cfg.assistantStallSec < minChatroomAssistantStallSec) {
          throw new Error(`chatroom: assistantStallSec must be 0 (off) or at least ${minChatroomAssistantStallSec}, got ${cfg.assistantStallSec}`)
        }
        this.assistantStallMs = cfg.assistantStallSec * 1000
      }
    }
    if (cfg.pollTimeoutSec !== undefined && cfg.pollTimeoutSec > 0) {
      this.pollTimeoutMs = cfg.pollTimeoutSec * 1000
    }
    if (cfg.pollMaxConcurrent !== undefined && cfg.pollMaxConcurrent > 0) {
      this.pollMaxConcurrentCfg = cfg.pollMaxConcurrent
    }
    if (cfg.pollProvider !== undefined) {
      this.pollProviderCfg = cfg.pollProvider.trim()
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
   * Effective re-arm window after a gather timeout (the override, or the
   * 20m default). One re-arm per gather round bounds the total wait at
   * ≈ 2× the gather timeout.
   */
  gatherRearmDuration(): number {
    return this.gatherRearmMs > 0 ? this.gatherRearmMs : defaultChatroomGatherRearm
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

  /** Effective default research mode; unknown values behave as 'auto'. */
  defaultResearchMode(): string {
    return this.defaultResearchModeValue === 'manual' ? 'manual' : 'auto'
  }

  /**
   * Effective base-package list installed into the shared research venv.
   * akshare's metadata requires pandas>=2.0.0 with no upper bound and
   * pandas 3.x breaks it, so the default pins pandas<3.
   */
  researchVenvPackages(): string[] {
    return this.researchVenvPackagesValue ?? ['akshare', 'pandas<3', 'numpy', 'requests']
  }

  /** Effective persistent research-playbook file; '' = none surfaced. */
  researchPlaybook(): string {
    return this.researchPlaybookCfg
  }

  /**
   * Effective research-assistant stall deadline; 0 disables the supervisor.
   * The default of 30 minutes sits above the gather barrier's 20-minute
   * quiet window and the incident's observed long-job cadence.
   */
  assistantStallDuration(): number {
    if (this.assistantStallOff) return 0
    return this.assistantStallMs > 0 ? this.assistantStallMs : defaultChatroomAssistantStallSec * 1000
  }

  /** Effective lightning-round poll timeout (the override, or the 10m default). */
  pollTimeoutDuration(): number {
    return this.pollTimeoutMs > 0 ? this.pollTimeoutMs : defaultChatroomPollTimeout
  }

  /** Effective lightning-round concurrency cap (the override, or the default of 4). */
  pollMaxConcurrent(): number {
    return this.pollMaxConcurrentCfg > 0 ? this.pollMaxConcurrentCfg : defaultChatroomPollConcurrent
  }

  /** Named provider route for lightning-round statements; '' = the default route. */
  pollProvider(): string {
    return this.pollProviderCfg
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
