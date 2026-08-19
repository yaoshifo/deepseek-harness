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
  asStoppedCardRenderer,
  asTransientPatchErrorChecker,
  type Platform,
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
  enabled: boolean
  /** Platforms where streaming preview is disabled. */
  disabledPlatforms?: string[]
  /** Minimum ms between updates. */
  intervalMs: number
  /** Minimum new chars before sending an update. */
  minDeltaChars: number
  /** Max preview length. */
  maxChars: number
  /** Enable partial-message streaming for earlier preview. */
  partial?: boolean
}

export function defaultStreamPreviewCfg(): StreamPreviewCfg {
  return { enabled: true, disabledPlatforms: [], intervalMs: 800, minDeltaChars: 15, maxChars: 2000 }
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
  success = false
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

  /** Render this entry as the markdown shown in the progress card. */
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

/** Keep the first maxLines lines plus an overflow marker (Go truncateToMaxLines). */
export function truncateToMaxLines(s: string, maxLines: number): string {
  if (s === '' || maxLines <= 0) return s
  const lines = s.split('\n')
  if (lines.length <= maxLines) return s
  const extra = lines.length - maxLines
  return `${lines.slice(0, maxLines).join('\n')}\n... (${extra} more lines)`
}

/** Normalize s to exactly maxLines lines for stable card height. */
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

const editTools = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'MultiEdit', 'NotebookEdit'])
const agentTools = new Set(['Agent', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'EnterPlanMode', 'ExitPlanMode'])
const webTools = new Set(['WebSearch', 'WebFetch'])

/**
 * The colored text_tag label for a tool in the progress card (icon + color
 * by tool family, name tail-truncated to maxLen).
 */
