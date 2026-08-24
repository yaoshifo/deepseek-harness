/**
 * Progress-card injection tests ported from cc-connect platform/feishu
 * feishu_progress_test.go (the pure inject* / markCardStopped suites; the
 * platform-level cardcache suites live with the platform tests).
 *
 * @module dsh-feishu-bridge/tests-feishu-progress
 */

import { describe, expect, it } from 'vitest'
import { jArr, jObj, jParse, jStr, type JsonObj } from '../stubs/json.js'
import {
  collapseStructuralBlankLines,
  formatProgressToolInput,
  injectReplyButtons,
  injectStopButton,
  injectStoppedButtons,
} from '../../src/feishu/progress.js'

function mkCard(template: string): string {
  return JSON.stringify({
    header: {
      template,
      title: { tag: 'plain_text', content: 'x' },
    },
    body: { elements: [] },
  })
}

describe('injectStopButton', () => {
  const cases: Array<[name: string, template: string, sessionKey: string, wantButton: boolean]> = [
    ['thinking violet shows stop', 'violet', 'sk1', true],
    ['running yellow shows stop', 'yellow', 'sk1', true],
    ['completed green hides stop', 'green', 'sk1', false],
    ['failed red hides stop', 'red', 'sk1', false],
    ['empty sessionKey injects nothing', 'violet', '', false],
  ]
  for (const [name, template, sessionKey, wantButton] of cases) {
    it(name, () => {
      const out = injectStopButton(mkCard(template), sessionKey)
      const hasButton = out.includes('cmd:/stop')
      expect(hasButton).toBe(wantButton)
      if (hasButton) {
        expect(out).toContain('"size":"tiny"')
        expect(out).not.toContain('"margin"')
      }
    })
  }
})

describe('injectStopButton background hint', () => {
  interface ColumnSet { tag: string; columns?: Array<{ tag: string }> }

  function lastRow(out: string): ColumnSet {
    const card = JSON.parse(out) as { body: { elements: ColumnSet[] } }
    const row = card.body.elements.at(-1)
    expect(row?.tag).toBe('column_set')
    return row as ColumnSet
  }

  it('rides the stop-button row as a grey notation column', () => {
    const out = injectStopButton(mkCard('yellow'), 'sk1', '💡 1 个后台任务')
    const columns = lastRow(out).columns ?? []
    expect(columns).toHaveLength(2)
    expect(JSON.stringify(columns[0])).toContain('cmd:/stop')
    const hintCol = JSON.stringify(columns[1])
    expect(hintCol).toContain('💡 1 个后台任务')
    expect(hintCol).toContain('"text_size":"notation"')
    expect(hintCol).toContain('"text_color":"grey"')
  })

  it('empty hint keeps the single-column button row', () => {
    for (const hint of ['', '   ']) {
      const columns = lastRow(injectStopButton(mkCard('yellow'), 'sk1', hint)).columns ?? []
      expect(columns).toHaveLength(1)
    }
  })

  it('terminal cards inject no hint even when provided', () => {
    for (const template of ['green', 'red']) {
      expect(injectStopButton(mkCard(template), 'sk1', '💡 1 个后台任务')).toBe(mkCard(template))
    }
  })
})

describe('injectStoppedButtons', () => {
  const cases: Array<[name: string, sessionKey: string, wantDisabled: boolean, wantContinue: boolean]> = [
    ['with sessionKey shows both', 'sk1', true, true],
    ['empty sessionKey injects nothing', '', false, false],
  ]
  for (const [name, sessionKey, wantDisabled, wantContinue] of cases) {
    it(name, () => {
      const out = injectStoppedButtons(mkCard('yellow'), sessionKey)
      const hasDisabled = out.includes('已停止')
      const hasContinue = out.includes('cmd:继续')
      expect(hasDisabled).toBe(wantDisabled)
      expect(hasContinue).toBe(wantContinue)
      if (hasContinue) {
        expect(out).toContain('"size":"tiny"')
        expect(out).not.toContain('"margin"')
      }
    })
  }
})

describe('injectReplyButtons', () => {
  const cases: Array<[name: string, template: string, sessionKey: string, wantBoth: boolean]> = [
    ['completed green injects both buttons', 'green', 'feishu:oc_c', true],
    ['thinking violet injects nothing', 'violet', 'feishu:oc_c', false],
    ['failed red injects nothing', 'red', 'feishu:oc_c', false],
    ['empty sessionKey injects nothing', 'green', '', false],
  ]
  for (const [name, template, sessionKey, wantBoth] of cases) {
    it(name, () => {
      const out = injectReplyButtons(mkCard(template), sessionKey, 'om_card1', '')
      const hasExport = out.includes('📄 导出文件') && out.includes('export:om_card1')
      const hasSendReply = out.includes('💬 查看完整回复') && out.includes('sendreply:om_card1')
      expect(hasExport && hasSendReply).toBe(wantBoth)
      if (wantBoth) {
        expect(out).toContain('"size":"tiny"')
        expect(out).not.toContain('"margin"')
      }
    })
  }
})

