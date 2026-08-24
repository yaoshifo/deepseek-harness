/**
 * Card renderer tests ported from cc-connect platform/feishu card_test.go,
 * card_sanitize_test.go, and the card-JSON tests in feishu_test.go.
 *
 * @module dsh-feishu-bridge/tests-feishu-card
 */

import { describe, expect, it } from 'vitest'
import {
  Card,
  dangerBtn,
  defaultBtn,
  newCard,
  primaryBtn,
  type CardButton,
  type CardColumnSet,
} from '../../src/card.js'
import {
  deleteModeCheckerName,
  renderCard,
  renderCardMap,
  renderElement,
} from '../../src/feishu/card.js'
import { buildReplyContent, buildPreviewCardJSON } from '../../src/feishu/progress.js'
import { noSpinner } from '../../src/feishu/spinner.js'
import { msgTypeInteractive } from '../../src/feishu/markdown.js'
import { jArr, jObj, jParse, jStr, type Json, type JsonObj } from '../stubs/json.js'

function decodeRenderedCard(card: Card | undefined): JsonObj {
  return jParse(renderCard(card, ''))
}

function getBodyElements(got: JsonObj): Json[] {
  const elements = jArr(jObj(got.body).elements)
  expect(elements.length).toBeGreaterThan(0)
  return elements
}

