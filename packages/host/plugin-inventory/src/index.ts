/** Read-only projection of the current Cordis Loader plugin entries. */

import type { Context, FiberState } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
// Type-only: the optional agent-preset roster resolved through `ctx.get`.
import type {} from '@deepseek-ai/dsh-agent-presets'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { load as loadYaml } from 'js-yaml'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import type {
  AgentPresetPluginGroup,
  PluginEntryId,
  PluginFiberPhase,
  PluginInventoryEntry,
  PluginInventorySnapshot,
  ProfileCompositionEntry,
  ProfileInventorySnapshot,
  ProfilePluginRow,
} from './types.ts'

export type * from './types.ts'

/** Brand an existing Loader-tree entry id at the owning boundary. */
function pluginEntryId(value: string): PluginEntryId {
  return value as PluginEntryId
}

/** Runtime mirror: FiberState is a cross-package const enum. */
const FIBER_STATE = {
  PENDING: 0 as FiberState.PENDING,
  LOADING: 1 as FiberState.LOADING,
  ACTIVE: 2 as FiberState.ACTIVE,
  FAILED: 3 as FiberState.FAILED,
  DISPOSED: 4 as FiberState.DISPOSED,
  UNLOADING: 5 as FiberState.UNLOADING,
} as const

/** Complete public projection of Cordis Fiber states. */
const FIBER_PHASE = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: null,
  [FIBER_STATE.UNLOADING]: 'unloading',
} as const satisfies Record<FiberState, PluginFiberPhase>

/** Remote-only service exposing the Loader's current non-group entry state. */
export class PluginInventoryGateway extends TypertRemoteService {
  static inject = ['loader']

  constructor(ctx: Context) {
    super(ctx, 'pluginInventory')
  }

  /**
   * Read the Loader directly on every call. Cordis's internal plugin/status
   * events already maintain Entry.fiber and Fiber.state, so a second cache
   * would only add another lifecycle truth to keep synchronized.
   *
   * When an agent-preset roster is composed, the snapshot also carries each
   * preset's composition rows, because those rows — not the Loader's own
   * entries — are where a deployment that mounts the roster runs its
   * model-facing plugins.
   * @returns Current non-group Loader entries in Loader order, with per-preset
   * compositions when a roster is composed.
   */
  @Remote('list')
  async list(): Promise<PluginInventorySnapshot> {
    const entries: PluginInventoryEntry[] = []
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.group) continue
      entries.push({
        entryId: pluginEntryId(entry.id),
        moduleName: entry.options.name,
        enabled: !entry.disabled,
        fiberPhase: entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state],
      })
    }
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return { entries }
    const agentPresets: AgentPresetPluginGroup[] = (await presets.compositionInventory()).map(
      composition => ({
        ...composition,
        rows: composition.rows.map(({ fiberState, ...row }) => ({
          ...row,
          fiberPhase: fiberState === undefined ? null : FIBER_PHASE[fiberState],
        })),
      }),
    )
    return { entries, agentPresets }
  }

  /**
   * List every stored harness profile with its composition files. A profile
   * directory whose `package.json` is missing or damaged degrades to an empty
   * bundle list; a missing composition file is simply absent from the entry.
   * @returns one entry per profile directory, in name order.
   */
  @Remote('listProfiles')
  async listProfiles(): Promise<ProfileInventorySnapshot> {
    const root = dshHomePath('profiles')
    let dirs
    try {
      dirs = await readdir(root, { withFileTypes: true })
    } catch (error: unknown) {
      // No profiles root yet means no profiles; every other failure surfaces.
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { profiles: [] }
      throw error
    }
    const profiles: ProfileCompositionEntry[] = []
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue
      profiles.push(await this.readProfile(join(root, dir.name), dir.name))
    }
    profiles.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    return { profiles }
  }

  /** Read one profile directory's composition, degrading per-file on damage. */
  private async readProfile(path: string, name: string): Promise<ProfileCompositionEntry> {
    let bundles: string[] = []
    try {
      const raw = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) as {
        dsh?: { profile?: { bundles?: unknown } }
      }
      const declared = raw.dsh?.profile?.bundles
      if (Array.isArray(declared) && declared.every(item => typeof item === 'string')) {
        bundles = declared
      }
    } catch {
      // A damaged or missing package.json leaves the bundle list empty.
    }
    const optional = async (file: string): Promise<string | undefined> => {
      try {
        return await readFile(join(path, file), 'utf8')
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
        throw error
      }
    }
    const cordisYml = await optional('cordis.yml')
    const patchYml = await optional('cordis.patch.yml')
    return {
      name,
      path,
      bundles,
      ...(cordisYml === undefined ? {} : { cordisYml }),
      ...(patchYml === undefined ? {} : { patchYml }),
      ...(patchYml === undefined ? {} : { pluginRows: parsePluginRows(patchYml) }),
    }
  }
}

/**
 * Flatten a patch layer into display rows. Parsing is deliberately lenient:
 * the Loader owns the patch schema, so any structure this reader does not
 * recognize degrades to an absent list rather than failing the profile read.
 */
function parsePluginRows(patchYml: string): readonly ProfilePluginRow[] | undefined {
  let parsed: unknown
  try {
    parsed = loadYaml(patchYml)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  const rows: ProfilePluginRow[] = []
  const walk = (entries: readonly unknown[]): boolean => {
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false
      const record = entry as Record<string, unknown>
      const id = typeof record.id === 'string' ? record.id : null
      const name = typeof record.name === 'string' ? record.name : null
      const disabled = record.disabled === true
      if (id !== null || name !== null) rows.push({ id, name, disabled })
      if (Array.isArray(record.insert)) {
        if (!walk(record.insert)) return false
      }
    }
    return true
  }
  return walk(parsed) ? rows : undefined
}

export default PluginInventoryGateway