describe('formatProgressToolInput todo rendering', () => {
  const todoJson = JSON.stringify({
    todos: [
      { content: 'step one', status: 'completed' },
      { content: 'step two', status: 'in_progress' },
    ],
  })

  it('renders a dsh todo_write input as a status-icon checklist', () => {
    const out = formatProgressToolInput('todo_write', todoJson)
    expect(out).toContain('✅ step one')
    expect(out).toContain('🔄 step two')
    expect(out).not.toContain('```')
  })

  it('renders a Claude-style TodoWrite input as a status-icon checklist', () => {
    const out = formatProgressToolInput('TodoWrite', todoJson)
    expect(out).toContain('✅ step one')
    expect(out).toContain('🔄 step two')
    expect(out).not.toContain('```')
  })

  it('falls back to a code block for non-todo tools', () => {
    const out = formatProgressToolInput('bash', 'echo hi')
    expect(out).toContain('```')
  })
})

describe('injectReplyButtons status text', () => {
  function findButtonColumnSet(cardJSON: string): JsonObj | undefined {
    const card = jParse(cardJSON)
    const elements = jArr(jObj(card.body).elements)
    for (const el of elements) {
      if (jStr(jObj(el).tag) === 'column_set') return jObj(el)
    }
    return undefined
  }

  it('with status text appends third status column', () => {
    const out = injectReplyButtons(mkCard('green'), 'feishu:oc_c', 'om_card1', '🖼 渲染中…')
    const cs = findButtonColumnSet(out)
    expect(cs).toBeDefined()
    const cols = jArr(cs?.columns)
    expect(cols.length).toBe(3)
    const statusCol = jObj(cols[2])
    const colElems = jArr(statusCol.elements)
    expect(colElems.length).toBe(1)
    const div = jObj(colElems[0])
    expect(jStr(div.tag)).toBe('div')
    expect(div).not.toHaveProperty('text_color')
    const text = jObj(div.text)
    expect(jStr(text.content)).toBe('🖼 渲染中…')
    expect(jStr(text.text_color)).toBe('grey')
    expect(jStr(text.text_size)).toBe('notation')
  })

  it('empty status text keeps only 2 button columns', () => {
    const out = injectReplyButtons(mkCard('green'), 'feishu:oc_c', 'om_card1', '')
    const cs = findButtonColumnSet(out)
    expect(jArr(cs?.columns).length).toBe(2)
  })

  it('non-green violet adds no buttons nor status', () => {
    const out = injectReplyButtons(mkCard('violet'), 'feishu:oc_c', 'om_card1', '🖼 渲染中…')
    expect(out).not.toContain('渲染中')
    expect(findButtonColumnSet(out)).toBeUndefined()
  })

  it('non-green yellow adds nothing', () => {
    const out = injectReplyButtons(mkCard('yellow'), 'feishu:oc_c', 'om_card1', '🖼 渲染中…')
    expect(out).not.toContain('渲染中')
    expect(findButtonColumnSet(out)).toBeUndefined()
  })

  it('terminal delivered status appends third column', () => {
    const out = injectReplyButtons(mkCard('green'), 'feishu:oc_c', 'om_card1', '✅ 已发送')
    const cs = findButtonColumnSet(out)
    expect(jArr(cs?.columns).length).toBe(3)
    const div = jObj(jArr(jObj(jArr(cs?.columns)[2]).elements)[0])
    expect(jStr(jObj(div.text).content)).toBe('✅ 已发送')
  })
})

describe('collapseStructuralBlankLines', () => {
  it('removes only blanks adjacent to fences, keeping the header line', () => {
    const in1 = '```bash\necho hi\n```\n\n**10:00:01** 🔍 `Read` · 3 🔴\n\n```text\nRead -> x\n```\n'
    const want = '```bash\necho hi\n```\n**10:00:01** 🔍 `Read` · 3 🔴\n```text\nRead -> x\n```\n'
    expect(collapseStructuralBlankLines(in1)).toBe(want)
  })

  it('preserves a blank between two non-structural paragraphs', () => {
    const in2 = 'para one\n\npara two'
    expect(collapseStructuralBlankLines(in2)).toBe(in2)
  })

  it('preserves a blank between a bold header and a list', () => {
    const in3 = '**改动明细：**\n\n- item one\n\n- item two'
    expect(collapseStructuralBlankLines(in3)).toBe(in3)
  })

  it('removes a blank adjacent to an ATX heading', () => {
    expect(collapseStructuralBlankLines('# 标题\n\npara')).toBe('# 标题\npara')
    expect(collapseStructuralBlankLines('para\n\n## 子标题')).toBe('para\n## 子标题')
  })

  it('treats a hash-prefixed reference as a plain paragraph', () => {
    const in4 = 'para one\n\n#59（随便聊聊）不是标题'
    expect(collapseStructuralBlankLines(in4)).toBe(in4)
  })

  it('preserves blanks inside a code block', () => {
    const in5 = '```text\na\n\nb\n```'
    expect(collapseStructuralBlankLines(in5)).toBe(in5)
  })

  it('preserves a blank adjacent to a table row', () => {
    const in6 = 'para\n\n| a | b |\n|---|---|\n| 1 | 2 |'
    expect(collapseStructuralBlankLines(in6)).toBe(in6)
  })
})
