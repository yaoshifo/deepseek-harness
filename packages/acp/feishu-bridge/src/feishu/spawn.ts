/**
 * Spawned-chat registry and group spawning, ported from cc-connect
 * platform/feishu/feishu_spawn.go. A spawned chat is a dedicated task group
 * created by /spawn: the bot answers there without an @-mention, and the
 * registry entry carries its active state plus per-group custom avatar keys
 * (#52) so /done dimming restores the custom avatar instead of the global bot
 * avatar.
 *
 * @module dsh-feishu-bridge/feishu-spawn
 */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { atomicWriteFile } from '../atomicwrite.js'
import type { GroupSpawnOptions, SpawnedChatInfo } from '../core/types.js'

export type { GroupSpawnOptions, SpawnedChatInfo }

/**
 * Persisted marker that a chat was /spawn-created. Field semantics follow Go's
 * SpawnedChatMeta JSON: absent/empty means zero.
 */
export interface SpawnedChatMeta {
  /** Active (color-avatar) state; /done=false, /undone=true. */
  active?: boolean
  /** Legacy-entry flag: activity was backfilled via the tag API once. */
  backfilled?: boolean
  /** Custom Lucide icon avatar key (colored), #52. */
  colorAvatarKey?: string
  /** Custom avatar's grayscaled counterpart, applied on /done. */
  grayAvatarKey?: string
  /** ISO timestamp of the /done that marked the chat inactive. */
  doneAt?: string
}

/** How long a /done'd entry lingers before eviction (Go spawnedChatRetention). */
export const spawnedChatRetention = 7 * 24 * 3600_000

/**
 * Extract the chat ID from a Feishu session key ("feishu:\<chatID\>[:...]");
 * every session-key form puts the chat ID in the second colon field.
 * @param sessionKey - Session key.
 * @returns The chat ID, or empty when absent.
 */
export function extractFeishuChatID(sessionKey: string): string {
  const parts = sessionKey.split(':', 3)
  return parts.length >= 2 ? (parts[1] ?? '') : ''
}

/**
 * The project (repo) name for a spawned chat's enterprise tag. A worktree
 * lives at `<repo>/.claude/worktrees/<slug>`, whose base name is a throwaway
 * slug — return the repo's base name instead so the chat is tagged with the
 * project. Any other directory keeps its plain base name.
 * @param dir - Working directory at spawn time.
 * @returns The tag seed name.
 */
export function projectBaseForTag(dir: string): string {
  const marker = '/.claude/worktrees/'
  const i = dir.indexOf(marker)
  if (i >= 0) return basename(dir.slice(0, i))
  return basename(dir)
}

/**
 * In-memory + on-disk registry of spawned chats. File mutations go through
 * {@link SpawnedChatStore.save}, which also runs the retention sweep.
 */
export class SpawnedChatStore {
  private readonly file: string
  private readonly chats = new Map<string, SpawnedChatMeta>()

  /**
   * @param file - Persistence path; empty disables on-disk persistence.
   */
  constructor(file = '') {
    this.file = file
  }

  /**
   * Load the persisted registry (new `{"chats":{...}}` format, then the legacy
   * `{"chat_ids":[...]}` shape). Missing file is a clean start.
   */
  async load(): Promise<void> {
    if (this.file === '') return
    let data: string
    try {
      data = await readFile(this.file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`feishu: load spawned chats failed: ${String(err)}`)
      }
      return
    }
    try {
      const newFmt = JSON.parse(data) as { chats?: Record<string, SpawnedChatMeta> }
      if (newFmt.chats !== undefined && Object.keys(newFmt.chats).length > 0) {
        for (const [id, meta] of Object.entries(newFmt.chats)) {
          this.chats.set(id, meta)
        }
        return
      }
      const legacy = JSON.parse(data) as { chat_ids?: string[] }
      for (const id of legacy.chat_ids ?? []) {
        this.chats.set(id, {})
      }
    } catch (err) {
      console.warn(`feishu: parse spawned chats failed: ${String(err)}`)
    }
  }

  /** Whether the chat is /spawn-created. */
  isSpawned(chatID: string): boolean {
    return this.chats.has(chatID)
  }

  /** Whether the spawned chat is active (color-avatar state). */
  isActive(chatID: string): boolean {
    return this.chats.get(chatID)?.active === true
  }

  /** The chat's meta, if registered. */
  get(chatID: string): SpawnedChatMeta | undefined {
    return this.chats.get(chatID)
  }

  /** Set a chat's meta in memory only; persist via {@link save}. */
  set(chatID: string, meta: SpawnedChatMeta): void {
    this.chats.set(chatID, meta)
  }

  /** All registered chat IDs (for tag discovery scans). */
  chatIDs(): string[] {
    return [...this.chats.keys()]
  }

  /** Snapshot of entries for listing. */
  entries(): Array<[string, SpawnedChatMeta]> {
    return [...this.chats.entries()]
  }

  /**
   * Persist the registry, evicting /done'd entries past the retention window
   * (backfilling `doneAt` for legacy entries so they start the clock instead
   * of being evicted immediately).
   */
  async save(): Promise<void> {
    if (this.file === '') return
    const now = Date.now()
    for (const [id, meta] of this.chats) {
      if (meta.active === true) continue
      if (meta.doneAt === undefined || meta.doneAt === '') {
        meta.doneAt = new Date(now).toISOString()
        continue
      }
      if (now - Date.parse(meta.doneAt) > spawnedChatRetention) {
        this.chats.delete(id)
      }
    }
    const data = new TextEncoder().encode(JSON.stringify({ chats: Object.fromEntries(this.chats) }))
    try {
      await atomicWriteFile(this.file, data, 0o644)
    } catch (err) {
      console.warn(`feishu: save spawned chats failed: ${String(err)}`)
    }
  }

  /** Mark a spawned chat done (inactive) and persist. */
  async markDone(chatID: string): Promise<void> {
    const meta = this.chats.get(chatID)
    if (meta === undefined) return
    meta.active = false
    meta.doneAt = new Date().toISOString()
    await this.save()
  }

  /** Mark a spawned chat active again (inverse of /done) and persist. */
  async markActive(chatID: string): Promise<void> {
    const meta = this.chats.get(chatID)
    if (meta === undefined) return
    meta.active = true
    delete meta.doneAt
    await this.save()
  }
}
