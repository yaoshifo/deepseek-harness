/**
 * The monitor domain ported from cc-connect core/engine_monitor.go (#53): a
 * monitored chat never runs an agent session — every message is triaged
 * (deterministic rules first, then an LLM side query with /learn few-shot
 * examples) and actionable ones spawn an isolated subgroup in a configured
 * directory. Alert coalescing, capacity caps, the dir-clarification card, the
 * dispatch hub mode, and the polling fallback (webhook-bot cards that never
 * arrive as events) all live here.
 *
 * Pure helpers (store, parsers, chat-list algebra) are exported for unit
 * tests; the engine-coupled lifecycle is {@link MonitorCore}, which owns all
 * monitor state and is reached through `engine.monitor`.
 *
 * @module dsh-feishu-bridge/monitor
 */

import { readFileSync } from 'node:fs'
import { normalizeKeyStyleVariants, type JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { atomicWriteFileSync } from '../atomicwrite.ts'
import {
  asChatBrander,
  asChatMemberManager,
  asForkQuerierWithProvider,
  asMessageReactionAdder,
  asMonitorChatConfigurable,
  asMonitorPoller,
  asProviderSwitcher,
  asReactionAdder,
  asReactionManager,
  asSpawnedChatLister,
  type ImageAttachment,
  type Message,
  type MonitorPoller,
  type MonitorPollPage,
  type Platform,
  type UserQuestion,
} from '../core/types.ts'
import { Msg } from '../i18n/index.ts'
import type { CardButton, CardHeader } from '../card.ts'
import type { Engine } from './engine.ts'
import type { Session, SessionManager } from './session.ts'
import { WorktreeMode } from './worktree.ts'
import { chatIDFromSessionKey } from './engine.ts'

/** LLM triage LightweightQuery timeout (Go monitorTriageTimeout). */
export const monitorTriageTimeoutMs = 60_000

/**
 * How long a clarification card stays actionable (Go monitorClarifyTimeout).
 * Checked lazily on the next message; after it the pending state is cleared
 * and the OnIt reaction removed.
 */
export const monitorClarifyTimeoutMs = 5 * 60_000

/** Max dir buttons on a clarification card, excluding the skip sentinel. */
export const monitorClarifyMaxOptions = 10

/** Per-chat dedup window size (bounded FIFO eviction, Go monitorSeenCap). */
export const monitorSeenCap = 500

/** Default monitor-mode (alert triage) prompt (Go defaultMonitorTriagePrompt). */
export const defaultMonitorTriagePrompt = `你是一个工程分诊机器人。判断群里的这条消息是否需要工程介入（报错、故障、任务请求、求助、可疑现象等）。

判定规则：
- 若需要介入且目录明确：把 "dir" 填为该目录的完整路径，"candidates" 留空数组。
- 若需要介入但你不确定去哪个目录（多个目录都可能相关）："dir" 留空字符串，把最可能的 2-4 个候选目录按可能性从高到低填入 "candidates"；同时给出一句简明的任务描述（交给子群 agent 作为首条指令）。
- 若只是闲聊、通知、无需行动：返回 actionable=false。

【人类教过的示例】会以 few-shot 形式列出。若新消息与某条「带目录」的示例相似，直接用该示例的目录填入 "dir"，不要另选；并把示例的处理要求揉进 task。
【人类标记为无需响应的示例】会单独列出。若新消息与其中某条相似（同类闲聊、通知、问候等），返回 actionable=false，不要拉群。

只输出一行 JSON，格式严格为：{"actionable": true/false, "dir": "<目录路径或空>", "task": "<任务描述>", "candidates": ["<目录路径>", ...]}
actionable 为 false 时 dir、task 留空、candidates 留空数组。candidates 中的目录必须来自「目录清单」。不要输出 JSON 之外的任何文字。`

/**
 * Hub-dispatcher triage prompt (#53 mode = "dispatch"): unlike the monitor
 * prompt which conservatively waits for errors/faults, this eagerly routes
 * any actionable request to a project dir by matching the message against
 * the dirs' descriptions (Go defaultDispatchTriagePrompt).
 */
export const defaultDispatchTriagePrompt = `你是一个任务分发中枢。用户在中枢群里发消息，你的职责是判断这条消息该交给哪个项目目录去处理。

从下方的「目录清单」里选最相关的一个目录（根据消息内容与各目录的描述判断归属），并生成一句清晰、可执行的任务描述（交给子群 agent 作为首条指令，把用户的意图完整传达）。
若消息只是寒暄、问候、或完全没有可执行内容：返回 actionable=false。
若消息看起来是个任务，但无法判断属于哪个目录：返回 actionable=false（不要猜测）。

【人类教过的示例】会以 few-shot 形式列出。若新消息与某条「带目录」的示例相似，直接用该示例的目录，不要另选；并把示例的处理要求揉进 task。
【人类标记为无需响应的示例】会单独列出。若新消息与其中某条相似（同类闲聊、通知、问候等），返回 actionable=false，不要拉群。

只输出一行 JSON，格式严格为：{"actionable": true/false, "dir": "<目录路径>", "task": "<任务描述>"}
actionable 为 false 时 dir 与 task 留空。不要输出 JSON 之外的任何文字。`

/** One entry in the directory menu presented to the LLM triage (Go MonitorDirEntry). */
export interface MonitorDirEntry {
  path: string
  description: string
}

/** A resolved monitor rule: compiled regex + dir + task template (Go MonitorRuleEntry). */
export interface MonitorRuleEntry {
  pattern: RegExp
  dir: string
  task: string
  noReport: boolean
}

/** One learned /learn entry: a real message + the handling the human taught. */
export interface MonitorExample {
  id: string
  example: string
  dir: string
  instruction: string
  drop: boolean
  created_at: number
}

interface ExampleFileData {
  examples?: MonitorExample[]
  next_id?: number
}

/**
 * Persists /learn examples to disk (Go MonitorExampleStore). A corrupt file is
 * copied aside (`.corrupt`) before the store starts empty, so the next save
 * cannot silently destroy potentially-recoverable data.
 */
export class MonitorExampleStore {
  private readonly path: string
  private examples: MonitorExample[] = []
  private nextID = 0

  constructor(path: string) {
    this.path = path
    this.load()
  }

  private load(): void {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch {
      return // not created yet — normal first run
    }
    let data: ExampleFileData
    try {
      data = JSON.parse(raw) as ExampleFileData
    } catch {
      // Corrupt: copy the raw bytes aside so the next save() — which starts
      // from this empty in-memory state — can't silently destroy the
      // potentially-recoverable original.
      try {
        atomicWriteFileSync(`${this.path}.corrupt`, new TextEncoder().encode(raw), 0o600)
        console.warn(`monitor: examples file unreadable, starting empty (original copied aside): ${this.path}`)
      } catch (werr) {
        console.error(`monitor: examples file unreadable and could not be preserved (${this.path}): ${String(werr)}`)
      }
      return
    }
    this.examples = data.examples ?? []
    this.nextID = data.next_id ?? this.examples.length
  }

  private save(): void {
    const data: ExampleFileData = { examples: this.examples, next_id: this.nextID }
    try {
      atomicWriteFileSync(this.path, new TextEncoder().encode(`${JSON.stringify(data, null, 2)}\n`), 0o600)
    } catch (error) {
      console.error(`monitor: persist examples failed (${this.path}): ${String(error)}`)
    }
  }

  /**
   * Append a learned example and return its ID.
   * @param example - the quoted message text being taught.
   * @param dir - the configured dir the example routes to; "" when unbound.
   * @param instruction - the handling requirement taught for the example.
   * @param drop - whether the example marks messages needing no response.
   * @param createdAt - creation time, epoch seconds.
   * @returns the stored example's ID.
   */
  add(example: string, dir: string, instruction: string, drop: boolean, createdAt: number): string {
    this.nextID++
    const id = `L${this.nextID}`
    this.examples.push({ id, example, dir, instruction, drop, created_at: createdAt })
    this.save()
    return id
  }

  /**
   * Delete by ID; false when absent.
   * @param id - the ID returned by {@link add}.
   * @returns whether an example was deleted.
   */
  delete(id: string): boolean {
    const idx = this.examples.findIndex(ex => ex.id === id)
    if (idx === -1) return false
    this.examples.splice(idx, 1)
    this.save()
    return true
  }

  /**
   * The most recent n examples (last n by insertion order).
   * @param n - number of examples to return; non-positive yields [].
   * @returns copies of the newest n examples.
   */
  recentN(n: number): MonitorExample[] {
    if (n <= 0 || this.examples.length === 0) return []
    return this.examples.slice(-n).map(ex => ({ ...ex }))
  }

  /**
   * Every stored example in insertion order.
   * @returns copies of all examples.
   */
  all(): MonitorExample[] {
    return this.examples.map(ex => ({ ...ex }))
  }
}

/** The outcome of an LLM triage (Go triageAction). */
export type TriageAction = 'drop' | 'spawn' | 'clarify'

/** The structured LLM triage outcome (Go triageResult). */
export interface TriageResult {
  action: TriageAction
  dir: string
  task: string
  /** Allow-listed candidate dirs; undefined = fall back to all dirs. */
  candidates: string[] | undefined
}

/** One row on the clarification card: button label + the dir spawned on click. */
export interface MonitorClarifyOption {
  label: string
  dir: string
}

/**
 * Pending state when the engine asked the monitor-chat user to pick a dir: it
 * carries the original message context so resolution can spawn a subgroup
 * into the chosen dir. Single slot per monitored chat, in-memory only; a
 * restart mid-clarify loses it (Go monitorClarification).
 */
export interface MonitorClarification {
  origText: string
  origTask: string
  origMessageID: string
  origReactionID: string
  origUserID: string
  images: ImageAttachment[]
  origReplyCtx: unknown
  options: MonitorClarifyOption[]
  askedAt: number
}

/** Whether content is a /monitor command — exact word, not /monitoring (Go IsMonitorCommand). */
export { isMonitorCommand } from '../core/types.ts'
import { isMonitorCommand } from '../core/types.ts'

/**
 * Parse the raw comma-separated monitor chats string into a trimmed, de-duplicated list.
 * @param raw - the raw chats config value.
 * @returns the unique chat IDs in order.
 */
export function splitMonitorChats(raw: string): string[] {
  const trimmed = raw.trim()
  if (trimmed === '') return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const c of trimmed.split(',')) {
    const v = c.trim()
    if (v === '' || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

/**
 * Whether chatID is in the raw chats string.
 * @param raw - the raw chats config value.
 * @param chatID - the chat ID to look for.
 * @returns whether the chat is monitored.
 */
export function containsMonitorChat(raw: string, chatID: string): boolean {
  return splitMonitorChats(raw).includes(chatID)
}

/**
 * The new raw chats string with chatID appended; "" or "*" collapses to chatID. Idempotent.
 * @param raw - the raw chats config value.
 * @param chatID - the chat ID to add.
 * @returns the updated raw chats string.
 */
export function addMonitorChat(raw: string, chatID: string): string {
  const id = chatID.trim()
  if (id === '') return raw
  if (containsMonitorChat(raw, id)) return raw
  if (raw === '' || raw === '*') return id
  return `${raw},${id}`
}

/**
 * The new raw chats string with chatID removed; "" when the list becomes empty.
 * @param raw - the raw chats config value.
 * @param chatID - the chat ID to remove.
 * @returns the updated raw chats string.
 */
export function removeMonitorChat(raw: string, chatID: string): string {
  const id = chatID.trim()
  return splitMonitorChats(raw).filter(c => c !== id).join(',')
}

/**
 * Extract the JSON triage verdict from the LLM output (Go
 * parseTriageResponse). Candidates are parsed tolerantly (non-string
 * elements skipped). Key-style variants normalize to the declared keys
 * instead of silently reading as not-actionable. Returns not-actionable on
 * any parse failure.
 * @param resp - the raw LLM triage output.
 * @returns the parsed verdict; not-actionable on any parse failure.
 */
const TRIAGE_VERDICT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    actionable: { type: 'boolean' },
    dir: { type: 'string' },
    task: { type: 'string' },
    candidates: { type: 'array', items: { type: 'string' } },
  },
}

export function parseTriageResponse(resp: string): { actionable: boolean; dir: string; task: string; candidates: string[] } {
  const start = resp.indexOf('{')
  const end = resp.lastIndexOf('}')
  if (start < 0 || end <= start) return { actionable: false, dir: '', task: '', candidates: [] }
  let out: { actionable?: boolean; dir?: string; task?: string; candidates?: unknown }
  try {
    out = normalizeKeyStyleVariants(TRIAGE_VERDICT_SCHEMA, JSON.parse(resp.slice(start, end + 1))) as typeof out
  } catch {
    return { actionable: false, dir: '', task: '', candidates: [] }
  }
  const candidates: string[] = []
  if (Array.isArray(out.candidates)) {
    for (const raw of out.candidates) {
      if (typeof raw !== 'string') continue
      const s = raw.trim()
      if (s !== '') candidates.push(s)
    }
  } else if (out.candidates !== undefined && out.candidates !== null) {
    // A non-array candidates value fails the whole parse, mirroring Go's
    // json.Unmarshal into []json.RawMessage.
    return { actionable: false, dir: '', task: '', candidates: [] }
  }
  return {
    actionable: out.actionable === true,
    dir: (out.dir ?? '').trim(),
    task: (out.task ?? '').trim(),
    candidates,
  }
}

/**
 * Map a clarification answer (an option label) to the chosen dir (Go matchClarifyAnswer).
 * @param answer - the user's reply text, expected to be an option label.
 * @param options - the card options the answer is matched against.
 * @returns the chosen dir, whether the skip sentinel matched, and whether any option matched.
 */
export function matchClarifyAnswer(answer: string, options: MonitorClarifyOption[]): { dir: string; isSkip: boolean; matched: boolean } {
  const a = answer.trim()
  if (a === '') return { dir: '', isSkip: false, matched: false }
  for (const o of options) {
    if (o.label === a) {
      if (o.dir === '') return { dir: '', isSkip: true, matched: true }
      return { dir: o.dir, isSkip: false, matched: true }
    }
  }
  return { dir: '', isSkip: false, matched: false }
}

const learnDirFlagRe = /--dir\s+(\S+)/i
const learnIgnoreFlagRe = /--ignore\b/i

/** Resolve a --dir value (full path or a description/substring) to a configured dir path (Go matchDir). */
function matchDir(v: string, dirs: MonitorDirEntry[]): string {
  for (const d of dirs) {
    if (d.path === v || d.description === v) return d.path
  }
  for (const d of dirs) {
    if (d.description !== '' && (d.description.includes(v) || v.includes(d.description))) return d.path
  }
  return ''
}

/**
 * Split a /learn instruction into (dir, instruction, drop) (Go parseLearnDir).
 * The dir is pinned via `--dir <path-or-desc>` or by mentioning a configured
 * dir's path/description; `--ignore` marks a no-response example and wins.
 * @param body - the /learn text after the command word.
 * @param dirs - the configured directory menu used to resolve the dir.
 * @returns the resolved dir, the remaining instruction, and the drop flag.
 */
export function parseLearnDir(body: string, dirs: MonitorDirEntry[]): { dir: string; instruction: string; drop: boolean } {
  if (learnIgnoreFlagRe.test(body)) {
    let rest = body.replace(learnIgnoreFlagRe, '')
    rest = rest.replace(learnDirFlagRe, '')
    return { dir: '', instruction: rest.trim(), drop: true }
  }
  let dir = ''
  let instruction = body
  const m = learnDirFlagRe.exec(body)
  if (m !== null) {
    const flagVal = (m[1] ?? '').trim()
    const matched = matchDir(flagVal, dirs)
    if (matched !== '') {
      dir = matched
      instruction = body.replace(learnDirFlagRe, '')
    }
  }
  if (dir === '') {
    for (const d of dirs) {
      if (d.description !== '' && body.includes(d.description)) {
        dir = d.path
        break
      }
      if (d.path !== '' && body.includes(d.path)) {
        dir = d.path
        break
      }
    }
  }
  return { dir, instruction: instruction.trim(), drop: false }
}

/**
 * Pull the quoted message text out of a reply's extraContent (single-quote
 * format "[Quoted message from <sender>]:\n<text>\n\n"); anything else is
 * returned trimmed as-is (Go extractQuotedText).
 * @param extra - the reply's extraContent.
 * @returns the quoted message text, or the trimmed input when it is not a quote.
 */
export function extractQuotedText(extra: string): string {
  const trimmed = extra.trim()
  if (trimmed === '') return ''
  const prefix = '[Quoted message from '
  const idx = trimmed.indexOf(']:\n')
  if (!trimmed.startsWith(prefix) || idx < 0) return trimmed
  return trimmed.slice(idx + ']:\n'.length).trim()
}

/**
 * IDs excluding the skip values, order preserved (Go filterExcept).
 * @param ids - candidate IDs.
 * @param skip - IDs to exclude; empty strings are ignored.
 * @returns ids without the skip values.
 */
export function filterExcept(ids: string[], skip: string[]): string[] {
  const skipSet = new Set(skip.filter(s => s !== ''))
  return ids.filter(id => !skipSet.has(id))
}

/** Whether target is in dirs (Go containsDir). */
function containsDir(dirs: string[], target: string): boolean {
  return dirs.includes(target)
}

/**
 * Truncate to n runes with an ellipsis (Go monitor truncate).
 * @param s - the text to truncate.
 * @param n - maximum rune count.
 * @returns the original text when short enough, else the first n runes plus an ellipsis.
 */
export function truncateMonitor(s: string, n: number): string {
  const runes = Array.from(s)
  if (runes.length <= n) return s
  return `${runes.slice(0, n).join('')}…`
}

/** Final path segment of a directory path. */
function basename(dir: string): string {
  const parts = dir.split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

/**
 * Resolve a human-readable name for a session: its custom Name, else the
 * persisted UserMeta ChatName, else the raw session key (Go
 * sessionDisplayName).
 */
function sessionDisplayName(s: Session | undefined, sessions: SessionManager, sessionKey: string): string {
  if (s !== undefined) {
    const n = s.getName().trim()
    if (n !== '') return n
  }
  const m = sessions.getUserMeta(sessionKey)
  if (m !== undefined && m.chatName.trim() !== '') return m.chatName
  return sessionKey
}

/**
 * Bounded FIFO of message ids for one chat: preserves insertion order so the
 * oldest id is evicted at the cap, keeping the recent dedup window intact
 * across the poll path's inclusive boundary refetch (Go monitorSeenSet).
 */
class MonitorSeenSet {
  private readonly m = new Set<string>()
  private readonly order: string[] = []

  has(id: string): boolean {
    return this.m.has(id)
  }

  add(id: string): void {
    if (this.m.has(id)) return
    this.m.add(id)
    this.order.push(id)
    if (this.order.length > monitorSeenCap) {
      const old = this.order.shift()
      if (old !== undefined) this.m.delete(old)
    }
  }
}

/** A monitor-spawned child paired with its session key for button rendering. */
interface MonitorChild {
  sessionKey: string
  session: Session
}

/** Originating dir + spawn time of a monitor-spawned subgroup (in-memory only). */
interface MonitorChildMeta {
  dir: string
  spawnedAt: number
}

/** Configuration accepted by {@link MonitorCore.setConfig} (Go SetMonitorConfig args). */
export interface MonitorConfigInput {
  enabled: boolean
  chats: string
  contextWindow: number
  spawnNotice: boolean
  maxConcurrent: number
  triageProvider: string
  triagePrompt: string
  dirs: MonitorDirEntry[]
  rules: MonitorRuleEntry[]
  learnEnabled: boolean
  learnMax: number
  reactEmoji: string
  pollIntervalMs: number
  fallbackUser: string
  examples: MonitorExampleStore | undefined
  mode: string
}

/**
 * The monitor domain state machine (Go engine_monitor.go Engine methods).
 * Owns every monitor field so the engine surface stays `engine.monitor.*`;
 * constructed by the Engine and reaching engine capabilities through its
 * back-reference.
 */
export class MonitorCore {
  private readonly e: Engine

  // Runtime-mutable config (Go atomic.Pointer fields; /monitor commands write
  // while triage readers run — plain fields are safe in the single-threaded
  // event loop).
  /** Whether monitor mode is enabled. */
  enabled: boolean = false
  /** Raw monitored-chats config value: comma-separated chat IDs, "" (none), or "*". */
  chats: string = ''
  /** Triage mode: "" / "monitor" (alert triage) or "dispatch" (hub routing). */
  mode: string = ''
  /** Rolling context messages fed to LLM triage; 0 disables the context block. */
  contextWindow: number = 0
  /** Whether a card is posted when a subgroup is spawned. */
  spawnNotice: boolean = true
  /** Max concurrent subgroups per monitored chat; 0 = unlimited. */
  maxConcurrent: number = 0
  /** Provider name for the LLM triage side query; "" = the active provider. */
  triageProvider: string = ''
  /** Base triage prompt; "" = the mode's default prompt. */
  triagePrompt: string = ''
  /** Directory menu offered to LLM triage and clarification cards. */
  dirs: MonitorDirEntry[] = []
  /** Deterministic triage rules tried before the LLM. */
  rules: MonitorRuleEntry[] = []
  /** Whether /learn few-shot teaching is active. */
  learnEnabled: boolean = false
  /** Max learned examples fed into the triage prompt. */
  learnMax: number = 0
  /** Emoji reacted on message pickup; "" = none. */
  reactEmoji: string = ''
  /** Polling fallback interval in ms; 0 = off. */
  pollIntervalMs: number = 0
  /** The /learn example store, when learning is configured. */
  examples: MonitorExampleStore | undefined
  /** Whether same-dir alerts coalesce into the active subgroup. */
  coalesceEnabled: boolean = false
  /** How recent (ms) a subgroup spawn stays coalescible. */
  coalesceWindowMs: number = 0

  /** Injected config persistence (Go monitorSaveChats/monitorSaveMode; undefined = skip persist). */
  saveChats: ((chats: string) => void) | undefined
  /** Mode counterpart of {@link saveChats}. */
  saveMode: ((mode: string) => void) | undefined

  /** Per-chat dedup windows, poll high-water marks, triage context buffers, coalesce metadata. */
  private readonly seen = new Map<string, MonitorSeenSet>()
  /** Poll high-water marks (chatID → newest seen create_time, seconds) and seed completion flags. */
  lastTime: Record<string, number> = {}
  /** Whether the poll high-water mark was seeded for each chat. */
  seeded: Record<string, boolean> = {}
  private buffers: Record<string, string[]> = {}
  /** Originating dir + spawn time of monitor-spawned subgroups (in-memory only). */
  childMeta: Record<string, MonitorChildMeta> = {}
  private pollTimer: ReturnType<typeof setInterval> | undefined
  /** Poll-loop generation: a bump abandons a loop still inside its seeding pass. */
  private pollGen = 0

  constructor(e: Engine) {
    this.e = e
  }

  // ── configuration ────────────────────────────────────────────────────────

  /**
   * Configure monitor mode (#53) and push the chat set to every platform
   * that implements MonitorChatConfigurable (Go SetMonitorConfig). Restarts
   * the poller and, in dispatch mode, brands the configured chats as hubs.
   * @param o - the full monitor configuration to apply.
   */
  setConfig(o: MonitorConfigInput): void {
    this.enabled = o.enabled
    this.chats = o.chats
    this.contextWindow = o.contextWindow
    this.spawnNotice = o.spawnNotice
    this.maxConcurrent = o.maxConcurrent
    this.triageProvider = o.triageProvider
    this.triagePrompt = o.triagePrompt
    this.dirs = o.dirs
    this.rules = o.rules
    this.learnEnabled = o.learnEnabled
    this.learnMax = o.learnMax
    this.reactEmoji = o.reactEmoji
    this.pollIntervalMs = o.pollIntervalMs
    this.examples = o.examples
    this.mode = o.mode
    for (const p of this.e.platforms) {
      const mc = asMonitorChatConfigurable(p)
      if (mc !== undefined) {
        mc.setMonitorChats(o.chats)
        mc.setMonitorFallbackUser(o.fallbackUser)
      } else if (o.enabled) {
        console.warn(`monitor: platform does not support monitor mode (${p.name()})`)
      }
    }
    // chats="*" listens to every chat via the event path, but polling (which
    // captures webhook-bot/other-app cards) needs explicit chat IDs.
    if (o.enabled && o.pollIntervalMs > 0 && o.chats === '*') {
      console.warn('monitor: chats="*" disables polling — webhook-bot/other-app cards won\'t be captured; list chat IDs explicitly to enable polling')
    }
    this.restartMonitorPoller()
    if (o.enabled) {
      console.info(`monitor: configured (chats=${o.chats} dirs=${o.dirs.length} rules=${o.rules.length} context_window=${o.contextWindow} learn=${o.learnEnabled} poll_interval_ms=${o.pollIntervalMs})`)
    }
    // dispatch mode: brand the configured monitor chats as hubs at startup.
    if (o.enabled && o.mode === 'dispatch') {
      for (const cid of splitMonitorChats(o.chats)) {
        if (cid === '' || cid === '*') continue
        for (const p of this.e.platforms) {
          if (asChatBrander(p) === undefined) continue
          const sk = `${p.name()}:${cid}`
          void this.brandChatSync(p, sk)
        }
      }
    }
  }

  /**
   * Configure alert coalescing (#53): same-dir alerts within the window route into the existing active subgroup.
   * @param enabled - whether to coalesce same-dir alerts.
   * @param windowMs - how recent a spawn stays coalescible; 0 = no age limit.
   */
  setCoalesce(enabled: boolean, windowMs: number): void {
    this.coalesceEnabled = enabled
    this.coalesceWindowMs = windowMs
  }

  /**
   * The raw monitored-chats config value.
   * @returns the current chats string.
   */
  chatsVal(): string {
    return this.chats
  }

  /**
   * Overwrite the in-memory chats value.
   * @param c - the new raw chats string.
   */
  setChats(c: string): void {
    this.chats = c
  }

  /**
   * The current triage mode.
   * @returns the mode string, "" before any setConfig.
   */
  modeVal(): string {
    return this.mode
  }

  /**
   * Overwrite the in-memory mode value.
   * @param m - the new mode string.
   */
  setMode(m: string): void {
    this.mode = m
  }

  // ── inbound routing ──────────────────────────────────────────────────────

  /**
   * Route a monitored-chat message: /learn teaching command or triage →
   * spawn (Go handleMonitorMessage). Dedup by message id so the event path
   * and the polling path don't double-process.
   * @param p - the platform that delivered the message.
   * @param msg - the monitored-chat message to route.
   */
  handleMonitorMessage(p: Platform, msg: Message): void {
    // Skip engine-synthesized messages injected via ReceiveMessage (subtask
    // reply/timeout carry userID=""): triaging them risks a bot echoing its
    // own output into a new spawn.
    if (msg.userID === '') return
    const chatID = chatIDFromSessionKey(msg.sessionKey, msg.platform)
    if (msg.messageID !== '') {
      if (this.seenHas(chatID, msg.messageID)) return
      this.seenAdd(chatID, msg.messageID)
    }
    if (msg.content === '') return
    // A /monitor command fetched back from history (boundary replay after a
    // restart, or a poll right after the WS path handled it) must be exempted
    // here too, or triage spawns a subgroup to "run" it.
    if (isMonitorCommand(msg.content)) return
    // A clarification answer resolves before /learn and triage.
    if (this.resolveMonitorClarification(p, msg)) return
    if (this.learnEnabled && msg.content.startsWith('/learn')) {
      void this.handleLearnExample(p, msg)
      return
    }
    this.enqueueTriage(p, msg)
  }

  /** Per-chat triage chains: a poll batch's concurrent triages would all
   * pass the capacity check before the first spawn registers (TOCTOU),
   * systematically bypassing maxConcurrent. */
  private readonly triageChains = new Map<string, Promise<void>>()

  private enqueueTriage(p: Platform, msg: Message): void {
    const chatID = chatIDFromSessionKey(msg.sessionKey, msg.platform)
    const prev = this.triageChains.get(chatID) ?? Promise.resolve()
    const next = prev.then(() => this.triageAndSpawn(p, msg)).catch((error: unknown) => {
      console.error(`monitor: triage failed (chat=${chatID}): ${String(error)}`)
    })
    this.triageChains.set(chatID, next)
    void next
  }

  // ── polling fallback (webhook-bot / other-app cards) ────────────────────

  private monitorPoller(): MonitorPoller | undefined {
    const p = this.e.spawnCapablePlatform()
    if (p === undefined) return undefined
    return asMonitorPoller(p)
  }

  /**
   * The explicit list of monitored chat IDs; "*" (all chats) is not supported for polling.
   * @returns the explicit chat IDs; empty when off or "*".
   */
  monitorChatIDs(): string[] {
    if (this.chats === '' || this.chats === '*') return []
    return splitMonitorChats(this.chats)
  }

  /** Start the polling fallback loop; a no-op when already running. */
  startMonitorPoll(): void {
    if (this.pollTimer !== undefined) return
    const gen = ++this.pollGen
    void this.monitorPollLoop(gen)
  }

  /** Stop the polling loop and invalidate any loop still in its seeding pass. */
  stopMonitorPoll(): void {
    this.pollGen++ // a loop still seeding observes the bump and never arms its timer
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
  }

  private async monitorPollLoop(gen: number): Promise<void> {
    const poller = this.monitorPoller()
    if (poller === undefined) {
      console.warn('monitor: polling enabled but platform does not implement MonitorPoller')
      return
    }
    // Seed the high-water mark to the latest message in each chat so history
    // isn't replayed on startup.
    for (const chatID of this.monitorChatIDs()) {
      await this.monitorSeedChat(poller, chatID)
    }
    if (gen !== this.pollGen) return // stopped while seeding
    this.pollTimer = setInterval(() => { void this.monitorPollOnce(poller) }, this.pollIntervalMs)
    this.pollTimer.unref()
  }

  /**
   * One poll tick over every monitored chat (Go monitorPollOnce).
   * @param poller - the platform's monitor-message lister.
   */
  async monitorPollOnce(poller: MonitorPoller): Promise<void> {
    const p = this.e.spawnCapablePlatform()
    if (p === undefined) return
    for (const chatID of this.monitorChatIDs()) {
      if (!this.seeded[chatID] && !(await this.monitorSeedChat(poller, chatID))) {
        // Never seeded (e.g. list API failing): polling from mark 0 would
        // replay the chat's oldest messages as fresh alerts.
        continue
      }
      const after = this.lastTime[chatID] ?? 0
      let page: MonitorPollPage
      try {
        page = await poller.listMonitorMessages(chatID, after, 20)
      } catch (error) {
        console.debug(`monitor: poll list failed (${chatID}): ${String(error)}`)
        continue
      }
      for (const msg of page.messages) {
        // The list StartTime is inclusive of `after`, so the boundary
        // second's messages come back on every fetch. The seen-set dedups
        // them in steady state but is empty right after a restart — skip by
        // time. Ceiling: a message created in the same second as the seed
        // message but after it is skipped too.
        if (after > 0 && (msg.createTime ?? 0) > 0 && (msg.createTime ?? 0) <= after) continue
        this.handleMonitorMessage(p, msg)
      }
      // Advance past every fetched raw item — including the ones the
      // platform filtered out of `messages` — or an unprocessable page
      // (webhook-card alert storm) pins the watermark and buries later alerts.
      if (page.latestTimeSec > after) this.lastTime[chatID] = page.latestTimeSec
    }
  }

  /**
   * Record the chat's high-water mark from its newest message (Go
   * monitorSeedChat). False when the lookup failed: the chat stays unseeded
   * and polling is skipped. t=0 (empty chat) counts as seeded.
   */
  private async monitorSeedChat(poller: MonitorPoller, chatID: string): Promise<boolean> {
    let t: number
    try {
      t = await poller.latestMessageTime(chatID)
    } catch (error) {
      console.debug(`monitor: seed latest time failed (${chatID}): ${String(error)}`)
      return false
    }
    this.lastTime[chatID] = t
    this.seeded[chatID] = true
    return true
  }

  /**
   * Whether a message ID is in the chat's dedup window.
   * @param chatID - the monitored chat.
   * @param msgID - the message ID.
   * @returns whether the ID was already processed.
   */
  seenHas(chatID: string, msgID: string): boolean {
    return this.seen.get(chatID)?.has(msgID) ?? false
  }

  /**
   * Add a message ID to the chat's dedup window, evicting the oldest at the cap.
   * @param chatID - the monitored chat.
   * @param msgID - the message ID.
   */
  seenAdd(chatID: string, msgID: string): void {
    let s = this.seen.get(chatID)
    if (s === undefined) {
      s = new MonitorSeenSet()
      this.seen.set(chatID, s)
    }
    s.add(msgID)
  }

  // ── triage → spawn ───────────────────────────────────────────────────────

  /**
   * Rules → LLM triage, then spawn a subgroup for actionable messages (Go triageAndSpawn).
   * @param p - the platform that delivered the message.
   * @param msg - the message to triage.
   */
  async triageAndSpawn(p: Platform, msg: Message): Promise<void> {
    const text = msg.content.trim()
    if (text === '') return

    // Rolling context buffer for LLM triage (size = contextWindow, 0=off).
    const chatID = chatIDFromSessionKey(msg.sessionKey, msg.platform)
    if (this.contextWindow > 0) {
      const buf = [...(this.buffers[chatID] ?? []), text]
      this.buffers[chatID] = buf.slice(-this.contextWindow)
    }

    // React immediately so humans see the bot picked up the message — before
    // the (slow) LLM triage + spawn. Removed below if triage drops it.
    const reactionID = await this.monitorReact(p, msg)

    const rule = this.rulePass(text)
    let dir = rule.dir
    let task = rule.task
    const noReport = rule.noReport
    if (dir === '') {
      // No rule matched → LLM triage.
      const res = await this.llmTriage(text, chatID, msg.sessionKey)
      if (res.action === 'drop') {
        if (this.modeVal() === 'dispatch') {
          // Hub mode: couldn't identify the target project → surface a
          // project-picker card. Monitor mode stays silent (alerts only).
          this.askMonitorClarification(p, msg, reactionID, '', undefined)
        } else {
          this.monitorUnreact(p, msg, reactionID)
        }
        console.debug(`monitor: triage dropped message (chat=${chatID} len=${text.length})`)
        return
      }
      if (res.action === 'clarify') {
        this.askMonitorClarification(p, msg, reactionID, res.task, res.candidates)
        return
      }
      dir = res.dir
      task = res.task
    }
    if (task === '') task = text

    // Coalescing (#53): if an active subgroup for the same dir was spawned
    // within the window, forward this alert into it instead of spawning a new
    // one. On any failure, fall through to a fresh spawn so the alert is
    // never silently dropped.
    const childKey = await this.findCoalesceChild(p, msg.sessionKey, dir)
    if (childKey !== '') {
      if (await this.coalesceIntoChild(p, msg, task, childKey, reactionID)) return
    }

    await this.spawnMonitorSubgroup(p, msg, dir, task, noReport, reactionID)
  }

  /**
   * The shared "spawn subgroup + mark sessions + notify" tail (Go
   * spawnMonitorSubgroup). The reaction is removed on capacity/spawn failure;
   * on success a Done reaction marks the original message dispatched.
   * @param p - the platform that will host the subgroup.
   * @param msg - the originating monitored-chat message.
   * @param dir - the directory the subgroup works in.
   * @param task - the task instruction injected as the subgroup's first message.
   * @param noReport - whether the child suppresses its result card.
   * @param reactionID - the pickup reaction to remove or mark Done.
   */
  async spawnMonitorSubgroup(p: Platform, msg: Message, dir: string, task: string, noReport: boolean, reactionID: string): Promise<void> {
    const chatID = chatIDFromSessionKey(msg.sessionKey, msg.platform)
    if (!(await this.monitorHasCapacity(msg.sessionKey))) {
      this.monitorUnreact(p, msg, reactionID)
      console.warn(`monitor: max concurrent subgroups reached, dropping (chat=${chatID} max=${this.maxConcurrent})`)
      await this.sendMonitorCapNotice(p, msg, msg.sessionKey)
      return
    }
    // Dispatch (hub) mode forwards the user's original message verbatim — no
    // template wrapping; monitor mode (alert triage) keeps the template +
    // handling instruction, and no-report fire-and-forget tasks drop the
    // "监控群" wording so the child agent doesn't wonder whether it IS the
    // monitor group.
    const raw = msg.content.trim()
    let injectMsg: string
    if (this.modeVal() === 'dispatch') {
      injectMsg = raw
    } else if (noReport) {
      injectMsg = `请处理以下消息：\n${raw}\n\n要求：\n${task}`
    } else {
      injectMsg = `监控群收到以下消息：\n${raw}\n\n处理要求：\n${task}`
    }
    // worktreeForceOff: investigate in-place in the configured dir (the dir
    // is explicit; a worktree offshoot surprised users).
    let childKey: string
    try {
      ;({ childKey } = await this.e.spawnSubtask(msg.sessionKey, dir, WorktreeMode.ForceOff, false, injectMsg, msg.images, true))
    } catch (error) {
      this.monitorUnreact(p, msg, reactionID)
      console.error(`monitor: spawn failed (chat=${chatID} dir=${dir}): ${String(error)}`)
      await this.e.send(p, msg.replyCtx, this.e.i18n.tf(Msg.MonitorSpawnFailed, String(error)))
      return
    }
    // Record the child's dir + spawn time so later same-dir alerts can
    // coalesce into this group instead of spawning another one (#53).
    this.recordMonitorChild(childKey, dir)
    // Mark the monitored-chat session so replyToParent skips waking an agent,
    // and remember the original message for the later Done reaction.
    const sess = this.e.sessions.getOrCreateActive(msg.sessionKey)
    sess.setMonitorGroup(true)
    sess.setMonitorOriginMessageID(msg.messageID)
    // Mark the original message Done now that dispatch succeeded.
    if (msg.messageID !== '') {
      const mr = asMessageReactionAdder(p)
      if (mr !== undefined) void mr.addReactionToMessage(chatID, msg.messageID, 'Done')
    }
    // Suppress the one-shot auto-report for monitor children: the monitored
    // chat has no coordinator agent to wake, so per-turn auto-report cards
    // are noise. Only an explicit /done --reply posts a result card.
    const child = this.e.sessions.getOrCreateActive(childKey)
    child.setSubtaskAutoReportSuppressed(true)
    // Hub has no agent and never renders; the child is the sole surface that
    // can produce an HTML overview, so exempt it from suppression.
    child.setMonitorChild(true)
    if (noReport) child.setSubtaskNoReport(true)
    if (this.spawnNotice) {
      const childChat = chatIDFromSessionKey(childKey, p.name())
      await this.sendMonitorSpawnNotice(p, msg.replyCtx, childChat, dir, raw)
    }
    // dispatch mode: copy the hub chat's members into the subgroup so every
    // collaborator can observe/participate. Best-effort — a listing failure
    // still copies whatever partial roster came back (Go returns partial+err).
    if (this.modeVal() === 'dispatch') {
      const mgr = asChatMemberManager(p)
      if (mgr !== undefined) {
        let members: string[] = []
        try {
          members = await mgr.listChatMembers(msg.sessionKey)
        } catch (error) {
          members = (error as { partial?: string[] }).partial ?? []
          console.warn(`monitor dispatch: list hub members (chat=${chatID} got=${members.length}): ${String(error)}`)
        }
        members = filterExcept(members, [msg.userID])
        if (members.length > 0) {
          try {
            await mgr.addChatMembers(childKey, members)
          } catch (error) {
            console.warn(`monitor dispatch: copy members to child (chat=${chatID} child=${childKey}): ${String(error)}`)
          }
        }
      }
    }
    console.info(`monitor: spawned subgroup (chat=${chatID} dir=${dir} child=${childKey})`)
  }

  /**
   * (dir, task, noReport) when a configured rule matches the text, else empty (Go rulePass).
   * @param text - the message text to match.
   * @returns the matched rule's dir, rendered task, and noReport flag, or empty values.
   */
  rulePass(text: string): { dir: string; task: string; noReport: boolean } {
    for (const r of this.rules) {
      if (r.pattern.test(text)) {
        return { dir: r.dir, task: this.renderTask(r.task, text), noReport: r.noReport }
      }
    }
    return { dir: '', task: '', noReport: false }
  }

  /**
   * Apply a rule's task template to the message text.
   * @param template - the task template; each "{{message}}" placeholder gets the text.
   * @param text - the message text.
   * @returns the rendered task, or the bare text when the template is blank.
   */
  renderTask(template: string, text: string): string {
    const t = template.trim()
    if (t === '') return text
    return t.replaceAll('{{message}}', text)
  }

  /** Add the monitor react emoji, returning a reaction ID for later removal (Go monitorReact). */
  private async monitorReact(p: Platform, msg: Message): Promise<string> {
    if (this.reactEmoji === '') return ''
    const rm = asReactionManager(p)
    if (rm !== undefined) return rm.addReactionWithID(msg.replyCtx, this.reactEmoji)
    asReactionAdder(p)?.addReaction(msg.replyCtx, this.reactEmoji)
    return ''
  }

  /**
   * Remove a previously added reaction (best-effort, Go monitorUnreact).
   * @param p - the platform the reaction lives on.
   * @param msg - the message the reaction was added to.
   * @param reactionID - the reaction ID returned by the pickup react.
   */
  monitorUnreact(p: Platform, msg: Message, reactionID: string): void {
    this.monitorUnreactByCtx(p, msg.replyCtx, reactionID)
  }

  /** Remove a reaction by an explicit replyCtx (Go monitorUnreactByCtx). */
  private monitorUnreactByCtx(p: Platform, replyCtx: unknown, reactionID: string): void {
    if (reactionID === '') return
    void asReactionManager(p)?.removeReaction(replyCtx, reactionID)
  }

  // ── clarification ────────────────────────────────────────────────────────

  /**
   * Consume a pending clarification when the user's answer arrives (Go
   * resolveMonitorClarification). True when the message was consumed (a
   * button answer or a skip); false lets the caller continue to /learn →
   * triage.
   * @param p - the platform the clarification card lives on.
   * @param msg - the incoming message to match as an answer.
   * @returns whether the message was consumed as a clarification answer.
   */
  resolveMonitorClarification(p: Platform, msg: Message): boolean {
    const sess = this.e.sessions.getOrCreateActive(msg.sessionKey)
    const pc = sess.getPendingMonitorClarification()
    if (pc === undefined) return false
    const chatID = chatIDFromSessionKey(msg.sessionKey, msg.platform)

    // Timed out: clear, unreact, nudge, and let this message flow normally.
    if (Date.now() - pc.askedAt > monitorClarifyTimeoutMs) {
      sess.setPendingMonitorClarification(undefined)
      this.e.sessions.save()
      this.monitorUnreactByCtx(p, pc.origReplyCtx, pc.origReactionID)
      void this.e.send(p, pc.origReplyCtx, this.e.i18n.t(Msg.MonitorClarifyTimeout))
      console.info(`monitor: clarification timed out (chat=${chatID})`)
      return false
    }

    const { dir, isSkip, matched } = matchClarifyAnswer(msg.content, pc.options)
    if (!matched) {
      // Not a button answer (e.g. a new event typed in the group): dismiss
      // the stale clarification and let this message be triaged.
      sess.setPendingMonitorClarification(undefined)
      this.e.sessions.save()
      this.monitorUnreactByCtx(p, pc.origReplyCtx, pc.origReactionID)
      console.info(`monitor: clarification dismissed by unmatched message (chat=${chatID} content=${truncateMonitor(msg.content, 50)})`)
      return false
    }

    // Matched. Clear BEFORE acting so a double-click / second callback sees
    // nil and falls through to triage instead of double-spawning.
    sess.setPendingMonitorClarification(undefined)
    this.e.sessions.save()

    if (isSkip) {
      this.monitorUnreactByCtx(p, pc.origReplyCtx, pc.origReactionID)
      void this.e.send(p, pc.origReplyCtx, this.e.i18n.t(Msg.MonitorClarifyCancelled))
      console.info(`monitor: clarification skipped by user (chat=${chatID})`)
      return true
    }

    // User picked a dir → spawn into it, rehydrating the original message
    // context (the button callback carried only the option label).
    const origMsg: Message = {
      ...msg,
      userID: pc.origUserID,
      content: pc.origText,
      images: pc.images,
      replyCtx: pc.origReplyCtx,
      messageID: pc.origMessageID,
    }
    let task = pc.origTask
    if (task === '') task = pc.origText
    void this.spawnMonitorSubgroup(p, origMsg, dir, task, false, pc.origReactionID)
    console.info(`monitor: clarification resolved, spawned (chat=${chatID} dir=${dir})`)
    return true
  }

  /**
   * Ask the monitor-chat user to pick a dir among candidates (Go askMonitorClarification).
   * @param p - the platform to send the card on.
   * @param msg - the originating message.
   * @param reactionID - the pickup reaction to remove when no option can be offered.
   * @param task - the task to re-inject when a dir is chosen.
   * @param candidates - allow-listed dirs for the buttons; undefined = the full pool.
   */
  askMonitorClarification(p: Platform, msg: Message, reactionID: string, task: string, candidates: string[] | undefined): void {
    const chatID = chatIDFromSessionKey(msg.sessionKey, msg.platform)
    const hadCandidates = (candidates?.length ?? 0) > 0

    // 1. Displayed dir list: LLM candidates first (deduped), then fall back
    //    to the full candidate pool. In dispatch mode the pool is the /dir
    //    result (dir_scan_paths live scan ∪ MRU history); monitor mode uses
    //    the configured dirs.
    const pool = this.monitorClarifyPool()
    const dirs: string[] = []
    const seen = new Set<string>()
    for (const c of candidates ?? []) {
      const v = c.trim()
      if (v === '' || seen.has(v) || !containsDir(pool, v)) continue
      seen.add(v)
      dirs.push(v)
    }
    if (dirs.length === 0) {
      for (const d of pool) {
        if (!seen.has(d)) {
          seen.add(d)
          dirs.push(d)
        }
      }
    }
    if (dirs.length === 0) {
      console.debug(`monitor: clarify has no candidates and no dirs, dropping (chat=${chatID})`)
      this.monitorUnreact(p, msg, reactionID)
      return
    }
    const capped = dirs.slice(0, monitorClarifyMaxOptions)

    // 2. Options: Label = Description (friendly) falling back to Path,
    //    deduped (a colliding label drops back to its path). Append a skip
    //    sentinel so the user can dismiss a false positive.
    const options: MonitorClarifyOption[] = []
    const usedLabel = new Set<string>()
    for (const d of capped) {
      let label = basename(d)
      for (const m of this.dirs) {
        if (m.path === d && m.description !== '') {
          label = m.description
          break
        }
      }
      if (usedLabel.has(label)) label = d // colliding label → fall back to path
      usedLabel.add(label)
      options.push({ label, dir: d })
    }
    options.push({ label: this.e.i18n.t(Msg.MonitorClarifySkip), dir: '' })

    // 3. Stash pending state BEFORE sending the card, so an instant button
    //    callback finds the state.
    const sess = this.e.sessions.getOrCreateActive(msg.sessionKey)
    sess.setPendingMonitorClarification({
      origText: msg.content.trim(),
      origTask: task,
      images: msg.images,
      origMessageID: msg.messageID,
      origReactionID: reactionID,
      origUserID: msg.userID,
      origReplyCtx: msg.replyCtx,
      options,
      askedAt: Date.now(),
    })
    this.e.sessions.save()

    // 4. Send a single-select card (option label becomes the callback content).
    let header = this.e.i18n.t(Msg.MonitorClarifyHeader)
    let question = `${this.e.i18n.t(Msg.MonitorClarifyQuestion)}\n\n> ${truncateMonitor(msg.content.trim(), 200)}`
    if (!hadCandidates) {
      header = this.e.i18n.t(Msg.MonitorClarifyHeaderNone)
      question = `${this.e.i18n.t(Msg.MonitorClarifyQuestionNone)}\n\n> ${truncateMonitor(msg.content.trim(), 200)}`
    }
    const userQ: UserQuestion = {
      header,
      question,
      options: options.map(o => ({
        label: o.label,
        description: o.dir === '' ? this.e.i18n.t(Msg.MonitorClarifySkipDesc) : o.dir,
      })),
      multiSelect: false,
    }
    void this.e.sendAskQuestionPrompt(p, msg.replyCtx, [userQ], new Map(), msg.sessionKey)
    console.info(`monitor: clarification asked (chat=${chatID} candidates=${capped.length})`)
  }

  /**
   * The candidate dir pool for clarification cards (Go monitorClarifyPool):
   * in dispatch mode the /dir result (dir_scan_paths live scan ∪ MRU history)
   * so newly added subdirs appear without reconfiguring monitor.dirs;
   * falling back to the configured dirs. Monitor mode uses the configured
   * dirs only.
   */
  private monitorClarifyPool(): string[] {
    if (this.modeVal() === 'dispatch' && this.e.dirHistory !== undefined) {
      const list = this.e.dirHistory.list(this.e.name)
      if (list.length > 0) return list
    }
    return this.dirs.map(d => d.path)
  }

  // ── LLM triage ───────────────────────────────────────────────────────────

  /**
   * Run a LightweightQuery side session to judge the message (Go llmTriage):
   * drop (noise / infra error / no dir to offer), spawn (actionable + dir
   * known), or clarify (actionable but dir uncertain).
   * @param text - the message text to judge.
   * @param chatID - the monitored chat, for logs and the context buffer.
   * @param sessionKey - the monitored chat's session key; its route override
   * resolves an empty triage_provider.
   * @returns the triage action; drop when triage cannot run or is uncertain.
   */
  async llmTriage(text: string, chatID: string, sessionKey = ''): Promise<TriageResult> {
    const fq = asForkQuerierWithProvider(this.e.agent)
    if (fq === undefined) {
      console.debug(`monitor: agent lacks LightweightQuery, skipping LLM triage (chat=${chatID})`)
      return { action: 'drop', dir: '', task: '', candidates: undefined }
    }
    // Resolve provider: explicit config → the chat's effective route
    // fallback. Without this, an empty triage_provider makes every non-rule
    // message silently dropped.
    let provider = this.triageProvider
    if (provider === '') {
      const ap = asProviderSwitcher(this.e.agent)?.getActiveProvider(sessionKey)
      if (ap !== undefined) provider = ap.name
    }
    if (provider === '') {
      console.warn(`monitor: no triage provider configured and no active provider (chat=${chatID})`)
      return { action: 'drop', dir: '', task: '', candidates: undefined }
    }
    const prompt = this.buildTriagePrompt(text, chatID)
    let resp: string
    try {
      resp = await fq.lightweightQuery(prompt, provider, AbortSignal.timeout(monitorTriageTimeoutMs))
    } catch (error) {
      console.warn(`monitor: triage query failed (chat=${chatID}): ${String(error)}`)
      return { action: 'drop', dir: '', task: '', candidates: undefined }
    }
    const { actionable, dir, task, candidates } = parseTriageResponse(resp)
    if (!actionable) {
      return { action: 'drop', dir: '', task: '', candidates: undefined }
    }
    // dir known → spawn directly.
    if (dir !== '' && this.dirKnown(dir)) {
      return { action: 'spawn', dir, task, candidates: undefined }
    }
    // Actionable but dir uncertain → ask the user, unless there is no dir to
    // offer at all (then drop).
    if (this.dirs.length === 0) {
      console.debug(`monitor: actionable but no monitorDirs to clarify, dropping (chat=${chatID})`)
      return { action: 'drop', dir: '', task: '', candidates: undefined }
    }
    // Filter LLM candidates to the allow-list (dedup, preserve order). An
    // empty list reads as undefined so askMonitorClarification falls back to
    // all dirs (Go's nil slice).
    const filtered: string[] = []
    const seen = new Set<string>()
    for (const c of candidates) {
      const v = c.trim()
      if (v === '' || seen.has(v) || !this.dirKnown(v)) continue
      seen.add(v)
      filtered.push(v)
    }
    return { action: 'clarify', dir: '', task, candidates: filtered.length > 0 ? filtered : undefined }
  }

  private dirKnown(dir: string): boolean {
    return this.dirs.some(d => d.path === dir)
  }

  /**
   * Build the LLM triage prompt: mode base + dir menu + few-shot + context (Go buildTriagePrompt).
   * @param text - the message text to judge.
   * @param chatID - the monitored chat whose context buffer is appended.
   * @returns the assembled prompt.
   */
  buildTriagePrompt(text: string, chatID: string): string {
    let base = this.triagePrompt
    if (base === '') {
      base = this.modeVal() === 'dispatch' ? defaultDispatchTriagePrompt : defaultMonitorTriagePrompt
    }
    const b: string[] = [base]
    b.push('\n\n【目录清单】\n')
    if (this.dirs.length === 0) b.push('（无）\n')
    for (const d of this.dirs) {
      b.push(`- ${d.path}${d.description !== '' ? ` — ${d.description}` : ''}\n`)
    }

    // Learned few-shot examples, split into spawn vs drop so the LLM gets a
    // clear signal for each: drop examples drive actionable=false.
    if (this.learnEnabled && this.examples !== undefined) {
      const exs = this.examples.recentN(this.learnMax)
      const spawn: MonitorExample[] = []
      const dropEx: MonitorExample[] = []
      for (const ex of exs) {
        if (ex.drop) dropEx.push(ex)
        else spawn.push(ex)
      }
      if (spawn.length > 0) {
        b.push('\n【人类教过的示例】\n')
        for (const ex of spawn) {
          b.push(`消息「${ex.example}」 → `)
          b.push(ex.dir !== '' ? `目录: ${ex.dir}；` : '（无目录）；')
          if (ex.instruction !== '') b.push(`处理: ${ex.instruction}`)
          b.push('\n')
        }
      }
      if (dropEx.length > 0) {
        b.push('\n【人类标记为无需响应的示例】\n')
        for (const ex of dropEx) {
          b.push(`消息「${ex.example}」 → 无需响应`)
          if (ex.instruction !== '') b.push(`（${ex.instruction}）`)
          b.push('\n')
        }
      }
    }

    // Optional rolling context (default off).
    if (this.contextWindow > 0) {
      const buf = this.buffers[chatID] ?? []
      if (buf.length > 1) {
        b.push('\n【近期消息（最后一条是待判断的新消息）】\n')
        buf.forEach((m, i) => { b.push(`[${i + 1}] ${m}\n`) })
      } else {
        b.push('\n【待判断的新消息】\n')
        b.push(`${text}\n`)
      }
    } else {
      b.push('\n【待判断的新消息】\n')
      b.push(`${text}\n`)
    }

    b.push('\n只输出 JSON。')
    return b.join('')
  }

  // ── active children / coalescing / capacity ─────────────────────────────

  /** The de-duplicated active (not /done) spawned child sessions of parentKey (Go monitorActiveChildren). */
  private async monitorActiveChildren(p: Platform, parentKey: string): Promise<MonitorChild[]> {
    const lister = asSpawnedChatLister(p)
    if (lister === undefined) return []
    let chats
    try {
      chats = await lister.listActiveSpawnedChats()
    } catch {
      return []
    }
    const active = new Set(chats.map(c => c.chatID))
    const { idToKey } = this.e.sessions.sessionKeyMap()
    const seen = new Set<string>()
    const out: MonitorChild[] = []
    for (const s of this.e.sessions.allSessions()) {
      if (s.getParentSessionKey() !== parentKey) continue
      const ck = idToKey[s.id] ?? ''
      const ccid = chatIDFromSessionKey(ck, p.name())
      if (ccid === '' || seen.has(ccid) || !active.has(ccid)) continue
      seen.add(ccid)
      out.push({ sessionKey: ck, session: s })
    }
    return out
  }

  /**
   * Remember a freshly spawned subgroup's dir + spawn time for coalescing.
   * @param childKey - the spawned subgroup's session key.
   * @param dir - the directory the subgroup was spawned into.
   */
  recordMonitorChild(childKey: string, dir: string): void {
    this.childMeta[childKey] = { dir, spawnedAt: Date.now() }
  }

  /**
   * Pick the newest active child within the window that shares the given dir
   * (Go pickCoalesceChild). Children absent from the meta map (spawned before
   * a restart) are skipped — their age is unknown. Lazily GCs meta entries
   * for children no longer active.
   * @param activeKeys - session keys of currently active subgroups.
   * @param dir - the alert's directory to match.
   * @param now - current epoch ms for the window check.
   * @returns the newest in-window child key, or "" to force a fresh spawn.
   */
  pickCoalesceChild(activeKeys: string[], dir: string, now: number): string {
    const active = new Set(activeKeys)
    this.childMeta = Object.fromEntries(Object.entries(this.childMeta).filter(([k]) => active.has(k)))
    let bestKey = ''
    let bestAt = 0
    for (const k of activeKeys) {
      const meta = this.childMeta[k]
      if (meta === undefined || meta.dir !== dir) continue
      if (this.coalesceWindowMs > 0 && now - meta.spawnedAt > this.coalesceWindowMs) continue
      if (bestKey === '' || meta.spawnedAt > bestAt) {
        bestKey = k
        bestAt = meta.spawnedAt
      }
    }
    return bestKey
  }

  /** The session key of an active subgroup a new alert for dir should coalesce into, or ''. */
  private async findCoalesceChild(p: Platform, parentKey: string, dir: string): Promise<string> {
    if (!this.coalesceEnabled || dir === '') return ''
    const children = await this.monitorActiveChildren(p, parentKey)
    return this.pickCoalesceChild(children.map(c => c.sessionKey), dir, Date.now())
  }

  /**
   * Forward a new alert into an existing active subgroup via SendToSubtask
   * (Go coalesceIntoChild). True on success; false means fall back to fresh
   * spawn.
   */
  private async coalesceIntoChild(p: Platform, msg: Message, task: string, childKey: string, _reactionID: string): Promise<boolean> {
    const chatID = chatIDFromSessionKey(msg.sessionKey, msg.platform)
    // Build the follow-up text the same way spawnMonitorSubgroup builds its
    // first message: dispatch forwards verbatim, monitor wraps with a template.
    const injectMsg = this.modeVal() === 'dispatch'
      ? msg.content.trim()
      : `监控群收到补充告警：\n${msg.content.trim()}\n\n处理要求：\n${task}`
    try {
      await this.e.sendToSubtask(msg.sessionKey, childKey, injectMsg)
    } catch (error) {
      console.warn(`monitor: coalesce send failed, will spawn fresh (chat=${chatID} child=${childKey}): ${String(error)}`)
      return false
    }
    // Mark the original message Done — same semantics as a spawn: dispatched.
    if (msg.messageID !== '') {
      const mr = asMessageReactionAdder(p)
      if (mr !== undefined) void mr.addReactionToMessage(chatID, msg.messageID, 'Done')
    }
    if (this.spawnNotice) {
      const childChat = chatIDFromSessionKey(childKey, p.name())
      await this.sendMonitorCoalesceNotice(p, msg.replyCtx, childChat, msg.content.trim())
    }
    console.info(`monitor: coalesced alert into existing subgroup (chat=${chatID} child=${childKey})`)
    return true
  }

  /** Whether the monitored chat can spawn another subgroup without exceeding maxConcurrent. */
  private async monitorHasCapacity(parentKey: string): Promise<boolean> {
    if (this.maxConcurrent <= 0) return true
    const p = this.e.spawnCapablePlatform()
    if (p === undefined) return true // cannot count → allow
    const children = await this.monitorActiveChildren(p, parentKey)
    return children.length < this.maxConcurrent
  }

  // ── notices ──────────────────────────────────────────────────────────────

  /**
   * Card announcing the new subgroup, with a jump button (Go sendMonitorSpawnNotice).
   * @param p - the platform to send the card on.
   * @param replyCtx - the monitored chat's reply context.
   * @param childChat - the spawned subgroup's chat ID for the jump button.
   * @param dir - the directory the subgroup works in.
   * @param origText - the originating message text quoted in the card.
   */
  async sendMonitorSpawnNotice(p: Platform, replyCtx: unknown, childChat: string, dir: string, origText: string): Promise<void> {
    const dispatch = this.modeVal() === 'dispatch'
    let headerTitle = this.e.i18n.t(Msg.MonitorPullGroupTitle)
    if (dispatch) headerTitle = this.e.i18n.t(Msg.MonitorDispatchTitle)
    const base = basename(dir)
    if (base !== '' && base !== '.') headerTitle += ` ${base}`
    const jumpURL = this.e.chatJumpURL(p, childChat)
    const buttons: CardButton[] = [{ text: this.e.i18n.t(Msg.MonitorJumpBtn), type: 'primary', value: '', url: jumpURL }]
    const body = `> ${truncateMonitor(origText, 200)}`
    const header: CardHeader = { title: headerTitle, color: 'indigo' }
    await this.e.sendAsCardWithButtons(p, replyCtx, body, header, buttons)
  }

  /** Heads-up that the alert was forwarded into an existing subgroup (Go sendMonitorCoalesceNotice). */
  private async sendMonitorCoalesceNotice(p: Platform, replyCtx: unknown, childChat: string, origText: string): Promise<void> {
    const headerTitle = this.e.i18n.t(Msg.MonitorCoalesceTitle)
    const buttons: CardButton[] = [{ text: this.e.i18n.t(Msg.MonitorJumpBtn), type: 'primary', value: '', url: this.e.chatJumpURL(p, childChat) }]
    const body = `> ${truncateMonitor(origText, 200)}`
    const header: CardHeader = { title: headerTitle, color: 'indigo' }
    await this.e.sendAsCardWithButtons(p, replyCtx, body, header, buttons)
  }

  /** Card listing the active subgroups when capacity is reached (Go sendMonitorCapNotice). */
  private async sendMonitorCapNotice(p: Platform, msg: Message, parentKey: string): Promise<void> {
    const children = await this.monitorActiveChildren(p, parentKey)
    const body = this.e.i18n.tf(Msg.MonitorCapBody, children.length, this.maxConcurrent)
    if (children.length === 0) {
      await this.e.send(p, msg.replyCtx, `⏳ ${body}`)
      return
    }
    const buttons: CardButton[] = children.map((c) => {
      const ccid = chatIDFromSessionKey(c.sessionKey, p.name())
      const name = sessionDisplayName(c.session, this.e.sessions, c.sessionKey)
      return { text: `🔍 ${truncateMonitor(name, 30)}`, type: 'primary', value: '', url: this.e.chatJumpURL(p, ccid) }
    })
    const header: CardHeader = { title: this.e.i18n.t(Msg.MonitorCapTitle), color: 'yellow' }
    await this.e.sendAsCardWithButtons(p, msg.replyCtx, body, header, buttons)
  }

  // ── /learn ────────────────────────────────────────────────────────────────

  /** Process `/learn` in a monitored chat: store a few-shot example, or list/delete (Go handleLearnExample). */
  private async handleLearnExample(p: Platform, msg: Message): Promise<void> {
    if (this.examples === undefined) {
      await this.e.send(p, msg.replyCtx, this.e.i18n.t(Msg.MonitorLearnUnavailable))
      return
    }
    const body = msg.content.replace('/learn', '').trim()
    if (body === '' || body === 'list') {
      await this.sendLearnList(p, msg)
      return
    }
    if (body.startsWith('del ') || body.startsWith('delete ')) {
      const id = body.replace(/^del /, '').replace(/^delete /, '').trim()
      if (this.examples.delete(id)) {
        await this.e.send(p, msg.replyCtx, this.e.i18n.tf(Msg.MonitorLearnDeleted, id))
      } else {
        await this.e.send(p, msg.replyCtx, this.e.i18n.tf(Msg.MonitorLearnNotFound, id))
      }
      return
    }

    // Add: the example is the quoted message; the instruction is body.
    const example = extractQuotedText(msg.extraContent)
    if (example === '') {
      await this.e.send(p, msg.replyCtx, this.e.i18n.t(Msg.MonitorLearnUsage))
      return
    }
    const { dir, instruction, drop } = parseLearnDir(body, this.dirs)
    this.examples.add(example, dir, instruction, drop, Math.floor(Date.now() / 1000))
    if (drop) {
      let ack = this.e.i18n.tf(Msg.MonitorLearnAckDrop, truncateMonitor(example, 200))
      if (instruction !== '') ack += this.e.i18n.tf(Msg.MonitorLearnReason, instruction)
      await this.e.send(p, msg.replyCtx, ack)
      return
    }
    const withDir = dir !== ''
      ? this.e.i18n.tf(Msg.MonitorLearnAckDir, truncateMonitor(example, 200), dir, instruction)
      : this.e.i18n.tf(Msg.MonitorLearnAck, truncateMonitor(example, 200), instruction)
    await this.e.send(p, msg.replyCtx, withDir)
  }

  /** The /learn list card with per-example delete buttons (Go sendLearnList). */
  private async sendLearnList(p: Platform, msg: Message): Promise<void> {
    const examples = this.examples?.all() ?? []
    if (examples.length === 0) {
      const body = this.e.i18n.t(Msg.MonitorLearnListEmpty)
      await this.e.sendAsCardWithButtons(p, msg.replyCtx, body, { title: this.e.i18n.t(Msg.MonitorLearnListTitle), color: 'grey' }, [])
      return
    }
    const lines: string[] = []
    lines.push(this.e.i18n.tf(Msg.MonitorLearnListCount, examples.length))
    for (const ex of examples) {
      if (ex.drop) {
        lines.push(`**[${ex.id}]** 🚫「${truncateMonitor(ex.example, 80)}」\n`)
      } else {
        lines.push(`**[${ex.id}]** 「${truncateMonitor(ex.example, 80)}」\n`)
        if (ex.dir !== '') lines.push(`📂 \`${ex.dir}\`\n`)
      }
      if (ex.instruction !== '') lines.push(`💡 ${truncateMonitor(ex.instruction, 120)}\n`)
      lines.push('\n')
    }
    const buttons: CardButton[] = examples.map(ex => ({
      text: `🗑 ${ex.id}`, type: 'danger', value: `cmd:/learn del ${ex.id}`,
    }))
    const body = lines.join('').replace(/\n+$/, '')
    await this.e.sendAsCardWithButtons(p, msg.replyCtx, body, { title: this.e.i18n.tf(Msg.MonitorLearnListCountTitle, examples.length), color: 'indigo' }, buttons)
  }

  // ── runtime persistence (Go engine_monitor_cmd.go) ──────────────────────

  /** Stop and (if enabled) restart the monitor polling loop. */
  restartMonitorPoller(): void {
    this.stopMonitorPoll()
    if (this.enabled && this.pollIntervalMs > 0) {
      this.startMonitorPoll()
    }
  }

  /**
   * Write the new chats string to config (via the injected save func), then
   * update in-memory state, push to platforms, and restart the poller (Go
   * persistAndApplyMonitorChats). Transactional: on save failure, memory is
   * untouched.
   * @param newChats - the new raw chats string.
   * @returns the save error, or undefined on success.
   */
  persistAndApplyMonitorChats(newChats: string): Error | undefined {
    if (this.saveChats !== undefined) {
      try {
        this.saveChats(newChats)
      } catch (error) {
        return new Error(`save monitor chats: ${String(error)}`)
      }
    }
    this.setChats(newChats)
    for (const p of this.e.platforms) {
      asMonitorChatConfigurable(p)?.setMonitorChats(newChats)
    }
    this.restartMonitorPoller()
    return undefined
  }

  /**
   * Write the new mode string to config, then update in-memory state (Go
   * persistAndApplyMonitorMode). Mode does not affect platform pushes or the
   * poller.
   * @param newMode - the new mode string.
   * @returns the save error, or undefined on success.
   */
  persistAndApplyMonitorMode(newMode: string): Error | undefined {
    if (this.saveMode !== undefined) {
      try {
        this.saveMode(newMode)
      } catch (error) {
        return new Error(`save monitor mode: ${String(error)}`)
      }
    }
    this.setMode(newMode)
    return undefined
  }

  /**
   * Brand one chat as the dispatch hub (name + trending-up-down icon), async fire-and-forget.
   * @param p - the platform that can brand the chat.
   * @param sessionKey - the hub chat's session key.
   */
  brandDispatchChat(p: Platform, sessionKey: string): void {
    if (asChatBrander(p) === undefined) return
    void this.brandChatSync(p, sessionKey)
  }

  private async brandChatSync(p: Platform, sessionKey: string): Promise<void> {
    const brander = asChatBrander(p)
    if (brander === undefined) return
    const name = this.e.i18n.t(Msg.MonitorDispatchGroupName)
    try {
      await brander.brandChat(sessionKey, name, 'trending-up-down')
    } catch (error) {
      console.warn(`monitor: brand dispatch chat failed (${sessionKey}): ${String(error)}`)
    }
  }
}
