/**
 * Feishu progress-card assembly ported from cc-connect platform/feishu
 * feishu_progress.go: text-path and payload-path progress card JSON, the
 * structured preview status (formerly the __cc_state__/__cc_ts__/__cc_tc__
 * header lines), structural blank-line
 * collapsing, and the stop/export button injections that mutate a rendered
 * card JSON in place. buildReplyContent (Go feishu_markdown.go) lives here
 * too: it needs buildCardJSON and markdown.ts must not import this module's
 * dependents.
 *
 * @module dsh-feishu-bridge/feishu-progress
 */

import {
  collapseExcessCardTables,
  buildPostMdJSON,
  containsMarkdown,
  countMarkdownTables,
  finalizeFeishuCardMarkdown,
  maxCardTables,
  msgTypeInteractive,
  msgTypePost,
  msgTypeText,
  padBoldDelimiters,
  preprocessFeishuMarkdown,
  sanitizeFeishuMarkdownHTML,
  sanitizeMarkdownURLs,
  isTableRow,
  FenceTracker,
} from './markdown.ts'
import { cardHeaderPadding, compactCardBody, type FeishuCardMap } from './card.ts'
import { noSpinner, spinnerKeyForItems, spinnerKeyForState, type SpinnerCfg } from './spinner.ts'
import {
  isTodoToolName,
  parseProgressCardPayload,
  parseTodoItems,
  type ProgressCardEntry,
  type ProgressCardPayload,
} from '../progress.ts'
import type { ProgressStatus } from '../core/types.ts'

/**
 * One-line markdown card body.
 *
 * @param content - Markdown body for the card.
 * @returns Feishu interactive-card JSON string.
 */
export function buildCardJSON(content: string): string {
  return buildCardJSONWithHeader(content, '', '', '')
}

/**
 * Markdown card with an optional header (title/template) and running-state GIF icon.
 *
 * @param content - Markdown body for the card.
 * @param title - Header title; empty string omits the header.
 * @param template - Header color template (e.g. "green").
 * @param iconKey - Header custom_icon image key; empty string renders no icon.
 * @returns Feishu interactive-card JSON string.
 */
export function buildCardJSONWithHeader(content: string, title: string, template: string, iconKey: string): string {
  const card: FeishuCardMap = {
    schema: '2.0',
    config: { wide_screen_mode: true },
  }
  if (title !== '') {
    const header: FeishuCardMap = {
      title: { tag: 'plain_text', content: title },
      template,
      padding: cardHeaderPadding,
    }
    // Running-state loading GIF as a header prefix icon (custom_icon);
    // iconKey is empty for non-running states / disabled feature.
    if (iconKey !== '') header.icon = { tag: 'custom_icon', img_key: iconKey }
    card.header = header
  }
  card.body = compactCardBody([{ tag: 'markdown', content }])
  return JSON.stringify(card)
}

/**
 * Outbound reply routing (Go buildReplyContent): plain text when no
 * markdown; card for markdown (schema 2.0 renders best); post-md fallback
 * only when the content exceeds the card table limit (API error 11310).
 *
 * @param content - Outbound reply text (may contain markdown).
 * @returns Message type plus serialized body for the Feishu send API.
 */
export function buildReplyContent(content: string): { msgType: string; body: string } {
  if (!containsMarkdown(content)) {
    return { msgType: msgTypeText, body: JSON.stringify({ text: content }) }
  }
  if (countMarkdownTables(content) > maxCardTables) {
    return { msgType: msgTypePost, body: buildPostMdJSON(content) }
  }
  return { msgType: msgTypeInteractive, body: buildCardJSON(finalizeFeishuCardMarkdown(content)) }
}

/**
 * Whether the progress lang is Chinese-like (titles/labels localize).
 *
 * @param lang - Progress language tag.
 * @returns True when labels should localize to Chinese.
 */
export function isZhLikeProgressLang(lang: string): boolean {
  return lang.trim().toLowerCase().startsWith('zh')
}

/**
 * Normalize the agent label shown on progress cards.
 *
 * @param agent - Raw agent name from the payload.
 * @returns Trimmed label, or "Agent" when empty.
 */
