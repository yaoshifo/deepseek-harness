/**
 * Persistent registry of open followups suggestion cards, keyed by session.
 * The in-memory askqMetaCache the platform reads on an `fw_multi:` submit is
 * lost on every daemon restart, degrading submissions on pre-restart cards to
 * index-only stale notices; this sidecar restores the send-time question at
 * startup so the selection message keeps its option labels.
 *
 * @module dsh-feishu-bridge/feishu-followups-meta
 */

import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { atomicWriteFile } from '../atomicwrite.ts'
import type { UserQuestion } from '../core/types.ts'

/**
 * The open question of one ask card, captured at send time: form_submit
 * callbacks carry no action.value and button-click callbacks only the
 * clicked option, so the platform caches the question itself (mirroring
 * permBodyCache) and reads it back to freeze the card with
 * buildAskQuestionCardSettled on its answer callback.
 */
export interface AskCardMeta {
  /** The question the card prompts. */
  question: UserQuestion
  /** Zero-based index of the question in its ask. */
  qIdx: number
  /** Total questions of the ask (settled cards keep the progress suffix). */
  total: number
  /** Set on a followups suggestion card: an `fw_multi:` form, not an ask. */
  followups?: true
}

/** One persisted followups registration on disk. */
interface PersistedMeta {
  /** Epoch ms of the card send that wrote this entry. */
  sentAt: number
  /** The card's question meta. */
  meta: AskCardMeta
}

/**
 * How long an unclicked registration lingers before eviction on the next
 * write; a suggestion card older than this window is as good as declined.
 */
export const followupsMetaRetention = 7 * 24 * 3600_000

/**
 * In-memory + on-disk registry of open followups cards. Only `followups`
 * entries belong here: after a restart no engine ask state survives to
 * resolve an askq card, so a followups submit is the only post-restart
 * consumer.
 */
export class FollowupsMetaStore {
  private readonly file: string
  private readonly entries = new Map<string, PersistedMeta>()
  /** Tail of the serialized mutation queue ({@link mutate}). */
  private tail: Promise<void> = Promise.resolve()

  /**
   * @param file - Persistence path; empty disables on-disk persistence.
   */
  constructor(file: string = '') {
    this.file = file
  }

  /**
   * Load the persisted registrations; a missing file is a clean start and a
   * corrupt file reads empty with a trace.
   */
  async load(): Promise<void> {
    if (this.file === '') return
    let data: string
    try {
      data = await readFile(this.file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`feishu: load followups meta failed: ${String(err)}`)
      }
      return
    }
    try {
      const parsed = JSON.parse(data) as { entries?: Record<string, PersistedMeta> }
      for (const [key, entry] of Object.entries(parsed.entries ?? {})) {
        if (entry?.meta === undefined) continue
        this.entries.set(key, entry)
      }
    } catch (err) {
      console.warn(`feishu: parse followups meta failed: ${String(err)}`)
    }
  }

  /**
   * All registrations for startup cache seeding.
   * @returns Copy of the [sessionKey, meta] pairs.
   */
  metas(): Array<[string, AskCardMeta]> {
    return [...this.entries.entries()].map(([key, entry]) => [key, entry.meta])
  }

  /**
   * Register the open followups card of a session, replacing any earlier one.
   * @param sessionKey - Session the card was sent to.
   * @param meta - The card's question meta.
   */
  async set(sessionKey: string, meta: AskCardMeta): Promise<void> {
    await this.mutate(() => {
      this.entries.set(sessionKey, { sentAt: Date.now(), meta })
      return true
    })
  }

  /**
   * Drop a consumed (or overwritten) registration so a restart cannot
   * resurrect it.
   * @param sessionKey - Session whose registration is gone.
   */
  async delete(sessionKey: string): Promise<void> {
    await this.mutate(() => this.entries.delete(sessionKey))
  }

  /**
   * Wait until every mutation queued so far has completed its disk write.
   * Callers fire-and-forget mutations, so anyone observing persisted state
   * (a test reloading the file, a fresh store generation) synchronizes on
   * this drain instead of sleeping.
   */
  settle(): Promise<void> {
    return this.tail
  }

  /**
   * Serialize one mutation with its disk write. Callers fire-and-forget, so
   * two card sends can queue a set and a delete back-to-back; independent
   * atomic renames could then land out of order and persist the retired
   * entry. The tail chain keeps every write's content in submission order.
   * @param apply - In-memory mutation; returning false skips the write.
   */
  private mutate(apply: () => boolean | void): Promise<void> {
    const run = this.tail.then(() => {
      if (apply() === false) return
      return this.write()
    })
    this.tail = run.catch(() => undefined)
    return run
  }

  private async write(): Promise<void> {
    if (this.file === '') return
    const now = Date.now()
    for (const [key, entry] of this.entries) {
      if (now - entry.sentAt > followupsMetaRetention) this.entries.delete(key)
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true })
    } catch (err) {
      console.warn(`feishu: save followups meta failed: ${String(err)}`)
      return
    }
    const data = new TextEncoder().encode(JSON.stringify({ entries: Object.fromEntries(this.entries) }))
    try {
      await atomicWriteFile(this.file, data, 0o644)
    } catch (err) {
      console.warn(`feishu: save followups meta failed: ${String(err)}`)
    }
  }
}
