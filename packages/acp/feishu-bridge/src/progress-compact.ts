/**
 * Compact progress writer ported from cc-connect core/progress_compact.go:
 * coalesces intermediate progress (thinking/tool use) into one editable
 * message for platforms supporting in-place updates, in "compact" (text) or
 * "card" (structured payload) style. The Go 15s API deadline becomes a
 * promise race that rejects on timeout so a hung platform call cannot block
 * the turn forever.
 *
 * @module dsh-feishu-bridge/progress-compact
 */

import {
  asMessageUpdater,
  asPreviewStarter,
  type Platform,
  type PreviewStarter,
  type MessageUpdater,
  type ProgressContent,
} from './core/types.ts'
import type { AsyncSender } from './async-sender.ts'
import {
  buildProgressCardPayload,
  progressStyleCard,
  progressStyleCompact,
  progressStyleLegacy,
  type ProgressCardEntry,
  type ProgressCardEntryKind,
  type ProgressCardPayload,
  type ProgressCardState,
  type TodoItem,
} from './progress.ts'

/** Bound each platform progress-card API call (Go compactProgressAPITimeout). */
const compactProgressAPITimeout = 15_000

async function withAPITimeout<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error('progress writer API timeout')) }, compactProgressAPITimeout)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function normalizeProgressStyle(style: string): string {
  switch (style.trim().toLowerCase()) {
    case '':
    case progressStyleLegacy:
      return progressStyleLegacy
    case progressStyleCompact:
      return progressStyleCompact
    case progressStyleCard:
      return progressStyleCard
    default:
      return progressStyleLegacy
  }
}

/**
 * The platform's advertised progress style (legacy when unadvertised).
 *
 * @param p - Platform possibly exposing progressStyle().
 * @returns Normalized progress style; legacy when unadvertised.
 */
export function progressStyleForPlatform(p: Platform): string {
  const provider = p as { progressStyle?: () => string }
  if (typeof provider.progressStyle !== 'function') return progressStyleLegacy
  return normalizeProgressStyle(provider.progressStyle())
}

/**
 * Whether the platform advertises structured progress-card payloads.
 *
 * @param p - Platform possibly exposing supportsProgressCardPayload().
 * @returns Whether the platform accepts structured progress-card payloads.
 */
export function progressCardPayloadForPlatform(p: Platform): boolean {
  const provider = p as { supportsProgressCardPayload?: () => boolean }
  return typeof provider.supportsProgressCardPayload === 'function' && provider.supportsProgressCardPayload()
}

function progressStyleForTarget(p: Platform, replyCtx: unknown): string {
  const hint = replyCtx as { progressStyleHint?: () => string } | undefined | null
  if (typeof hint?.progressStyleHint === 'function') return normalizeProgressStyle(hint.progressStyleHint())
  return progressStyleForPlatform(p)
}

function progressCardPayloadForTarget(p: Platform, replyCtx: unknown): boolean {
  const hint = replyCtx as { supportsProgressCardPayloadHint?: () => boolean } | undefined | null
  if (typeof hint?.supportsProgressCardPayloadHint === 'function') return hint.supportsProgressCardPayloadHint()
  return progressCardPayloadForPlatform(p)
}

/**
 * Whether a platform opts into progress styling but uses legacy mode: tool
 * results then skip the standalone chat message to avoid duplicate noise.
 *
 * @param p - Platform to inspect.
 * @returns Whether standalone tool-result messages are suppressed.
 */
export function suppressStandaloneToolResultEvent(p: Platform): boolean {
  const provider = p as { progressStyle?: () => string }
  if (typeof provider.progressStyle !== 'function') return false
  return progressStyleForPlatform(p) === progressStyleLegacy
}

function normalizeProgressAgentLabel(name: string): string {
  switch (name.trim().toLowerCase()) {
    case '':
    case 'agent':
      return 'Agent'
    case 'codex':
      return 'Codex'
    case 'claudecode':
    case 'claude-code':
    case 'cc':
      return 'CC'
    case 'gemini':
      return 'Gemini'
    case 'cursor':
      return 'Cursor'
    case 'qoder':
      return 'Qoder'
    case 'iflow':
      return 'iFlow'
    case 'opencode':
      return 'OpenCode'
    case 'mimocode':
    case 'mimo':
      return 'MiMo'
    case 'pi':
      return 'PI'
    default: {
      const n = name.trim()
      if (n === '') return 'Agent'
      return n.charAt(0).toUpperCase() + n.slice(1)
    }
  }
}

function renderCardProgressMarkdownFallback(entries: string[], truncated: boolean): string {
  let b = '⏳ **Progress**\n'
  if (truncated) b += '_Showing latest updates only._\n'
  entries.forEach((entry, i) => {
    b += `\n${i + 1}. ${entry.replaceAll('\n', '\n   ')}`
  })
  return b
}

/**
 * Coalesces intermediate progress into one editable preview message. Append
 * returns true when this writer handled the item; false means the caller
 * falls back to legacy per-event sends.
 */
