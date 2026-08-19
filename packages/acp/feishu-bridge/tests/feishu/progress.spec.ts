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
