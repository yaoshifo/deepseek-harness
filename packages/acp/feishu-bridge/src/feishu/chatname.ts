/**
 * Chat-name resolution with a TTL cache, ported from cc-connect
 * platform/feishu/feishu_user.go (resolveChatName + chatNameEntry). Rename
 * events update the cache directly; the TTL covers missed renames (a stale
 * name refreshes on the next miss), and failed lookups cache the chat ID for
 * longer because "bot not in chat" is a steady state.
 *
 * Go's sync.Map holds either a fresh entry, a legacy plain string (older
 * rename handler), or a fail entry; this Map mirrors all three value shapes.
 *
 * @module dsh-feishu-bridge/feishu-chatname
 */

/** Successful cache entry. */
export interface ChatNameEntry {
  name: string
  at: number
}

/** Failed-lookup cache entry. */
interface ChatFailEntry {
  failAt: number
}

type CacheValue = ChatNameEntry | string | ChatFailEntry

/** Successful-entry TTL (Go chatNameTTL). */
export const chatNameTTL = 10 * 60_000

/** Failed-lookup TTL: bot-not-in-chat is steady state, cache it longer. */
export const chatNameFailTTL = 60 * 60_000

/**
 * Resolve chat IDs to names via one API fetch, TTL-cached. The fetcher is
 * injected so unit tests and the platform client stay decoupled.
 */
export class ChatNameCache {
  private readonly cache = new Map<string, CacheValue>()

  /**
   * Seed/overwrite a raw cache value (rename-event updates and test setup).
   * @param chatID - Chat ID.
   * @param value - Entry (fresh, legacy string, or fail marker).
   */
  put(chatID: string, value: CacheValue): void {
    this.cache.set(chatID, value)
  }

  /** Record a fresh successful name (rename events). */
  setName(chatID: string, name: string): void {
    this.cache.set(chatID, { name, at: Date.now() })
  }

  /** The raw cached value, if any. */
  get(chatID: string): CacheValue | undefined {
    return this.cache.get(chatID)
  }

  /**
   * Resolve a chat's name: fresh cache hit returns immediately; a stale or
   * failed entry re-fetches; a fetch failure returns the chat ID and caches
   * the failure.
   * @param chatID - Chat ID (empty short-circuits to empty).
   * @param fetch - API call returning the chat's name.
   * @returns The display name, or the chat ID on lookup failure.
   */
  async resolve(chatID: string, fetch: (chatID: string) => Promise<{ name?: string | undefined }>): Promise<string> {
    if (chatID === '') return ''
    const cached = this.cache.get(chatID)
    if (typeof cached === 'string') {
      // Legacy plain-string entry: treated as fresh and upgraded on next store.
      return cached
    }
    if (cached !== undefined && 'name' in cached) {
      if (Date.now() - cached.at < chatNameTTL) return cached.name
    } else if (cached !== undefined) {
      if (Date.now() - cached.failAt < chatNameFailTTL) return chatID
      this.cache.delete(chatID)
    }
    try {
      const resp = await fetch(chatID)
      const name = resp.name ?? ''
      if (name === '') {
        this.cache.set(chatID, { failAt: Date.now() })
        return chatID
      }
      this.cache.set(chatID, { name, at: Date.now() })
      return name
    } catch (err) {
      console.warn(`feishu: resolve chat name failed (chat_id ${chatID}): ${String(err)}`)
      this.cache.set(chatID, { failAt: Date.now() })
      return chatID
    }
  }
}
