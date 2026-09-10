import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable Loader-tree identity of one configured plugin entry. */
export type PluginEntryId = Branded<'PluginEntryId'>

/** Lifecycle state of an entry's root Fiber, or null when it has no live root Fiber. */
export type PluginFiberPhase =
  | 'pending'
  | 'loading'
  | 'active'
  | 'failed'
  | 'unloading'
  | null

/** One non-group Loader entry exposed to trusted clients. */
export interface PluginInventoryEntry {
  readonly entryId: PluginEntryId
  /** Exact module specifier imported by the Loader entry. */
  readonly moduleName: string
  /** Effective Loader enablement, including disabled ancestor groups. */
  readonly enabled: boolean
  readonly fiberPhase: PluginFiberPhase
}

/** Effective enablement of one preset composition row. */
export type PresetPluginEnablement = boolean | 'conditional'

/** One plugin row an agent preset's composition names. */
export interface AgentPresetPluginRow {
  /** Composition row id, or null when the row declares none. */
  readonly entryId: string | null
  /** Module specifier the row names. */
  readonly moduleName: string
  /**
   * Effective enablement, including disabled ancestor groups. `'conditional'`
   * marks a `!!js` disabled expression on a composition no session has
   * mounted, which only a Loader context can decide.
   */
  readonly enabled: PresetPluginEnablement
  /** The row's own `!!js` disabled expression, when it carries one. */
  readonly condition?: string
  /** Root-fiber phase when the composition is live; null otherwise. */
  readonly fiberPhase: PluginFiberPhase
}

/** One agent preset's identity and flattened composition in the inventory. */
export interface AgentPresetPluginGroup {
  /** Stable preset id. */
  readonly id: string
  /** Whether the deployment ships the preset or the user owns it. */
  readonly trust: 'system' | 'user'
  /** Display name the preset published; a reader falls back to the id. */
  readonly name?: string
  /** Whether a session naming no preset composes this one. */
  readonly isDefault: boolean
  /** Why this preset's composition cannot be read; absent when rows answer. */
  readonly broken?: string
  /** Plugin rows in composition order; empty when the preset is broken. */
  readonly rows: readonly AgentPresetPluginRow[]
}

/** Point-in-time inventory returned by the plugin inventory Remote. */
export interface PluginInventorySnapshot {
  readonly entries: readonly PluginInventoryEntry[]
  /**
   * Per-preset compositions, present only when an agent-preset roster is
   * composed in this deployment.
   */
  readonly agentPresets?: readonly AgentPresetPluginGroup[]
}

/** One harness profile's composition as stored under the profiles root. */
export interface ProfileCompositionEntry {
  /** Profile directory name under the harness home's `profiles/`. */
  readonly name: string
  /** Absolute path of the profile directory. */
  readonly path: string
  /** Bundle names the profile stacks, from `package.json`; empty when unreadable. */
  readonly bundles: readonly string[]
  /** Raw `cordis.yml` entry list, when the file exists. */
  readonly cordisYml?: string
  /** Raw `cordis.patch.yml` patch layer, when the file exists. */
  readonly patchYml?: string
  /** Flattened patch-entry rows, present when the patch layer parses. */
  readonly pluginRows?: readonly ProfilePluginRow[] | undefined
}

/** Read-only composition inventory of every stored harness profile. */
export interface ProfileInventorySnapshot {
  readonly profiles: readonly ProfileCompositionEntry[]
}

/** One loader patch entry of a profile's patch layer, flattened across inserts. */
export interface ProfilePluginRow {
  /** Entry id; null when the patch row carries no id. */
  readonly id: string | null
  /** Module name the row references, when the patch names one. */
  readonly name: string | null
  /** Whether the patch disables the entry. */
  readonly disabled: boolean
}
