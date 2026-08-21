/**
 * Per-project runtime state store ported from cc-connect core/projectstate.go:
 * workDir override plus per-workspace dir overrides, JSON-persisted with the
 * same field names so existing state files reload unchanged.
 *
 * @module dsh-feishu-bridge/project-state
 */

import { readFileSync } from 'node:fs'
import { atomicWriteFileSync } from '../atomicwrite.js'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

interface ProjectStateData {
  work_dir_override?: string
  workspace_dir_overrides?: Record<string, string> | undefined
  /** Runtime /monitor chats override (#53; empty = use config). */
  monitor_chats?: string
  /** Runtime /monitor mode override (#53; empty = use config). */
  monitor_mode?: string
  /** Runtime active-provider override from /provider switch (#9; empty = use config). */
  active_provider?: string
}

/** Persists lightweight runtime state for one project. */
export class ProjectStateStore {
  private readonly storePath: string
  private state: ProjectStateData = {}

  constructor(path: string) {
    this.storePath = path
    if (path !== '') this.load()
  }

  /**
   * The project-wide workDir override ('' when unset).
   * @returns The override directory, or '' when unset.
   */
  workDirOverride(): string {
    return this.state.work_dir_override ?? ''
  }

  /**
   * Set or clear the project-wide workDir override.
   * @param dir - Override directory; '' clears the override.
   */
  setWorkDirOverride(dir: string): void {
    this.state.work_dir_override = dir
  }

  /**
   * The per-workspace dir override ('' when unset).
   * @param workspace - Workspace key whose override to read.
   * @returns The override directory for workspace, or '' when unset.
   */
  workspaceDirOverride(workspace: string): string {
    return this.state.workspace_dir_overrides?.[workspace] ?? ''
  }

  /**
   * Set the per-workspace dir override.
   * @param workspace - Workspace key to set the override for.
   * @param dir - Override directory; '' records an empty override.
   */
  setWorkspaceDirOverride(workspace: string, dir: string): void {
    if (this.state.workspace_dir_overrides === undefined) {
      this.state.workspace_dir_overrides = {}
    }
    this.state.workspace_dir_overrides[workspace] = dir
  }

  /**
   * Remove the per-workspace dir override; the map is dropped once empty.
   * @param workspace - Workspace key whose override to remove.
   */
  clearWorkspaceDirOverride(workspace: string): void {
    const overrides = this.state.workspace_dir_overrides
    if (overrides === undefined) return
    const next: Record<string, string> = {}
    for (const [k, v] of Object.entries(overrides)) {
      if (k !== workspace) next[k] = v
    }
    this.state.workspace_dir_overrides = Object.keys(next).length === 0 ? undefined : next
  }

  /** Clear the project-wide workDir override by setting it to ''. */
  clearWorkDirOverride(): void {
    this.setWorkDirOverride('')
  }

  /**
   * The runtime /monitor chats override ('' when unset).
   * @returns The override chat list, or '' when unset.
   */
  monitorChats(): string {
    return this.state.monitor_chats ?? ''
  }

  /**
   * Set the runtime /monitor chats override.
   * @param chats - Override chat list; '' falls back to config.
   */
  setMonitorChats(chats: string): void {
    this.state.monitor_chats = chats
  }

  /**
   * The runtime /monitor mode override ('' when unset).
   * @returns The override mode, or '' when unset.
   */
  monitorMode(): string {
    return this.state.monitor_mode ?? ''
  }

  /**
   * Set the runtime /monitor mode override.
   * @param mode - Override mode; '' falls back to config.
   */
  setMonitorMode(mode: string): void {
    this.state.monitor_mode = mode
  }

  /**
   * The runtime active-provider override ('' when unset = config default).
   * @returns The override provider name, or '' when unset.
   */
  activeProvider(): string {
    return this.state.active_provider ?? ''
  }

  /**
   * Set the runtime active-provider override.
   * @param name - Override provider name; '' falls back to config.
   */
  setActiveProvider(name: string): void {
    this.state.active_provider = name
  }

  /** Persist synchronously (Go saveLocked). */
  save(): void {
    if (this.storePath === '') return
    try {
      const data = JSON.stringify(this.state, null, 2) + '\n'
      mkdirSync(dirname(this.storePath), { recursive: true })
      atomicWriteFileSync(this.storePath, new TextEncoder().encode(data), 0o644)
    } catch (error) {
      console.error(`project_state: failed to write ${this.storePath}: ${String(error)}`)
    }
  }

  private load(): void {
    let data: string
    try {
      data = readFileSync(this.storePath, 'utf8')
    } catch {
      return
    }
    try {
      this.state = JSON.parse(data) as ProjectStateData
    } catch (error) {
      console.error(`project_state: failed to unmarshal ${this.storePath}: ${String(error)}`)
    }
  }
}