describe('renderCardMap', () => {
  it('equal-columns actions use column_set', () => {
    const buttons: CardButton[] = [
      primaryBtn('Session Management', 'nav:/help session'),
      defaultBtn('Agent Configuration', 'nav:/help agent'),
      defaultBtn('Tools & Automation', 'nav:/help tools'),
      defaultBtn('System', 'nav:/help system'),
    ]
    const got = decodeRenderedCard(newCard().buttonsEqual(...buttons).build())

    const elements = getBodyElements(got)
    expect(elements.length).toBe(1)
    const columnSet = jObj(elements[0])
    expect(jStr(columnSet.tag)).toBe('column_set')
    expect(columnSet.margin).toBeUndefined()
    const columns = jArr(columnSet.columns)
    expect(columns.length).toBe(buttons.length)

    columns.forEach((colRaw, i) => {
      const col = jObj(colRaw)
      expect(jStr(col.width)).toBe('weighted')
      expect(col.weight).toBe(1)
      const inner = jArr(col.elements)
      expect(inner.length).toBe(1)
      const btn = jObj(inner[0])
      expect(jStr(btn.tag)).toBe('button')
      expect(jStr(btn.size)).toBe('tiny')
      expect(jStr(jObj(btn.text).content)).toBe(buttons[i]?.text)
      expect(jStr(btn.type)).toBe(buttons[i]?.type)
      expect(jStr(jObj(btn.value).action)).toBe(buttons[i]?.value)
    })
  })

  it('two equal columns use bisect and centered buttons', () => {
    const buttons: CardButton[] = [
      primaryBtn('Session Management', 'nav:/help session'),
      defaultBtn('Agent Configuration', 'nav:/help agent'),
    ]
    const got = decodeRenderedCard(newCard().buttonsEqual(...buttons).build())

    const elements = getBodyElements(got)
    expect(elements.length).toBe(1)
    const columnSet = jObj(elements[0])
    expect(jStr(columnSet.flex_mode)).toBe('bisect')
    expect(columnSet.margin).toBeUndefined()
    const columns = jArr(columnSet.columns)
    expect(columns.length).toBe(buttons.length)
    for (const colRaw of columns) {
      const col = jObj(colRaw)
      expect(jStr(col.horizontal_align)).toBe('center')
      const inner = jArr(col.elements)
      expect(inner.length).toBe(1)
      expect(jStr(jObj(inner[0]).width)).toBe('fill')
    }
  })

  it('default actions use column_set (schema 2.0 forbids action tag)', () => {
    const buttons: CardButton[] = [
      primaryBtn('Yes', 'act:/yes'),
      defaultBtn('No', 'act:/no'),
    ]
    const got = decodeRenderedCard(newCard().buttons(...buttons).build())

    const elements = getBodyElements(got)
    expect(elements.length).toBe(1)
    const columnSet = jObj(elements[0])
    expect(jStr(columnSet.tag)).toBe('column_set')
    expect(columnSet.margin).toBeUndefined()
    const columns = jArr(columnSet.columns)
    expect(columns.length).toBe(buttons.length)
    columns.forEach((colRaw, i) => {
      const col = jObj(colRaw)
      expect(jStr(col.width)).toBe('auto')
      const inner = jArr(col.elements)
      expect(inner.length).toBe(1)
      const btn = jObj(inner[0])
      expect(jStr(btn.tag)).toBe('button')
      expect(jStr(btn.size)).toBe('tiny')
      expect(jStr(jObj(btn.text).content)).toBe(buttons[i]?.text)
      expect(jStr(btn.type)).toBe(buttons[i]?.type)
      expect(jStr(jObj(btn.value).action)).toBe(buttons[i]?.value)
    })
  })

  it('checkOptions carries the initial checked state on the checker', () => {
    const card = newCard()
      .checkOptions('Which fixes?', [
        { label: 'Fix leak', description: 'src/a.ts:12', checked: true },
        { label: 'Add test', description: 'tests/a.spec.ts' },
      ], 'askq_multi:0', { askq_question: 'Which fixes?' })
      .build()

    const got = decodeRenderedCard(card)
    const form = getBodyElements(got).map(jObj).find(e => jStr(e.tag) === 'form')
    expect(form).toBeDefined()
    const checkers = jArr(jObj(form).elements).map(jObj).filter(e => jStr(e.tag) === 'checker')
    expect(checkers.map(c => [jStr(c.name), c.checked])).toEqual([
      ['askq_opt_1', true],
      ['askq_opt_2', undefined],
    ])
  })

  it('delete-mode uses checker form', () => {
    const card = newCard()
      .title('删除会话', 'carmine')
      .listItemBtn('☑ **1.** One · **10** msgs · 03-13 20:00', '已选择', 'primary', 'act:/delete-mode toggle session-1')
      .listItemBtn('▶ **2.** Active · **30** msgs · 03-13 20:01', '当前会话', 'primary', 'act:/delete-mode noop session-2')
      .listItemBtn('◻ **3.** Three · **20** msgs · 03-13 20:02', '选择', 'default', 'act:/delete-mode toggle session-3')
      .note('2 selected')
      .buttons(
        dangerBtn('删除已选', 'act:/delete-mode confirm'),
        defaultBtn('取消', 'act:/delete-mode cancel'),
      )
      .buttons(defaultBtn('下一页 →', 'act:/delete-mode page 2'))
      .build()

    const got = decodeRenderedCard(card)
    const s = JSON.stringify(got)
    expect(s).toContain('"tag":"form"')
    expect(s).toContain('"tag":"checker"')
    expect(s.split('"tag":"checker"').length - 1).toBe(2)
    expect(s).toContain(deleteModeCheckerName('session-1'))
    expect(s).not.toContain(deleteModeCheckerName('session-2'))
    expect(s).toContain(deleteModeCheckerName('session-3'))
    const activeIdx = s.indexOf('▶ **2.** Active')
    const firstIdx = s.indexOf(deleteModeCheckerName('session-1'))
    const thirdIdx = s.indexOf(deleteModeCheckerName('session-3'))
    expect(activeIdx).toBeGreaterThanOrEqual(0)
    expect(firstIdx).toBeGreaterThanOrEqual(0)
    expect(thirdIdx).toBeGreaterThanOrEqual(0)
    expect(firstIdx).toBeLessThan(activeIdx)
    expect(activeIdx).toBeLessThan(thirdIdx)
    expect(s).toContain('"name":"delete_mode_form"')
    expect(s).toContain('"name":"delete_mode_submit"')
    expect(s).toContain('"name":"delete_mode_cancel"')
    expect(s).toContain('"form_action_type":"submit"')
    expect(s).toContain('act:/delete-mode form-submit')
    expect(s).toContain('"size":"tiny"')
    expect(s).not.toContain('"margin"')
    expect(s).not.toContain('act:/delete-mode toggle')
    // 紧凑基线：body 必须带 padding + vertical_spacing。
    expect(jStr(jObj(got.body).padding)).toBe('4px 12px 4px 12px')
    expect(jStr(jObj(got.body).vertical_spacing)).toBe('0px')
  })

  it('injects session key into callbacks', () => {
    const card = newCard()
      .buttons(primaryBtn('Open', 'nav:/help session'))
      .listItem('Choose', 'Confirm', 'act:/confirm')
      .select('Pick one', [{ text: 'A', value: 'askq:0:1' }], '')
      .build()

    const got = renderCardMap(card, 'feishu:oc_chat:root:om_root')
    const elements = jArr(jObj(got.body).elements)
    expect(elements.length).toBe(3)

    // elements[0]: Buttons() → column_set
    const firstCols = jArr(jObj(elements[0]).columns)
    const firstButton = jObj(jArr(jObj(firstCols[0]).elements)[0])
    expect(jStr(jObj(firstButton.value).session_key)).toBe('feishu:oc_chat:root:om_root')
    expect(jStr(firstButton.size)).toBe('tiny')

    // elements[1]: ListItem → column_set
    const listCols = jArr(jObj(elements[1]).columns)
    const listBtn = jObj(jArr(jObj(listCols[1]).elements)[0])
    expect(jStr(jObj(listBtn.value).session_key)).toBe('feishu:oc_chat:root:om_root')
    expect(jStr(listBtn.size)).toBe('tiny')

    // elements[2]: Select → select_static directly
    expect(jStr(jObj(jObj(elements[2]).value).session_key)).toBe('feishu:oc_chat:root:om_root')
  })

  it('column_set has no margin', () => {
    const card = new Card()
    card.elements = [
      {
        kind: 'columnSet',
        columns: [
          {
            width: 'auto',
            elements: [{ kind: 'actions', buttons: [primaryBtn('run', 'cmd:/run')], layout: 'row' }],
          },
          {
            width: 'weighted',
            weight: 1,
            elements: [{ kind: 'input', name: 'arg', placeholder: '参数' }],
          },
        ],
      } satisfies CardColumnSet,
    ]
    const got = decodeRenderedCard(card)
    const elements = getBodyElements(got)
    expect(elements.length).toBe(1)
    expect(jStr(jObj(elements[0]).tag)).toBe('column_set')
    expect(jObj(elements[0]).margin).toBeUndefined()
  })

  it('body has zero vertical spacing', () => {
    const got = decodeRenderedCard(newCard().title('t', 'blue').markdown('hello').build())
    expect(jStr(jObj(got.body).vertical_spacing)).toBe('0px')
  })
})