export function toolTagForProgress(name: string, maxLen: number): string {
  let displayName = name
  if (displayName.length > maxLen) displayName = displayName.slice(displayName.length - maxLen)

  let icon = '⚙️'
  switch (name) {
    case 'Read':
    case 'Glob':
    case 'Grep':
      icon = '🔍'
      break
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      icon = '📝'
      break
    case 'WebFetch':
    case 'WebSearch':
      icon = '🌐'
      break
    case 'Agent':
      icon = '🤖'
      break
    case 'ExitPlanMode':
      icon = '📋'
      break
    case 'AskUserQuestion':
      icon = '❓'
      break
    case 'Skill':
      icon = '📚'
      break
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
      icon = '📝'
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

/** Parse a Skill tool call input into (skillName, args); empty for non-skill tools. */
export function parseSkillToolUse(toolName: string, toolInput: string): [string, string] {
  if (toolName.toLowerCase() !== 'skill') return ['', '']
  if (toolInput.startsWith('skill=')) return [toolInput.slice('skill='.length).trim(), '']
  try {
    const m = JSON.parse(toolInput) as { skill?: unknown; args?: unknown }
    const name = typeof m.skill === 'string' ? m.skill : ''
    const args = typeof m.args === 'string' ? m.args : ''
    return [name, args]
  } catch {
    return ['', '']
  }
}

/**
 * Build a tool progress entry: timestamped header, escaped body (bash gets a
 * language tag), Thinking entries flagged, and Skill entries relabeled with
 * the skill name.
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

/** Escape markdown special characters (#, *, ~) in plain text. */
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

  /** @internal White-box: ported same-package tests read/write this directly. */
  fullText = ''
  private lastSentText = ''
  private lastSentAt = 0
  private lastSentViaUpdate = false
  /** @internal White-box: ported same-package tests read/write this directly. */
  previewMsgID: unknown
  /** @internal White-box: ported same-package tests read/write this directly. */
  degraded = false
  /** @internal White-box: ported same-package tests read/write this directly. */
  failedPatchStreak = 0

  private progressMode = false
  /** @internal White-box: ported same-package tests read/write this directly. */
  progressEntries: ProgressEntry[] = []
  private progressWriteIdx = 0
  private progressLatestIdx = 0
  private progressTotalCount = 0
  private toolCallSeq = 0
  private failureCount = 0
  private compactCount = 0
  /** @internal White-box: ported same-package tests read/write this directly. */
  skillNames: string[] = []
  /** @internal White-box: ported same-package tests read/write this directly. */
  analysisText = ''
  /** @internal White-box: ported same-package tests read/write this directly. */
  analysisTruncated = false
  private thinkingText = ''
  /** @internal White-box: ported same-package tests read/write this directly. */
  completed = false
  /** @internal White-box: ported same-package tests read/write this directly. */
  failed = false
  private todoItems: TodoItem[] = []
  private bgTaskHint = ''

  /** @internal White-box: ported same-package tests read/write this directly. */
  timer: TimerHandle | undefined
  /** @internal White-box: ported same-package tests read/write this directly. */
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
   */
  canPreview(): boolean {
    if (this.degraded || !this.cfg.enabled) return false
    const platformName = this.platform.name()
    for (const disabled of this.cfg.disabledPlatforms ?? []) {
      if (disabled.toLowerCase() === platformName.toLowerCase()) return false
    }
    return asMessageUpdater(this.platform) !== undefined
  }

  /** Send an initial placeholder card before any agent events arrive. */
  async showPlaceholder(placeholderText: string): Promise<void> {
    await this.locked(async () => {
      if (this.degraded || !this.cfg.enabled || this.previewMsgID !== undefined) return
      this.progressMode = true
      await this.flushLocked(placeholderText)
      // Reset throttle state so the first real appendText flushes immediately.
      this.lastSentAt = 0
      this.lastSentText = ''
    })
  }

  /** Add new text content and trigger a throttled flush if needed. */
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
      await this.flushLocked(displayText)
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
      await this.flushLocked(displayText)
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

  /** Send the current preview text to the platform. Must hold the lock. */
  private async flushLocked(textIn: string): Promise<void> {
    let text = textIn
    if (this.transform !== undefined) text = this.transform(text)
    if (text === this.lastSentText || text === '') return

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
          handle = await starter.sendPreviewStart(this.replyCtx, text)
        } catch (error) {
          console.warn(`stream preview: start failed, degrading: ${String(error)}`)
          this.degraded = true
          return
        }
        this.previewMsgID = handle
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
      const content = text
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
              if (this.lastSentText === content) this.lastSentText = prevLastSentText
              return
            }
            this.failedPatchStreak++
            // Rewind only if no newer flush has overwritten lastSentText.
            if (this.lastSentText === content) this.lastSentText = prevLastSentText
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
      await updater.updateMessage(this.previewMsgID, text)
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
          const text = this.buildFreezeTextLocked()
          if (text !== '') {
            try {
              await updater.updateMessage(this.previewMsgID, text)
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
      let display = ''
      if (this.previewMsgID !== undefined) {
        this.completed = true
        handle = this.previewMsgID
        if (this.progressMode) {
          this.finalizePendingEntriesLocked(true)
          display = this.buildProgressDisplayLocked()
          if (this.analysisTruncated) deliverText = this.analysisText
        } else {
          const header = `__cc_state__:completed\n__cc_ts__:${hms()}\n`
          let text = this.fullText
          if (this.transform !== undefined) text = this.transform(text)
          display = header + text
        }
      }
      this.previewMsgID = undefined
      return { handle, display, deliverText }
    })
    // Drain async PATCHes queued before degraded=true so a stale running
    // snapshot cannot land after the completed PATCH below.
    if (this.async !== undefined) await this.async.barrier()
    if (state.handle !== undefined) {
      const updater = asMessageUpdater(this.platform)
      if (updater !== undefined) {
        try {
          await updater.updateMessage(state.handle, state.display)
        } catch (error) {
          console.debug(`streaming update skipped: ${String(error)}`)
        }
      }
    }
    if (state.deliverText !== '') await this.deliverAnswer(state.deliverText)
  }

  /** Text to display when freezing the preview (progress lines or fullText). */
  private buildFreezeTextLocked(): string {
    if (this.progressMode && this.progressEntries.length > 0) {
      let display = this.buildProgressDisplayLocked()
      if (this.transform !== undefined) display = this.transform(display)
      return display
    }
    let text = this.fullText
    const maxChars = this.cfg.maxChars
    if (maxChars > 0 && runeCount(text) > maxChars) {
      text = `${Array.from(text).slice(0, maxChars).join('')}…`
    }
    if (this.transform !== undefined) text = this.transform(text)
    return text
  }

  /**
   * Un-degrade the preview so subsequent appendProgress calls continue
   * PATCHing the same card (after a permission prompt resolves).
   */
  async resumeFromFreeze(): Promise<void> {
    return this.locked(() => {
      if (this.previewMsgID !== undefined) {
        this.degraded = false
        // Reset the failure streak so the post-resume tolerance window
        // starts fresh.
        this.failedPatchStreak = 0
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
   */
  async finish(finalTextIn: string): Promise<boolean> {
    return this.locked(async () => {
      this.cancelTimerLocked()
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
      // text; emit the completion marker so the platform greens the header.
      const displayText = `__cc_state__:completed\n__cc_ts__:${hms()}\n${finalText}`
      try {
        await updater.updateMessage(this.previewMsgID, displayText)
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
   * Must hold the lock.
   */
  private async bumpToEndLocked(): Promise<void> {
    if (this.previewMsgID === undefined || this.degraded || this.completed || this.failed) return
    let display = this.buildProgressDisplayLocked()
    if (display === '') display = this.lastSentText
    const starter = asPreviewStarter(this.platform)
    if (starter === undefined) return
    let newHandle: unknown
    try {
      newHandle = await starter.sendPreviewStart(this.replyCtx, display)
    } catch (error) {
      console.warn(`stream preview: bump SendPreviewStart failed: ${String(error)}`)
      return
    }
    const oldHandle = this.previewMsgID
    this.previewMsgID = newHandle
    this.lastSentText = display
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

  /**
   * Whether the preview was delivered via in-place UpdateMessage at least
   * once — the user then only got the initial push, so a done reaction is
   * worth sending.
   */
  needsDoneReaction(): boolean {
    return this.previewMsgID !== undefined && this.lastSentViaUpdate
  }

  /** Whether the progress card has been created. */
  hasStarted(): boolean {
    return this.previewMsgID !== undefined
  }

  /** Whether tool-progress lines are being shown. */
  inProgressMode(): boolean {
    return this.progressMode
  }

  /** Create the preview card immediately with placeholder text (push). */
  async forceStart(text: string): Promise<void> {
    if (text === '') return
    await this.locked(async () => {
      if (this.degraded || this.previewMsgID !== undefined) return
      await this.flushLocked(text)
    })
  }

  /** Replace the placeholder text with tool progress via PATCH (no push). */
  async updateProgress(text: string): Promise<void> {
    if (text === '') return
    await this.locked(async () => {
      if (this.degraded || this.previewMsgID === undefined || this.fullText !== '') return
      this.lastSentText = '' // force PATCH even if text is similar
      await this.flushLocked(text)
    })
  }

  /** Append a tool progress entry; PATCHes in-place after creation. */
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

  /** Update the background-task hint at the card bottom and flush. */
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

  /** Store the latest todo items (pinned section) and flush. */
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
   * Update the tool entry matching toolID with its result; empty toolID
   * falls back to the first pending entry.
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
          await this.flushLocked(display)
          this.lastProgressFlush = Date.now()
        })
      }
      return
    }
    this.lastProgressFlush = now
    this.lastSentText = ''
    await this.flushLocked(text)
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
      await this.flushLocked(this.buildProgressDisplayLocked())
      return
    }
    // Within the throttle window: arm a delayed flush that rebuilds with the
    // latest analysisText; a pending timer is reused.
    if (this.timer === undefined || this.timer.stop()) {
      this.timer = this.armTimer(progressFlushInterval - (now - this.lastProgressFlush), async () => {
        if (this.degraded || this.previewMsgID === undefined) return
        const display = this.buildProgressDisplayLocked()
        this.lastSentText = ''
        await this.flushLocked(display)
        this.lastProgressFlush = Date.now()
      })
    }
  }

  /** One final PATCH with the complete response text replacing the streamed text. */
  async finalProgressDisplay(finalText: string): Promise<void> {
    await this.locked(async () => {
      if (this.degraded || this.previewMsgID === undefined) return
      this.fullText = finalText
      const display = this.buildProgressDisplayLocked()
      const updater = asMessageUpdater(this.platform)
      if (updater === undefined) return
      try {
        await updater.updateMessage(this.previewMsgID, display)
      } catch (error) {
        console.debug(`streaming update skipped: ${String(error)}`)
      }
      this.lastSentText = display
      this.lastSentViaUpdate = true
    })
  }

  /** Update the 实时播报 section with the latest EventText chunk (replaced). */
  async appendAnalysisText(chunk: string): Promise<void> {
    if (chunk === '') return
    await this.locked(async () => {
      if (this.degraded) return
      this.analysisText = chunk
      await this.flushProgressRebuildLocked()
    })
  }

  /** Update the 💭 思考中 section with the latest thinking chunk. */
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

  /** Replace the analysis text without flushing (completion-time injection). */
  async setAnalysisText(text: string): Promise<void> {
    return this.locked(() => {
      this.analysisText = text
    })
  }

  /** Set the analysis text only when streaming has not populated it yet. */
  async setAnalysisTextIfEmpty(text: string): Promise<void> {
    return this.locked(() => {
      if (this.analysisText === '' && text !== '') this.analysisText = text
    })
  }

  /** Remove one exact copy of content before a dedicated card takes ownership. */
  async removeText(content: string): Promise<void> {
    if (content === '') return
    return this.locked(() => {
      this.fullText = this.fullText.replace(content, '').trim()
      this.analysisText = this.analysisText.replace(content, '').trim()
    })
  }

  isDegraded(): boolean {
    return this.degraded
  }

  /**
   * Re-deliver the answer out-of-band (markdown file attachment, falling
   * back to chunked text) so it is never lost when the card cannot show it.
   * Must NOT hold the lock.
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
      if (this.async !== undefined) {
        const handle = this.previewMsgID
        this.lastSentText = display
        this.lastSentViaUpdate = true
        this.degraded = false
        this.async.enqueue(async () => {
          try {
            await updater.updateMessage(handle, display)
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
        await updater.updateMessage(this.previewMsgID, display)
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
          await updater.updateMessage(handle, display)
        } catch (error) {
          console.warn(`stream preview: async markFailed PATCH failed, sending fallback: ${String(error)}`)
          await this.fallbackSend(handle, answerText)
        }
      })
      return
    }
    try {
      await updater.updateMessage(this.previewMsgID, display)
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
      if (this.previewMsgID === undefined) return
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
      if (this.previewMsgID === undefined) return undefined
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
   * todo/status block, tool progress entries, 实时播报 section, and the
   * background hint, with the state/ts/tc header protocol. Must hold the lock.
   */
  /** @internal White-box: ported same-package tests call this directly. Caller must hold the lock. */
  buildProgressDisplayLocked(): string {
    let b = ''

    // State prefix for the platform layer to set card header color/title.
    if (this.completed) {
      b += '__cc_state__:completed\n'
      b += `__cc_ts__:${hms()}\n`
    } else if (this.failed) {
      b += '__cc_state__:failed\n'
      b += `__cc_ts__:${hms()}\n`
    } else if (this.thinkingText !== '') {
      b += '__cc_state__:thinking\n'
      b += `__cc_ts__:${hms()}\n`
    } else {
      b += `__cc_ts__:${hms()}\n`
    }
    if (this.toolCallSeq > 0) b += `__cc_tc__:${this.toolCallSeq}\n`

    // Section 0: 回复正文 — assistant text accumulated before progressMode.
    if (this.fullText !== '') {
      const [leadIn] = stripTrailingSilent(this.fullText)
      if (leadIn !== '') b += `${leadIn}\n`
    }

    // Section 1: 待办事项 + 状态计数（失败/压缩/技能）in one code block.
    const hasToolEntries = this.progressEntries.some(e => e.isTool)
    const hasStatus = this.todoItems.length > 0 || this.failureCount > 0 || this.compactCount > 0 || this.skillNames.length > 0
    if (hasStatus) {
      b += '```\n'
      // 摘要统计置顶（失败/压缩/技能）；待办跟在后面
      if (this.failureCount > 0) b += `🔴调用失败：${this.failureCount}/${this.progressTotalCount}\n`
      if (this.compactCount > 0) b += `🗜上下文压缩：${this.compactCount}次\n`
      if (this.skillNames.length > 0) b += `📚 技能：${this.skillNames.join('、')}\n`
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

    // Section 4: 后台任务提示 (foreground path only)
    if (this.bgTaskHint !== '') {
      b += '\n'
      b += this.bgTaskHint
    }

    return b
  }
}

/** Create a streaming preview (Go newStreamPreview). */
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
