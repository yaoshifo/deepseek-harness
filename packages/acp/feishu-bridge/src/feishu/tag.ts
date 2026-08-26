/**
 * Feishu im/v2 enterprise-tag management, ported from cc-connect
 * platform/feishu/feishu_tag.go: tag-id caching with create/discover/sibling
 * fallbacks, the active (heart) tag claim protocol, and the verify-after-bind
 * self-healing for dangling tag ids (Feishu accepts a bind with a dead id,
 * returns code=0, and creates nothing — a successful API call is not proof).
 * Ids that fail verification are blacklisted in-process so resolution stops
 * returning them.
 *
 * @module dsh-feishu-bridge/feishu-tag
 */

import { readFileSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readdir } from 'node:fs/promises'
import { atomicWriteFile } from '../atomicwrite.js'

/** Default active-tag name applied to spawned groups (Go core.ActiveTagName). */
export const activeTagName = '❤️'

/**
 * Per-bot active-tag name candidates tried in order: Feishu tenant-tag names
 * are unique per tenant but bound per-app, so each bot claims the first heart
 * it can create.
 */
export const activeTagCandidates = [
  activeTagName, '🧡', '💛', '💚', '💙', '💜', '🖤', '💗', '💖', '💝', '♥️',
]

/** Feishu's tenant-tag name length limit, measured in code points. */
const maxTagNameRunes = 16

/**
 * Produce a Feishu-acceptable tag name from a directory basename: keep
 * letters, digits, hyphen, underscore, and emoji/symbol code points; strip
 * everything else; truncate to the rune limit without splitting a character.
 * @param name - Raw name.
 * @returns Sanitized tag name.
 */
export function sanitizeTagName(name: string): string {
  let out = ''
  for (const r of name) {
    const cp = r.codePointAt(0) ?? 0
    if ((/\p{L}|\p{N}/u).test(r) || r === '-' || r === '_' || cp >= 0x1f000) {
      out += r
    }
  }
  const cps = Array.from(out)
  if (cps.length > maxTagNameRunes) {
    return cps.slice(0, maxTagNameRunes).join('')
  }
  return out
}

/**
 * Split a directory basename into letter/digit words on any non-alphanumeric
 * code point (hyphen, underscore, punctuation, whitespace, emoji). Case is
 * preserved: "FX" in FX_Backtest counts as one token.
 * @param name - Raw name.
 * @returns The words, possibly empty.
 */
export function splitTagWords(name: string): string[] {
  return name.split(/[^\p{L}\p{N}]+/u).filter(w => w !== '')
}

/**
 * Scan the workspace's subdirectories and return each word's document
 * frequency across project names (how many distinct projects contain it). A
 * missing/unreadable workspace yields an empty table; files are ignored.
 * @param workspace - Workspace root directory.
 * @returns Word → project count.
 */
export async function buildDirWordFreq(workspace: string): Promise<Record<string, number>> {
  const freq: Record<string, number> = {}
  let entries
  try {
    entries = await readdir(workspace, { withFileTypes: true })
  } catch {
    return freq
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const seen = new Set<string>()
    for (const w of splitTagWords(e.name)) {
      if (seen.has(w)) continue
      seen.add(w)
      freq[w] = (freq[w] ?? 0) + 1
    }
  }
  return freq
}

/**
 * Choose a Feishu tag name for a directory basename: the word with the lowest
 * document frequency (the rarest word is the most identifying). Ties —
 * including the all-zero degraded case — break to the last word, usually the
 * most specific. The chosen word goes through {@link sanitizeTagName}.
 * @param name - Directory basename.
 * @param freq - Document frequency table from {@link buildDirWordFreq}.
 * @returns Tag name; empty when no alphanumeric word exists.
 */
export function pickDirTagName(name: string, freq: Record<string, number>): string {
  const words = splitTagWords(name)
  if (words.length === 0) return ''
  let best = ''
  let bestDF = -1
  for (const w of words) {
    const df = freq[w] ?? 0
    if (best === '' || df <= bestDF) {
      best = w
      bestDF = df
    }
  }
  return sanitizeTagName(best)
}

