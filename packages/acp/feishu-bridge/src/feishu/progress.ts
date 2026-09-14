/**
 * Feishu progress-card assembly ported from cc-connect platform/feishu
 * feishu_progress.go: progress card JSON, the structured preview status
 * (formerly the __cc_state__/__cc_ts__/__cc_tc__
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
import { noSpinner, spinnerKeyForState, type SpinnerCfg } from './spinner.ts'
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
  pending: number = 0,
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
    case 'truncated':
      // Terminal, but not a completion claim: the turn hit the output-token
      // cap mid-flight. Orange separates it from both failed-red and
      // completed-green, and stays off the stop-button template whitelist.
      title = zh ? '输出截断' : 'Truncated'
      color = 'orange'
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
  if (pending > 0 && (state === 'completed' || state === 'failed' || state === 'truncated')) {
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
 * Build the streaming-preview card JSON.
 *
 * @param content - Text body rendered into the card.
 * @param spin - Spinner configuration for the header icon.
 * @param status - Structured status driving the header title/color/icon; absent renders the running default.
 * @returns Feishu interactive-card JSON string.
 */
export function buildPreviewCardJSON(content: string, spin: SpinnerCfg, status?: ProgressStatus): string {
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
  // Align the header icon with the state — thinking → pulse ring,
  // running/执行中 → Material spinner.
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
 * waiting (blue) card; no-op on terminal (green/red/orange) and settled
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
  if (hdr.template === 'green' || hdr.template === 'red' || hdr.template === 'orange' || hdr.template === 'turquoise' || hdr.template === 'grey') return cardJSON
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
