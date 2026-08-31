/**
 * B2 ask protocol pure logic: the ONE parser for card-button answer payloads
 * (`askq:{q}:{i1},{i2}`), the permission verdict parser (structured `perm:`
 * payloads first, keyword tables as the card-less fallback), per-question
 * answer resolution with the selected/custom split, the research-timeout
 * default, and the one-card-per-ask question card builder shared by the
 * engine (send) and the Feishu platform (callback card replacement).
 *
 * @module dsh-feishu-bridge/engine-ask
 */

import type { Card, CardElement } from '../card.js'
import { newCard } from '../card.js'
import { I18n, langChinese, Msg, type MsgKey } from '../i18n/index.js'
import type { PendingAskAnswer, UserQuestion } from '../core/types.js'
import { isAllowResponse, isApproveAllResponse, isDenyResponse } from './permission.js'

/**
 * Minimal i18n face for ask-card copy: the engine's `I18n` instance and the
 * platform's `PlatformI18nHandle` both satisfy it structurally. Ask-card copy
 * lives in the message table (config.language drives it engine-side); callers
 * without a wired handle fall back to {@link zhAskCardI18n}.
 */
export interface AskCardI18n {
  /** Plain message lookup (no formatting args). */
  t(key: MsgKey): string
  /** Printf-style formatted lookup (%s / %d in the message table). */
  tf(key: MsgKey, ...args: unknown[]): string
}

/** zh lookup for callers without a wired handle (direct calls, tests). */
export const zhAskCardI18n: AskCardI18n = new I18n(langChinese)

/** Prefix of every ask card button payload. */
const askqPrefix = 'askq:'

/** Multi-select form submit prefix, normalized onto {@link askqPrefix}. */
const askqMultiPrefix = 'askq_multi:'

/** Card text-input submit prefix: `askq_text:{q}` names its question. */
const askqTextPrefix = 'askq_text:'

/** One chat-text question address: the named question plus the remainder. */
export interface QuestionAddress {
  /** Zero-based index of the addressed question. */
  qIdx: number
  /** The answer text with the address prefix stripped. */
  rest: string
}

/**
 * Parse a chat-text question address on a multi-question ask: `2: because…`
 * names (and revises) question 2 explicitly. A full-width colon needs no
 * following space; a half-width one requires whitespace so clock times like
 * `2:30` stay plain answers. Single-question asks and out-of-range numbers
 * are not addresses — the text stays whole.
 *
 * @param content - Raw chat text.
 * @param total - Number of questions on the ask.
 * @returns The address, or undefined when the text does not name a question.
 */
export function parseQuestionAddress(content: string, total: number): QuestionAddress | undefined {
  if (total <= 1) return undefined
  const match = content.trim().match(/^(\d{1,2})(?:\s*：\s*|\s*:\s+)([\s\S]+)$/)
  if (match === null) return undefined
  const n = Number.parseInt(match[1] ?? '', 10)
  if (!Number.isInteger(n) || n < 1 || n > total) return undefined
  return { qIdx: n - 1, rest: (match[2] ?? '').trim() }
}

/** One parsed card-button answer payload. */
export interface AskqSelection {
  /** Zero-based index of the question the payload answers. */
  qIdx: number
  /** Sorted 1-based option indices; empty when nothing was selected. */
  indices: number[]
  /** Card-input text riding the payload after the NUL separator ('' when none). */
  custom: string
}

/**
 * Parse an ask card button payload into its question and selected option
 * indices. This is the single parser for the wire format — the platform's
 * card callbacks and the engine's response routing both go through it.
 * Accepted forms: `askq:{q}:{idx}` and `askq:{q}:{i1},{i2},...`, the
 * `askq_multi:{...}` form normalized onto them, and the card text submit
 * `askq_text:{q}` — every form may carry free text after a NUL separator
 * (the same convention as `perm:` verdict notes). The NUL split runs first
 * so option text containing colons cannot break index parsing. Indices
 * below 1 are filtered so an empty-selection submit (`askq:0:0`) selects
 * nothing instead of option 0. The legacy two-segment `askq:{n}` form is
 * rejected: with all questions on one card it cannot name its question.
 *
 * @param content - Raw callback payload or message text.
 * @returns The parsed selection, or undefined when the text is not a payload.
 */
