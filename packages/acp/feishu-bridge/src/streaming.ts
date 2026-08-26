/**
 * Streaming preview ported from cc-connect core/streaming.go: the
 * per-turn preview card state machine (text accumulation, tool-progress
 * ring buffer, 实时播报 section, terminal markers) plus the asyncSender
 * wiring that keeps PATCHes off the event loop.
 *
 * Concurrency mapping (plan D7): sp.mu becomes a promise-queue Mutex;
 * *Locked helpers assume it is held; Go's time.AfterFunc timers become
 * cancellable setTimeout handles whose callbacks acquire the mutex; Go's
 * vestigial timerStop channel (no readers) was dropped.
 *
 * @module dsh-feishu-bridge/streaming
 */

import {
  asFileSender,
  asMessageUpdater,
  asPreviewCleaner,
  asPreviewFinishPreference,
  asPreviewOverflowReporter,
  asPreviewStarter,
  asPreviewTailProber,
  asStoppedCardRenderer,
  asTransientPatchErrorChecker,
  type Platform,
  type ProgressContent,
  type ProgressStatus,
  type TextPreviewContent,
} from './core/types.js'
import type { AsyncSender } from './async-sender.js'
import { MaxPlatformMessageLen, splitMessage, stripTrailingSilent } from './engine/message-split.js'
import type { TodoItem } from './progress.js'

/**
 * Bound on consecutive UpdateMessage failures before the preview degrades
 * permanently; a single hiccup must not kill the card.
 */
export const maxConsecutivePatchFailures = 3

/**
 * Cap on the answer text embedded in the progress card's 实时播报 section;
 * beyond it the card shows a truncated preview and the full answer is
 * delivered out-of-band (Feishu 11310 guard).
 */
export const maxAnalysisDisplayChars = 6000

/** Streaming preview behavior switches (Go StreamPreviewCfg). */
export interface StreamPreviewCfg {
  /** Whether streaming preview cards are sent at all. */
  enabled: boolean
  /** Platforms where streaming preview is disabled. */
  disabledPlatforms?: string[]
  /** Minimum ms between updates. */
  intervalMs: number
  /** Minimum new chars before sending an update. */
  minDeltaChars: number
  /** Max preview length. */
  maxChars: number
  /**
   * Period in ms of the preview tail guard: while the card is active, verify
   * it is still the chat's newest message and reissue it above any message
   * that pushed it off the tail, whatever sent that message. 0 disables.
   */
  tailCheckMs?: number
  /** Enable partial-message streaming for earlier preview. */
  partial?: boolean
}

/**
 * Default preview configuration: enabled on all platforms, 800ms update
 * interval, 15-char minimum delta, 2000-char cap, tail guard every 5s,
 * partial streaming off.
 *
 * @returns A fresh cfg populated with the defaults above.
 */
export function defaultStreamPreviewCfg(): StreamPreviewCfg {
  return { enabled: true, disabledPlatforms: [], intervalMs: 800, minDeltaChars: 15, maxChars: 2000, tailCheckMs: 5000 }
}

/** Promise-queue mutex replacing Go's sync.Mutex. */
class Mutex {
  private chain: Promise<void> = Promise.resolve()

  /** Queue fn under the lock; prior rejections do not block it. */
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const exec = async (): Promise<T> => fn()
    const result = this.chain.then(exec, exec)
    this.chain = result.then(() => {}, () => {})
    return result
  }
}

/** Local-time "HH:MM:SS" (Go time.Format("15:04:05")). */
function hms(date = new Date()): string {
  return date.toTimeString().slice(0, 8)
}

/** Local-time "HH-MM-SS" for file names. */
function hmsFile(date = new Date()): string {
  return date.toTimeString().slice(0, 8).replaceAll(':', '-')
}

const runeCount = (s: string): number => Array.from(s).length

/**
 * One entry in the tool-progress display card. Tool entries (isTool=true)
 * can be updated with a result; non-tool entries (thinking) are immutable
 * once created.
 */
export class ProgressEntry {
  /** Fully rendered text for non-tool entries (thinking). */
  text = ''
  /** Tool entry: "**HH:MM:SS**" header (timestamp only, tag at render time). */
  header = ''
  /** Tool entry: code block content (without backticks). */
  body = ''
  /** Tool entry: code block language ("bash" or ""). */
  lang = ''
  /** tool_use id for matching call to result. */
  toolID = ''
  /** Tool entry: result text (appended with --- separator). */
  result = ''
  /** Tool entry: whether the recorded result succeeded (rendered 🟢 vs 🔴). */
  success = false
  /** Tool entry: whether a result has been recorded. */
  hasResult = false
  /** True for tool call entries (can receive result update). */
  isTool = false
  /** True for thinking entries (rendered as plain text, 5 lines). */
  isThinking = false
  /** True for compaction entries (counted in summary line). */
  isCompact = false
  /** Tool call sequence number within this turn (0 = not assigned). */
  seq = 0
  /** Full tool name when header name was truncated. */
  fullName = ''
  /** Raw tool name for dynamic truncation at render time. */
  toolName = ''
  /** Skill 工具条目：调用的 skill 名；空则走通用 toolTagForProgress。 */
  skillName = ''

  constructor(init: Partial<ProgressEntry> = {}) {
    Object.assign(this, init)
  }

  /**
   * Render this entry as the markdown shown in the progress card.
   *
   * @param isLatest - True for the newest entry (adds the 🚨 marker).
   * @returns The markdown block for this entry.
   */
  render(isLatest: boolean): string {
    if (!this.isTool) return this.text
    // Dynamic name truncation based on seq digit count.
    let maxNameLen = 16
    if (this.seq >= 100) maxNameLen -= String(this.seq).length - 2
    let tag: string
    if (this.skillName !== '') {
      let dn = this.skillName
      if (dn.length > maxNameLen) dn = dn.slice(dn.length - maxNameLen)
      tag = `<text_tag color='blue'>📚 ${dn}</text_tag>`
    } else {
      tag = toolTagForProgress(this.toolName, maxNameLen)
    }
    // Thinking entries: code block with 5-line body, fixed 🟢 status.
    if (this.isThinking) {
      let b = this.header
      b += ' '
      b += tag
      if (this.seq > 0) b += ` · ${this.seq}`
      b += ' 🟢'
      if (isLatest) b += ' 🚨'
      b += '\n```\n'
      const padded = padToFixedLines(this.body, 5)
      const lines = padded.split('\n', 2)
      b += padLineWidth(lines[0] ?? '', minCodeBlockLineWidth) + (lines[1] !== undefined ? `\n${lines[1]}` : '')
      b += '\n```'
      return b
    }
    let b = this.header
    b += ' '
    b += tag
    if (this.seq > 0) b += ` · ${this.seq}`
    if (this.hasResult) {
      b += this.success ? ' 🟢' : ' 🔴'
    } else {
      b += ' 🟡'
    }
    if (isLatest) b += ' 🚨'
    let body = padToFixedLines(this.body, 1)
    let resultText: string
    if (this.hasResult) {
      resultText = padToFixedLines(this.result, 3)
    } else {
      resultText = padToFixedLines('', 3) // placeholder: 3 empty lines
    }
    const lang = this.lang === '' ? 'text' : this.lang
    b += `\n\`\`\`${lang}\n`
    if (this.fullName !== '') body = `${this.fullName} -> ${body}`
    body = padLineWidth(body, minCodeBlockLineWidth)
    b += body
    b += '\n---\n'
    b += resultText
    b += '\n```'
    return b
  }
}

/**
 * Keep the first maxLines lines plus an overflow marker (Go truncateToMaxLines).
 *
 * @param s - Text to truncate.
 * @param maxLines - Maximum number of lines to keep.
 * @returns s unchanged when it fits; otherwise the kept lines plus the overflow marker.
 */
export function truncateToMaxLines(s: string, maxLines: number): string {
  if (s === '' || maxLines <= 0) return s
  const lines = s.split('\n')
  if (lines.length <= maxLines) return s
  const extra = lines.length - maxLines
  return `${lines.slice(0, maxLines).join('\n')}\n... (${extra} more lines)`
}