export class CompactProgressWriter {
  private readonly platform: Platform
  private readonly replyCtx: unknown
  private readonly transform: ((s: string) => string) | undefined

  private starter: PreviewStarter | undefined
  private updater: MessageUpdater | undefined
  private handle: unknown

  /**
   * Whether the platform supports in-place updates so this writer is active.
   *
   * @internal White-box: ported same-package tests read these.
   */
  enabled: boolean = false
  /**
   * Whether a platform API call failed; later appends are skipped.
   *
   * @internal White-box: ported same-package tests read these.
   */
  failed: boolean = false
  /**
   * Normalized progress style for the target platform/reply context.
   *
   * @internal White-box: ported same-package tests read these.
   */
  style: string
  /**
   * Whether to transport structured payloads instead of markdown fallback text.
   *
   * @internal White-box: ported same-package tests read these.
   */
  usePayload: boolean = false
  private readonly async: AsyncSender | undefined

  private content = ''
  private entries: string[] = []
  private items: ProgressCardEntry[] = []
  private payload: ProgressCardPayload | undefined
  private state: ProgressCardState
  private readonly agentName: string
  private readonly lang: string
  private truncated = false
  private lastSent = ''
  private readonly maxEntries: number = 10
  private todos: TodoItem[] = []
  private lastTS = ''

  constructor(
    p: Platform,
    replyCtx: unknown,
    agentName: string,
    lang: string,
    transform: ((s: string) => string) | undefined,
    as: AsyncSender | undefined,
  ) {
    this.platform = p
    this.replyCtx = replyCtx
    this.transform = transform
    this.style = progressStyleForTarget(p, replyCtx)
    this.state = 'running'
    this.agentName = normalizeProgressAgentLabel(agentName)
    this.lang = lang
    this.async = as
    if (this.style !== progressStyleCompact && this.style !== progressStyleCard) return
    const updater = asMessageUpdater(p)
    if (updater === undefined) return
    this.enabled = true
    this.updater = updater
    this.starter = asPreviewStarter(p)
    if (this.style === progressStyleCard && progressCardPayloadForTarget(p, replyCtx)) {
      this.usePayload = true
    }
  }

  /**
   * Store the latest todo items for display as a dedicated section.
   *
   * @param items - Latest todo items.
   */
  setTodos(items: TodoItem[]): void {
    if (!this.enabled) return
    this.todos = items
  }

  /**
   * Append one progress item (info kind); see {@link appendStructured}.
   *
   * @param item - Text of the info-kind event.
   * @returns True when this writer handled the item; false means the caller falls back to legacy sends.
   */
  async append(item: string): Promise<boolean> {
    return this.appendEvent('info', item, '', item)
  }

  /**
   * Append one typed progress event; fallback is used for compact/plain rendering.
   *
   * @param kind - Event kind.
   * @param text - Event text.
   * @param tool - Tool name for tool events; empty string otherwise.
   * @param fallback - Plain text used for compact-style rendering.
   * @returns True when this writer handled the event; false means the caller falls back to legacy sends.
   */
  async appendEvent(kind: ProgressCardEntryKind, text: string, tool: string, fallback: string): Promise<boolean> {
    return this.appendStructured({ kind, text, tool }, fallback)
  }