export function parseAskqSelection(content: string): AskqSelection | undefined {
  const trimmed = content.trim()
  let body = trimmed
  let custom = ''
  const nulIdx = trimmed.indexOf('\x00')
  if (nulIdx >= 0) {
    custom = trimmed.slice(nulIdx + 1).trim()
    body = trimmed.slice(0, nulIdx).trim()
  }
  const isTextSubmit = body.startsWith(askqTextPrefix)
  const prefix = isTextSubmit ? askqTextPrefix
    : body.startsWith(askqMultiPrefix) ? askqMultiPrefix
      : body.startsWith(askqPrefix) ? askqPrefix
        : ''
  if (prefix === '') return undefined
  const segments = body.slice(prefix.length).split(':')
  if (!isTextSubmit && segments.length !== 2) return undefined
  if (isTextSubmit && segments.length !== 1) return undefined
  const qIdx = Number.parseInt(segments[0] ?? '', 10)
  if (!Number.isInteger(qIdx) || qIdx < 0) return undefined
  const indices: number[] = []
  if (!isTextSubmit) {
    for (const part of (segments[1] ?? '').split(',')) {
      const n = Number.parseInt(part.trim(), 10)
      if (Number.isInteger(n) && n >= 1) indices.push(n)
    }
    indices.sort((a, b) => a - b)
  }
  return { qIdx, indices, custom }
}

/** One parsed permission verdict: the decision plus the card-input note. */
export interface PermissionVerdict {
  verdict: 'allow' | 'allow-all' | 'deny'
  /** Card-input text riding the verdict ('' when none). */
  note: string
}

/**
 * Parse a permission response into its verdict. Structured card payloads
 * (`perm:allow`, `perm:deny`, `perm:allow_all`, optionally followed by
 * `\x00{note}`) match first — the card path never consults the keyword
 * tables. Free text falls back to the allow/deny/allow-all word lists (the
 * card-less platform degradation); anything else is undefined so routing
 * treats it as a non-response.
 *
 * @param content - Raw response text, possibly carrying a NUL-separated note.
 * @returns The parsed verdict, or undefined when the text is not one.
 */
export function parsePermissionVerdict(content: string): PermissionVerdict | undefined {
  let body = content
  let note = ''
  const nulIdx = content.indexOf('\x00')
  if (nulIdx >= 0) {
    note = content.slice(nulIdx + 1).trim()
    body = content.slice(0, nulIdx)
  }
  const lower = body.toLowerCase().trim()
  if (lower === 'perm:allow' || isAllowResponse(lower)) return { verdict: 'allow', note }
  if (lower === 'perm:allow_all' || isApproveAllResponse(lower)) return { verdict: 'allow-all', note }
  if (lower === 'perm:deny' || isDenyResponse(lower)) return { verdict: 'deny', note }
  return undefined
}

/** One question's resolved answer: chosen labels in selected, free text in custom. */
export interface AskAnswer {
  /** Labels of the chosen options; may be empty with custom text. */
  selected: string[]
  /** Free-text answer ('' or absent when the answer was a selection). */
  custom?: string
}

/**
 * Resolve one question's answer from raw user input (card payload, numeric
 * index(es), or free text). Option selections land in `selected` as labels;
 * free text lands in `custom`. Card-input text riding a payload (after the
 * NUL separator) accompanies its selection — the upstream answer type allows
 * the pair for exactly this case; plain chat text never produces both.
 *
 * @param q - The question whose options resolve index inputs.
 * @param input - Raw user input.
 * @returns The resolved answer.
 */
export function resolveAskAnswer(q: UserQuestion, input: string): AskAnswer {
  const trimmed = input.trim()
  const payload = parseAskqSelection(trimmed)
  if (payload !== undefined) {
    const selected = labelsForIndices(q, payload.indices)
    return payload.custom !== '' ? { selected, custom: payload.custom } : { selected }
  }
  if (q.multiSelect) {
    const parts = trimmed.split(/[,，\s]+/).filter(p => p !== '')
    if (parts.length > 0 && parts.every(p => isOptionIndex(q, p))) {
      return { selected: labelsForIndices(q, parts.map(p => Number.parseInt(p, 10))) }
    }
  } else if (isOptionIndex(q, trimmed)) {
    return { selected: labelsForIndices(q, [Number.parseInt(trimmed, 10)]) }
  }
  return { selected: [], custom: trimmed }
}

/**
 * The default answer applied to an unanswered question when a
 * research-manual ask times out: the first option's label, or an empty
 * answer when the question has no options.
 *
 * @param q - The question to default.
 * @returns The default answer.
 */
export function defaultAskAnswer(q: UserQuestion): AskAnswer {
  const first = q.options[0]
  return first === undefined ? { selected: [] } : { selected: [first.label] }
}

