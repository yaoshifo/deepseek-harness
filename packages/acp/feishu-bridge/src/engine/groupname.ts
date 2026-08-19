/**
 * Group-name generation helpers ported from cc-connect
 * core/engine_predict.go (icon classification/sampling, name sanitizing,
 * fallback icons, the default prompt), the rename helpers in
 * core/engine_events.go, and chatroomHubGroupName from
 * core/engine_chatroom.go. Pure functions; the Engine methods that drive
 * them live in engine.ts.
 *
 * @module dsh-feishu-bridge/groupname
 */

import { lucideIconIDs } from '../lucide/icon.js'
import type { Session } from './session.js'
import type { HistoryEntry } from '../core/types.js'

/** Cap on generated/manual group names shared by every truncation helper (Go maxGroupNameRunes). */
export const maxGroupNameRunes = 60

/** Icons sampled per category into the prompt's 「可选图标」 menu (Go iconsPerCategory). */
export const iconsPerCategory = 4

/** Capacity of the recent-icon ring buffer for the 避免重复 prompt rule (Go groupIconRecentMax). */
export const groupIconRecentMax = 8

/** Default group-name + icon generation prompt (Go defaultGroupNamePrompt). */
export const defaultGroupNamePrompt = `你是一个群聊名 + 图标生成器。只输出两行：第 1 行群名，第 2 行一个 Lucide 图标名（kebab-case）。两行都要有。

# 规则
- 与用户首条消息同语言。
- 群名 ≤20 字符；简洁可读。
- 抓住用户要做的核心任务或话题。
- 群名纯文本，单行，无引号，无 markdown，无解释。
- 永远不要包含工具名（如 read、bash、edit）。
- 永远不要把群名包在引号或反引号里。
- 保留精确的短技术术语、数字、HTTP 状态码。绝不把完整文件路径写进群名；若必须引用路径，只取末段文件名，目录前缀与长哈希名一律省略。
- 如果消息是问候或含糊（如 "hello"、"hey"），输出一个反映用户意图的短名（如 打招呼、Quick check-in）。
- 第 2 行图标名（kebab-case）：优先从下方「可选图标」里挑最贴合任务语义的一个；清单只覆盖一小部分，若都不贴切可凭记忆写出清单外的 Lucide 图标名（拼写不准时 engine 会自动纠错到最近的有效图标）。尽量为不同任务选不同图标。
- 第 2 行只输出图标名本身，不加引号、不加 icon- 前缀。
- 如果实在没有合适的图标，第 2 行输出 - 。
{{recent_icons_rule}}

# 可选图标
{{icon_pool}}

# 示例
"debug 500 errors in production" →
生产环境500错误排查
bug

"set up CI/CD pipeline" →
CI/CD流水线
git-branch

"analyze user retention" →
用户留存分析
chart-line

"读取 /Users/hm/workspace/chatroom/ledgers/f9568b8f/SYNTHESIS.md 渲染HTML" →
账本HTML渲染
file-code

现在是这个群的多轮对话内容（含用户消息与最后一条助手回复）。请综合整个对话，抓住用户正在进行的核心任务或话题来生成群名，不要复述最后一条消息；若对话内容较杂，提炼一个能概括整体的标题。

现在为这个对话生成群名和图标：
`

/** One substring→category rule (Go iconCategoryRules entries). */
interface IconCategoryRule {
  substr: string
  cat: string
}

/**
 * Lucide icon names classified by substring, first match wins, no match →
 * misc (Go iconCategoryRules). misc never joins the sampled pool.
 */
