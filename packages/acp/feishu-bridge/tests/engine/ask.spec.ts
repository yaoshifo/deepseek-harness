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
  buildAskQuestionsCard,
  defaultAskAnswer,
  parseAskqSelection,
  parsePermissionVerdict,
  resolveAskAnswer,
} from '../../src/engine/ask.js'
import type { UserQuestion } from '../../src/core/types.js'

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
    expect(parseAskqSelection('askq:0:1')).toEqual({ qIdx: 0, indices: [1] })
  })

  it('multi-select value "askq:2:1,3" parses to question 2, options 1 and 3', () => {
    expect(parseAskqSelection('askq:2:1,3')).toEqual({ qIdx: 2, indices: [1, 3] })
  })

  it('multi-select form prefix "askq_multi:1:2,4" normalizes to the askq form', () => {
    expect(parseAskqSelection('askq_multi:1:2,4')).toEqual({ qIdx: 1, indices: [2, 4] })
  })

  it('indices below 1 are filtered (empty multi submit selects nothing)', () => {
    expect(parseAskqSelection('askq:0:0')).toEqual({ qIdx: 0, indices: [] })
  })

  it('non-numeric segments drop out of the index list', () => {
    expect(parseAskqSelection('askq:0:1,x,3')).toEqual({ qIdx: 0, indices: [1, 3] })
  })

  it('legacy two-segment payload is rejected (ambiguous with multi-question cards)', () => {
    expect(parseAskqSelection('askq:0')).toBeUndefined()
  })

  it('plain text and other payloads are not askq selections', () => {
    expect(parseAskqSelection('PostgreSQL')).toBeUndefined()
    expect(parseAskqSelection('askq:a:1')).toBeUndefined()
    expect(parseAskqSelection('')).toBeUndefined()
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

describe('buildAskQuestionsCard', () => {
  it('single-select renders the question plus list rows with askq:{q}:{n} buttons', () => {
    const card = buildAskQuestionsCard('‼️ Setup', [singleQuestion()], new Map())

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

  it('all questions ride one card: later questions carry their own qIdx', () => {
    const card = buildAskQuestionsCard('‼️ Agent Question', [
      singleQuestion(),
      {
        question: 'Which framework?',
        header: 'Framework',
        options: [{ label: 'Gin', description: '' }, { label: 'Echo', description: '' }],
        multiSelect: false,
      },
    ], new Map())

    // Question 2 heading is numbered; its buttons address qIdx 1.
    const heading = card.elements[4] as { kind: string; content: string }
    expect(heading.content).toBe('**2. Which framework?**')
    const row = card.elements[5] as { btnValue: string }
    expect(row.btnValue).toBe('askq:1:1')
  })

  it('a multi-select question renders a checker form addressed by askq_multi:{q}', () => {
    const q: UserQuestion = { ...singleQuestion(), multiSelect: true }
    const card = buildAskQuestionsCard('‼️ Setup', [q], new Map())

    const form = card.elements[1] as {
      kind: string
      action?: string
      options: Array<{ label: string; value?: string }>
    }
    expect(form.kind).toBe('checkOptions')
    expect(form.action).toBe('askq_multi:0')
    expect(form.options.map(o => o.value)).toEqual(['1', '2', '3'])
  })

  it('an answered question renders frozen marks and no interactive buttons', () => {
    const card = buildAskQuestionsCard('‼️ Setup', [singleQuestion()], new Map([[0, [2]]]))

    expect(card.elements).toHaveLength(2)
    const frozen = card.elements[1] as { kind: string; content: string }
    expect(frozen.kind).toBe('markdown')
    expect(frozen.content).toContain('✅ **SQLite**')
    expect(frozen.content).toContain('◻️ **PostgreSQL**')
    expect(card.elements.some(e => e.kind === 'listItem')).toBe(false)
  })

  it('a mixed card keeps unanswered questions interactive beside a frozen one', () => {
    const card = buildAskQuestionsCard('t', [
      singleQuestion(),
      {
        question: 'Which framework?',
        header: '',
        options: [{ label: 'Gin', description: '' }],
        multiSelect: false,
      },
    ], new Map([[0, [1]]]))

    expect(card.elements.some(e => e.kind === 'markdown' && e.content.includes('✅ **PostgreSQL**'))).toBe(true)
    expect(card.elements.some(e => e.kind === 'listItem' && e.btnValue === 'askq:1:1')).toBe(true)
  })

  it('a question without options renders just its heading', () => {
    const q: UserQuestion = { ...singleQuestion(), options: [] }
    const card = buildAskQuestionsCard('t', [q], new Map())
    expect(card.elements).toHaveLength(1)
  })
})