export function progressAgentLabel(agent: string): string {
  const trimmed = agent.trim()
  return trimmed === '' ? 'Agent' : trimmed
}

/**
 * Card title/template/footer for a progress state.
 *
 * @param state - Payload state driving the title and template.
 * @param lang - Progress language tag.
 * @param _agent - Unused; kept for the Go signature.
 * @param lastTS - Latest tool-call timestamp appended to the title; empty string omits it.
 * @returns Card title, header color template, and footer text.
 */
export function progressStateMeta(
  state: ProgressCardPayload['state'],
  lang: string,
  _agent: string,
  lastTS: string,
): { title: string; template: string; footer: string } {
  const zh = isZhLikeProgressLang(lang)
  let title: string
  let template: string
  switch (state) {
    case 'completed':
      title = zh ? '执行完成' : 'Completed'
      template = 'green'
      break
    case 'failed':
      title = zh ? '执行失败' : 'Failed'
      template = 'red'
      break
    default:
      title = zh ? '执行中' : 'Running'
      template = 'yellow'
      break
  }
  if (lastTS !== '') title = `${title} · ${lastTS}`
  return { title, template, footer: '' }
}

/**
 * Localized label for one progress entry kind.
 *
 * @param kind - Entry kind to label.
 * @param lang - Progress language tag.
 * @returns Localized label for the kind.
 */
export function progressKindLabel(kind: ProgressCardEntry['kind'], lang: string): string {
  const zh = isZhLikeProgressLang(lang)
  switch (kind) {
    case 'thinking':
      return zh ? '思考' : 'Thinking'
    case 'tool_use':
      return zh ? '工具调用' : 'Tool'
    case 'tool_result':
      return zh ? '工具结果' : 'Result'
    case 'error':
      return zh ? '错误' : 'Error'
    default:
      return zh ? '更新' : 'Update'
  }
}

/**
 * Prefer typed items; fall back to legacy entries with inferred kinds.
 *
 * @param payload - Parsed progress payload (may be undefined).
 * @returns Typed items; legacy entries fall back to emoji-based kind inference.
 */
export function normalizeProgressItems(payload: ProgressCardPayload | undefined): ProgressCardEntry[] {
  if (payload === undefined) return []
  if ((payload.items ?? []).length > 0) return payload.items ?? []
  const out: ProgressCardEntry[] = []
  for (const entry of payload.entries ?? []) {
    const trimmed = entry.trim()
    if (trimmed === '') continue
    let kind: ProgressCardEntry['kind'] = 'info'
    if (trimmed.startsWith('💭')) kind = 'thinking'
    else if (trimmed.startsWith('🔧') || trimmed.includes('**Tool #')) kind = 'tool_use'
    else if (trimmed.startsWith('🧾')) kind = 'tool_result'
    else if (trimmed.startsWith('❌')) kind = 'error'
    out.push({ kind, text: trimmed })
  }
  return out
}

/**
 * Inline-code text: trim and neutralize backticks.
 *
 * @param s - Raw text.
 * @returns Trimmed text with backticks replaced by single quotes.
 */
export function inlineCodeText(s: string): string {
  return s.trim().replaceAll('`', "'")
}

/**
 * Format a todo-list tool input into a readable markdown list; empty string
 * when parsing fails or no todos remain. Todo content and active forms are
 * untrusted card markdown, so the composed list is HTML-sanitized — bare
 * tags would trigger the 11311 card rejection.
 *
 * @param text - Raw todo tool input JSON.
 * @returns Markdown list with status icons, or empty string.
 */