const iconCategoryRules: IconCategoryRule[] = [
  { substr: 'code', cat: 'dev' }, { substr: 'coding', cat: 'dev' }, { substr: 'terminal', cat: 'dev' }, { substr: 'shell', cat: 'dev' },
  { substr: 'bug', cat: 'dev' }, { substr: 'git-', cat: 'dev' }, { substr: 'branch', cat: 'dev' }, { substr: 'commit', cat: 'dev' },
  { substr: 'merge', cat: 'dev' }, { substr: 'server', cat: 'dev' }, { substr: 'cpu', cat: 'dev' }, { substr: 'database', cat: 'dev' },
  { substr: 'cloud', cat: 'dev' }, { substr: 'api', cat: 'dev' }, { substr: 'bracket', cat: 'dev' }, { substr: 'braces', cat: 'dev' },
  { substr: 'function', cat: 'dev' }, { substr: 'binary', cat: 'dev' }, { substr: 'script', cat: 'dev' },
  { substr: 'chart', cat: 'data' }, { substr: 'graph', cat: 'data' }, { substr: 'bar-', cat: 'data' }, { substr: 'pie', cat: 'data' },
  { substr: 'trend', cat: 'data' }, { substr: 'stats', cat: 'data' }, { substr: 'gauge', cat: 'data' }, { substr: 'report', cat: 'data' },
  { substr: 'analytics', cat: 'data' }, { substr: 'table', cat: 'data' },
  { substr: 'file', cat: 'file' }, { substr: 'folder', cat: 'file' }, { substr: 'directory', cat: 'file' },
  { substr: 'document', cat: 'file' }, { substr: 'paper', cat: 'file' }, { substr: 'notebook', cat: 'file' }, { substr: 'archive', cat: 'file' },
  { substr: 'message', cat: 'comm' }, { substr: 'mail', cat: 'comm' }, { substr: 'chat', cat: 'comm' }, { substr: 'send', cat: 'comm' },
  { substr: 'inbox', cat: 'comm' }, { substr: 'phone', cat: 'comm' }, { substr: 'bell', cat: 'comm' }, { substr: 'megaphone', cat: 'comm' },
  { substr: 'at-sign', cat: 'comm' },
  { substr: 'arrow', cat: 'nav' }, { substr: 'chevron', cat: 'nav' }, { substr: 'corner-', cat: 'nav' }, { substr: 'move', cat: 'nav' },
  { substr: 'navigation', cat: 'nav' }, { substr: 'compass', cat: 'nav' }, { substr: 'route', cat: 'nav' }, { substr: 'map', cat: 'nav' },
  { substr: 'link', cat: 'nav' }, { substr: 'external-link', cat: 'nav' },
  { substr: 'image', cat: 'media' }, { substr: 'video', cat: 'media' }, { substr: 'film', cat: 'media' }, { substr: 'camera', cat: 'media' },
  { substr: 'music', cat: 'media' }, { substr: 'play', cat: 'media' }, { substr: 'pause', cat: 'media' }, { substr: 'volume', cat: 'media' },
  { substr: 'mic', cat: 'media' }, { substr: 'headphones', cat: 'media' },
  { substr: 'user', cat: 'people' }, { substr: 'contact', cat: 'people' }, { substr: 'person', cat: 'people' },
  { substr: 'smile', cat: 'people' }, { substr: 'avatar', cat: 'people' },
  { substr: 'lock', cat: 'security' }, { substr: 'shield', cat: 'security' }, { substr: 'key', cat: 'security' },
  { substr: 'unlock', cat: 'security' }, { substr: 'password', cat: 'security' }, { substr: 'fingerprint', cat: 'security' },
  { substr: 'eye', cat: 'security' },
  { substr: 'settings', cat: 'settings' }, { substr: 'gear', cat: 'settings' }, { substr: 'sliders', cat: 'settings' },
  { substr: 'wrench', cat: 'settings' }, { substr: 'tool', cat: 'settings' }, { substr: 'hammer', cat: 'settings' },
  { substr: 'cog', cat: 'settings' }, { substr: 'toggle', cat: 'settings' }, { substr: 'adjust', cat: 'settings' },
  { substr: 'check', cat: 'status' }, { substr: 'alert', cat: 'status' }, { substr: 'info', cat: 'status' },
  { substr: 'loader', cat: 'status' }, { substr: 'spinner', cat: 'status' }, { substr: 'clock', cat: 'status' },
  { substr: 'timer', cat: 'status' }, { substr: 'hourglass', cat: 'status' },
  { substr: 'layout', cat: 'layout' }, { substr: 'grid', cat: 'layout' }, { substr: 'columns', cat: 'layout' },
  { substr: 'rows', cat: 'layout' }, { substr: 'panel', cat: 'layout' }, { substr: 'sidebar', cat: 'layout' },
  { substr: 'menu', cat: 'layout' }, { substr: 'list', cat: 'layout' }, { substr: 'card', cat: 'layout' },
  { substr: 'dollar', cat: 'finance' }, { substr: 'euro', cat: 'finance' }, { substr: 'pound', cat: 'finance' },
  { substr: 'yen', cat: 'finance' }, { substr: 'bitcoin', cat: 'finance' }, { substr: 'wallet', cat: 'finance' },
  { substr: 'credit', cat: 'finance' }, { substr: 'receipt', cat: 'finance' }, { substr: 'coins', cat: 'finance' },
  { substr: 'payment', cat: 'finance' },
]

/** The category for icons matching no rule (Go iconCategoryMisc). */
export const iconCategoryMisc = 'misc'

