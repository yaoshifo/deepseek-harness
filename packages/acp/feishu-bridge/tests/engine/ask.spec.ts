/**
 * B2 ask protocol tests: the converged card-button payload parser, the
 * permission verdict parser (structured perm: payloads first, keyword
 * fallback), per-question answer resolution with the selected/custom split,
 * and the timeout default answer.
 *
 * @module dsh-feishu-bridge/tests-engine-ask
 */

import { describe, expect, it } from 'vitest'
import {
  buildAskQuestionCard,
  buildAskQuestionCardSettled,
  defaultAskAnswer,
  parseAskqSelection,
  parsePermissionVerdict,
  resolveAskAnswer,
} from '../../src/engine/ask.ts'
import type { AskCardI18n } from '../../src/engine/ask.ts'
import type { UserQuestion } from '../../src/core/types.ts'

/** Deterministic en-face stub: the message key itself is the asserted copy. */
function enAskCardI18n(): AskCardI18n {
  return {
    t: key => `en:${key}`,
    tf: (key, ...args) => `en:${key}:${args.join('+')}`,
  }
}

function singleQuestion(): UserQuestion {
  return {
    question: 'Which database?',
    header: 'Setup',
    options: [
      { label: 'PostgreSQL', description: 'Recommended for production' },
      { label: 'SQLite', description: 'Lightweight, file-based' },
      { label: 'MySQL', description: 'Popular open-source' },
    ],
    multiSelect: false,
  }
}

describe('parseAskqSelection', () => {
  it('single-select button value "askq:0:1" parses to question 0, option 1', () => {
    expect(parseAskqSelection('askq:0:1')).toEqual({ qIdx: 0, indices: [1], custom: '' })
  })

  it('multi-select value "askq:2:1,3" parses to question 2, options 1 and 3', () => {
    expect(parseAskqSelection('askq:2:1,3')).toEqual({ qIdx: 2, indices: [1, 3], custom: '' })
  })

  it('multi-select form prefix "askq_multi:1:2,4" normalizes to the askq form', () => {
    expect(parseAskqSelection('askq_multi:1:2,4')).toEqual({ qIdx: 1, indices: [2, 4], custom: '' })
  })

  it('indices below 1 are filtered (empty multi submit selects nothing)', () => {
    expect(parseAskqSelection('askq:0:0')).toEqual({ qIdx: 0, indices: [], custom: '' })
  })

  it('non-numeric segments drop out of the index list', () => {
    expect(parseAskqSelection('askq:0:1,x,3')).toEqual({ qIdx: 0, indices: [1, 3], custom: '' })
  })

  it('legacy two-segment payload is rejected (ambiguous with multi-question cards)', () => {
    expect(parseAskqSelection('askq:0')).toBeUndefined()
  })

  it('plain text and other payloads are not askq selections', () => {
    expect(parseAskqSelection('PostgreSQL')).toBeUndefined()
    expect(parseAskqSelection('askq:a:1')).toBeUndefined()
    expect(parseAskqSelection('')).toBeUndefined()
  })

  it('a card text submit "askq_text:1\\x00Redis" parses to question 1 with the custom text', () => {
    expect(parseAskqSelection('askq_text:1\x00Redis')).toEqual({ qIdx: 1, indices: [], custom: 'Redis' })
  })

  it('free text rides a selection payload after the NUL separator', () => {
    expect(parseAskqSelection('askq:0:1,3\x00also Redis in staging'))
      .toEqual({ qIdx: 0, indices: [1, 3], custom: 'also Redis in staging' })
    expect(parseAskqSelection('askq_multi:2:4\x00note'))
      .toEqual({ qIdx: 2, indices: [4], custom: 'note' })
  })

  it('text containing colons cannot break index parsing (NUL split runs first)', () => {
    expect(parseAskqSelection('askq_text:0\x002: 30 every morning'))
      .toEqual({ qIdx: 0, indices: [], custom: '2: 30 every morning' })
  })
})