describe('renderElement sanitize', () => {
  it('list item sanitizes html and urls', () => {
    const got = renderElement(
      {
        kind: 'listItem',
        text: '选项 A',
        description: 'desc <div>with html</div> and ![img](http://x/y.png)',
        btnText: '1',
        btnType: 'default',
        btnValue: 'v',
      },
      '',
    )
    expect(got).toBeDefined()
    expect(jStr(got?.tag)).toBe('column_set')
    const leftCol = jObj(jArr(jObj(got).columns)[0])
    const content = jStr(jObj(jArr(leftCol.elements)[0]).content)
    expect(content).not.toContain('<div')
    expect(content).not.toContain('![')
    expect(content).toContain('with html')
  })

  it('card image fit_horizontal full-bleed', () => {
    const got = renderElement({ kind: 'image', imageKey: 'k', alt: 't', scaleType: 'fit_horizontal' }, '')
    expect(jStr(got?.scale_type)).toBe('fit_horizontal')
    expect(jStr(got?.margin)).toContain('-12px')
    expect(got).not.toHaveProperty('size')
  })

  it('card image default crop center', () => {
    const got = renderElement({ kind: 'image', imageKey: 'k', alt: 't' }, '')
    expect(jStr(got?.scale_type)).toBe('crop_center')
    expect(jStr(got?.size)).toBe('stretch')
    expect(got).not.toHaveProperty('margin')
  })
})

describe('buildReplyContent', () => {
  it('falls back to post when many tables', () => {
    const mk = (n: number): string => {
      const parts: string[] = []
      for (let i = 0; i < n; i++) {
        if (i > 0) parts.push('\n\nsome text\n\n')
        parts.push('| H |\n|---|\n| V |')
      }
      return parts.join('')
    }
    expect(buildReplyContent(mk(6)).msgType).not.toBe(msgTypeInteractive)
    expect(buildReplyContent(mk(5)).msgType).toBe(msgTypeInteractive)
  })

  it('strips html in the card path', () => {
    const content = "❓ Question\n\n1. Label1 — desc\n   <div class='hero'><p>善本</p></div>\n"
    const { msgType, body } = buildReplyContent(content)
    expect(msgType).toBe(msgTypeInteractive)
    expect(body).not.toContain('<div')
    expect(body).not.toContain('<p>')
    expect(body).toContain('善本')
  })
})

describe('buildPreviewCardJSON', () => {
  it('collapses excess tables', () => {
    const parts: string[] = []
    for (let i = 0; i < 7; i++) parts.push(`| ${String.fromCharCode(65 + i)} |\n|---|`)
    const out = buildPreviewCardJSON(parts.join('\n\n'), noSpinner)
    expect(out).toContain('更多表格见完整答复')
    expect(out).not.toContain('| F |')
    expect(out).not.toContain('| G |')
    expect(out).toContain('| A |')
    expect(out).toContain('| E |')
  })

  it('keeps paragraph breaks in the reply below tool entries', () => {
    // Schema 2.0 card markdown renders a single \n as whitespace, so the
    // blank lines separating a bold header from its list must survive the
    // preview-card pipeline.
    const reply = '**改动明细：**\n\n- item one\n\n- item two'
    const tool = '**10:00:01** <text_tag color=\'blue\'>bash</text_tag> · 1 🟢\n```text\ncmd\n---\nok\n```'
    const content = `__cc_state__:completed\n__cc_ts__:10:00:05\n__cc_tc__:1\n${tool}\n${reply}`
    const card = jParse(buildPreviewCardJSON(content, noSpinner))
    const md = jStr(jObj(jArr(jObj(card.body).elements)[0]).content)
    expect(md).toContain('**改动明细：**\n\n- item one\n\n- item two')
  })
})
