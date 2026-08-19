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
}

/** Persists lightweight runtime state for one project. */
export class ProjectStateStore {
  private readonly storePath: string
  private state: ProjectStateData = {}

  constructor(path: string) {
    this.storePath = path
    if (path !== '') this.load()
  }

  /** The project-wide workDir override ('' when unset). */
  workDirOverride(): string {
    return this.state.work_dir_override ?? ''
  }

  setWorkDirOverride(dir: string): void {
    this.state.work_dir_override = dir
  }

  /** The per-workspace dir override ('' when unset). */
  workspaceDirOverride(workspace: string): string {
    return this.state.workspace_dir_overrides?.[workspace] ?? ''
  }

  setWorkspaceDirOverride(workspace: string, dir: string): void {
    if (this.state.workspace_dir_overrides === undefined) {
      this.state.workspace_dir_overrides = {}
    }
    this.state.workspace_dir_overrides[workspace] = dir
  }

  clearWorkspaceDirOverride(workspace: string): void {
    const overrides = this.state.workspace_dir_overrides
    if (overrides === undefined) return
    const next: Record<string, string> = {}
    for (const [k, v] of Object.entries(overrides)) {
      if (k !== workspace) next[k] = v
    }
    this.state.workspace_dir_overrides = Object.keys(next).length === 0 ? undefined : next
  }

  clearWorkDirOverride(): void {
    this.setWorkDirOverride('')
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