describe('parsePermissionVerdict', () => {
  it('structured card payloads match without the keyword tables', () => {
    expect(parsePermissionVerdict('perm:allow')).toEqual({ verdict: 'allow', note: '' })
    expect(parsePermissionVerdict('perm:deny')).toEqual({ verdict: 'deny', note: '' })
    expect(parsePermissionVerdict('perm:allow_all')).toEqual({ verdict: 'allow-all', note: '' })
  })

  it('the card-input note rides after the NUL separator', () => {
    expect(parsePermissionVerdict('perm:deny\x00use git clean instead'))
      .toEqual({ verdict: 'deny', note: 'use git clean instead' })
    expect(parsePermissionVerdict('perm:allow\x00also add tests'))
      .toEqual({ verdict: 'allow', note: 'also add tests' })
  })

  it('free-text keywords fall back to the word lists', () => {
    expect(parsePermissionVerdict('yes')).toEqual({ verdict: 'allow', note: '' })
    expect(parsePermissionVerdict('允许')).toEqual({ verdict: 'allow', note: '' })
    expect(parsePermissionVerdict('deny')).toEqual({ verdict: 'deny', note: '' })
    expect(parsePermissionVerdict('拒绝')).toEqual({ verdict: 'deny', note: '' })
    expect(parsePermissionVerdict('allow all')).toEqual({ verdict: 'allow-all', note: '' })
    expect(parsePermissionVerdict('全部允许')).toEqual({ verdict: 'allow-all', note: '' })
  })

  it('non-verdict text is undefined (not consumed as a permission response)', () => {
    expect(parsePermissionVerdict('随便说说')).toBeUndefined()
    expect(parsePermissionVerdict('')).toBeUndefined()
  })
})

describe('resolveAskAnswer', () => {
  it('numeric index "2" resolves to the option label in selected', () => {
    expect(resolveAskAnswer(singleQuestion(), '2')).toEqual({ selected: ['SQLite'] })
  })

  it('button payload "askq:0:1" resolves to the option label in selected', () => {
    expect(resolveAskAnswer(singleQuestion(), 'askq:0:1')).toEqual({ selected: ['PostgreSQL'] })
  })

  it('multi-select numeric "1,3" resolves both labels in selected', () => {
    const q: UserQuestion = { ...singleQuestion(), multiSelect: true }
    expect(resolveAskAnswer(q, '1,3')).toEqual({ selected: ['PostgreSQL', 'MySQL'] })
  })

  it('multi-select payload "askq:0:1,3" resolves both labels in selected', () => {
    const q: UserQuestion = { ...singleQuestion(), multiSelect: true }
    expect(resolveAskAnswer(q, 'askq:0:1,3')).toEqual({ selected: ['PostgreSQL', 'MySQL'] })
  })

  it('an empty multi-select payload answers with an empty selection', () => {
    const q: UserQuestion = { ...singleQuestion(), multiSelect: true }
    expect(resolveAskAnswer(q, 'askq:0:0')).toEqual({ selected: [] })
  })

  it('free text lands in custom with an empty selection', () => {
    expect(resolveAskAnswer(singleQuestion(), 'Redis')).toEqual({ selected: [], custom: 'Redis' })
  })

  it('an out-of-range number is custom text, not a selection', () => {
    expect(resolveAskAnswer(singleQuestion(), '99')).toEqual({ selected: [], custom: '99' })
  })

  it('partially numeric multi-select input stays custom text', () => {
    const q: UserQuestion = { ...singleQuestion(), multiSelect: true }
    expect(resolveAskAnswer(q, '1 and 3')).toEqual({ selected: [], custom: '1 and 3' })
  })

  it('full-width commas split multi-select numeric input', () => {
    const q: UserQuestion = { ...singleQuestion(), multiSelect: true }
    expect(resolveAskAnswer(q, '1，3')).toEqual({ selected: ['PostgreSQL', 'MySQL'] })
  })

  it('a question without options takes any text as custom', () => {
    const q: UserQuestion = { ...singleQuestion(), options: [] }
    expect(resolveAskAnswer(q, 'anything')).toEqual({ selected: [], custom: 'anything' })
  })

  it('a card text submit resolves to custom with an empty selection', () => {
    expect(resolveAskAnswer(singleQuestion(), 'askq_text:0\x00Redis'))
      .toEqual({ selected: [], custom: 'Redis' })
  })

  it('riding text lands in custom alongside the selection (never replaces it)', () => {
    const q: UserQuestion = { ...singleQuestion(), multiSelect: true }
    expect(resolveAskAnswer(q, 'askq:0:1,3\x00also Redis in staging'))
      .toEqual({ selected: ['PostgreSQL', 'MySQL'], custom: 'also Redis in staging' })
    expect(resolveAskAnswer(singleQuestion(), 'askq:0:2\x00unless you object'))
      .toEqual({ selected: ['SQLite'], custom: 'unless you object' })
  })
})