/**
 * The display form of one answer for the ✅ echo: the chosen labels joined
 * with commas, or the custom text.
 *
 * @param answer - The collected answer.
 * @returns The human-readable answer text.
 */
export function askAnswerDisplay(answer: PendingAskAnswer): string {
  if (answer.selected.length > 0) return answer.selected.join(', ')
  return answer.custom ?? ''
}

/**
 * Final answers for a questions ask: collected answers in question order,
 * with the timeout default applied to every unanswered question.
 *
 * @param questions - The ask's questions, in order.
 * @param collected - Collected answers keyed by question index.
 * @returns One answer per question.
 */
export function finalAskAnswers(
  questions: UserQuestion[],
  collected: Map<number, PendingAskAnswer>,
): Array<{ id: string; selected: string[]; custom?: string }> {
  return questions.map((q, i) => {
    const id = q.id ?? q.question
    const answer = collected.get(i)
    if (answer === undefined) return { id, ...defaultAskAnswer(q) }
    return {
      id,
      selected: [...answer.selected],
      ...(answer.custom !== undefined && answer.custom !== '' ? { custom: answer.custom } : {}),
    }
  })
}

/** Option labels for 1-based indices; out-of-range indices drop out. */
function labelsForIndices(q: UserQuestion, indices: number[]): string[] {
  const labels: string[] = []
  for (const idx of indices) {
    const opt = q.options[idx - 1]
    if (idx >= 1 && idx <= q.options.length && opt !== undefined) labels.push(opt.label)
  }
  return labels
}

/** Whether the text is a 1-based option index of the question. */
function isOptionIndex(q: UserQuestion, text: string): boolean {
  if (!/^\d+$/.test(text)) return false
  const idx = Number.parseInt(text, 10)
  return idx >= 1 && idx <= q.options.length
}

/** One question's on-card answer state: chosen option indices plus card-input text. */
export interface AskCardAnswer {
  /** Sorted 1-based option indices of the current selection. */
  indices: number[]
  /** Card-input text riding the current answer ('' when none). */
  custom?: string
}

/** Answered-state marks for one rendered question, keyed by question index. */
export type AskCardAnswered = Map<number, AskCardAnswer>

/**
 * Project the engine's collected answers onto the card's answered state:
 * `selected` labels resolve back to 1-based option indices (a duplicated
 * label marks every row carrying it) and custom text rides along. Powers the
 * engine→platform card sync after chat-text answers.
 *
 * @param questions - The ask's questions, in order.
 * @param collected - Collected answers keyed by question index.
 * @returns The per-question on-card answer state.
 */
export function cardAnsweredFrom(questions: UserQuestion[], collected: Map<number, PendingAskAnswer>): AskCardAnswered {
  const out: AskCardAnswered = new Map()
  for (const [i, answer] of collected) {
    const q = questions[i]
    if (q === undefined) continue
    const indices: number[] = []
    for (const [optIdx, opt] of q.options.entries()) {
      if (answer.selected.includes(opt.label)) indices.push(optIdx + 1)
    }
    out.set(i, {
      indices,
      ...(answer.custom !== undefined && answer.custom !== '' ? { custom: answer.custom } : {}),
    })
  }
  return out
}

/**
 * Build the one card that carries every question of one ask as a live form:
 * every not-yet-settled question stays interactive — single-select list rows
 * (`askq:{q}:{n}`), multi-select checker forms (`askq_multi:{q}`), and one
 * text-input form per question (`askq_text:{q}`) so free text names its
 * question — with answered questions showing their current answer (a
 * 当前 line / checker ticks) so any question can be revised until the ask
 * settles. Once every question is answered the card renders its read-only
 * terminal state: frozen selection marks and custom text, no controls.
 *
 * @param title - Card title, computed by the caller.
 * @param questions - All questions of the ask, in order.
 * @param answered - Current answer per answered question index.
 * @param i18n - Ask-card copy face (engine I18n or platform handle); defaults to zh.
 * @returns The assembled card.
 */
export function buildAskQuestionsCard(
  title: string, questions: UserQuestion[], answered: AskCardAnswered, i18n: AskCardI18n = zhAskCardI18n,
): Card {
  const cb = newCard().title(title, 'blue')
  const multiple = questions.length > 1
  const settled = questions.every((_q, i) => answered.has(i))
  for (const [i, q] of questions.entries()) {
    // A divider between question blocks visually groups each question's
    // controls (its 提交第 N 题 button belongs to it, not the whole card).
    if (multiple && i > 0) cb.raw({ kind: 'divider' })
    cb.raw(...questionElements(q, i, multiple, settled, answered.get(i), i18n))
  }
  // Card-level teaching, multi-question cards only: revision and auto-submit
  // guidance. Single-question cards end with the per-question hint note
  // instead — a card-level variant would duplicate it verbatim. Skipped when
  // settled (no controls to explain) and when no question has options to
  // re-pick.
  if (!settled && multiple && questions.some(q => q.options.length > 0)) {
    cb.note(i18n.t(Msg.AskqCardTeachingMulti))
  }
  return cb.build()
}

