import { describe, expect, it } from 'vitest'
import {
  appendIntoLastCollapsible,
  type CardActions,
  type CardElement,
  type CardForm,
  defaultBtn,
  newCard,
  primaryBtn,
  type CardSelectOption,
} from '../src/card.js'

// Ported from cc-connect core/card_test.go (3 Go tests). Go struct literals
// become object literals with kind discriminant tags.

describe('card renderText', () => {
  it('IncludesAllElementTypes', () => {
    const card = newCard()
      .title('Help', 'blue')
      .markdown('Use `/help` to see commands.')
      .divider()
      .buttons(primaryBtn('Run', 'cmd:/run'), defaultBtn('Cancel', 'cmd:/cancel'))
      .listItemBtn('Current session', 'Switch', 'primary', 'act:/switch 1')
      .select('Mode', [{ text: 'Default', value: 'default' }, { text: 'YOLO', value: 'yolo' }] satisfies CardSelectOption[], 'default')
      .note('Tip: /new starts a fresh session.')
      .build()

    const got = card.renderText()
    const want = '**Help**\n\nUse `/help` to see commands.\n\n---\n\n[Run]  [Cancel]\n\nCurrent session  [Switch]\nMode: Default | YOLO\n\nTip: /new starts a fresh session.'
    expect(got).toBe(want)
  })
})

describe('card hasButtons', () => {
  it('no interactive elements', () => {
    expect(newCard().markdown('Plain text only').build().hasButtons()).toBe(false)
  })

  it('action row buttons', () => {
    expect(newCard().buttons(defaultBtn('Open', 'cmd:/open')).build().hasButtons()).toBe(true)
  })

  it('list item button', () => {
    expect(newCard().listItem('Session A', 'Switch', 'act:/switch 1').build().hasButtons()).toBe(true)
  })

  it('select dropdown', () => {
    expect(newCard().select('Mode', [{ text: 'Default', value: 'default' }], 'default').build().hasButtons()).toBe(true)
  })
})

describe('appendIntoLastCollapsible', () => {
  const action: CardActions = {
    kind: 'actions',
    buttons: [{ text: '↩ 父群', type: 'default', value: '', url: 'https://example.com' }],
    layout: 'row',
  }

  it('appends into panel', () => {
    const elements: CardElement[] = [
      {
        kind: 'form',
        elements: [
          { kind: 'collapsiblePanel', elements: [{ kind: 'markdown', content: 'x' }] },
        ],
      } satisfies CardForm,
    ]
    const got = appendIntoLastCollapsible(elements, action)
    const form = got[0] as CardForm
    const panel = form.elements[0]!
    expect(panel).toMatchObject({ kind: 'collapsiblePanel' })
    expect(panel.kind === 'collapsiblePanel' ? panel.elements.length : 0).toBe(2)
    if (panel.kind === 'collapsiblePanel') {
      expect(panel.elements[1]?.kind).toBe('actions')
    }
    expect(got.length).toBe(1)
  })

  it('falls back to top-level when no panel', () => {
    const elements: CardElement[] = [{ kind: 'markdown', content: 'x' }]
    const got = appendIntoLastCollapsible(elements, action)
    expect(got.length).toBe(2)
    expect(got[1]?.kind).toBe('actions')
  })

  it('targets last form\'s panel', () => {
    const elements: CardElement[] = [
      { kind: 'form', elements: [{ kind: 'collapsiblePanel', elements: [{ kind: 'markdown', content: 'a' }] }] },
      { kind: 'form', elements: [{ kind: 'collapsiblePanel', elements: [{ kind: 'markdown', content: 'b' }] }] },
    ]
    const got = appendIntoLastCollapsible(elements, action)
    const first = got[0] as CardForm
    const second = got[1] as CardForm
    const firstPanel = first.elements[0]!
    const secondPanel = second.elements[0]!
    expect(firstPanel.kind === 'collapsiblePanel' ? firstPanel.elements.length : 0).toBe(1)
    expect(secondPanel.kind === 'collapsiblePanel' ? secondPanel.elements.length : 0).toBe(2)
    if (secondPanel.kind === 'collapsiblePanel') {
      expect(secondPanel.elements[1]?.kind).toBe('actions')
    }
  })
})