export function formatTodoWriteInput(text: string): string {
  const items = parseTodoItems(text)
  if (items === undefined || items.length === 0) return ''

  let sb = ''
  for (const todo of items) {
    let icon: string
    switch (todo.status.trim().toLowerCase()) {
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
    // Escape markdown special characters
    const safeContent = todo.content.replaceAll('`', "'")
    sb += `${icon} ${safeContent}`
    const activeForm = todo.activeForm ?? ''
    if (activeForm !== '' && activeForm !== todo.content) {
      sb += ` _(${activeForm.replaceAll('`', "'")})_`
    }
    sb += '\n'
  }
  const list = sb.endsWith('\n') ? sb.slice(0, -1) : sb
  // Sanitize after the loop's backtick neutralization: with no backticks
  // left, no line can look like a fence opener and hide a tag from the strip.
  return sanitizeFeishuMarkdownHTML(list)
}

/**
 * Fixed number of lines every tool input/result code block occupies in the
 * progress card, keeping card height stable across PATCH updates.
 */
export const maxProgressEntryLines = 6

/** Characters per line cap in progress code blocks (prevents wrapping). */
export const maxProgressLineChars = 120

/**
 * Normalize s to exactly maxLines lines: empty → placeholders, fewer →
 * padded, more → first maxLines-1 lines + "... (N more lines)".
 *
 * @param s - Raw text to normalize.
 * @param maxLines - Exact line count to produce.
 * @returns Text normalized to exactly maxLines lines.
 */
export function padProgressLines(s: string, maxLines: number): string {
  if (maxLines <= 0) return s
  if (s === '') return ' \n'.repeat(maxLines - 1) + ' '
  const lines = s.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    if (Array.from(line).length > maxProgressLineChars) {
      lines[i] = `${Array.from(line).slice(0, maxProgressLineChars).join('')}...`
    }
  }
  if (lines.length < maxLines) {
    while (lines.length < maxLines) lines.push(' ')
    return lines.join('\n')
  }
  if (lines.length === maxLines) return lines.join('\n')
  const extra = lines.length - maxLines + 1
  return `${lines.slice(0, maxLines - 1).join('\n')}\n... (${extra} more lines)`
}

/**
 * Pad/truncate lines within code blocks; text outside code blocks stays intact.
 *
 * @param s - Text possibly containing fenced code blocks.
 * @param maxLines - Exact line count per code block.
 * @returns Text with padded/truncated code blocks; other text intact.
 */
export function padCodeBlockContent(s: string, maxLines: number): string {
  if (maxLines <= 0 || !s.includes('```')) return s
  let b = ''
  let remaining = s
  let inCode = false
  for (;;) {
    const idx = remaining.indexOf('```')
    if (idx === -1) {
      b += remaining
      break
    }
    if (!inCode) {
      b += remaining.slice(0, idx)
      b += '```'
      const afterFence = remaining.slice(idx + 3)
      const nlIdx = afterFence.indexOf('\n')
      if (nlIdx === -1) {
        b += afterFence
        break
      }
      b += afterFence.slice(0, nlIdx + 1)
      remaining = afterFence.slice(nlIdx + 1)
      inCode = true
    } else {
      const content = trimTrailingNewlines(remaining.slice(0, idx))
      b += padProgressLines(content, maxLines)
      b += '\n```'
      remaining = remaining.slice(idx + 3)
      inCode = false
    }
  }
  return b
}

function trimTrailingNewlines(s: string): string {
  return s.replace(/\n+$/, '')
}

/**
 * Format a tool input for the progress card (todo tools get a markdown list).
 *
 * @param toolName - Tool name; `todo_write`/`TodoWrite` input renders as a markdown list.
 * @param text - Raw tool input text.
 * @returns Formatted markdown for the progress card entry.
 */
export function formatProgressToolInput(toolName: string, text: string): string {
  let t = text.trim()
  if (t === '') return ''

  if (isTodoToolName(toolName)) {
    const formatted = formatTodoWriteInput(t)
    if (formatted !== '') return formatted
    return `\`\`\`python\n${padProgressLines(t, maxProgressEntryLines)}\n\`\`\``
  }

  // Sanitize before any formatting: prose outside fences carries bare HTML
  // tags that card markdown rejects with 11311; fenced lines stay verbatim
  // inside the sanitizer.
  t = preprocessFeishuMarkdown(sanitizeMarkdownURLs(sanitizeFeishuMarkdownHTML(t)))
  if (t.includes('```')) return padCodeBlockContent(t, maxProgressEntryLines)
  t = padProgressLines(t, maxProgressEntryLines)
  return `\`\`\`python\n${t}\n\`\`\``
}