/** Result of creating a tag: the id, or the duplicate id when the name is taken. */
export interface CreateTagResult {
  code?: number | undefined
  msg?: string | undefined
  id?: string | undefined
  duplicateId?: string | undefined
}

/** Wire reply carrying a Feishu business code. */
export interface FeishuCodeReply {
  code?: number | undefined
  msg?: string | undefined
}

/** One tag bound to a chat, as read back from the relation API. */
export interface TagRelationTag {
  id?: string | undefined
  name?: string | undefined
}

/** The four im/v2 tag wire calls the manager needs (thin node-sdk slices). */
export interface TagApi {
  /** Create a tenant tag; duplicateId carries the taken name's id. */
  createTag(name: string): Promise<CreateTagResult>
  /** Read the tags currently bound to a chat. */
  getTagRelation(chatId: string): Promise<FeishuCodeReply & { tags: TagRelationTag[] }>
  /** Bind tags to a chat. */
  createTagRelation(chatId: string, tagIds: string[]): Promise<FeishuCodeReply>
  /** Unbind tags from a chat. */
  updateTagRelation(chatId: string, tagIds: string[]): Promise<FeishuCodeReply>
}

/** Construction options for {@link TagManager}. */
export interface TagManagerOptions {
  api: TagApi
  /** Persistence path for the tag-id cache; empty disables persistence. */
  tagCacheFile?: string
  /**
   * Older cache paths merged into {@link tagCacheFile} at load (entries the
   * primary file already has win); the merged result persists under the
   * primary path. Migration from shapes beyond these paths is not attempted.
   */
  legacyTagCacheFiles?: string[]
  /**
   * Project-default tag name derived from the work dir. The platform may
   * derive it asynchronously and assign {@link TagManager.dirTagName} after
   * construction (mirroring the Go source's post-construction assignment).
   */
  dirTagName?: string
  /** Ordered heart candidates overriding the default list. */
  activeTagCandidates?: string[]
  /** Project name for the "❤️+name" exhaustion fallback. */
  projectName?: string
  /** Explicit active-tag override skipping heart-candidate fallthrough. */
  activeTagOverride?: string
  /** Registered spawned-chat ids for tag discovery scans. */
  spawnedChatIDs?: () => string[]
}

/**
 * Tag-id cache plus the attach/verify/remove protocols. One instance per
 * platform; all API verbs are injected so unit tests feed recording fakes.
 */
export class TagManager {
  private readonly o: TagManagerOptions
  private readonly tagIDCache = new Map<string, string>()
  private activeTagNameField: string

  /**
   * Tag names → ids whose bind did not verify in this process: dangling ids,
   * or ids of tags owned by another app (a bind then returns code=0 while
   * creating nothing). In-memory only — a restart retries a persisted foreign
   * id once, then re-blacklists it.
   */
  private readonly unbindableTagIDs = new Map<string, Set<string>>()

  /** Project-default tag name; mutable for post-construction derivation. */
  dirTagName: string

  constructor(options: TagManagerOptions) {
    this.o = options
    this.dirTagName = options.dirTagName ?? ''
    this.activeTagNameField = options.activeTagOverride?.trim() ?? ''
  }

  /**
   * Load the persisted tag-id cache, merging legacy cache files underneath it
   * (primary entries win). Missing files are a clean start.
   */
  async load(): Promise<void> {
    const file = this.o.tagCacheFile ?? ''
    if (file === '') return
    const entries = await this.readCacheMap(file)
    let migrated = false
    for (const legacy of this.o.legacyTagCacheFiles ?? []) {
      if (legacy === file) continue
      for (const [k, v] of await this.readCacheMap(legacy)) {
        if (entries.has(k)) continue
        entries.set(k, v)
        migrated = true
      }
    }
    for (const [k, v] of entries) {
      this.tagIDCache.set(k, v)
    }
    if (migrated) await this.save()
  }

