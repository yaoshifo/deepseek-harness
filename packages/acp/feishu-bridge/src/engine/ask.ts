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
import type { PendingAskAnswer, UserQuestion } from '../core/types.js'
import { isAllowResponse, isApproveAllResponse, isDenyResponse } from './permission.js'

/** Prefix of every ask card button payload. */
const askqPrefix = 'askq:'

/** Multi-select form submit prefix, normalized onto {@link askqPrefix}. */
const askqMultiPrefix = 'askq_multi:'

/** One parsed card-button answer payload. */
export interface AskqSelection {
  /** Zero-based index of the question the payload answers. */
  qIdx: number
  /** Sorted 1-based option indices; empty when nothing was selected. */
  indices: number[]
}

/**
 * Parse an ask card button payload into its question and selected option
 * indices. This is the single parser for the wire format — the platform's
 * card callbacks and the engine's response routing both go through it.
 * Accepted forms: `askq:{q}:{idx}` and `askq:{q}:{i1},{i2},...`, with the
 * `askq_multi:{...}` form normalized onto them. Indices below 1 are filtered
 * so an empty-selection submit (`askq:0:0`) selects nothing instead of option
 * 0. The legacy two-segment `askq:{n}` form is rejected: with all questions
 * on one card it cannot name its question.
 *
 * @param content - Raw callback payload or message text.
 * @returns The parsed selection, or undefined when the text is not a payload.
 */
export function parseAskqSelection(content: string): AskqSelection | undefined {
  const trimmed = content.trim()
  const prefix = trimmed.startsWith(askqMultiPrefix) ? askqMultiPrefix
    : trimmed.startsWith(askqPrefix) ? askqPrefix
      : ''
  if (prefix === '') return undefined
  const segments = trimmed.slice(prefix.length).split(':')
  if (segments.length !== 2) return undefined
  const qIdx = Number.parseInt(segments[0] ?? '', 10)
  if (!Number.isInteger(qIdx) || qIdx < 0) return undefined
  const indices: number[] = []
  for (const part of (segments[1] ?? '').split(',')) {
    const n = Number.parseInt(part.trim(), 10)
    if (Number.isInteger(n) && n >= 1) indices.push(n)
  }
  indices.sort((a, b) => a - b)
  return { qIdx, indices }
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
 * free text lands in `custom` with an empty `selected` — the two never mix.
 *
 * @param q - The question whose options resolve index inputs.
 * @param input - Raw user input.
 * @returns The resolved answer.
 */
export function resolveAskAnswer(q: UserQuestion, input: string): AskAnswer {
  const trimmed = input.trim()
  const payload = parseAskqSelection(trimmed)
  if (payload !== undefined) {
    return { selected: labelsForIndices(q, payload.indices) }
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

/** Selection marks for one rendered question (1-based option indices). */
export type AskCardAnswered = Map<number, number[]>

/**
 * Build the one card that carries every question of one ask. Unanswered
 * questions render interactively — single-select as list rows with number
 * buttons (`askq:{q}:{n}`) ending in a free-text-input hint note,
 * multi-select as a checker form (`askq_multi:{q}`) whose submit row carries
 * the same hint — while answered questions render frozen with their
 * selection marked, so the callback card replacement keeps the remaining
 * questions clickable.
 *
 * @param title - Card title, computed by the caller.
 * @param questions - All questions of the ask, in order.
 * @param answered - Selected option indices per answered question index.
 * @param freeTextHint - Locale-owned hint that free text answers the
 *   question too (Msg.AskFreeTextHint); the caller owns the language.
 * @returns The assembled card.
 */
export function buildAskQuestionsCard(title: string, questions: UserQuestion[], answered: AskCardAnswered, freeTextHint: string): Card {
  const cb = newCard().title(title, 'blue')
  const multiple = questions.length > 1
  for (const [i, q] of questions.entries()) {
    cb.raw(...questionElements(q, i, multiple, answered.get(i), freeTextHint))
  }
  return cb.build()
}

/** Render one question's elements: heading plus frozen marks or interactive options. */
function questionElements(
  q: UserQuestion, qIdx: number, multiple: boolean, selected: number[] | undefined, freeTextHint: string,
): CardElement[] {
  const prefix = multiple ? `${qIdx + 1}. ` : ''
  const elements: CardElement[] = [
    { kind: 'markdown', content: `**${prefix}${q.question}**` },
  ]
  if (selected !== undefined) {
    const marks = q.options.map((opt, i) =>
      `${selected.includes(i + 1) ? '✅' : '◻️'} **${opt.label}**${opt.description !== '' ? `\n${opt.description}` : ''}`)
    if (marks.length > 0) {
      elements.push({ kind: 'markdown', content: marks.join('\n') })
    }
    return elements
  }
  if (q.multiSelect) {
    elements.push({
      kind: 'checkOptions',
      question: '',
      options: q.options.map((opt, i) => ({
        label: opt.label,
        description: opt.description,
        value: String(i + 1),
        ...opt.recommended === true ? { checked: true } : {},
      })),
      action: `askq_multi:${qIdx}`,
      extra: { askq_question: q.question },
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
  // Free text answers this question too (resolveAskAnswer's custom branch),
  // so the card says so; a question without options needs no hint — free text
  // is its only answer path. The label is locale-owned (the caller passes the
  // translated Msg.AskFreeTextHint); the Feishu renderer's submit-row chrome
  // (提交选择 beside the same hint) stays renderer-owned.
  if (q.options.length > 0) {
    elements.push({ kind: 'note', text: freeTextHint })
  }
  return elements
}