/**
 * Format a tool result for the progress card.
 *
 * @param text - Raw tool result text.
 * @returns Formatted markdown code block for the progress card entry.
 */
export function formatProgressToolResult(text: string): string {
  let t = text.trim()
  // Sanitize before any formatting: prose outside fences carries bare HTML
  // tags (error stacks, HTML-ish tool output) that card markdown rejects
  // with 11311; fenced lines stay verbatim inside the sanitizer.
  t = preprocessFeishuMarkdown(sanitizeMarkdownURLs(sanitizeFeishuMarkdownHTML(t)))
  if (t.includes('```')) return padCodeBlockContent(t, maxProgressEntryLines)
  t = padProgressLines(t, maxProgressEntryLines)
  return `\`\`\`python\n${t}\n\`\`\``
}

/**
 * Localized "no output" label.
 *
 * @param lang - Progress language tag.
 * @returns Localized "no output" label.
 */
export function progressNoOutputText(lang: string): string {
  return isZhLikeProgressLang(lang) ? '无输出' : 'No output'
}

/**
 * Status dot for a tool-result entry: 🟢 success, 🔴 failure, ⚪ unknown.
 *
 * @param item - Tool-result entry whose success indicators decide the dot.
 * @returns Status dot emoji.
 */
export function progressResultDot(item: ProgressCardEntry): string {
  if (item.success !== undefined) return item.success ? '🟢' : '🔴'
  if (item.exitCode !== undefined) return item.exitCode === 0 ? '🟢' : '🔴'
  const status = (item.status ?? '').trim().toLowerCase()
  if (status === 'completed' || status === 'success' || status === 'succeeded' || status === 'ok') return '🟢'
  if (status === 'failed' || status === 'error') return '🔴'
  return '⚪'
}

/**
 * Render one progress entry as a card element map.
 *
 * @param item - Progress entry to render.
 * @param lang - Progress language tag.
 * @returns Card element map for the entry.
 */
export function renderProgressEntryElement(item: ProgressCardEntry, lang: string): FeishuCardMap {
  const text = item.text.trim() === '' ? ' ' : item.text.trim()
  switch (item.kind) {
    case 'thinking':
      return {
        tag: 'div',
        text: {
          tag: 'plain_text',
          content: `💭 ${inlineCodeText(text)}`,
          text_size: 'notation',
          text_color: 'grey',
        },
      }
    case 'tool_use': {
      const toolName = item.tool?.trim() === '' ? 'Tool' : (item.tool ?? '').trim()
      let content = `<text_tag color='blue'>${progressKindLabel(item.kind, lang)}</text_tag> \`${inlineCodeText(toolName)}\``
      const body = formatProgressToolInput(toolName, text)
      if (body !== '') content += `\n${body}`
      return { tag: 'markdown', content }
    }
    case 'tool_result': {
      const toolName = (item.tool ?? '').trim()
      let content = `<text_tag color='turquoise'>${progressKindLabel(item.kind, lang)}</text_tag>`
      if (toolName !== '') content += ` \`${inlineCodeText(toolName)}\``
      const dot = progressResultDot(item)
      let meta = dot
      if (item.exitCode !== undefined) meta += ` exit code: \`${item.exitCode}\``
      content += `\n${meta}`
      content += `\n${formatProgressToolResult(text)}`
      return { tag: 'markdown', content }
    }
    case 'error':
      return {
        tag: 'markdown',
        // Sanitize the untrusted text before the trusted <text_tag> chrome
        // is composed around it: sanitizeFeishuMarkdownHTML would strip the
        // chrome too, and a bare tag (error stacks carry <anonymous>) would
        // trigger the 11311 PATCH-rejection loop.
        content: `<text_tag color='red'>${progressKindLabel(item.kind, lang)}</text_tag>\n${preprocessFeishuMarkdown(sanitizeMarkdownURLs(sanitizeFeishuMarkdownHTML(text)))}`,
      }
    default:
      // Same first-step HTML sanitize as the error branch: info prose
      // carries untrusted text (agent updates, excerpts) into card markdown.
      return { tag: 'markdown', content: preprocessFeishuMarkdown(sanitizeMarkdownURLs(sanitizeFeishuMarkdownHTML(text))) }
  }
}

