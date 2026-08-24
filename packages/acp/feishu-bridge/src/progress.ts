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

/**
 * Whether a tool name is the todo-list tool: dsh `todo_write` or the
 * Claude-style `TodoWrite`.
 *
 * @param name - Invoked tool name.
 * @returns True when the tool's input carries a todo list.
 */
export function isTodoToolName(name: string): boolean {
  return name.trim().toLowerCase().replaceAll('_', '') === 'todowrite'
}

/**
 * Parse a todo-list tool input into card todo items.
 *
 * @param text - Raw tool input JSON: `{todos: [{content, status, activeForm?}]}`.
 * @returns Parsed items — empty when the list is empty (clears the section);
 *   undefined when the input is not shaped like a todo call (keeps the last list).
 */
export function parseTodoItems(text: string): TodoItem[] | undefined {
  let input: { todos?: Array<{ content?: string; status?: string; activeForm?: string }> }
  try {
    input = JSON.parse(text) as typeof input
  } catch {
    return undefined
  }
  if (!Array.isArray(input.todos)) return undefined
  const out: TodoItem[] = []
  for (const todo of input.todos) {
    const content = (todo.content ?? '').trim()
    if (content === '') continue
    const item: TodoItem = { content, status: (todo.status ?? '').trim() }
    const activeForm = (todo.activeForm ?? '').trim()
    if (activeForm !== '') item.activeForm = activeForm
    out.push(item)
  }
  return out
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

/**
 * Prefix marking a structured payload serialized into text content at the
 * Platform seam (the `__cc_connect_progress_card_v1__:` JSON-in-string codec).
 * Payload-style writers now pass {@link ProgressCardPayload} objects through
 * the seam, so this codec only remains as the text-path decoder for prefixed
 * strings; it is not the Feishu wire format (cards travel as rendered card
 * JSON).
 */
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
 * Trim one entry into its normalized form. An empty kind (only possible from
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
 * Build the normalized structured progress payload (V2) from ordered typed
 * events.
 *
 * @param items - Ordered typed progress events.
 * @param truncated - Whether older events were dropped.
 * @param agent - Agent label for the card title.
 * @param lang - Progress language tag.
 * @param state - Card lifecycle state; empty string normalizes to running.
 * @param extraTodos - Todo items for the dedicated task list section.
 * @param lastTS - Latest tool-call timestamp for the card title.
 * @returns The normalized payload, or undefined when no items survive.
 */
export function buildProgressCardPayload(
  items: ProgressCardEntry[],
  truncated: boolean,
  agent: string,
  lang: string,
  state: ProgressCardState | '',
  extraTodos: TodoItem[],
  lastTS: string,
): ProgressCardPayload | undefined {
  const cleaned: ProgressCardEntry[] = []
  for (const item of items) {
    const text = item.text.trim()
    if (text === '') continue
    cleaned.push(cleanEntry(item, text))
  }
  if (cleaned.length === 0) return undefined
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
  return payload
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