/** Classify a single icon name into a category (Go classifyIcon). */
export function classifyIcon(id: string): string {
  for (const r of iconCategoryRules) {
    if (id.includes(r.substr)) return r.cat
  }
  return iconCategoryMisc
}

let iconCategoriesCache: Map<string, string[]> | undefined

/**
 * Lazily built category → icon id list (misc included, but sampling skips
 * it). Scans the Lucide sprite once (Go loadIconCategories).
 */
export function loadIconCategories(): Map<string, string[]> {
  if (iconCategoriesCache === undefined) {
    iconCategoriesCache = new Map()
    for (const id of lucideIconIDs()) {
      const cat = classifyIcon(id)
      const list = iconCategoriesCache.get(cat)
      if (list === undefined) iconCategoriesCache.set(cat, [id])
      else list.push(id)
    }
  }
  return iconCategoriesCache
}

/**
 * Sample n items from ids without replacement (partial Fisher-Yates, input
 * untouched). n<=0 yields []; n>=len yields a full copy (Go sampleSubset).
 */
export function sampleSubset(ids: string[], n: number): string[] {
  if (n <= 0 || ids.length === 0) return []
  if (n >= ids.length) return [...ids]
  const idx = ids.map((_, i) => i)
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (ids.length - i))
    const tmp = idx[i]
    idx[i] = idx[j] as number
    idx[j] = tmp as number
  }
  return idx.slice(0, n).map(i => ids[i] ?? '')
}

/**
 * Sample perCat icons from every category (skipping misc), shuffled together
 * so no category block gets a positional bias (Go sampleAcrossCategories).
 */
export function sampleAcrossCategories(perCat: number): string[] {
  const cats = loadIconCategories()
  const out: string[] = []
  for (const [cat, ids] of cats) {
    if (cat === iconCategoryMisc || ids.length === 0) continue
    out.push(...sampleSubset(ids, perCat))
  }
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = out[i]
    out[i] = out[j] ?? ''
    out[j] = tmp ?? ''
  }
  return out
}

/**
 * Replace whitespace-delimited absolute/home path tokens with their basename
 * so a path echoed by the LLM or the first-message fallback cannot blow the
 * group name up to a 60-rune path dump (Go shortenGroupPathTokens).
 */
export function shortenGroupPathTokens(s: string): string {
  const fields = s.split(/\s+/).filter(f => f !== '')
  let changed = false
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]
    if (f === undefined) continue
    const ab = abbrevPathToken(f)
    if (ab !== f) {
      fields[i] = ab
      changed = true
    }
  }
  if (!changed) return s
  return fields.join(' ')
}

/**
 * Basename of a single absolute/home path token, capped to 16 runes (13 +
 * "..." when longer). Non-path tokens pass through (Go abbrevPathToken).
 */
function abbrevPathToken(tok: string): string {
  if (!tok.startsWith('/') && !tok.startsWith('~/')) return tok
  let t = tok.replace(/^~/, '')
  t = t.replace(/\/+$/, '')
  if (t === '') return tok
  const segs = t.split('/')
  // "/a/b" → ["", "a", "b"] = 3 elements; require ≥2 real segments so
  // "/file" and "/" alone are left alone.
  if (segs.length < 3) return tok
  let base = segs[segs.length - 1] ?? ''
  if (Array.from(base).length > 16) {
    base = `${Array.from(base).slice(0, 13).join('')}...`
  }
  return base
}

/**
 * Turn raw name text (LLM output or a user-supplied name) into a single-line
 * group name within the 60-rune cap, stripping surrounding quotes/backticks.
 * Returns '' when there is no non-empty line (Go sanitizeGroupName).
 */
export function sanitizeGroupName(raw: string): string {
  for (const rawLine of raw.split('\n')) {
    let line = rawLine.trim()
    line = line.replace(/^["`'“”‘’]+|["`'“”‘’]+$/g, '')
    if (line === '') continue
    // Abbreviate path tokens BEFORE truncating so a full absolute path is
    // never preserved just to be cut at 60 runes.
    line = shortenGroupPathTokens(line)
    if (Array.from(line).length > maxGroupNameRunes) {
      line = `${Array.from(line).slice(0, maxGroupNameRunes - 3).join('')}...`
    }
    return line
  }
  return ''
}

/**
 * Take the second non-empty line of the LLM's two-line output as the Lucide
 * icon name: lowercased, quotes stripped; "-" or missing means no icon (Go
 * parseGroupIcon).
 */
export function parseGroupIcon(raw: string): string {
  let nonEmpty = 0
  for (const rawLine of raw.split('\n')) {
    let line = rawLine.trim()
    line = line.replace(/^["`'“”‘’]+|["`'“”‘’]+$/g, '')
    if (line === '') continue
    // Skip the 1st non-empty line (the group name); take the one after it.
    if (nonEmpty === 0) {
      nonEmpty++
      continue
    }
    line = line.toLowerCase()
    if (line === '-') return ''
    return line
  }
  return ''
}