/**
 * Build the structured progress card JSON from a payload.
 *
 * @param payload - Structured progress payload.
 * @param spin - Spinner configuration for the running-state header icon.
 * @returns Feishu interactive-card JSON string.
 */
export function buildProgressCardJSONFromPayload(payload: ProgressCardPayload, spin: SpinnerCfg): string {
  const items = normalizeProgressItems(payload)
  if (items.length === 0) return buildCardJSON(' ')

  const agent = progressAgentLabel(payload.agent ?? '')
  const { title, template, footer } = progressStateMeta(payload.state, payload.lang ?? '', agent, payload.lastTS ?? '')

  const elements: FeishuCardMap[] = []
  if (payload.truncated) {
    const truncatedText = isZhLikeProgressLang(payload.lang ?? '') ? '仅显示最近更新。' : 'Showing latest updates only.'
    elements.push({
      tag: 'div',
      text: { tag: 'plain_text', content: truncatedText, text_size: 'notation', text_color: 'grey' },
    })
    elements.push({ tag: 'hr' })
  }

  // Dedicated todo section on top using plain_text divs to avoid markdown
  // parsing issues (e.g. # becoming headings).
  if ((payload.todos ?? []).length > 0) {
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: '📋 Task List' } })
    for (const item of payload.todos ?? []) {
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
      let display: string
      if (item.status.trim().toLowerCase() === 'in_progress' && (item.activeForm ?? '') !== '') {
        display = `${icon} ${(item.activeForm ?? '').replaceAll('\n', ' ')}`
      } else {
        display = `${icon} ${item.content.replaceAll('\n', ' ')}`
      }
      elements.push({ tag: 'div', text: { tag: 'plain_text', content: display } })
    }
    elements.push({ tag: 'hr' })
  }

  items.forEach((item, i) => {
    elements.push(renderProgressEntryElement(item, payload.lang ?? ''))
    if (i < items.length - 1) elements.push({ tag: 'hr' })
  })
  if (footer !== '') {
    elements.push({ tag: 'hr' })
    elements.push({
      tag: 'div',
      text: { tag: 'plain_text', content: footer, text_size: 'notation', text_color: 'grey' },
    })
  }

  const header: FeishuCardMap = {
    title: { tag: 'plain_text', content: title },
    template,
    padding: cardHeaderPadding,
  }
  // Running-state loading GIF as a header prefix icon, chosen by the latest
  // entry kind (thinking vs executing). Non-running states render no icon.
  if (payload.state === 'running') {
    const k = spinnerKeyForItems(spin, items)
    if (k !== '') header.icon = { tag: 'custom_icon', img_key: k }
  }
  const card: FeishuCardMap = {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header,
    body: compactCardBody(elements),
  }
  return JSON.stringify(card)
}

/**
 * Card header title and color template for a state string (+ts, +tool count,
 * +pending native subtasks).
 *
 * @param state - State string from the header protocol.
 * @param zh - Localize the title to Chinese.
 * @param ts - Timestamp appended to the title; empty string omits it.
 * @param tc - Tool count appended when positive.
 * @param pending - Unreported native subtasks appended to terminal titles when positive.
 * @returns Card header title and color template.
 */