describe('defaultAskAnswer', () => {
  it('defaults to the first option label', () => {
    expect(defaultAskAnswer(singleQuestion())).toEqual({ selected: ['PostgreSQL'] })
  })

  it('a question without options defaults to an empty answer', () => {
    const q: UserQuestion = { ...singleQuestion(), options: [] }
    expect(defaultAskAnswer(q)).toEqual({ selected: [] })
  })
})

describe('buildAskQuestionCard', () => {
  it('single-select renders the question plus list rows with askq:{q}:{n} buttons', () => {
    const card = buildAskQuestionCard(singleQuestion(), 0, 1)

    expect(card.header?.title).toBe('‼️ Setup')
    expect(card.header?.color).toBe('blue')
    const q = card.elements[0] as { kind: string; content: string }
    expect(q.kind).toBe('markdown')
    expect(q.content).toBe('**Which database?**')
    for (let i = 0; i < 3; i++) {
      const row = card.elements[i + 1] as {
        kind: string
        text: string
        description: string
        btnText: string
        btnValue: string
        extra?: Record<string, string>
      }
      expect(row.kind).toBe('listItem')
      expect(row.text).toContain(['PostgreSQL', 'SQLite', 'MySQL'][i])
      expect(row.btnText).toBe(String(i + 1))
      expect(row.btnValue).toBe(`askq:0:${i + 1}`)
      expect(row.extra?.askq_label).toBe(['PostgreSQL', 'SQLite', 'MySQL'][i])
    }
  })

  it('a multi-question ask titles its per-question card with the progress suffix (2/5)', () => {
    const card = buildAskQuestionCard(singleQuestion(), 1, 5)
    expect(card.header?.title).toBe('‼️ Setup (2/5)')
    const sole = buildAskQuestionCard(singleQuestion(), 0, 1)
    expect(sole.header?.title).toBe('‼️ Setup')
  })

  it('a question without a header falls back to the localized ask title', () => {
    const card = buildAskQuestionCard({ ...singleQuestion(), header: '' }, 0, 1)
    expect(card.header?.title).toBe('‼️ Agent 提问')
  })

  it('a question without options renders its heading plus the text-input form', () => {
    const q: UserQuestion = { ...singleQuestion(), options: [] }
    const card = buildAskQuestionCard(q, 0, 1)
    expect(card.elements).toHaveLength(2)
    expect(card.elements[1]?.kind).toBe('form')
  })

  it('an interactive single-select question carries a text-input form addressed by askq_text:{q}', () => {
    const card = buildAskQuestionCard(singleQuestion(), 0, 1)

    const form = card.elements.find(e => e.kind === 'form')
    expect(form?.name).toBe('askq_text_form_0')
    const input = form?.elements[0] as { kind: string; name?: string; placeholder?: string } | undefined
    expect(input?.kind).toBe('input')
    expect(input?.name).toBe('askq_text_0')
    expect(input?.placeholder).toContain('输入你的答案')
    const actions = form?.elements[1] as { buttons?: Array<{ value: string; name?: string; actionType?: string }> } | undefined
    const submit = actions?.buttons?.[0]
    expect(submit?.value).toBe('askq_text:0')
    expect(submit?.name).toBe('askq_text_submit_0')
    expect(submit?.actionType).toBe('form_submit')
  })

  it('an interactive single-select question localizes its copy through the i18n face', () => {
    const en = buildAskQuestionCard(singleQuestion(), 0, 1, enAskCardI18n())

    const form = en.elements.find(e => e.kind === 'form') as {
      elements: Array<{ placeholder?: string; buttons?: Array<{ text?: string }> }>
    }
    const input = form.elements[0] as { placeholder?: string }
    expect(input.placeholder).toBe('en:askq_text_placeholder_options')
    const submit = form.elements[1] as { buttons?: Array<{ text?: string }> }
    expect(submit.buttons?.[0]?.text).toBe('en:askq_text_submit')
    const note = en.elements[en.elements.length - 1] as { kind: string; text: string }
    expect(note.kind).toBe('note')
    expect(note.text).toBe('en:ask_free_text_hint')
  })

  it('an interactive single-select question ends with the free-text hint note', () => {
    const card = buildAskQuestionCard(singleQuestion(), 0, 1)

    const note = card.elements[card.elements.length - 1] as { kind: string; text: string }
    expect(note.kind).toBe('note')
    expect(note.text).toBe('也可以直接文字输入')
  })

  it('a multi-select question renders a checker form addressed by askq_multi:{q} with the single-card submit label', () => {
    const q: UserQuestion = { ...singleQuestion(), multiSelect: true }
    const card = buildAskQuestionCard(q, 2, 3)

    const form = card.elements[1] as {
      kind: string
      action?: string
      options: Array<{ label: string; value?: string }>
      submitLabel?: string
    }
    expect(form.kind).toBe('checkOptions')
    expect(form.action).toBe('askq_multi:2')
    expect(form.options.map(o => o.value)).toEqual(['1', '2', '3'])
    expect(form.submitLabel).toBe('提交本题')
  })

  it('a multi-select question localizes its checker placeholder and submit label', () => {
    const q: UserQuestion = { ...singleQuestion(), multiSelect: true }
    const card = buildAskQuestionCard(q, 0, 1, enAskCardI18n())

    const form = card.elements[1] as {
      textInput?: { placeholder?: string }
      submitLabel?: string
    }
    expect(form.textInput?.placeholder).toBe('en:askq_multi_text_placeholder')
    expect(form.submitLabel).toBe('en:askq_submit_this_question')
  })
})