/**
 * Fallback icon pool for when the LLM omits the icon line. All confirmed to
 * exist in the Lucide sprite; picked by group-name hash so the same name
 * always maps to the same icon (Go fallbackIcons).
 */
const fallbackIcons = [
  'hash', 'circle', 'square', 'diamond',
  'hexagon', 'star', 'flag', 'bookmark',
  'compass', 'route', 'layers', 'sparkles',
  'lightbulb', 'feather', 'zap', 'globe',
]

/** FNV-1a 32-bit hash of s as an unsigned 32-bit integer. */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    // 32-bit FNV prime multiplication via imul keeps it exact.
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Deterministic fallback icon for a group name (Go FallbackGroupIcon). Used
 * when the LLM omitted or gave an invalid icon name so the avatar is still
 * set rather than silently skipped.
 */
export function fallbackGroupIcon(name: string): string {
  if (name === '') return fallbackIcons[0] ?? 'hash'
  return fallbackIcons[fnv1a32(name) % fallbackIcons.length] ?? 'hash'
}

/**
 * Trim raw message text into a usable group name: trim, first line, path-token
 * abbreviation, 60-rune cap with "..." (Go truncateGroupName). Used by the
 * first-message rename and the LLM-failure fallback.
 */
export function truncateGroupName(s: string): string {
  s = s.trim()
  const idx = s.indexOf('\n')
  if (idx >= 0) s = s.slice(0, idx)
  s = shortenGroupPathTokens(s)
  if (Array.from(s).length > maxGroupNameRunes) {
    s = `${Array.from(s).slice(0, maxGroupNameRunes - 3).join('')}...`
  }
  return s
}

/**
 * Hub group name derived from the chatroom topic: the topic truncated to the
 * 60-rune ceiling, no prefix (Go chatroomHubGroupName).
 */
export function chatroomHubGroupName(topic: string): string {
  if (Array.from(topic).length > maxGroupNameRunes) {
    return `${Array.from(topic).slice(0, maxGroupNameRunes - 3).join('')}...`
  }
  return topic
}

/**
 * Whether a session's group keeps a fixed name that first-message spawn
 * renaming must not clobber: chatroom role groups, research-assistant
 * groups, and direct-role groups (Go sessionExemptFromSpawnRename).
 */
export function sessionExemptFromSpawnRename(session: Session): boolean {
  return session.getChatroomHubKey() !== ''
    || session.getChatroomDirectRole()
    || session.getResearchAssistant()
}

/** Per-user-message truncation cap for the compact context (Go maxPredictUserMsgLen). */
const maxCompactUserMsgLen = 200

/** Truncation cap for the last assistant message (Go maxPredictAssistantLen). */
const maxCompactAssistantLen = 500

/** Total cap for the compact context (Go maxPredictContextChars). */
const maxCompactContextChars = 3000

/**
 * Collapse a conversation history into a compact text context for one-shot
 * LLM queries (Go buildCompactContext, used by /rename's regeneration): the
 * user messages (each truncated, oldest dropped past the total cap) plus the
 * last assistant reply.
 * @param entries - The session history.
 * @returns The compact context text.
 */
export function buildCompactContext(entries: HistoryEntry[]): string {
  const userMsgs: string[] = []
  let lastAssistant = ''
  for (const entry of entries) {
    if (entry.role === 'user') {
      userMsgs.push(entry.content.length > maxCompactUserMsgLen
        ? `${entry.content.slice(0, maxCompactUserMsgLen)}...`
        : entry.content)
    } else {
      lastAssistant = entry.content
    }
  }
  let sb = ''
  for (const m of userMsgs) {
    sb += `User: ${m}\n`
    if (sb.length >= maxCompactContextChars) {
      // Keep only the last N user messages that fit.
      const kept: string[] = []
      let total = 0
      for (let i = userMsgs.length - 1; i >= 0; i--) {
        const line = `User: ${userMsgs[i]}\n`
        if (total + line.length > maxCompactContextChars) break
        kept.push(line)
        total += line.length
      }
      sb = kept.reverse().join('')
      break
    }
  }
  if (lastAssistant !== '') {
    sb += `\nAssistant: ${lastAssistant.length > maxCompactAssistantLen
      ? `${lastAssistant.slice(0, maxCompactAssistantLen)}...`
      : lastAssistant}\n`
  }
  return sb
}