export function progressTitleAndColor(
  state: string,
  zh: boolean,
  ts: string,
  tc: number,
  pending = 0,
): { title: string; color: string } {
  let title: string
  let color: string
  switch (state) {
    case 'completed':
      title = zh ? '执行完成' : 'Completed'
      color = 'green'
      break
    case 'failed':
      title = zh ? '执行失败' : 'Failed'
      color = 'red'
      break
    case 'waiting':
      title = zh ? '等待中' : 'Waiting'
      color = 'blue'
      break
    // The four settled states replace a parked card's waiting header once its
    // ask resolves. None may use green: green claims 执行完成, which the
    // pre-ask segment is not; their export/reply buttons ride state-keyed
    // injection instead.
    case 'approved':
      title = zh ? '已批准' : 'Approved'
      color = 'turquoise'
      break
    case 'rejected':
      title = zh ? '已拒绝' : 'Rejected'
      color = 'red'
      break
    case 'answered':
      title = zh ? '已回答' : 'Answered'
      color = 'turquoise'
      break
    case 'cancelled':
      title = zh ? '已取消' : 'Cancelled'
      color = 'grey'
      break
    case 'thinking':
      title = zh ? '思考中' : 'Thinking'
      color = 'violet'
      break
    default:
      title = zh ? '执行中' : 'Running'
      color = 'yellow'
      break
  }
  if (ts !== '') title = `${title} · ${ts}`
  if (tc > 0) title += ` · ${tc}`
  if (pending > 0 && (state === 'completed' || state === 'failed')) {
    title += ` · ${zh ? `${pending} 个子任务在途` : `${pending} subtask(s) in flight`}`
  }
  return { title, color }
}

/**
 * Remove blank lines sitting directly between a code fence or Markdown
 * heading and an adjacent non-empty line, so consecutive tool entries
 * (header paragraph ↔ code block) pack tightly. Blank lines inside code
 * blocks, between non-structural paragraphs, and adjacent to table rows are
 * preserved.
 *
 * @param s - Markdown text.
 * @returns Text with structural blank lines removed.
 */