/**
 * Render one question's elements. Settled cards freeze marks and custom text
 * (read-only terminal state); otherwise the question stays a live form:
 * current-answer line for answered ones, interactive options, the per-question
 * text-input form — including for option-less questions, where the input is
 * the only on-card answer path — and the locale-owned free-text hint note on
 * option-bearing questions.
 */
function questionElements(
  q: UserQuestion, qIdx: number, multiple: boolean, settled: boolean, cur: AskCardAnswer | undefined, i18n: AskCardI18n,
): CardElement[] {
  const prefix = multiple ? `${qIdx + 1}. ` : ''
  const elements: CardElement[] = [
    { kind: 'markdown', content: `**${prefix}${q.question}**` },
  ]
  if (settled) {
    if (cur !== undefined) {
      const marks = q.options.map((opt, i) =>
        `${cur.indices.includes(i + 1) ? '✅' : '◻️'} **${opt.label}**${opt.description !== '' ? `\n${opt.description}` : ''}`)
      if (marks.length > 0) {
        elements.push({ kind: 'markdown', content: marks.join('\n') })
      }
      if ((cur.custom ?? '') !== '') {
        elements.push({ kind: 'markdown', content: `✍️ ${cur.custom ?? ''}` })
      }
    }
    return elements
  }
  if (cur !== undefined) {
    const current = cur.indices.length > 0
      ? `${i18n.t(Msg.AskqCurrentPrefix)}${cur.indices.map(i => `**${q.options[i - 1]?.label ?? String(i)}**`).join(i18n.t(Msg.AskqListSeparator))}`
      : ''
    const custom = (cur.custom ?? '') !== '' ? `✍️ ${cur.custom ?? ''}` : ''
    const line = [current, custom].filter(s => s !== '').join(' · ')
    if (line !== '') {
      elements.push({ kind: 'markdown', content: `> ${line}` })
    }
  }
  if (q.multiSelect) {
    elements.push({
      kind: 'checkOptions',
      question: '',
      options: q.options.map((opt, i) => ({
        label: opt.label,
        description: opt.description,
        value: String(i + 1),
        ...((opt.recommended === true || cur?.indices.includes(i + 1)) ? { checked: true } : {}),
      })),
      action: `askq_multi:${qIdx}`,
      extra: { askq_question: q.question },
      textInput: { name: `askq_text_${qIdx}`, placeholder: i18n.t(Msg.AskqMultiTextPlaceholder) },
      submitLabel: multiple ? i18n.tf(Msg.AskqSubmitQuestionN, qIdx + 1) : i18n.t(Msg.AskqSubmitThisQuestion),
    })
    return elements
  }
  for (const [i, opt] of q.options.entries()) {
    elements.push({
      kind: 'listItem',
      text: opt.label,
      description: opt.description,
      btnText: String(i + 1),
      btnType: 'default',
      btnValue: `askq:${qIdx}:${i + 1}`,
      extra: { askq_label: opt.label, askq_question: q.question },
    })
  }
  elements.push({
    kind: 'form',
    name: `askq_text_form_${qIdx}`,
    elements: [
      { kind: 'input', name: `askq_text_${qIdx}`, placeholder: i18n.t(q.options.length > 0 ? Msg.AskqTextPlaceholderOptions : Msg.AskqTextPlaceholder), maxLength: 1000 },
      {
        kind: 'actions',
        buttons: [{
          text: i18n.t(Msg.AskqTextSubmit),
          type: 'default',
          value: `askq_text:${qIdx}`,
          name: `askq_text_submit_${qIdx}`,
          actionType: 'form_submit',
          // Self-describes the form's question for askCardMeta — an
          // optionless question has no listItems, so its text form is the
          // only element naming it.
          extra: { askq_question: q.question },
        }],
        layout: 'row',
      },
    ],
  })
  // Free text also lands in resolveAskAnswer's custom branch, so the block
  // closes with the hint. A question without options skips it — the form's
  // input above is its only answer path and already says so.
  if (q.options.length > 0) {
    elements.push({ kind: 'note', text: i18n.t(Msg.AskFreeTextHint) })
  }
  return elements
}