describe('buildAskQuestionCardSettled', () => {
  it('renders frozen selection marks and no controls', () => {
    const card = buildAskQuestionCardSettled(singleQuestion(), 0, 1, { indices: [2] })

    expect(card.header?.title).toBe('✅ 已作答 · Setup')
    expect(card.elements).toHaveLength(2)
    const frozen = card.elements[1] as { kind: string; content: string }
    expect(frozen.kind).toBe('markdown')
    expect(frozen.content).toContain('✅ **SQLite**')
    expect(frozen.content).toContain('◻️ **PostgreSQL**')
    expect(card.elements.some(e => e.kind === 'listItem')).toBe(false)
    expect(card.elements.some(e => e.kind === 'form')).toBe(false)
    expect(card.elements.some(e => e.kind === 'checkOptions')).toBe(false)
  })

  it('shows the card-input custom text under its question', () => {
    const card = buildAskQuestionCardSettled(singleQuestion(), 0, 1, { indices: [], custom: 'Redis' })

    const custom = card.elements.find(e => e.kind === 'markdown' && e.content.startsWith('✍️')) as { content: string }
    expect(custom.content).toBe('✍️ Redis')
    expect(card.elements.some(e => e.kind === 'form')).toBe(false)
  })

  it('keeps the progress suffix and localizes the answered title mark', () => {
    const zh = buildAskQuestionCardSettled(singleQuestion(), 1, 4, { indices: [1] })
    expect(zh.header?.title).toBe('✅ 已作答 · Setup (2/4)')
    const en = buildAskQuestionCardSettled(singleQuestion(), 0, 1, { indices: [1] }, enAskCardI18n())
    expect(en.header?.title).toBe('en:ask_question_answered · Setup')
  })
})