export function collapseStructuralBlankLines(s: string): string {
  const lines = s.split('\n')
  const isFence = (l: string): boolean => l.trim().startsWith('```')
  // ATX heading: #'s must be followed by whitespace (or end of line);
  // "#59（随便聊聊）…" is a plain numbered reference, not a heading.
  const isHeading = (l: string): boolean => {
    const t = l.trim()
    if (isFence(l)) return false
    const n = t.length - t.replace(/^#+/, '').length
    return n > 0 && (t.length === n || t.charAt(n) === ' ' || t.charAt(n) === '\t')
  }
  const isStructural = (l: string): boolean => isFence(l) || isHeading(l)
  // Length-aware fence tracking: a ``` run shorter than the opening fence
  // is content, so blanks after it stay protected as code blanks.
  const fence = new FenceTracker()
  const inCode: boolean[] = lines.map(l => fence.update(l.trim()))
  const out: string[] = []
  lines.forEach((l, i) => {
    if (l === '' && i > 0 && i + 1 < lines.length && !inCode[i]) {
      const prev = lines[i - 1] as string
      const next = lines[i + 1] as string
      // A blank line adjacent to a table row is the table's boundary.
      if (isTableRow(prev) || isTableRow(next)) {
        out.push(l)
        return
      }
      if (isStructural(prev) || isStructural(next)) return // drop
    }
    out.push(l)
  })
  return out.join('\n')
}

/**
 * Build the streaming-preview card JSON (payload path or text path).
 *
 * @param content - Text body; a payload-prefixed string takes the payload path.
 * @param spin - Spinner configuration for the header icon.
 * @param status - Structured status driving the header title/color/icon; absent renders the running default.
 * @returns Feishu interactive-card JSON string.
 */
export function buildPreviewCardJSON(content: string, spin: SpinnerCfg, status?: ProgressStatus): string {
  const payload = parseProgressCardPayload(content)
  if (payload !== undefined) return buildProgressCardJSONFromPayload(payload, spin)
  const state = status?.state ?? ''
  // Strip non-whitelisted HTML exactly like the final reply path
  // (finalizeFeishuCardMarkdown): a bare tag PATCHes into an 11311 card
  // rejection and degrades the preview after three failures. Unconditional —
  // containsMarkdown does not count bare HTML tags as markdown indicators.
  let processed = sanitizeFeishuMarkdownHTML(content)
  if (containsMarkdown(processed)) processed = preprocessFeishuMarkdown(padBoldDelimiters(processed))
  processed = collapseExcessCardTables(processed)
  processed = collapseStructuralBlankLines(processed)
  const { title, color } = progressTitleAndColor(
    state, true, status?.ts ?? '', status?.toolCallSeq ?? 0, status?.pendingSubtasks ?? 0)
  // Text-path card (placeholder / streaming preview): align the header icon
  // with the state — thinking → pulse ring, running/执行中 → Material spinner.
  return buildCardJSONWithHeader(sanitizeMarkdownURLs(processed), title, color, spinnerKeyForState(spin, state))
}

/** Mutable parsed card JSON for in-place button injections. */
interface MutableCardJSON {
  header?: { template?: unknown; title?: unknown; icon?: unknown }
  body?: { elements?: unknown[] }
  [key: string]: unknown
}

function parseMutable(cardJSON: string): MutableCardJSON | undefined {
  try {
    return JSON.parse(cardJSON) as MutableCardJSON
  } catch {
    return undefined
  }
}

/**
 * Progress states whose card carries registered export content: turn-end
 * replies (completed) and parked-ask segments — the waiting park and every
 * settled outcome — registered by captureReplyForExport under the card key.
 */
const replyButtonStates: ReadonlySet<string> = new Set([
  'completed', 'waiting', 'approved', 'rejected', 'answered', 'cancelled',
])

/**
 * Append the export/reply button row (plus optional render-status line) to a
 * card carrying registered export content. With `buttonState` (the PATCH
 * path's authoritative status) eligibility is state-keyed; without it, the
 * header template decides — green (completed) or blue, and blue maps
 * exclusively to the waiting state an ask/permission park entered after
 * captureReplyForExport registered the partial reply under the same key, so
 * keep new blue progress states out of that precondition. No-op otherwise.
 *
 * @param cardJSON - Rendered card JSON to mutate.
 * @param sessionKey - Session the buttons act on; empty string is a no-op.
 * @param exportKey - Key identifying the exportable reply.
 * @param statusText - Optional render-status line; empty string omits it.
 * @param buttonState - Progress status state driving state-keyed eligibility;
 *   undefined falls back to the header-template check.
 * @returns Card JSON with the button row appended, or the input unchanged on no-op.
 */
export function injectReplyButtons(
  cardJSON: string, sessionKey: string, exportKey: string, statusText: string, buttonState?: string,
): string {
  if (sessionKey === '') return cardJSON
  const card = parseMutable(cardJSON)
  if (card === undefined) return cardJSON
  const hdr = card.header
  if (hdr === undefined) return cardJSON
  if (buttonState === undefined) {
    if (hdr.template !== 'green' && hdr.template !== 'blue') return cardJSON
  } else if (!replyButtonStates.has(buttonState)) return cardJSON
  const body = card.body
  if (body === undefined) return cardJSON
  const elements = body.elements
  if (!Array.isArray(elements)) return cardJSON
  const columns: FeishuCardMap[] = [
    {
      tag: 'column',
      width: 'auto',
      vertical_align: 'center',
      elements: [{
        tag: 'button',
        size: 'tiny',
        text: { tag: 'plain_text', content: '📄 导出文件' },
        type: 'default',
        value: { action: `export:${exportKey}`, session_key: sessionKey },
      }],
    },
    {
      tag: 'column',
      width: 'auto',
      vertical_align: 'center',
      elements: [{
        tag: 'button',
        size: 'tiny',
        text: { tag: 'plain_text', content: '💬 查看完整回复' },
        type: 'default',
        value: { action: `sendreply:${exportKey}`, session_key: sessionKey },
      }],
    },
  ]
  // Render-task status line shares the button row (saves vertical space).
  if (statusText.trim() !== '') columns.push(notationColumn(statusText))
  elements.push({ tag: 'column_set', flex_mode: 'none', columns })
  return JSON.stringify(card)
}

/**
 * Grey notation text column sharing a button row. text_size/text_color live
 * on the plain_text text object, NOT the div top level (schema 2.0 rejects
 * them at div level, code 230099).
 *
 * @param content - Notation text to render.
 * @returns Column element for a column_set.
 */
function notationColumn(content: string): FeishuCardMap {
  return {
    tag: 'column',
    width: 'auto',
    vertical_align: 'center',
    elements: [{
      tag: 'div',
      text: { tag: 'plain_text', content, text_size: 'notation', text_color: 'grey' },
    }],
  }
}

/**
 * Append a ⏹ 停止执行 danger button to a still-running (yellow/violet) or
 * waiting (blue) card; no-op on terminal (green/red) and settled
 * (turquoise/grey) cards or cards without a header/body. Settled cards carry
 * the settled ask's export/reply buttons instead — their turn runs on the
 * post-decision card. A non-empty hint rides the button row as a grey
 * notation column beside the button.
 *
 * @param cardJSON - Rendered card JSON to mutate.
 * @param sessionKey - Session the stop command targets; empty string is a no-op.
 * @param hint - Background-task hint rendered beside the button; empty string omits it.
 * @returns Card JSON with the stop button row appended, or the input unchanged.
 */
export function injectStopButton(cardJSON: string, sessionKey: string, hint = ''): string {
  if (sessionKey === '') return cardJSON
  const card = parseMutable(cardJSON)
  if (card === undefined) return cardJSON
  const hdr = card.header
  if (hdr === undefined) return cardJSON
  if (hdr.template === 'green' || hdr.template === 'red' || hdr.template === 'turquoise' || hdr.template === 'grey') return cardJSON
  const body = card.body
  if (body === undefined) return cardJSON
  const elements = body.elements
  if (!Array.isArray(elements)) return cardJSON
  const columns: FeishuCardMap[] = [{
    tag: 'column',
    width: 'auto',
    vertical_align: 'center',
    elements: [{
      tag: 'button',
      size: 'tiny',
      text: { tag: 'plain_text', content: '⏹ 停止执行' },
      type: 'danger',
      value: { action: 'cmd:/stop', session_key: sessionKey },
    }],
  }]
  if (hint.trim() !== '') columns.push(notationColumn(hint))
  elements.push({ tag: 'column_set', flex_mode: 'none', columns })
  return JSON.stringify(card)
}

/**
 * Append the stopped-card footer: a disabled "⏹ 已停止" indicator beside an
 * active "▶ 继续执行" button (cmd:继续 resumes the same agent session).
 *
 * @param cardJSON - Rendered card JSON to mutate.
 * @param sessionKey - Session the resume command targets; empty string is a no-op.
 * @returns Card JSON with the stopped footer appended, or the input unchanged.
 */
export function injectStoppedButtons(cardJSON: string, sessionKey: string): string {
  if (sessionKey === '') return cardJSON
  const card = parseMutable(cardJSON)
  if (card === undefined) return cardJSON
  const body = card.body
  if (body === undefined) return cardJSON
  const elements = body.elements
  if (!Array.isArray(elements)) return cardJSON
  elements.push({
    tag: 'column_set',
    flex_mode: 'none',
    columns: [
      {
        tag: 'column',
        width: 'auto',
        vertical_align: 'center',
        elements: [{
          tag: 'button',
          size: 'tiny',
          text: { tag: 'plain_text', content: '⏹ 已停止' },
          type: 'default',
          disabled: true,
          disabled_tips: { tag: 'plain_text', content: '执行已停止' },
        }],
      },
      {
        tag: 'column',
        width: 'auto',
        vertical_align: 'center',
        elements: [{
          tag: 'button',
          size: 'tiny',
          text: { tag: 'plain_text', content: '▶ 继续执行' },
          type: 'primary',
          value: { action: 'cmd:继续', session_key: sessionKey },
        }],
      },
    ],
  })
  return JSON.stringify(card)
}

/**
 * Turn a cached progress card into a stopped state: red "⏹ 已停止" header
 * (spinner icon dropped) plus the stopped-card footer, preserving the body.
 *
 * @param cardJSON - Cached card JSON to restyle.
 * @param sessionKey - Session the resume command targets.
 * @returns Card JSON restyled as stopped; unparseable input returns unchanged.
 */
export function markCardStopped(cardJSON: string, sessionKey: string): string {
  const card = parseMutable(cardJSON)
  if (card === undefined) return cardJSON
  if (card.header !== undefined) {
    card.header.template = 'red'
    card.header.title = { tag: 'plain_text', content: '⏹ 已停止' }
    delete card.header.icon
  }
  return injectStoppedButtons(JSON.stringify(card), sessionKey)
}

export { noSpinner }