/**
 * Normalize s to exactly maxLines lines for stable card height.
 *
 * @param s - Text to normalize.
 * @param maxLines - Exact line count to produce.
 * @returns s padded with blank lines or truncated to exactly maxLines lines.
 */
export function padToFixedLines(s: string, maxLines: number): string {
  if (maxLines <= 0) return s
  if (s === '') return ' \n'.repeat(maxLines - 1) + ' '
  const lines = s.split('\n')
  if (lines.length <= maxLines) {
    while (lines.length < maxLines) lines.push(' ')
    return lines.join('\n')
  }
  if (maxLines === 1) return `${lines[0] ?? ''}  ...+${lines.length - 1}`
  const extra = lines.length - maxLines + 1
  return `${lines.slice(0, maxLines - 1).join('\n')}\n... (${extra} more lines)`
}

const minCodeBlockLineWidth = 100

function padLineWidth(s: string, minW: number): string {
  if (minW <= 0 || s.length >= minW) return s
  return s + ' '.repeat(minW - s.length)
}

// Tool families for the tag color. Claude Code names (Read/Write/…) stay for
// ported-test parity; the lowercase entries are the dsh-native tool names.
const editTools = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'MultiEdit', 'NotebookEdit', 'read', 'write', 'edit', 'glob', 'grep', 'lsp', 'session_search', 'session_event_read', 'session_event_search', 'session_event_trace', 'memory_read', 'memory_list', 'memory_index', 'memory_write', 'memory_delete'])
const agentTools = new Set(['Agent', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'EnterPlanMode', 'ExitPlanMode', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents', 'report', 'workflow', 'ralph', 'create_goal', 'get_goal', 'job_list', 'job_output', 'job_kill', 'feishu_bridge_subtask', 'feishu_bridge_chatroom', 'feishu_bridge_relay', 'feishu_bridge_send'])
const webTools = new Set(['WebSearch', 'WebFetch', 'web_search', 'web_fetch', 'lark-cli', 'feishu_bridge_cron'])

/**
 * The colored text_tag label for a tool in the progress card (icon + color
 * by tool family, name tail-truncated to maxLen).
 *
 * @param name - Full tool name; only its tail is kept when truncated.
 * @param maxLen - Maximum displayed name length.
 * @returns The text_tag markdown label.
 */
export function toolTagForProgress(name: string, maxLen: number): string {
  let displayName = name
  if (displayName.length > maxLen) displayName = displayName.slice(displayName.length - maxLen)

  let icon = '⚙️'
  switch (name) {
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'read':
    case 'glob':
    case 'grep':
    case 'lsp':
      icon = '🔍'
      break
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'write':
    case 'edit':
      icon = '📝'
      break
    case 'WebFetch':
    case 'WebSearch':
    case 'web_fetch':
    case 'web_search':
    case 'lark-cli':
      icon = '🌐'
      break
    case 'Agent':
    case 'subagent_fork':
      icon = '🤖'
      break
    case 'ExitPlanMode':
      icon = '📋'
      break
    case 'AskUserQuestion':
    case 'ask_user_question':
      icon = '❓'
      break
    case 'Skill':
    case 'skill':
      icon = '📚'
      break
    case 'TodoWrite':
    case 'todo_write':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
      icon = '📝'
      break
    case 'feishu_bridge_send':
      icon = '📤'
      break
    case 'Thinking':
      icon = '💭'
      break
    default:
      break
  }

  let color = 'blue'
  if (name === 'Bash') {
    color = 'blue'
  } else if (editTools.has(name)) {
    color = 'turquoise'
  } else if (agentTools.has(name)) {
    color = 'purple'
  } else if (webTools.has(name)) {
    color = 'orange'
  }

  return `<text_tag color='${color}'>${icon} ${displayName}</text_tag>`
}

/**
 * Parse a Skill tool call input into (skillName, args); empty for non-skill tools.
 *
 * @param toolName - Name of the invoked tool.
 * @param toolInput - Raw tool input: "skill=..." or JSON with skill/args fields
 * (claudecode/opencode) or a name field (dsh).
 * @returns [skillName, args], or ["", ""] when not a skill call or unparseable.
 */
export function parseSkillToolUse(toolName: string, toolInput: string): [string, string] {
  if (toolName.toLowerCase() !== 'skill') return ['', '']
  if (toolInput.startsWith('skill=')) return [toolInput.slice('skill='.length).trim(), '']
  try {
    const m = JSON.parse(toolInput) as { skill?: unknown; name?: unknown; args?: unknown }
    const skill = typeof m.skill === 'string' ? m.skill : typeof m.name === 'string' ? m.name : ''
    const args = typeof m.args === 'string' ? m.args : ''
    return [skill, args]
  } catch {
    return ['', '']
  }
}

/**
 * Build a tool progress entry: timestamped header, escaped body (bash gets a
 * language tag), Thinking entries flagged, and Skill entries relabeled with
 * the skill name.
 *
 * @param name - Invoked tool name; "Thinking" yields a thinking entry, "Bash" gets a bash language tag.
 * @param summary - Tool input shown as the code block body.
 * @param toolID - tool_use id for matching a later result update.
 * @param now - Timestamp source for the header.
 * @returns The constructed progress entry.
 */
export function newToolProgressEntry(name: string, summary: string, toolID: string, now = new Date()): ProgressEntry {
  const ts = now.toTimeString().slice(0, 8)
  let body = ''
  let lang = ''
  if (summary !== '') {
    body = summary.replaceAll('```', "'''")
    if (name === 'Bash') lang = 'bash'
  }
  const entry = new ProgressEntry({
    header: `**${ts}**`,
    body,
    lang,
    isTool: true,
    isThinking: name === 'Thinking',
    toolID,
    toolName: name,
  })
  entry.fullName = name
  // Skill 工具：标签改用 skill 名、正文改用可读 args；fullName 清空避免
  // "Skill -> " 前缀（标签已展示 skill 名）。
  const [skill, args] = parseSkillToolUse(name, summary)
  if (skill !== '') {
    entry.skillName = skill
    entry.body = args
    entry.fullName = ''
  }
  return entry
}

/**
 * Escape markdown special characters (#, *, ~) in plain text.
 *
 * @param s - Plain text to escape.
 * @returns s with #, *, and ~ backslash-escaped.
 */
export function escapeMarkdownChars(s: string): string {
  return s.replaceAll('#', '\\#').replaceAll('*', '\\*').replaceAll('~', '\\~')
}

/** Max visible progress entries (circular buffer slots). */
export const maxProgressLines = 3

/** Minimum time between progress-card PATCHes. */
export const progressFlushInterval = 300

interface TimerHandle {
  /** Go timer.Stop(): true when the timer had not fired yet (callback will never run). */
  stop(): boolean
}

/**
 * Streaming preview for one interactive turn: accumulates text from
 * EventText events and periodically pushes updates via
 * MessageUpdater.updateMessage.
 */
export class StreamPreview {
  private readonly cfg: StreamPreviewCfg
  private readonly platform: Platform
  private readonly replyCtx: unknown
  private readonly transform: ((s: string) => string) | undefined
  private readonly async: AsyncSender | undefined
  private readonly mu = new Mutex()

  /**
   * Full text accumulated from EventText events.
   * @internal White-box: ported same-package tests read/write this directly.
   */
  fullText = ''
  private lastSentText = ''
  private lastSentAt = 0
  private lastSentViaUpdate = false
  /**
   * Platform message handle of the preview card; undefined until the card exists.
   * @internal White-box: ported same-package tests read/write this directly.
   */
  previewMsgID: unknown
  /**
   * True once the preview stopped sending updates (patch failures, freeze, or terminal state).
   * @internal White-box: ported same-package tests read/write this directly.
   */
  degraded = false
  /**
   * Consecutive UpdateMessage failures; reaching maxConsecutivePatchFailures degrades the preview.
   * @internal White-box: ported same-package tests read/write this directly.
   */
  failedPatchStreak = 0

  private progressMode = false
  /**
   * Visible tool-progress entries (circular buffer of maxProgressLines slots).
   * @internal White-box: ported same-package tests read/write this directly.
   */
  progressEntries: ProgressEntry[] = []
  private progressWriteIdx = 0
  private progressLatestIdx = 0
  private progressTotalCount = 0
  private toolCallSeq = 0
  private failureCount = 0
  private compactCount = 0
  /**
   * Skill names invoked this turn (deduped, insertion-ordered).
   * @internal White-box: ported same-package tests read/write this directly.
   */
  skillNames: string[] = []
  /**
   * Latest EventText chunk shown in the 实时播报 section.
   * @internal White-box: ported same-package tests read/write this directly.
   */
  analysisText = ''
  /**
   * True when the card shows a truncated 实时播报 and the full answer is delivered out-of-band.
   * @internal White-box: ported same-package tests read/write this directly.
   */
  analysisTruncated = false
  private thinkingText = ''
  /**
   * True once the completed terminal card was rendered.
   * @internal White-box: ported same-package tests read/write this directly.
   */
  completed = false
  /**
   * True once the failed terminal card was rendered.
   * @internal White-box: ported same-package tests read/write this directly.
   */
  failed = false
  /**
   * True once a stopped (⏹) terminal card render was initiated. Both the
   * event loop's stop arm and stopInteractiveSession's synchronous finalize
   * race to render it; the loser must not PATCH the card again.
   * @internal White-box: ported same-package tests read/write this directly.
   */
  stoppedCardRendered = false
  private todoItems: TodoItem[] = []
  private bgTaskHint = ''
  private subagentCount = 0
  private pendingSubtasksCount = 0

  /**
   * Pending delayed-flush timer handle, if armed.
   * @internal White-box: ported same-package tests read/write this directly.
   */
  timer: TimerHandle | undefined
  /**
   * Pending tail-guard timer handle, if armed. Separate from {@link timer}
   * (the delayed flush) so flush churn never cancels a pending tail check.
   * @internal White-box: ported same-package tests read/write this directly.
   */
  tailTimer: TimerHandle | undefined
  /**
   * True once finish() ran — its delete paths clear the card without setting
   * a terminal flag, and an in-flight tail check must neither reissue the
   * deleted card nor re-arm. Distinct from {@link completed} (rendered
   * terminal card) on purpose: finish deletes the card without rendering it.
   */
  private finished = false
  /**
   * Timestamp of the last progress-card PATCH (throttle reference).
   * @internal White-box: ported same-package tests read/write this directly.
   */
  lastProgressFlush = 0

  /** Session this preview belongs to (bump routing). */
  readonly sessionKey: string

  constructor(
    cfg: StreamPreviewCfg,
    p: Platform,
    replyCtx: unknown,
    transform: ((s: string) => string) | undefined,
    as: AsyncSender | undefined,
    sessionKey = '',
  ) {
    this.cfg = cfg
    this.platform = p
    this.replyCtx = replyCtx
    this.transform = transform
    this.async = as
    this.sessionKey = sessionKey
    this.previewMsgID = undefined
  }

  /** Run fn under the preview lock. */
  private locked<T>(fn: () => T | Promise<T>): Promise<T> {
    return this.mu.run(fn)
  }

  /**
   * Whether the platform supports message updating and is not disabled.
   * Mirrors Go canPreview (lock only guards memory visibility there).
   *
   * @returns True when the preview card may be sent and updated.
   */
  canPreview(): boolean {
    if (this.degraded || !this.cfg.enabled) return false
    const platformName = this.platform.name()
    for (const disabled of this.cfg.disabledPlatforms ?? []) {
      if (disabled.toLowerCase() === platformName.toLowerCase()) return false
    }
    return asMessageUpdater(this.platform) !== undefined
  }

  /**
   * Send an initial placeholder card before any agent events arrive.
   *
   * @param placeholderText - Text shown on the placeholder card.
   */
  async showPlaceholder(placeholderText: string): Promise<void> {
    await this.locked(async () => {
      if (this.degraded || !this.cfg.enabled || this.previewMsgID !== undefined) return
      this.progressMode = true
      await this.flushLocked({ kind: 'text', text: placeholderText })
      // Reset throttle state so the first real appendText flushes immediately.
      this.lastSentAt = 0
      this.lastSentText = ''
    })
  }

  /**
   * Add new text content and trigger a throttled flush if needed.
   *
   * @param text - New text content to append to the accumulated fullText.
   */
  async appendText(text: string): Promise<void> {
    await this.locked(async () => {
      if (this.degraded || !this.cfg.enabled) return
      this.fullText += text

      let displayText = this.fullText
      const maxChars = this.cfg.maxChars
      if (maxChars > 0 && runeCount(displayText) > maxChars) {
        displayText = `${Array.from(displayText).slice(0, maxChars).join('')}…`
      }

      const delta = runeCount(displayText) - runeCount(this.lastSentText)
      const elapsed = Date.now() - this.lastSentAt
      const interval = this.cfg.intervalMs

      if (delta < this.cfg.minDeltaChars && this.lastSentAt !== 0) {
        this.scheduleFlushLocked(interval)
        return
      }
      if (elapsed < interval && this.lastSentAt !== 0) {
        this.scheduleFlushLocked(interval - elapsed)
        return
      }
      this.cancelTimerLocked()
      await this.flushLocked({ kind: 'text', text: displayText })
    })
  }

  private scheduleFlushLocked(delay: number): void {
    if (this.timer !== undefined) return // already scheduled
    this.timer = this.armTimer(delay, async () => {
      if (this.degraded) return
      let displayText = this.fullText
      const maxChars = this.cfg.maxChars
      if (maxChars > 0 && runeCount(displayText) > maxChars) {
        displayText = `${Array.from(displayText).slice(0, maxChars).join('')}…`
      }
      await this.flushLocked({ kind: 'text', text: displayText })
    })
  }

  /** Arm a timer whose callback acquires the preview lock (Go time.AfterFunc). */
  private armTimer(delay: number, body: () => Promise<void>): TimerHandle {
    let fired = false
    const id = setTimeout(() => {
      fired = true
      void this.locked(async () => {
        this.timer = undefined
        await body()
      })
    }, delay)
    return {
      stop: (): boolean => {
        if (fired) return false
        clearTimeout(id)
        return true
      },
    }
  }

  private cancelTimerLocked(): void {
    if (this.timer !== undefined) {
      this.timer.stop()
      this.timer = undefined
    }
  }

  /**
   * Structured status for the current progress display: terminal states win,
   * streaming thinking shows 思考中, otherwise running. Must hold the lock.
   *
   * @internal White-box: ported same-package tests call this directly. Caller must hold the lock.
   * @returns The status the platform layer renders the card header from.
   */
  progressStatusLocked(): ProgressStatus {
    const state: ProgressStatus['state'] = this.completed
      ? 'completed'
      : this.failed
        ? 'failed'
        : this.thinkingText !== ''
          ? 'thinking'
          : 'running'
    return {
      state,
      ts: hms(),
      toolCallSeq: this.toolCallSeq,
      ...(this.pendingSubtasksCount > 0 ? { pendingSubtasks: this.pendingSubtasksCount } : {}),
    }
  }

  /** Progress display text wrapped with its structured status. Must hold the lock. */
  private progressContentLocked(text: string): TextPreviewContent {
    return {
      kind: 'text',
      text,
      status: this.progressStatusLocked(),
      ...(this.bgTaskHint !== '' ? { bgTaskHint: this.bgTaskHint } : {}),
    }
  }

  /** Send the current preview content to the platform. Must hold the lock. */
  private async flushLocked(contentIn: TextPreviewContent): Promise<void> {
    // Terminal latch: a throttled flush racing the stopped render must not
    // overwrite the ⏹ card with Running content. Completed and failed cards
    // rebuild with their own terminal status, and the stall-retry flow
    // keeps PATCHing a failed card for the retried turn, so only the stopped
    // render (rendered out-of-band, no status on rebuild) latches flushes.
    if (this.stoppedCardRendered) return
    let text = contentIn.text
    if (this.transform !== undefined) text = this.transform(text)
    // Status-bearing (progress) content always PATCHes — an empty body still
    // renders the header state, and progress flushes have their own throttle.
    // Plain text skips unchanged or empty bodies.
    if (contentIn.status === undefined && (text === this.lastSentText || text === '')) return
    const content: ProgressContent = {
      kind: 'text',
      text,
      ...(contentIn.status !== undefined ? { status: contentIn.status } : {}),
      ...(contentIn.bgTaskHint !== undefined ? { bgTaskHint: contentIn.bgTaskHint } : {}),
    }

    const updater = asMessageUpdater(this.platform)
    if (updater === undefined) {
      console.warn('stream preview: platform does not support UpdateMessage, degrading')
      this.degraded = true
      return
    }

    if (this.previewMsgID === undefined) {
      // First preview: try to send a new preview message
      const starter = asPreviewStarter(this.platform)
      if (starter !== undefined) {
        let handle: unknown
        try {
          handle = await starter.sendPreviewStart(this.replyCtx, content)
        } catch (error) {
          console.warn(`stream preview: start failed, degrading: ${String(error)}`)
          this.degraded = true
          return
        }
        this.previewMsgID = handle
        this.armTailGuardLocked()
      } else {
        try {
          await this.platform.send(this.replyCtx, text)
        } catch (error) {
          console.warn(`stream preview: initial send failed: ${String(error)}`)
          this.degraded = true
          return
        }
        this.previewMsgID = this.replyCtx
      }
      this.lastSentText = text
      this.lastSentViaUpdate = false
      this.lastSentAt = Date.now()
      return
    }

    // Update existing preview message
    if (this.async !== undefined) {
      const handle = this.previewMsgID
      const sentText = text
      // Optimistically update lastSentText so concurrent flushes with the
      // same content don't queue duplicate PATCHes; rewind on failure.
      const prevLastSentText = this.lastSentText
      this.lastSentText = text
      this.lastSentViaUpdate = true
      this.lastSentAt = Date.now()
      this.async.enqueueCoalescable(async () => {
        try {
          await updater.updateMessage(handle, content)
        } catch (error) {
          void this.locked(() => {
            // Transient PATCH errors (e.g. feishu 230020 "update too
            // frequently") clear in seconds — rewind and retry on the next
            // flush; must NOT count toward degradation.
            const checker = asTransientPatchErrorChecker(this.platform)
            if (checker !== undefined && checker.isTransientPatchError(error)) {
              if (this.lastSentText === sentText) this.lastSentText = prevLastSentText
              return
            }
            this.failedPatchStreak++
            // Rewind only if no newer flush has overwritten lastSentText.
            if (this.lastSentText === sentText) this.lastSentText = prevLastSentText
            if (this.failedPatchStreak >= maxConsecutivePatchFailures) {
              console.warn(`stream preview: too many consecutive async update failures, degrading (streak ${this.failedPatchStreak})`)
              this.degraded = true
            }
          })
          return
        }
        void this.locked(() => {
          this.failedPatchStreak = 0
        })
      })
      return
    }
    try {
      await updater.updateMessage(this.previewMsgID, content)
    } catch (error) {
      const checker = asTransientPatchErrorChecker(this.platform)
      if (checker !== undefined && checker.isTransientPatchError(error)) {
        return // don't degrade; next flush resends
      }
      this.failedPatchStreak++
      if (this.failedPatchStreak >= maxConsecutivePatchFailures) {
        console.warn(`stream preview: too many consecutive sync update failures, degrading (streak ${this.failedPatchStreak})`)
        this.degraded = true
      }
      return // don't update lastSentText so next flush resends
    }
    this.failedPatchStreak = 0
    this.lastSentText = text
    this.lastSentViaUpdate = true
    this.lastSentAt = Date.now()
  }

  /**
   * Stop the streaming preview permanently: cancel pending timers, update
   * the preview message in-place with the accumulated text, and degrade so
   * no further updates are sent (permission prompts and other interruptions).
   */
  async freeze(): Promise<void> {
    await this.locked(async () => {
      this.cancelTimerLocked()
      if (this.previewMsgID !== undefined && !this.degraded) {
        const updater = asMessageUpdater(this.platform)
        if (updater !== undefined) {
          const content = this.buildFreezeContentLocked()
          if (content.text !== '') {
            try {
              await updater.updateMessage(this.previewMsgID, content)
            } catch (error) {
              console.debug(`streaming update skipped: ${String(error)}`)
            }
          }
        }
      }
      this.degraded = true
    })
  }

  /**
   * Mark the streaming card completed (green header) and detach the preview
   * handle so the card stays visible permanently.
   */
  async completeAndDetach(): Promise<void> {
    const state = await this.locked(() => {
      this.cancelTimerLocked()
      // Set degraded first so timers and appendProgress stop queueing new
      // async running PATCHes after we release the lock; the barrier below
      // drains anything already queued.
      this.degraded = true
      let deliverText = ''
      let handle: unknown
      let content: ProgressContent | undefined
      if (this.previewMsgID !== undefined) {
        this.completed = true
        handle = this.previewMsgID
        if (this.progressMode) {
          this.finalizePendingEntriesLocked(true)
          content = this.progressContentLocked(this.buildProgressDisplayLocked())
          if (this.analysisTruncated) deliverText = this.analysisText
        } else {
          let text = this.fullText
          if (this.transform !== undefined) text = this.transform(text)
          content = { kind: 'text', text, status: this.progressStatusLocked() }
        }
      }
      this.previewMsgID = undefined
      return { handle, content, deliverText }
    })
    // Drain async PATCHes queued before degraded=true so a stale running
    // snapshot cannot land after the completed PATCH below.
    if (this.async !== undefined) await this.async.barrier()
    if (state.handle !== undefined && state.content !== undefined) {
      const updater = asMessageUpdater(this.platform)
      if (updater !== undefined) {
        try {
          await updater.updateMessage(state.handle, state.content)
        } catch (error) {
          console.debug(`streaming update skipped: ${String(error)}`)
        }
      }
    }
    if (state.deliverText !== '') await this.deliverAnswer(state.deliverText)
  }

  /** Content to display when freezing the preview (progress lines or fullText). */
  private buildFreezeContentLocked(): TextPreviewContent {
    if (this.progressMode && this.progressEntries.length > 0) {
      let display = this.buildProgressDisplayLocked()
      if (this.transform !== undefined) display = this.transform(display)
      return this.progressContentLocked(display)
    }
    let text = this.fullText
    const maxChars = this.cfg.maxChars
    if (maxChars > 0 && runeCount(text) > maxChars) {
      text = `${Array.from(text).slice(0, maxChars).join('')}…`
    }
    if (this.transform !== undefined) text = this.transform(text)
    return { kind: 'text', text }
  }

  /**
   * Un-degrade the preview so subsequent appendProgress calls continue
   * PATCHing the same card (after a permission prompt resolves).
   */
  async resumeFromFreeze(): Promise<void> {
    return this.locked(() => {
      if (this.previewMsgID !== undefined) {
        this.degraded = false
        this.stoppedCardRendered = false
        // Reset the failure streak so the post-resume tolerance window
        // starts fresh.
        this.failedPatchStreak = 0
        // The freeze disarmed the guard (degraded reads as terminal); the
        // card is live again, so resume keeping it at the chat tail.
        this.armTailGuardLocked()
      }
    })
  }

  /**
   * Remove the preview message when possible and disable further preview
   * updates (the caller intends a separate non-preview message).
   */
  async discard(): Promise<void> {
    await this.locked(async () => {
      this.cancelTimerLocked()
      this.clearTailGuardLocked()
      if (this.previewMsgID !== undefined) {
        const cleaner = asPreviewCleaner(this.platform)
        if (cleaner !== undefined) {
          const handle = this.previewMsgID
          const doDelete = async (): Promise<void> => {
            try {
              await cleaner.deletePreviewMessage(handle)
            } catch (error) {
              console.debug(`streaming cleanup skipped: ${String(error)}`)
            }
          }
          if (this.async !== undefined) this.async.enqueue(doDelete)
          else await doDelete()
        }
      }
      this.previewMsgID = undefined
      this.degraded = true
    })
  }

  /**
   * Called when the agent response completes: cancels timers and optionally
   * cleans up the preview message. Returns true when the final message was
   * delivered via the preview (caller should skip a separate send).
   *
   * @param finalTextIn - Full final response text; the transform is applied before use.
   * @returns True when the final message was delivered via the preview.
   */
  async finish(finalTextIn: string): Promise<boolean> {
    return this.locked(async () => {
      this.cancelTimerLocked()
      // The delete paths below clear the card without setting a terminal
      // flag; latch finish and stop the tail guard so an in-flight tail
      // check cannot reissue the deleted card.
      this.finished = true
      this.clearTailGuardLocked()
      let finalText = finalTextIn
      if (this.transform !== undefined) finalText = this.transform(finalText)
      if (this.previewMsgID === undefined || this.degraded) {
        if (this.previewMsgID !== undefined && this.degraded) {
          const cleaner = asPreviewCleaner(this.platform)
          if (cleaner !== undefined) {
            try {
              await cleaner.deletePreviewMessage(this.previewMsgID)
            } catch (error) {
              console.debug(`streaming cleanup skipped: ${String(error)}`)
            }
          }
        }
        return false
      }

      let keepPreview = false
      const pref = asPreviewFinishPreference(this.platform)
      if (pref !== undefined) keepPreview = pref.keepPreviewOnFinish()

      // If platform wants to delete the preview and send fresh, let it.
      const cleaner = asPreviewCleaner(this.platform)
      if (cleaner !== undefined && !keepPreview) {
        try {
          await cleaner.deletePreviewMessage(this.previewMsgID)
        } catch (error) {
          console.debug(`streaming cleanup skipped: ${String(error)}`)
        }
        return false
      }

      const updater = asMessageUpdater(this.platform)
      if (updater === undefined) return false
      if (finalText === '') return false

      // Skip the redundant API call when the final text is byte-identical to
      // the last UpdateMessage payload — unless it only went out via
      // SendPreviewStart (formatting may differ) or progressMode is on.
      if (finalText === this.lastSentText && this.lastSentViaUpdate && !this.progressMode) {
        return true
      }

      // In progressMode the final message only contains the AI response
      // text; the structured completion status greens the header (carrying
      // the pending-subtasks count for text-only turns too).
      this.completed = true
      const content: ProgressContent = {
        kind: 'text',
        text: finalText,
        status: this.progressStatusLocked(),
      }
      try {
        await updater.updateMessage(this.previewMsgID, content)
      } catch (error) {
        console.debug(`stream preview finish: final update FAILED, cleaning up preview: ${String(error)}`)
        // Update failed (e.g. too long for the edit API): delete the stale
        // preview so the caller can send a fresh message.
        const innerCleaner = asPreviewCleaner(this.platform)
        if (innerCleaner !== undefined) {
          try {
            await innerCleaner.deletePreviewMessage(this.previewMsgID)
          } catch (innerError) {
            console.debug(`streaming cleanup skipped: ${String(innerError)}`)
          }
        }
        return false
      }
      return true
    })
  }

  /** Clear the preview handle so finish() won't delete the frozen card. */
  async detachPreview(): Promise<void> {
    return this.locked(() => {
      this.previewMsgID = undefined
    })
  }

  /**
   * Reissue the preview card (create new, delete old) so it becomes the
   * latest message again after system notices push it off the chat tail.
   * Not throttled: rename/avatar notices must not eat the last bump.
   * A stopped card is terminal — a bump must not resurrect it as a running
   * card (markStopped leaves degraded=false, so the guard list alone cannot
   * catch it; 2026-08-25 oc_d22d incident).
   * Must hold the lock.
   */
  private async bumpToEndLocked(): Promise<void> {
    if (this.previewMsgID === undefined || this.degraded || this.completed || this.failed || this.stoppedCardRendered) return
    // An empty body still bumps: the running-status header renders alone.
    const content = this.progressContentLocked(this.buildProgressDisplayLocked())
    const starter = asPreviewStarter(this.platform)
    if (starter === undefined) return
    let newHandle: unknown
    try {
      newHandle = await starter.sendPreviewStart(this.replyCtx, content)
    } catch (error) {
      console.warn(`stream preview: bump SendPreviewStart failed: ${String(error)}`)
      return
    }
    const oldHandle = this.previewMsgID
    this.previewMsgID = newHandle
    this.lastSentText = content.text
    this.lastSentViaUpdate = false
    const cleaner = asPreviewCleaner(this.platform)
    if (cleaner !== undefined) {
      try {
        await cleaner.deletePreviewMessage(oldHandle)
      } catch (error) {
        console.debug(`stream preview: bump delete old card failed: ${String(error)}`)
      }
    }
  }

  /** Reissue the preview card so it becomes the latest message; no-op when inactive. */
  async bumpToEnd(): Promise<void> {
    await this.locked(() => this.bumpToEndLocked())
  }

  // ── tail guard: keep the active card the chat's newest message ──────────

  /** Whether the tail guard must stand down: no card, or a terminal/frozen state. */
  private tailGuardTerminalLocked(): boolean {
    return this.previewMsgID === undefined || this.degraded || this.completed
      || this.failed || this.stoppedCardRendered || this.finished
  }

  /**
   * Arm the periodic tail guard once the card exists. No-op when disabled,
   * already armed, or the platform cannot verify the chat tail. Must hold
   * the lock.
   */
  private armTailGuardLocked(): void {
    if (this.tailTimer !== undefined || this.tailGuardTerminalLocked()) return
    const interval = this.cfg.tailCheckMs ?? 0
    if (interval <= 0 || asPreviewTailProber(this.platform) === undefined) return
    this.scheduleTailCheckLocked()
  }

  /** Schedule the next tail check; self-rescheduling from the tick body. Must hold the lock. */
  private scheduleTailCheckLocked(): void {
    const interval = this.cfg.tailCheckMs ?? 0
    let fired = false
    const id = setTimeout(() => {
      fired = true
      this.tailTimer = undefined
      void this.runTailCheck()
    }, interval)
    this.tailTimer = {
      stop: (): boolean => {
        if (fired) return false
        clearTimeout(id)
        return true
      },
    }
  }

  /** Stop the tail guard (turn finished or card discarded). Must hold the lock. */
  private clearTailGuardLocked(): void {
    if (this.tailTimer !== undefined) {
      this.tailTimer.stop()
      this.tailTimer = undefined
    }
  }

  /**
   * One tail-guard cycle: verify the card is still the chat's newest message
   * and reissue it above whatever displaced it — engine cards, human
   * messages, system notices, other bots. The probe runs off the lock; a
   * displaced verdict re-enters through bumpToEnd, whose own guard re-checks
   * terminal state against races with finish(). A terminal sighting disarms
   * instead of probing, so a missed clear at most wastes one tick.
   */
  private async runTailCheck(): Promise<void> {
    if (this.tailGuardTerminalLocked()) return // finish/discard raced us; tick not re-armed
    const prober = asPreviewTailProber(this.platform)
    if (prober === undefined || (this.cfg.tailCheckMs ?? 0) <= 0) return
    const handle = this.previewMsgID
    let latest = true
    try {
      latest = await prober.previewIsLatest(handle)
    } catch (error) {
      console.debug(`stream preview: tail check failed: ${String(error)}`)
    }
    if (!latest) await this.bumpToEnd()
    // Re-arm under the lock so a finish() racing between the probe and here
    // is observed (it latches `finished` holding the same lock).
    await this.locked(() => {
      if (this.tailGuardTerminalLocked()) return
      this.scheduleTailCheckLocked()
    })
  }

  /**
   * Whether the preview was delivered via in-place UpdateMessage at least
   * once — the user then only got the initial push, so a done reaction is
   * worth sending.
   *
   * @returns True when a done reaction is worth sending.
   */
  needsDoneReaction(): boolean {
    return this.previewMsgID !== undefined && this.lastSentViaUpdate
  }

  /**
   * Whether the progress card has been created.
   *
   * @returns True once the preview message handle exists.
   */
  hasStarted(): boolean {
    return this.previewMsgID !== undefined
  }

  /**
   * Whether tool-progress lines are being shown.
   *
   * @returns True while the card is in progress mode.
   */
  inProgressMode(): boolean {
    return this.progressMode
  }

  /**
   * Create the preview card immediately with placeholder text (push).
   *
   * @param text - Placeholder text pushed as the first preview card; ignored when empty.
   */
  async forceStart(text: string): Promise<void> {
    if (text === '') return
    await this.locked(async () => {
      if (this.degraded || this.previewMsgID !== undefined) return
      await this.flushLocked({ kind: 'text', text })
    })
  }

  /**
   * Replace the placeholder text with tool progress via PATCH (no push).
   *
   * @param text - Progress text replacing the placeholder; ignored when empty.
   */
  async updateProgress(text: string): Promise<void> {
    if (text === '') return
    await this.locked(async () => {
      if (this.degraded || this.previewMsgID === undefined || this.fullText !== '') return
      this.lastSentText = '' // force PATCH even if text is similar
      await this.flushLocked({ kind: 'text', text })
    })
  }

  /**
   * Append a tool progress entry; PATCHes in-place after creation.
   *
   * @param entry - Tool or thinking entry to append to the progress ring buffer.
   */
  async appendProgress(entry: ProgressEntry): Promise<void> {
    await this.locked(async () => {
      if (this.degraded || (entry.text === '' && !entry.isTool)) return
      this.progressMode = true
      this.progressTotalCount++
      if (entry.isTool) {
        this.toolCallSeq++
        entry.seq = this.toolCallSeq
        if (entry.skillName !== '') this.addSkillName(entry.skillName)
      }
      if (entry.isCompact) this.compactCount++
      if (this.progressEntries.length < maxProgressLines) {
        this.progressEntries.push(entry)
        this.progressLatestIdx = this.progressEntries.length - 1
        this.progressWriteIdx = 0 // next overwrite starts at slot 0 once full
      } else {
        // Circular buffer: replace the oldest slot, advance cursor.
        this.progressEntries[this.progressWriteIdx] = entry
        this.progressLatestIdx = this.progressWriteIdx
        this.progressWriteIdx = (this.progressWriteIdx + 1) % maxProgressLines
      }
      const display = this.buildProgressDisplayLocked()
      await this.flushProgressLocked(display)
    })
  }

  /** Append a skill name to the per-turn accumulator (deduped, ordered). */
  private addSkillName(name: string): void {
    if (this.skillNames.includes(name)) return
    this.skillNames.push(name)
  }

  /**
   * Clear per-turn tool-progress state while keeping the card alive; used by
   * the unsolicited reader so each background turn starts with a clean
   * 工具调用 section on the one shared card.
   */
  async resetProgressEntries(): Promise<void> {
    return this.locked(() => {
      this.progressEntries = []
      this.progressWriteIdx = 0
      this.progressLatestIdx = 0
      this.progressTotalCount = 0
      this.toolCallSeq = 0
      this.failureCount = 0
      this.compactCount = 0
      this.skillNames = []
    })
  }

  /**
   * Update the background-task hint and flush. Non-terminal cards render it
   * beside the stop button; terminal cards inside the body.
   *
   * @param hint - New hint line shown with the card's button row.
   */
  async setBackgroundHint(hint: string): Promise<void> {
    await this.locked(async () => {
      if (this.bgTaskHint === hint) return
      this.bgTaskHint = hint
      if (this.progressMode) {
        const display = this.buildProgressDisplayLocked()
        await this.flushProgressLocked(display)
      }
    })
  }

  /**
   * Store the latest todo items (pinned section) and flush.
   *
   * @param items - Latest todo items to render in the pinned section.
   */
  async updateTodoSection(items: TodoItem[]): Promise<void> {
    await this.locked(async () => {
      if (this.degraded) return
      this.todoItems = items
      if (this.progressMode) {
        const display = this.buildProgressDisplayLocked()
        await this.flushProgressLocked(display)
      }
    })
  }

  /**
   * Update the cumulative subagent count shown in the pinned stats section.
   * Zero hides the line; unchanged counts skip the flush.
   *
   * @param count - Number of delegated subagent child sessions that ever ran.
   */
  async setSubagentCount(count: number): Promise<void> {
    await this.locked(async () => {
      if (this.degraded || this.subagentCount === count) return
      this.subagentCount = count
      if (this.progressMode) {
        const display = this.buildProgressDisplayLocked()
        await this.flushProgressLocked(display)
      }
    })
  }

  /**
   * Update the unreported native-subtask count carried on the structured
   * status; terminal card titles append it as a running-subtasks suffix.
   * Unchanged counts skip the flush.
   *
   * @param count - Unreported native subtasks of the session; 0 omits the field.
   */
  async setPendingSubtasks(count: number): Promise<void> {
    await this.locked(async () => {
      if (this.degraded || this.pendingSubtasksCount === count) return
      this.pendingSubtasksCount = count
      if (this.progressMode) {
        const display = this.buildProgressDisplayLocked()
        await this.flushProgressLocked(display)
      }
    })
  }

  /**
   * Update the tool entry matching toolID with its result; empty toolID
   * falls back to the first pending entry.
   *
   * @param toolID - tool_use id of the call to update; empty matches the first pending entry.
   * @param result - Result text shown below the call body.
   * @param success - Whether the tool call succeeded (rendered 🟢 vs 🔴).
   */
  async updateToolResult(toolID: string, result: string, success: boolean): Promise<void> {
    await this.locked(async () => {
      if (this.degraded) return
      let idx = -1
      if (toolID !== '') {
        for (let i = 0; i < this.progressEntries.length; i++) {
          const e = this.progressEntries[i]
          if (e?.isTool && e.toolID === toolID) {
            idx = i
            break
          }
        }
      }
      if (idx < 0) {
        for (let i = 0; i < this.progressEntries.length; i++) {
          const e = this.progressEntries[i]
          if (e?.isTool && !e.hasResult) {
            idx = i
            break
          }
        }
      }
      if (idx < 0) return
      const target = this.progressEntries[idx]
      if (target === undefined) return
      let display = result.trim()
      display = display.replaceAll('```', "'''")
      target.result = display
      target.success = success
      target.hasResult = true
      this.progressLatestIdx = idx
      if (!success) this.failureCount++
      const displayText = this.buildProgressDisplayLocked()
      await this.flushProgressLocked(displayText)
    })
  }

  /**
   * Flush the progress display with rate limiting: within
   * progressFlushInterval of the last flush, skip the PATCH and arm a
   * delayed flush instead. Must hold the lock.
   */
  private async flushProgressLocked(text: string): Promise<void> {
    const now = Date.now()
    if (now - this.lastProgressFlush < progressFlushInterval) {
      // Too soon — schedule a delayed flush if none pending.
      if (this.timer === undefined || this.timer.stop()) {
        this.timer = this.armTimer(progressFlushInterval - (now - this.lastProgressFlush), async () => {
          if (this.degraded || this.previewMsgID === undefined) return
          const display = this.buildProgressDisplayLocked()
          this.lastSentText = ''
          await this.flushLocked(this.progressContentLocked(display))
          this.lastProgressFlush = Date.now()
        })
      }
      return
    }
    this.lastProgressFlush = now
    this.lastSentText = ''
    await this.flushLocked(this.progressContentLocked(text))
  }

  /**
   * Variant for high-frequency updaters (per text_delta): defers the
   * expensive buildProgressDisplayLocked to the actual flush so the rebuild
   * runs at most once per progressFlushInterval. Must hold the lock.
   */
  private async flushProgressRebuildLocked(): Promise<void> {
    const now = Date.now()
    if (now - this.lastProgressFlush >= progressFlushInterval) {
      this.lastProgressFlush = now
      this.lastSentText = ''
      await this.flushLocked(this.progressContentLocked(this.buildProgressDisplayLocked()))
      return
    }
    // Within the throttle window: arm a delayed flush that rebuilds with the
    // latest analysisText; a pending timer is reused.
    if (this.timer === undefined || this.timer.stop()) {
      this.timer = this.armTimer(progressFlushInterval - (now - this.lastProgressFlush), async () => {
        if (this.degraded || this.previewMsgID === undefined) return
        const display = this.buildProgressDisplayLocked()
        this.lastSentText = ''
        await this.flushLocked(this.progressContentLocked(display))
        this.lastProgressFlush = Date.now()
      })
    }
  }

  /**
   * Update the 实时播报 section with the latest EventText chunk (replaced).
   *
   * @param chunk - Latest EventText chunk; replaces the previous one.
   */
  async appendAnalysisText(chunk: string): Promise<void> {
    if (chunk === '') return
    await this.locked(async () => {
      if (this.degraded) return
      this.analysisText = chunk
      await this.flushProgressRebuildLocked()
    })
  }

  /**
   * Update the 💭 思考中 section with the latest thinking chunk.
   *
   * @param chunk - Latest thinking chunk shown in the section.
   */
  async appendThinking(chunk: string): Promise<void> {
    if (chunk === '') return
    await this.locked(async () => {
      if (this.degraded) return
      this.thinkingText = chunk
      this.progressMode = true
      const display = this.buildProgressDisplayLocked()
      await this.flushProgressLocked(display)
    })
  }

  /** Drop the 💭 思考中 section once the full thinking block arrives. */
  async clearThinking(): Promise<void> {
    await this.locked(async () => {
      if (this.thinkingText === '') return
      this.thinkingText = ''
      if (this.degraded) return
      const display = this.buildProgressDisplayLocked()
      await this.flushProgressLocked(display)
    })
  }

  /**
   * Replace the analysis text without flushing (completion-time injection).
   *
   * @param text - New analysis text for the 实时播报 section.
   */
  async setAnalysisText(text: string): Promise<void> {
    return this.locked(() => {
      this.analysisText = text
    })
  }

  /**
   * Set the analysis text only when streaming has not populated it yet.
   *
   * @param text - Analysis text used only when the current one is empty.
   */
  async setAnalysisTextIfEmpty(text: string): Promise<void> {
    return this.locked(() => {
      if (this.analysisText === '' && text !== '') this.analysisText = text
    })
  }

  /**
   * Remove one exact copy of content before a dedicated card takes ownership.
   *
   * @param content - Exact text to remove once from fullText and analysisText.
   */
  async removeText(content: string): Promise<void> {
    if (content === '') return
    return this.locked(() => {
      this.fullText = this.fullText.replace(content, '').trim()
      this.analysisText = this.analysisText.replace(content, '').trim()
    })
  }

  /**
   * Whether the preview stopped sending updates (patch failures, freeze, or terminal state).
   *
   * @returns True when no further updates will be sent.
   */
  isDegraded(): boolean {
    return this.degraded
  }

  /**
   * Re-deliver the answer out-of-band (markdown file attachment, falling
   * back to chunked text) so it is never lost when the card cannot show it.
   * Must NOT hold the lock.
   *
   * @param text - Complete answer text to deliver.
   */
  async deliverAnswer(text: string): Promise<void> {
    if (text.trim() === '') return
    const fs = asFileSender(this.platform)
    if (fs !== undefined) {
      const fileName = `reply-${hmsFile()}.md`
      try {
        await fs.sendFile(this.replyCtx, {
          mimeType: 'text/markdown',
          data: new TextEncoder().encode(text),
          fileName,
        })
        return
      } catch (error) {
        console.warn(`stream preview: deliverAnswer SendFile failed, degrading to plain text: ${String(error)}`)
      }
    }
    for (const chunk of splitMessage(text, MaxPlatformMessageLen)) {
      try {
        await this.platform.send(this.replyCtx, chunk)
      } catch (error) {
        console.warn(`stream preview: deliverAnswer Send failed: ${String(error)}`)
      }
    }
  }

  /**
   * Recover when the final terminal PATCH is rejected (e.g. Feishu 11310):
   * delete the frozen preview card and re-deliver via deliverAnswer. Must
   * NOT hold the lock.
   */
  private async fallbackSend(previewHandle: unknown, text: string): Promise<void> {
    const cleaner = asPreviewCleaner(this.platform)
    if (cleaner !== undefined && previewHandle !== undefined) {
      try {
        await cleaner.deletePreviewMessage(previewHandle)
      } catch (error) {
        console.debug(`streaming cleanup skipped: ${String(error)}`)
      }
    }
    await this.deliverAnswer(text)
  }

  /**
   * Force tool entries still awaiting a result into a terminal state before
   * a terminal render, so the card never freezes on 🟡.
   */
  private finalizePendingEntriesLocked(success: boolean): void {
    for (const e of this.progressEntries) {
      if (e.isTool && !e.hasResult) {
        e.hasResult = true
        e.success = success
      }
    }
  }

  /** Mark the turn completed: final PATCH with a green header. */
  async markCompleted(): Promise<void> {
    await this.locked(async () => {
      this.cancelTimerLocked()
      if (this.previewMsgID === undefined) return
      this.completed = true
      this.finalizePendingEntriesLocked(true)
      const display = this.buildProgressDisplayLocked()
      const updater = asMessageUpdater(this.platform)
      if (updater === undefined) return
      const answerText = this.analysisText
      const truncated = this.analysisTruncated
      const content = this.progressContentLocked(display)
      if (this.async !== undefined) {
        const handle = this.previewMsgID
        this.lastSentText = display
        this.lastSentViaUpdate = true
        this.degraded = false
        this.async.enqueue(async () => {
          try {
            await updater.updateMessage(handle, content)
          } catch (error) {
            console.warn(`stream preview: async markCompleted PATCH failed, sending fallback: ${String(error)}`)
            await this.fallbackSend(handle, answerText)
            return
          }
          if (truncated) await this.deliverAnswer(answerText)
        })
        return
      }
      try {
        await updater.updateMessage(this.previewMsgID, content)
      } catch (error) {
        console.warn(`stream preview: markCompleted PATCH failed, sending fallback: ${String(error)}`)
        await this.fallbackSend(this.previewMsgID, answerText)
        return
      }
      this.lastSentText = display
      this.lastSentViaUpdate = true
      this.degraded = false
      if (truncated) await this.deliverAnswer(answerText)
    })
  }

  /** Mark the turn failed: final PATCH with a red header. */
  async markFailed(): Promise<void> {
    await this.locked(async () => {
      await this.markFailedLocked()
    })
  }

  /** markFailed without re-acquiring the lock (markStopped fallback). */
  private async markFailedLocked(): Promise<void> {
    this.cancelTimerLocked()
    if (this.previewMsgID === undefined) return
    this.failed = true
    this.finalizePendingEntriesLocked(false)
    const display = this.buildProgressDisplayLocked()
    const content = this.progressContentLocked(display)
    const updater = asMessageUpdater(this.platform)
    if (updater === undefined) return
    const answerText = this.analysisText
    if (this.async !== undefined) {
      const handle = this.previewMsgID
      this.lastSentText = display
      this.lastSentViaUpdate = true
      this.degraded = false
      this.async.enqueue(async () => {
        try {
          await updater.updateMessage(handle, content)
        } catch (error) {
          console.warn(`stream preview: async markFailed PATCH failed, sending fallback: ${String(error)}`)
          await this.fallbackSend(handle, answerText)
        }
      })
      return
    }
    try {
      await updater.updateMessage(this.previewMsgID, content)
    } catch (error) {
      console.warn(`stream preview: markFailed PATCH failed, sending fallback: ${String(error)}`)
      await this.fallbackSend(this.previewMsgID, answerText)
      return
    }
    this.lastSentText = display
    this.lastSentViaUpdate = true
    this.degraded = false
  }

  /**
   * Render a user-initiated stop terminal card: StoppedCardRenderer in
   * place (⏹ 已停止 + ▶ 继续执行) when available, else the failed card.
   */
  async markStopped(): Promise<void> {
    await this.locked(async () => {
      this.cancelTimerLocked()
      if (this.previewMsgID === undefined || this.stoppedCardRendered) return
      this.stoppedCardRendered = true
      const r = asStoppedCardRenderer(this.platform)
      if (r !== undefined) {
        const handle = this.previewMsgID
        const rc = this.replyCtx
        if (this.async !== undefined) {
          this.async.enqueue(async () => {
            try {
              await r.renderStoppedCard(rc, handle)
            } catch (error) {
              console.warn(`stream preview: async RenderStoppedCard failed, falling back to failed card: ${String(error)}`)
              await this.locked(() => this.markFailedLocked())
            }
          })
          return
        }
        try {
          await r.renderStoppedCard(rc, handle)
        } catch (error) {
          console.warn(`stream preview: RenderStoppedCard failed, falling back to failed card: ${String(error)}`)
          await this.markFailedLocked()
          return
        }
        this.lastSentViaUpdate = true
        this.degraded = false
        return
      }
      await this.markFailedLocked()
    })
  }

  /**
   * Synchronous-stop variant: set degraded (stop queueing), drain the async
   * sender with a barrier so in-flight running PATCHes cannot overwrite the
   * stopped card, then PATCH the stopped card inline.
   */
  async markStoppedSync(): Promise<void> {
    const state = await this.locked(async () => {
      this.cancelTimerLocked()
      if (this.previewMsgID === undefined || this.stoppedCardRendered) return undefined
      this.stoppedCardRendered = true
      this.degraded = true
      const r = asStoppedCardRenderer(this.platform)
      if (r === undefined) {
        await this.markFailedLocked()
        return undefined
      }
      return { handle: this.previewMsgID, rc: this.replyCtx, r, async: this.async }
    })
    if (state === undefined) return

    // Drain in-flight running PATCHes before the terminal stopped PATCH.
    if (state.async !== undefined) await state.async.barrier()
    try {
      await state.r.renderStoppedCard(state.rc, state.handle)
    } catch (error) {
      console.warn(`stream preview: sync RenderStoppedCard failed, falling back to failed card: ${String(error)}`)
      await this.locked(() => this.markFailedLocked())
      return
    }
    return this.locked(() => {
      this.lastSentViaUpdate = true
    })
  }

  /**
   * Build the combined display text for the preview card: lead-in text,
   * todo/status block, tool progress entries, 实时播报 section, and — on
   * terminal cards only — the background hint (running cards carry it as the
   * structured bgTaskHint field rendered beside the stop button). The
   * card-header state travels beside the text as the structured
   * {@link ProgressStatus} (progressStatusLocked). Must hold the lock.
   *
   * @internal White-box: ported same-package tests call this directly. Caller must hold the lock.
   * @returns The full markdown body for one preview-card PATCH.
   */
  buildProgressDisplayLocked(): string {
    let b = ''

    // Section 0: 回复正文 — assistant text accumulated before progressMode.
    if (this.fullText !== '') {
      const [leadIn] = stripTrailingSilent(this.fullText)
      if (leadIn !== '') b += `${leadIn}\n`
    }

    // Section 1: 待办事项 + 状态计数（失败/压缩/技能/子代理）in one code block.
    const hasToolEntries = this.progressEntries.some(e => e.isTool)
    const hasStatus = this.todoItems.length > 0 || this.failureCount > 0 || this.compactCount > 0
      || this.skillNames.length > 0 || this.subagentCount > 0
    if (hasStatus) {
      b += '```\n'
      // 摘要统计置顶（失败/压缩/技能/子代理）；待办跟在后面
      if (this.failureCount > 0) b += `🔴调用失败：${this.failureCount}/${this.progressTotalCount}\n`
      if (this.compactCount > 0) b += `🗜上下文压缩：${this.compactCount}次\n`
      if (this.skillNames.length > 0) b += `📚 技能：${this.skillNames.join('、')}\n`
      if (this.subagentCount > 0) b += `🤖 Sub Agent：${this.subagentCount}\n`
      for (const item of this.todoItems) {
        let icon: string
        switch (item.status.trim().toLowerCase()) {
          case 'completed':
            icon = '✅'
            break
          case 'in_progress':
            icon = '🔄'
            break
          case 'pending':
            icon = '⏳'
            break
          default:
            icon = '•'
            break
        }
        let content = item.content.replaceAll('\n', ' ')
        if (item.status.trim().toLowerCase() === 'in_progress' && (item.activeForm ?? '') !== '') {
          content = (item.activeForm ?? '').replaceAll('\n', ' ')
        }
        b += `${icon} ${content}\n`
      }
      b += '```\n'
    }

    // Section 2: 工具调用 (oldest → newest, max maxProgressLines)
    if (hasToolEntries) {
      this.progressEntries.forEach((e, i) => {
        b += e.render(i === this.progressLatestIdx)
        b += '\n'
      })
    }

    // Section 3: 实时播报 (latest EventText)
    if (this.analysisText !== '') {
      const [stripped] = stripTrailingSilent(this.analysisText)
      const analysisDisplay = stripped
      if (analysisDisplay !== '') {
        const charOverflow = runeCount(analysisDisplay) > maxAnalysisDisplayChars
        let tableOverflow = false
        const r = asPreviewOverflowReporter(this.platform)
        if (r !== undefined) tableOverflow = r.previewOverflow(analysisDisplay)
        if (charOverflow) {
          b += Array.from(analysisDisplay).slice(0, maxAnalysisDisplayChars).join('')
          b += '\n\n…（内容过长，完整回复见下方单独消息/附件）'
          this.analysisTruncated = true
        } else if (tableOverflow) {
          // Fits the core cap but exceeds a platform card limit (e.g.
          // Feishu's 5-table cap → 11310): keep the full text — the platform
          // collapses excess tables — and flag truncated so the engine
          // delivers the complete answer out-of-band.
          b += analysisDisplay
          b += '\n\n…（内容过长，完整回复见下方单独消息/附件）'
          this.analysisTruncated = true
        } else {
          b += analysisDisplay
          this.analysisTruncated = false
        }
      }
    }

    // Section 4: 后台任务提示 — 运行态随结构化 bgTaskHint 字段渲染在停止
    // 按钮行内；正文仅终态卡承载（green 化后按钮行消失，提示不能丢）。
    if (this.bgTaskHint !== '' && (this.completed || this.failed)) {
      b += '\n'
      b += this.bgTaskHint
    }

    return b
  }
}

/**
 * Create a streaming preview (Go newStreamPreview).
 *
 * @param cfg - Preview behavior switches.
 * @param p - Platform adapter used to send and update the card.
 * @param replyCtx - Reply context the preview message is sent in.
 * @param transform - Optional text transform applied before every send.
 * @param as - Async sender serializing PATCHes; undefined sends inline.
 * @param sessionKey - Session this preview belongs to (bump routing); empty when unknown.
 * @returns A new idle preview; nothing is sent until an append or flush call.
 */
export function newStreamPreview(
  cfg: StreamPreviewCfg,
  p: Platform,
  replyCtx: unknown,
  transform: ((s: string) => string) | undefined,
  as: AsyncSender | undefined,
  sessionKey = '',
): StreamPreview {
  return new StreamPreview(cfg, p, replyCtx, transform, as, sessionKey)
}
