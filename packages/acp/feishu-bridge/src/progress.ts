/**
 * Structured progress-card payload ported from cc-connect core/progress.go
 * and core/progress_compact.go's payload layer: the typed event model
 * transported between the engine-side progress writers and platform card
 * renderers, plus style validation.
 *
 * @module dsh-feishu-bridge/progress
 */

/** Progress card lifecycle state. */
export type ProgressCardState = 'running' | 'completed' | 'failed'

/** Kind of one progress entry. */
export type ProgressCardEntryKind = 'info' | 'thinking' | 'tool_use' | 'tool_result' | 'error'

/** One typed progress event shown as a card entry. */
export interface ProgressCardEntry {
  kind: ProgressCardEntryKind
  text: string
  tool?: string
  status?: string
  exitCode?: number
  success?: boolean
}

/** One todo item from a TodoWrite tool input. */
export interface TodoItem {
  id?: string
  content: string
  /** "completed", "in_progress", or "pending". */
  status: string
  activeForm?: string
  description?: string
}

/** Structured progress payload for platforms that render custom progress cards. */
export interface ProgressCardPayload {
  version?: number
  agent?: string
  lang?: string
  state?: ProgressCardState
  /** Legacy text-only fallback entries. */
  entries?: string[]
  /** Ordered typed events. */
  items?: ProgressCardEntry[]
  /** Dedicated task list section. */
  todos?: TodoItem[]
  truncated: boolean
  /** Latest tool call timestamp for the card title. */
  lastTS?: string
}

/** Marks a structured payload for card-style progress. */
export const ProgressCardPayloadPrefix = '__cc_connect_progress_card_v1__:'

/** Legacy progress style: per-event chat messages. */
const progressStyleLegacy = 'legacy'
/** Compact progress style: coalesced editable message. */
const progressStyleCompact = 'compact'
/** Card progress style: structured progress card payload. */
const progressStyleCard = 'card'

export { progressStyleLegacy, progressStyleCompact, progressStyleCard }

/**
 * Validate and normalise a progress_style config value: "legacy" (default),
 * "compact", or "card".
 *
 * @param platformName - Platform name for the error message.
 * @param raw - Config value to validate.
 * @returns Normalized style name.
 */
export function parseProgressStyle(platformName: string, raw: string): string {
  const v = raw.trim().toLowerCase()
  switch (v) {
    case '':
    case progressStyleLegacy:
      return progressStyleLegacy
    case progressStyleCompact:
    case progressStyleCard:
      return v
    default:
      throw new Error(`${platformName}: invalid progress_style "${raw}" (want legacy, compact, or card)`)
  }
}

/**
 * Encode legacy text-only progress entries into a transport string.
 *
 * @param entries - Legacy text-only progress entries.
 * @param truncated - Whether older entries were dropped.
 * @returns Transport string with the payload prefix, or empty string when no entries survive.
 */
export function buildProgressCardPayload(entries: string[], truncated: boolean): string {
  const cleaned: string[] = []
  for (const entry of entries) {
    const trimmed = entry.trim()
    if (trimmed !== '') cleaned.push(trimmed)
  }
  if (cleaned.length === 0) return ''
  const payload: ProgressCardPayload = { entries: cleaned, truncated }
  return ProgressCardPayloadPrefix + JSON.stringify(payload)
}

/**
 * Trim one entry into its transport form. An empty kind (only possible from
 * parsed JSON, where it is the Go zero value) normalizes to "info"; optional
 * fields drop when absent.
 */
function cleanEntry(item: ProgressCardEntry, text: string): ProgressCardEntry {
  const cleaned: ProgressCardEntry = {
    kind: (item.kind as string) === '' ? 'info' : item.kind,
    text,
  }
  const tool = (item.tool ?? '').trim()
  if (tool !== '') cleaned.tool = tool
  const status = (item.status ?? '').trim()
  if (status !== '') cleaned.status = status
  if (item.exitCode !== undefined) cleaned.exitCode = item.exitCode
  if (item.success !== undefined) cleaned.success = item.success
  return cleaned
}

/**
 * Encode ordered typed progress events (V2) into a transport string.
 *
 * @param items - Ordered typed progress events.
 * @param truncated - Whether older events were dropped.
 * @param agent - Agent label for the card title.
 * @param lang - Progress language tag.
 * @param state - Card lifecycle state; empty string normalizes to running.
 * @param extraTodos - Todo items for the dedicated task list section.
 * @param lastTS - Latest tool-call timestamp for the card title.
 * @returns Transport string with the payload prefix, or empty string when no items survive.
 */
export function buildProgressCardPayloadV2(
  items: ProgressCardEntry[],
  truncated: boolean,
  agent: string,
  lang: string,
  state: ProgressCardState | '',
  extraTodos: TodoItem[],
  lastTS: string,
): string {
  const cleaned: ProgressCardEntry[] = []
  for (const item of items) {
    const text = item.text.trim()
    if (text === '') continue
    cleaned.push(cleanEntry(item, text))
  }
  if (cleaned.length === 0) return ''
  const payload: ProgressCardPayload = {
    version: 2,
    agent: agent.trim(),
    lang,
    state: state === '' ? 'running' : state,
    items: cleaned,
    truncated,
    lastTS,
  }
  if (extraTodos.length > 0) payload.todos = extraTodos
  return ProgressCardPayloadPrefix + JSON.stringify(payload)
}

/**
 * Decode a structured progress payload; false when absent or malformed.
 *
 * @param content - Raw content, possibly payload-prefixed.
 * @returns Decoded payload with normalized items, or undefined when absent or malformed.
 */
export function parseProgressCardPayload(content: string): ProgressCardPayload | undefined {
  if (!content.startsWith(ProgressCardPayloadPrefix)) return undefined
  const raw = content.slice(ProgressCardPayloadPrefix.length)
  let payload: ProgressCardPayload
  try {
    payload = JSON.parse(raw) as ProgressCardPayload
  } catch {
    return undefined
  }
  const legacy: string[] = []
  for (const entry of payload.entries ?? []) {
    const trimmed = entry.trim()
    if (trimmed !== '') legacy.push(trimmed)
  }
  const items: ProgressCardEntry[] = []
  for (const item of payload.items ?? []) {
    const text = (typeof item.text === 'string' ? item.text : '').trim()
    if (text === '') continue
    items.push(cleanEntry(item, text))
  }
  if (items.length === 0 && legacy.length > 0) {
    for (const entry of legacy) {
      items.push({ kind: inferLegacyEntryKind(entry), text: entry })
    }
  }
  if (items.length === 0 && legacy.length === 0) return undefined
  if ((payload.state ?? '') === '') payload.state = 'running'
  payload.items = items
  payload.entries = legacy
  if ((payload.entries ?? []).length === 0 && items.length > 0) {
    payload.entries = items.map(item => item.text)
  }
  return payload
}

/**
 * Infer the entry kind from a legacy emoji-prefixed text entry.
 *
 * @param entry - Legacy text entry.
 * @returns Entry kind inferred from emoji prefixes and tool markers.
 */
export function inferLegacyEntryKind(entry: string): ProgressCardEntryKind {
  if (entry.startsWith('💭')) return 'thinking'
  if (entry.startsWith('🔧') || entry.includes('**Tool #')) return 'tool_use'
  if (entry.startsWith('🧾')) return 'tool_result'
  if (entry.startsWith('❌')) return 'error'
  return 'info'
}