  /**
   * Append one structured progress event and update the in-place message.
   *
   * @param item - Structured progress event.
   * @param fallbackIn - Plain text used for compact-style rendering.
   * @returns True when this writer handled the event; false means the caller falls back to legacy sends.
   */
  async appendStructured(item: ProgressCardEntry, fallbackIn: string): Promise<boolean> {
    if (!this.enabled || this.failed) return false
    let text = item.text.trim()
    let fallback = fallbackIn.trim()
    if (text === '' && fallback === '') return true
    if (text === '') text = fallback
    if (fallback === '') fallback = text
    if (item.kind === 'thinking' || item.kind === 'error' || item.kind === 'info') {
      if (this.transform !== undefined) {
        text = this.transform(text)
        fallback = this.transform(fallback)
      }
    }
    const kind = (item.kind as string) === '' ? 'info' : item.kind
    const entry: ProgressCardEntry = { kind, text, tool: (item.tool ?? '').trim(), status: (item.status ?? '').trim() }

    if (this.style === progressStyleCard) {
      if (kind === 'tool_use') this.lastTS = new Date().toTimeString().slice(0, 8)
      this.items.push(entry)
      this.entries.push(fallback)
      let truncated = false
      if (this.maxEntries > 0 && this.items.length > this.maxEntries) {
        this.items = this.items.slice(this.items.length - this.maxEntries)
        if (this.entries.length > this.maxEntries) {
          this.entries = this.entries.slice(this.entries.length - this.maxEntries)
        }
        truncated = true
      } else if (this.maxEntries > 0 && this.entries.length > this.maxEntries) {
        this.entries = this.entries.slice(this.entries.length - this.maxEntries)
        truncated = true
      }
      this.truncated = truncated
      // The markdown fallback doubles as the plain-text form for the
      // no-preview-starter degenerate path (a structured payload has none).
      this.content = renderCardProgressMarkdownFallback(this.entries, truncated)
      if (this.usePayload) {
        this.payload = buildProgressCardPayload(
          this.items, this.truncated, this.agentName, this.lang, this.state, this.todos, this.lastTS)
        if (this.payload === undefined) {
          console.warn(`progress writer: failed to build structured payload (${this.platform.name()})`)
          this.failed = true
          return false
        }
      }
    } else {
      this.content = this.content === '' ? fallback : `${this.content}\n\n${fallback}`
    }

    const signature = this.currentSignature()
    if (signature === this.lastSent) return true

    if (this.handle === undefined) {
      if (this.starter !== undefined) {
        let handle: unknown
        try {
          handle = await withAPITimeout(this.starter.sendPreviewStart(this.replyCtx, this.currentContent()))
        } catch (error) {
          console.warn(`progress writer: SendPreviewStart failed (${this.platform.name()}): ${String(error)}`)
          this.failed = true
          return false
        }
        if (handle === undefined || handle === null) {
          console.warn(`progress writer: SendPreviewStart returned no handle (${this.platform.name()})`)
          this.failed = true
          return false
        }
        this.handle = handle
        this.lastSent = signature
        return true
      }
      try {
        await withAPITimeout(this.platform.send(this.replyCtx, this.content))
      } catch (error) {
        console.warn(`progress writer: initial Send failed (${this.platform.name()}): ${String(error)}`)
        this.failed = true
        return false
      }
      this.handle = this.replyCtx
      this.lastSent = signature
      return true
    }

    const handle = this.handle
    const content = this.currentContent()
    if (this.async !== undefined) {
      this.lastSent = signature
      this.async.enqueue(async () => {
        try {
          await withAPITimeout(this.updater?.updateMessage(handle, content) ?? Promise.resolve())
        } catch (error) {
          console.warn(`progress writer: async UpdateMessage failed (${this.platform.name()}): ${String(error)}`)
          this.failed = true
        }
      })
      return true
    }

    try {
      await withAPITimeout(this.updater?.updateMessage(handle, content) ?? Promise.resolve())
    } catch (error) {
      console.warn(`progress writer: UpdateMessage failed (${this.platform.name()}): ${String(error)}`)
      this.failed = true
      return false
    }
    this.lastSent = signature
    return true
  }

  /**
   * Content to send for the current state: the structured payload in
   * card-payload mode, text otherwise. Must not be called before the first
   * successful append in payload mode (payload is then still undefined).
   */
  private currentContent(): ProgressContent {
    if (this.usePayload && this.payload !== undefined) return { kind: 'card', payload: this.payload }
    return { kind: 'text', text: this.content }
  }

  /**
   * Dedup signature of the current content. JSON key order is fixed by the
   * payload builder, so equal payloads stringify identically.
   */
  private currentSignature(): string {
    return this.usePayload && this.payload !== undefined ? JSON.stringify(this.payload) : this.content
  }

  /**
   * Update the card progress state (running/completed/failed) without appending.
   *
   * @param state - Terminal state to transition to; empty string normalizes to completed.
   * @returns True when the card state was updated; false when disabled, failed, or unchanged.
   */
  async finalize(state: ProgressCardState | ''): Promise<boolean> {
    if (!this.enabled || this.failed || this.style !== progressStyleCard || !this.usePayload || this.handle === undefined) {
      return false
    }
    const next = state === '' ? 'completed' : state
    if (this.state === next) return true
    this.state = next
    this.payload = buildProgressCardPayload(this.items, this.truncated, this.agentName, this.lang, this.state, this.todos, this.lastTS)
    const signature = this.payload !== undefined ? JSON.stringify(this.payload) : ''
    if (this.payload === undefined || signature === this.lastSent) return this.payload !== undefined
    try {
      await withAPITimeout(this.updater?.updateMessage(this.handle, { kind: 'card', payload: this.payload }) ?? Promise.resolve())
    } catch (error) {
      console.warn(`progress writer: Finalize UpdateMessage failed (${this.platform.name()}): ${String(error)}`)
      this.failed = true
      return false
    }
    this.lastSent = signature
    return true
  }
}

/**
 * Create a compact progress writer (Go newCompactProgressWriter).
 *
 * @param p - Platform to render progress on.
 * @param replyCtx - Platform reply context the writer sends into.
 * @param agentName - Agent label shown on the card.
 * @param lang - Progress language tag.
 * @param transform - Optional text transform applied to thinking/error/info text.
 * @param as - Optional async sender queueing in-place updates.
 * @returns The constructed compact progress writer.
 */
export function newCompactProgressWriter(
  p: Platform,
  replyCtx: unknown,
  agentName: string,
  lang: string,
  transform: ((s: string) => string) | undefined,
  as: AsyncSender | undefined,
): CompactProgressWriter {
  return new CompactProgressWriter(p, replyCtx, agentName, lang, transform, as)
}