  /** Read one cache file into a fresh map; missing or corrupt files read empty. */
  private async readCacheMap(file: string): Promise<Map<string, string>> {
    const m = new Map<string, string>()
    let data: string
    try {
      data = await readFile(file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`feishu: read tag cache failed: ${String(err)}`)
      }
      return m
    }
    try {
      for (const [k, v] of Object.entries(JSON.parse(data) as Record<string, string>)) {
        m.set(k, v)
      }
    } catch (err) {
      console.warn(`feishu: parse tag cache failed: ${String(err)}`)
    }
    return m
  }

  /**
   * Record a tag id whose bind did not verify, so {@link ensureTagCached}
   * stops resolving the name to it.
   * @param tagName - Tag name the id was resolved for.
   * @param id - The id that failed bind verification.
   */
  markTagUnbindable(tagName: string, id: string): void {
    if (id === '') return
    const set = this.unbindableTagIDs.get(tagName) ?? new Set<string>()
    set.add(id)
    this.unbindableTagIDs.set(tagName, set)
  }

  private tagUnbindable(tagName: string, id: string): boolean {
    return this.unbindableTagIDs.get(tagName)?.has(id) === true
  }

  /**
   * Seed the in-memory cache (tests, load-time recovery).
   * @param tagName - Tag name.
   * @param id - Tag id to cache for the name.
   */
  seedTagCache(tagName: string, id: string): void {
    this.tagIDCache.set(tagName, id)
  }

  /**
   * The cached id for a tag name, if any.
   * @param tagName - Tag name.
   * @returns The cached id, or undefined when not cached.
   */
  cachedTagID(tagName: string): string | undefined {
    return this.tagIDCache.get(tagName)
  }

  /** Persist the tag-id cache. */
  private async save(): Promise<void> {
    const file = this.o.tagCacheFile ?? ''
    if (file === '' || this.tagIDCache.size === 0) return
    try {
      await atomicWriteFile(file, new TextEncoder().encode(JSON.stringify(Object.fromEntries(this.tagIDCache))), 0o644)
    } catch (err) {
      console.warn(`feishu: save tag cache failed: ${String(err)}`)
    }
  }

  /**
   * Create an im/v2 enterprise tag, returning the existing id when the name is
   * already taken (DuplicateId makes the call idempotent).
   * @param tagName - Tag name.
   * @returns The tag id.
   */
  private async ensureTag(tagName: string): Promise<string> {
    const resp = await this.o.api.createTag(tagName)
    if (resp.id !== undefined && resp.id !== '') return resp.id
    if (resp.duplicateId !== undefined && resp.duplicateId !== '') return resp.duplicateId
    throw new Error(`feishu: ensure tag "${tagName}": no id (code=${resp.code ?? 0} msg=${resp.msg ?? ''})`)
  }

  /**
   * Last-resort tag discovery: scan the spawned chats' tag relations for a tag
   * whose sanitized name matches. The only way to find an existing tag's id by
   * name — im/v2 has no Tag.List/Get.
   * @param tagName - Tag name to find.
   * @returns The tag id, or empty.
   */
  private async discoverTagFromSpawnedChats(tagName: string): Promise<string> {
    if (tagName === '') return ''
    const chatIDs = this.o.spawnedChatIDs?.() ?? []
    if (chatIDs.length === 0) return ''
    const target = sanitizeTagName(tagName)
    for (const chatID of chatIDs) {
      try {
        const resp = await this.o.api.getTagRelation(chatID)
        if (resp.code !== undefined && resp.code !== 0) continue
        for (const t of resp.tags) {
          if (t.id === undefined || t.id === '' || t.name === undefined) continue
          if (sanitizeTagName(t.name) === target) return t.id
        }
      } catch (err) {
        console.warn(`feishu: discover tag query failed (chat_id ${chatID}, tag ${tagName}): ${String(err)}`)
      }
    }
    return ''
  }

  /**
   * Resolve a tag id by name, creating the tag when missing. On create
   * failure, fall back to discovering the id from this bot's chats or a
   * sibling bot's cache file. Ids known to have failed bind verification are
   * skipped in every source; when nothing usable remains the original failure
   * (or an only-unbindable-ids error) propagates. Results are cached.
   * @param tagName - Tag name.
   * @returns The tag id.
   */
  private async ensureTagCached(tagName: string): Promise<string> {
    const cached = this.tagIDCache.get(tagName)
    if (cached !== undefined && cached !== '' && !this.tagUnbindable(tagName, cached)) return cached

    let id = ''
    let createErr: Error | undefined
    try {
      id = await this.ensureTag(tagName)
    } catch (err) {
      createErr = err instanceof Error ? err : new Error(String(err))
    }
    if (id === '' || this.tagUnbindable(tagName, id)) {
      const discovered = await this.discoverTagFromSpawnedChats(tagName)
      if (discovered !== '' && !this.tagUnbindable(tagName, discovered)) {
        id = discovered
      } else {
        const sibling = this.lookupSiblingTagCaches(tagName)
        if (sibling !== '' && !this.tagUnbindable(tagName, sibling)) {
          id = sibling
        } else if (createErr !== undefined) {
          throw createErr
        } else if (id === '') {
          throw new Error(`feishu: tag "${tagName}" not found via create, discover or sibling caches`)
        } else {
          throw new Error(`feishu: tag "${tagName}" resolves only to ids that failed bind verification`)
        }
      }
    }
    this.tagIDCache.set(tagName, id)
    await this.save()
    return id
  }

  /** Remove a tag from the caches so a stale id cannot be reused or borrowed. */
  private async evictTagCacheEntry(tagName: string): Promise<void> {
    this.tagIDCache.delete(tagName)
    await this.save()
  }

  /**
   * Attach the active (heart) tag to a chat and verify it actually landed:
   * try candidate ids in priority order (cached → freshly created →
   * discovered from own chats) and keep the first that verifies, evicting a
   * stale cached id.
   * @param chatID - Chat to tag.
   */
  async resolveAndAttachActiveTag(chatID: string): Promise<void> {
    const name = await this.resolveActiveTagName()
    if (name === '') {
      console.warn(`feishu: no active tag name resolved, leaving spawned chat untagged (chat_id ${chatID})`)
      return
    }
    const tried = new Set<string>()
    const tryID = async (id: string): Promise<boolean> => {
      if (id === '' || tried.has(id)) return false
      tried.add(id)
      await this.tagChat(chatID, [id])
      if (await this.chatHasActiveTag(chatID)) {
        this.tagIDCache.set(name, id)
        await this.save()
        return true
      }
      this.markTagUnbindable(name, id)
      console.info(`feishu: active tag id did not stick, trying next candidate (id ${id}, chat_id ${chatID})`)
      return false
    }

    // 1. Cached id — fast path, correct in steady state.
    const cached = this.tagIDCache.get(name) ?? ''
    if (await tryID(cached)) return
    if (cached !== '') await this.evictTagCacheEntry(name)
    // 2. Create — our own name returns our private, attachable id.
    try {
      const id = await this.ensureTag(name)
      if (await tryID(id)) return
    } catch {
      // fall through to discovery
    }
    // 3. Discover from this bot's own spawned chats — only live ids appear.
    if (await tryID(await this.discoverTagFromSpawnedChats(name))) return
    console.warn(`feishu: could not attach active tag to spawned chat (chat_id ${chatID}, tag ${name})`)
  }

  /**
   * Resolve this bot's active-tag name via create-fallthrough: claim the first
   * creatable heart candidate; a name taken by another app fails creation and
   * is skipped. A cached candidate is adopted without any API call. Runs at
   * most once per process.
   * @returns The claimed tag name, or '' when no candidate could be claimed.
   */
  async resolveActiveTagName(): Promise<string> {
    if (this.activeTagNameField !== '') return this.activeTagNameField
    const adopted = this.adoptActiveTagFromCache()
    if (adopted !== '') return adopted

    for (const name of this.activeTagCandidateList()) {
      try {
        const id = await this.ensureTag(name)
        if (id === '') continue
        this.activeTagNameField = name
        this.tagIDCache.set(name, id)
        await this.save()
        console.info(`feishu: claimed active tag (tag ${name}, tag_id ${id})`)
        return name
      } catch {
        continue
      }
    }
    console.warn('feishu: could not claim any active tag candidate')
    return ''
  }

  /** Heart candidates plus the "❤️+projectName" exhaustion fallback. */
  private activeTagCandidateList(): string[] {
    const candidates = this.o.activeTagCandidates !== undefined && this.o.activeTagCandidates.length > 0
      ? this.o.activeTagCandidates
      : activeTagCandidates
    if (this.o.projectName !== undefined && this.o.projectName !== '') {
      return [...candidates, activeTagName + this.o.projectName]
    }
    return candidates
  }

  /**
   * Recover the claimed heart from the persisted cache without an API call:
   * the first candidate with a cached id was created by this app and is
   * therefore ours. Pure/local, so getters can call it after a restart.
   */
  private adoptActiveTagFromCache(): string {
    if (this.activeTagNameField !== '') return this.activeTagNameField
    for (const name of this.activeTagCandidateList()) {
      const id = this.tagIDCache.get(name)
      if (id !== undefined && id !== '') {
        this.activeTagNameField = name
        console.info(`feishu: adopted active tag from cache (tag ${name}, tag_id ${id})`)
        return name
      }
    }
    return ''
  }

  /**
   * This bot's resolved active-tag name; falls back to the global default so
   * /done removal still targets a plausible heart.
   * @returns The resolved name, or the global default heart name.
   */
  activeTagName(): string {
    if (this.activeTagNameField !== '') return this.activeTagNameField
    const adopted = this.adoptActiveTagFromCache()
    if (adopted !== '') return adopted
    return activeTagName
  }

  /**
   * Scan sibling Feishu tag-cache files in the same data directory for the
   * tag's id: tags are tenant-level, so an id created by one bot in the tenant
   * can be reused by a sibling. Read-only; the result is a candidate, not a
   * guarantee (a cross-tenant id is rejected when applied).
   */
  private lookupSiblingTagCaches(tagName: string): string {
    const file = this.o.tagCacheFile ?? ''
    if (file === '' || tagName === '') return ''
    const dir = dirname(file)
    let matches: string[]
    try {
      matches = readdirSync(dir).filter(n => n.endsWith('_tag_cache.json'))
    } catch {
      return ''
    }
    for (const name of matches) {
      const path = join(dir, name)
      if (path === file) continue
      try {
        const m = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
        const id = m[tagName]
        if (id !== undefined && id !== '') return id
      } catch {
        continue
      }
    }
    return ''
  }

  /**
   * Resolve the project-default dir tag id via {@link ensureTagCached}, or
   * empty on failure (leaves the chat untagged).
   */
  private async getDirTagID(): Promise<string> {
    const tagName = this.dirTagName
    if (tagName === '') return ''
    try {
      return await this.ensureTagCached(tagName)
    } catch (err) {
      console.warn(`feishu: failed to ensure dir tag (tag ${tagName}): ${String(err)}`)
      return ''
    }
  }

  /**
   * Bind tag ids to a chat; failures are logged, not thrown (tagging is
   * best-effort relative to the spawn flow).
   */
  private async tagChat(chatID: string, tagIDs: string[]): Promise<void> {
    if (tagIDs.length === 0) return
    try {
      const resp = await this.o.api.createTagRelation(chatID, tagIDs)
      if (resp.code !== undefined && resp.code !== 0) {
        throw new Error(`feishu: tag chat ${chatID}: code=${resp.code} msg=${resp.msg ?? ''}`)
      }
    } catch (err) {
      console.warn(`feishu: failed to tag spawned chat (chat_id ${chatID}): ${String(err)}`)
    }
  }

  /**
   * Whether the chat currently carries a binding for the exact tag id. A bind
   * with a dead id returns code=0 while creating nothing, so binds are
   * verified by reading the relation back.
   * @param chatID - Chat ID.
   * @param tagID - Tag id to look for.
   * @returns True when the chat carries the tag; false on query failure.
   */
  async chatHasTagID(chatID: string, tagID: string): Promise<boolean> {
    let resp: Awaited<ReturnType<TagApi['getTagRelation']>>
    try {
      resp = await this.o.api.getTagRelation(chatID)
    } catch (err) {
      console.warn(`feishu: check spawn tag failed (chat_id ${chatID}): ${String(err)}`)
      return false
    }
    if (resp.code !== undefined && resp.code !== 0) {
      console.warn(`feishu: spawn tag check query failed; assuming not attached (chat_id ${chatID}, code ${resp.code}, msg ${resp.msg ?? ''})`)
      return false
    }
    return resp.tags.some(t => t.id === tagID)
  }

  /**
   * Whether the chat still carries the active (heart) tag.
   * @param chatID - Chat ID.
   * @returns True when the chat carries the active tag; false on query failure.
   */
  async chatHasActiveTag(chatID: string): Promise<boolean> {
    let resp: Awaited<ReturnType<TagApi['getTagRelation']>>
    try {
      resp = await this.o.api.getTagRelation(chatID)
    } catch (err) {
      console.warn(`feishu: check active tag failed (chat_id ${chatID}): ${String(err)}`)
      return false
    }
    if (resp.code !== undefined && resp.code !== 0) {
      // A GET failure (e.g. missing scope) must not read as a clean
      // "not attached" — surface it, then assume not attached.
      console.warn(`feishu: active tag check query failed; assuming not attached (chat_id ${chatID}, code ${resp.code}, msg ${resp.msg ?? ''})`)
      return false
    }
    return resp.tags.some(t => t.name === this.activeTagName())
  }

  /**
   * Resolve the dir tag for a freshly spawned chat, bind it, and self-heal
   * from an id that does not verify: mark it unbindable, evict the cache
   * entry, and re-resolve once (the unbindable set stops the re-resolve from
   * landing on the same id via create-duplicate or a sibling cache).
   * @param chatID - Spawned chat.
   * @param tagName - Tag name to apply (may differ from the project default
   * for /sp --dir spawns).
   */
  async applySpawnDirTag(chatID: string, tagName: string): Promise<void> {
    if (tagName === '') return
    const resolve = async (): Promise<string> => {
      if (tagName === this.dirTagName) return this.getDirTagID()
      try {
        return await this.ensureTagCached(tagName)
      } catch (err) {
        // Leave the chat untagged rather than fall back to the
        // project-default tag, which would mislabel the chat.
        console.warn(`feishu: failed to ensure spawn tag, leaving untagged (tag ${tagName}): ${String(err)}`)
        return ''
      }
    }

    const id = await resolve()
    if (id === '') return
    await this.tagChat(chatID, [id])
    if (await this.chatHasTagID(chatID, id)) return
    console.warn(`feishu: spawn tag bind did not take effect, evicting cached id and re-resolving (chat_id ${chatID}, tag ${tagName}, tag_id ${id})`)
    this.markTagUnbindable(tagName, id)
    await this.evictTagCacheEntry(tagName)
    const fresh = await resolve()
    if (fresh === '') return
    await this.tagChat(chatID, [fresh])
    if (!await this.chatHasTagID(chatID, fresh)) {
      console.warn(`feishu: spawn tag bind still not effective after retry (chat_id ${chatID}, tag ${tagName}, tag_id ${fresh})`)
      this.markTagUnbindable(tagName, fresh)
      await this.evictTagCacheEntry(tagName)
    }
  }

  /**
   * Remove a tag from a chat (/done): resolve the tag id (creating it if the
   * name is somehow unknown) and unbind it.
   * @param chatID - Chat to untag.
   * @param tagName - Tag name.
   */
  async removeTagFromChat(chatID: string, tagName: string): Promise<void> {
    let tagID: string
    try {
      tagID = await this.ensureTagCached(tagName)
    } catch (err) {
      throw new Error(`feishu: resolve tag "${tagName}" for removal: ${String(err)}`)
    }
    if (tagID === '') {
      throw new Error(`feishu: resolve tag "${tagName}" for removal: no id`)
    }
    console.info(`feishu: removing tag from chat (chat_id ${chatID}, tag ${tagName}, tag_id ${tagID})`)
    const resp = await this.o.api.updateTagRelation(chatID, [tagID])
    if (resp.code !== undefined && resp.code !== 0) {
      throw new Error(`feishu: remove tag from chat ${chatID}: code=${resp.code} msg=${resp.msg ?? ''}`)
    }
  }
}
