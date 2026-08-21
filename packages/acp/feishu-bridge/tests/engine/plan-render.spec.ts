/**
 * M7 plan/reply HTML render pure-logic tests, ported from cc-connect
 * core/engine_plan_render_test.go (throttle, path derivation, slugify, title
 * extraction, temp cleanup, render cancels, status text, plan-card status
 * PATCH, assembleHTML template suite, icon sprite extraction, SVG var/viewBox
 * sanitation, prompt expression contracts, preview-discard predicate).
 *
 * @module dsh-feishu-bridge/tests-engine-plan-render
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Engine, InteractiveState } from '../../src/engine/engine.js'
import { newCard } from '../../src/card.js'
import {
  assembleHTML,
  cancelRenders,
  clearPlanRenderRunning,
  cloneCardWithStatusNote,
  deriveHtmlPath,
  displayReplyText,
  ensureSVGViewBox,
  extractHTMLTitle,
  extractMarkdownTitle,
  extractUsedIcons,
  getRenderStatus,
  recordRenderedReply,
  registerRenderCancel,
  removeRenderedTemp,
  renderReplySummaryPrompt,
  renderSessionPrompt,
  renderStatusText,
  sanitizeSVGVars,
  slugifyTitle,
  setRenderStatus,
  shouldDiscardPreviewBeforeReplyRender,
  shouldRenderPlan,
  storePlanExport,
  updatePlanCardStatus,
} from '../../src/engine/plan-render.js'
import { diagramCSS, diagramDefs, renderTemplatePlan, renderTemplateReply } from '../../src/engine/plan-render-templates.js'
import type { StreamPreview } from '../../src/streaming.js'
import { Msg } from '../../src/i18n/keys.js'
import { createStubAgent, createStubPlatform } from '../stubs/engine-stubs.js'
import type { Platform } from '../../src/core/types.js'
import { createCardUpdatePlatform } from './plan-render-helpers.js'

function newTestEngine(): Engine {
  return new Engine('test', createStubAgent(), [createCardUpdatePlatform()], '', 'en')
}

describe('ShouldRenderPlan_Throttle', () => {
  it('blocks while running, dedupes unchanged content, debounces rev>1, nil state never renders', () => {
    const e = newTestEngine()
    const state = new InteractiveState()

    expect(shouldRenderPlan(state, 'plan A', 1)).toBe(true)
    expect(shouldRenderPlan(state, 'plan A', 1)).toBe(false)
    clearPlanRenderRunning(state)

    expect(shouldRenderPlan(state, 'plan A', 2)).toBe(false)
    expect(shouldRenderPlan(state, 'plan B', 2)).toBe(false)

    expect(shouldRenderPlan(undefined, 'x', 1)).toBe(false)
    void e
  })
})

describe('ShouldRenderPlan_Rev1IgnoresDebounce', () => {
  it('two back-to-back rev-1 renders are both allowed', () => {
    const state = new InteractiveState()
    expect(shouldRenderPlan(state, 'first', 1)).toBe(true)
    clearPlanRenderRunning(state)
    expect(shouldRenderPlan(state, 'second', 1)).toBe(true)
  })
})

describe('DeriveHtmlPath', () => {
  it('keeps the plan dir and stacks revision suffixes; nameHint overrides the basename', () => {
    expect(deriveHtmlPath('/wd/.claude/plans/foo.md', 'sess', '', 1)).toBe('/wd/.claude/plans/foo.html')
    expect(deriveHtmlPath('/wd/.claude/plans/foo.md', 'sess', '', 3)).toBe('/wd/.claude/plans/foo-v3.html')

    const inline = deriveHtmlPath('', 'my-sess', '', 1)
    expect(inline.endsWith('.html')).toBe(true)
    expect(inline.includes('my-sess')).toBe(true)

    expect(deriveHtmlPath('/wd/.claude/plans/foo.md', 'sess', '修复告警', 1)).toBe('/wd/.claude/plans/修复告警.html')
    expect(deriveHtmlPath('/wd/.claude/plans/foo.md', 'sess', '修复告警', 3)).toBe('/wd/.claude/plans/修复告警-v3.html')
    const inlineHint = deriveHtmlPath('', 'my-sess', '修复告警', 1)
    expect(inlineHint.endsWith('/修复告警.html')).toBe(true)
  })
})

describe('SlugifyTitle', () => {
  const cases: Array<[string, string, string, string]> = [
    ['markdown header', '# 修复登录 bug\n详见下文', 'reply', '修复登录 bug'],
    ['plain', '这是回复正文', 'reply', '这是回复正文'],
    ['bullet', '- 列表项\n第二行', 'reply', '列表项'],
    ['blockquote', '> 引用内容', 'reply', '引用内容'],
    ['ordered list', '1. 第一点\n2. 第二点', 'reply', '第一点'],
    ['code fence with lang', '```go\npackage main', 'reply', 'go'],
    ['code fence bare', '```\ncode', 'reply', 'reply'],
    ['unsafe chars', 'foo/bar:baz*qux', 'reply', 'foo-bar-baz-qux'],
    ['hash becomes dash', '优化特性 #47-#48 生成的 HTML', 'fb', '优化特性 -47-48 生成的 HTML'],
    ['leading unsafe trimmed', ':/foo', 'reply', 'foo'],
    ['empty', '', 'reply', 'reply'],
    ['only whitespace', '   \n  ', 'reply', 'reply'],
    ['only markers', '---\n正文', 'reply', 'reply'],
    ['long truncate', '字'.repeat(50), 'reply', '字'.repeat(40)],
    ['empty with custom fallback', '', 'plan', 'plan'],
    ['all-unsafe falls back', '///', 'fallback-name', 'fallback-name'],
  ]
  for (const [name, input, fallback, want] of cases) {
    it(name, () => {
      expect(slugifyTitle(input, fallback)).toBe(want)
    })
  }
})

describe('ExtractHTMLTitle', () => {
  const cases: Array<[string, string, string]> = [
    ['simple', '<html><head><title>修复登录 bug</title></head></html>', '修复登录 bug'],
    ['full doc', '<!DOCTYPE html><html><head><meta charset="utf-8"><title>导出文件名</title><style>x{}</style></head><body></body></html>', '导出文件名'],
    ['entity', '<title>a &amp; b &lt;tag&gt;</title>', 'a & b <tag>'],
    ['icon prefix in h1', '<h1><svg class="icon"><use href="#icon-wrench"/></svg> 修复 #51 污染</h1>', '修复 #51 污染'],
    ['icon prefix in title', '<title><svg class="icon"><use href="#icon-wrench"/></svg> 导出标题</title>', '导出标题'],
    ['attrs', '<title lang="zh">带属性</title>', '带属性'],
    ['whitespace', '<title>  前后空格  </title>', '前后空格'],
    ['fallback h1', '<html><head></head><body><h1>只有H1</h1></body></html>', '只有H1'],
    ['none', '<html><head></head><body></body></html>', ''],
    ['empty title', '<title></title>', ''],
  ]
  for (const [name, html, want] of cases) {
    it(name, () => {
      expect(extractHTMLTitle(html)).toBe(want)
    })
  }
})

describe('ExtractMarkdownTitle', () => {
  const cases: Array<[string, string, string]> = [
    ['typical h1', '# 修复登录 bug\n\n正文', '修复登录 bug'],
    ['blank lines before h1', '\n\n# 标题\n正文', '标题'],
    ['indented h1', '  # 缩进标题', '缩进标题'],
    ['h2 counts as first heading', '## 二级标题\n正文', '二级标题'],
    ['first heading wins', '# 第一\n# 第二', '第一'],
    ['heading after prose', '正文段落\n# 标题', '标题'],
    ['trailing whitespace trimmed', '# 标题   \n正文', '标题'],
    ['full-width colon kept', '# 修复：split_param 的告警', '修复：split_param 的告警'],
    ['no heading', '纯文本无标题\n第二行', ''],
    ['hash not at line start', 'foo # bar', ''],
    ['empty', '', ''],
  ]
  for (const [name, input, want] of cases) {
    it(name, () => {
      expect(extractMarkdownTitle(input)).toBe(want)
    })
  }
})

describe('RemoveRenderedTemp_Guarded', () => {
  it('removes cc-plan-render-* dirs, preserves others, no-ops on empty path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-plan-render-'))
    const hp = join(dir, 'sess.html')
    writeFileSync(hp, '<html></html>', 'utf8')
    await removeRenderedTemp(hp)
    expect(existsSync(dir)).toBe(false)

    const dir2 = mkdtempSync(join(tmpdir(), 'plans-stash-'))
    const hp2 = join(dir2, 'plan.html')
    writeFileSync(hp2, '<html></html>', 'utf8')
    await removeRenderedTemp(hp2)
    expect(existsSync(hp2)).toBe(true)

    await removeRenderedTemp('')
  })
})

/** Make a cc-plan-render-* temp dir holding one html file (Go test mk helper). */
function mkRenderTemp(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cc-plan-render-'))
  const p = join(dir, 'sess.html')
  writeFileSync(p, body, 'utf8')
  return p
}

describe('RecordRenderedReply_RetainsAcrossTurns', () => {
  it('second turn record does not evict or delete the first turn HTML', () => {
    const mk = mkRenderTemp
    const path1 = mk('<html>1</html>')
    const path2 = mk('<html>2</html>')
    const state = new InteractiveState()

    recordRenderedReply(state, 'ek1', path1)
    recordRenderedReply(state, 'ek2', path2)

    expect(state.renderedReplyHTML?.get('ek1')).toBe(path1)
    expect(state.renderedReplyHTML?.get('ek2')).toBe(path2)
    expect(existsSync(path1)).toBe(true)
  })
})

describe('RenderCancels', () => {
  it('register and cancel all', () => {
    const s = new InteractiveState()
    const ctl1 = new AbortController()
    const ctl2 = new AbortController()
    registerRenderCancel(s, () => { ctl1.abort() })
    registerRenderCancel(s, () => { ctl2.abort() })
    cancelRenders(s)
    expect(ctl1.signal.aborted).toBe(true)
    expect(ctl2.signal.aborted).toBe(true)
  })

  it('unregistered cancel is not invoked', () => {
    const s = new InteractiveState()
    const ctl = new AbortController()
    const h = registerRenderCancel(s, () => { ctl.abort() })
    registerRenderCancel(s, undefined)
    // @ts-expect-error nil-handle mirror of the Go test
    registerRenderCancel(undefined, undefined)
    if (h !== undefined) { /* keep type-narrowed */ }
    // unregister then cancel: not invoked
    s.renderCancels = []
    cancelRenders(s)
    expect(ctl.signal.aborted).toBe(false)
  })

  it('cancel clears the set so a later register works', () => {
    const s = new InteractiveState()
    const ctl1 = new AbortController()
    registerRenderCancel(s, () => { ctl1.abort() })
    cancelRenders(s)
    expect(ctl1.signal.aborted).toBe(true)
    expect(s.renderCancels).toHaveLength(0)

    const ctl2 = new AbortController()
    registerRenderCancel(s, () => { ctl2.abort() })
    cancelRenders(s)
    expect(ctl2.signal.aborted).toBe(true)
  })

  it('nil and empty are safe', () => {
    const s = new InteractiveState()
    registerRenderCancel(s, undefined)
    cancelRenders(undefined)
    cancelRenders(s)
  })
})

describe('RenderStatusText_AppendsElapsed', () => {
  it('delivered/rendering append rounded seconds; cancelled/failed ignore elapsed', () => {
    const e = newTestEngine()
    expect(renderStatusText(e, 'delivered', 67_000)).toBe(`${e.i18n.t(Msg.RenderStatusDelivered)} 67s`)
    expect(renderStatusText(e, 'delivered', 0)).toBe(e.i18n.t(Msg.RenderStatusDelivered))
    expect(renderStatusText(e, 'delivered', 67_600)).toBe(`${e.i18n.t(Msg.RenderStatusDelivered)} 68s`)
    expect(renderStatusText(e, 'rendering', 99_000)).toBe(`${e.i18n.t(Msg.RenderStatusRendering)} 99s`)
    expect(renderStatusText(e, 'rendering', 0)).toBe(e.i18n.t(Msg.RenderStatusRendering))
    expect(renderStatusText(e, 'failed', 99_000)).toBe(e.i18n.t(Msg.RenderStatusFailed))
  })
})

describe('UpdatePlanCardStatus', () => {
  it('patches the stored plan card with a status Note in the button row', async () => {
    const p = createCardUpdatePlatform()
    // CardSenderWithUpdate requires both members for the structural check.
    p.sendCardWithHandle = async () => 'plan-handle'
    const e = new Engine('test', createStubAgent(), [p], '', 'en')

    const baseCard = newCard()
      .title('计划·x', 'blue')
      .markdown('plan body')
      .buttons({ text: '导出', type: 'default', value: 'export:plan:1' })
      .build()
    const state = new InteractiveState()
    state.platform = p
    state.planCardRender = new Map([['plan:1', { handle: 'h1', baseCard }]])

    updatePlanCardStatus(e, state, 'plan:1', 'delivered', 0)
    await new Promise((resolve) => { setTimeout(resolve, 20) })

    expect(p.updated).toHaveLength(1)
    expect(p.updated[0]?.handle).toBe('h1')
    const card = p.updated[0]?.card as { elements: Array<{ kind: string; note?: string }> }
    const actions = card.elements.find(el => el.kind === 'actions')
    expect(actions?.note).toBe(e.i18n.t(Msg.RenderStatusDelivered))
    // baseCard must be untouched (clone, not mutate).
    expect(baseCard.elements.some(el => el.kind === 'actions' && el.note !== undefined)).toBe(false)

    const entry = getRenderStatus(state, 'plan:1')
    expect(entry?.status).toBe('delivered')
    expect(entry?.kind).toBe('plan')
  })

  it('records status without PATCHing when no handle is stored', () => {
    const p = createCardUpdatePlatform()
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    const state = new InteractiveState()
    state.platform = p

    updatePlanCardStatus(e, state, 'plan:2', 'failed', 0)

    expect(p.updated).toHaveLength(0)
    expect(getRenderStatus(state, 'plan:2')?.status).toBe('failed')
  })
})

describe('setRenderStatus / storePlanExport', () => {
  it('records statuses per exportKey and caches plan markdown for the export button', () => {
    const state = new InteractiveState()
    setRenderStatus(state, 'plan:1', 'plan', 'rendering')
    expect(getRenderStatus(state, 'plan:1')?.status).toBe('rendering')
    storePlanExport(state, 'plan:1', '# plan')
    expect(state.exportContent?.get('plan:1')).toBe('# plan')
  })
})

describe('cloneCardWithStatusNote', () => {
  it('returns undefined for a missing base card', () => {
    expect(cloneCardWithStatusNote(undefined, 'x')).toBeUndefined()
  })
})

const planBody = `<div class="wrap">
  <header>
    <h1>#47/#48 plan-render 优化计划</h1>
    <p class="sub">加速渲染管道</p>
  </header>
  <div class="diagram"><svg xmlns="http://www.w3.org/2000/svg"></svg></div>
</div>`

describe('AssembleHTML', () => {
  it('plan wraps body with F/Swiss palette + title from h1', () => {
    const out = assembleHTML('plan', planBody, '')
    for (const want of ['<!DOCTYPE html>', '#0969da', '<title>#47/#48 plan-render 优化计划</title>', 'class="diagram"']) {
      expect(out).toContain(want)
    }
    expect(out).not.toContain('BlinkMacSystemFont')
    expect(out).not.toContain('{{')
  })

  it('reply wraps body with the reply palette', () => {
    const out = assembleHTML('reply', '<div class="wrap"><header><h1>做了X</h1></header></div>', '')
    expect(out).toContain('#1a7f37')
    expect(out).toContain('<title>做了X</title>')
    expect(out).not.toContain('#c96442')
  })

  it('unknown subtype falls back to the plan template', () => {
    expect(assembleHTML('bogus', planBody, '')).toContain('#0969da')
  })

  it('resolves the TITLE placeholder even without an h1', () => {
    const out = assembleHTML('plan', '<div class="wrap"><p>无标题</p></div>', '')
    expect(out).not.toContain('{{TITLE}}')
  })

  it('plan template CSS keeps the full class set', () => {
    const out = assembleHTML('plan', planBody, '')
    for (const sel of ['.file-list', 'table.compare', '.summary-band', '.key-point', '.diagram', '.keypoints']) {
      expect(out).toContain(sel)
    }
  })

  it('reply template CSS keeps the full class set', () => {
    const out = assembleHTML('reply', '<div class="wrap"><h1>x</h1></div>', '')
    for (const sel of ['.keypoints', '.file-list', '.summary-band', 'table.compare', 'pre code[class|="language"]']) {
      expect(out).toContain(sel)
    }
  })

  it('template hoists SVG marker defs + default shape/connector attrs', () => {
    for (const subtype of ['plan', 'reply']) {
      const out = assembleHTML(subtype, planBody, '')
      expect(out).toContain('<marker id="cc-arrow"')
      for (const sel of ['rect:not([fill])', 'circle:not([fill])', 'ellipse:not([fill])', 'polygon:not([fill])']) {
        expect(out).toContain(sel)
      }
      for (const sel of ['line:not([fill])', 'path:not([fill])', 'polyline:not([fill])']) {
        expect(out).toContain(sel)
      }
    }
  })

  it('template has semantic node classes', () => {
    for (const subtype of ['plan', 'reply']) {
      const out = assembleHTML(subtype, planBody, '')
      for (const want of ['--c-core:', '--c-risk:', 'g.core>rect', 'g.external>rect', 'g.risk>rect']) {
        expect(out).toContain(want)
      }
    }
  })

  it('prefixes <title> per subtype and themes the accent without touching <h1>', () => {
    const out = assembleHTML('plan', planBody, '计划·')
    expect(out).toContain('<title>计划·#47/#48 plan-render 优化计划</title>')
    expect(out).toContain('<h1>#47/#48 plan-render 优化计划</h1>')
    expect(out).toContain('--accent:#0969da')
    expect(out).toContain('--c-risk:#cf222e')
    expect(out).toContain('header h1::after')
    expect(out).toContain('content:"计划"')
    expect(out).toContain('h1>.icon')

    const outR = assembleHTML('reply', '<div class="wrap"><header><h1>做了X</h1></header></div>', '回复·')
    expect(outR).toContain('<title>回复·做了X</title>')
    expect(outR).toContain('--accent:#1a7f37')
    expect(outR).toContain('--c-risk:#cf222e')
    expect(outR).toContain('content:"回复"')
    expect(outR).toContain('h1>.icon')
  })

  it('key-point semantics are injected via CSS ::before with per-category colors', () => {
    const body = '<div class="wrap"><div class="key-point risk">别动生产库</div></div>'
    for (const subtype of ['plan', 'reply']) {
      const out = assembleHTML(subtype, body, '')
      for (const want of ['content:"重点"', 'content:"关键决策"', 'content:"主要风险"', 'content:"核心约束"', 'content:"核心结论"', 'content:"关键影响"']) {
        expect(out).toContain(want)
      }
      for (const sel of ['.key-point.decision', '.key-point.risk', '.key-point.constraint', '.key-point.conclusion', '.key-point.impact']) {
        expect(out).toContain(sel)
      }
      expect(out).toContain('--c-risk')
    }
  })

  it('diagram components (.flow/.layers/.diff) are present in the shared stylesheet', () => {
    const body = '<div class="wrap"><div class="diagram"><div class="flow"><span>A</span><span>B</span></div></div></div>'
    for (const subtype of ['plan', 'reply']) {
      const out = assembleHTML(subtype, body, '')
      for (const want of ['.flow', '.flow>span:not(:last-child)', '.layers', '.diff', 'content:"→"']) {
        expect(out).toContain(want)
      }
    }
  })
})

describe('ExtractUsedIcons', () => {
  it('empty body and body without refs yield no sprite', () => {
    expect(extractUsedIcons('')).toBe('')
    expect(extractUsedIcons('<div class="wrap"><p>no icons here</p></div>')).toBe('')
  })

  it('extracts only referenced symbols with the icon- prefix', () => {
    const body = `<div class="wrap">
      <svg class="icon"><use href="#icon-check"/></svg>
      <svg class="icon"><use href="#icon-arrow-right"/></svg>
      <svg class="icon"><use href="#icon-nonexistent-zzz"/></svg>
    </div>`
    const got = extractUsedIcons(body)
    expect(got).toContain('<symbol id="icon-check"')
    expect(got).toContain('<symbol id="icon-arrow-right"')
    expect(got).not.toContain('icon-nonexistent-zzz')
    expect(got.split('<symbol id="icon-').length - 1).toBe(2)
    expect(got.startsWith('<svg width="0" height="0"')).toBe(true)
  })

  it('dedupes repeated refs', () => {
    const got = extractUsedIcons('<use href="#icon-check"/><use href="#icon-check"/><use href="#icon-check"/>')
    expect(got.split('<symbol id="icon-check"').length - 1).toBe(1)
  })

  it('old alias names resolve from the extended sprite', () => {
    const got = extractUsedIcons('<svg class="icon"><use href="#icon-alert-triangle"/></svg>')
    expect(got).toContain('<symbol id="icon-alert-triangle"')
  })

  it('diagram-internal use with attrs extracts too', () => {
    const body = '<g class="core"><rect x="0" y="0" width="120" height="40" rx="8"/>'
      + '<use class="ico" href="#icon-database" x="8" y="11" width="18" height="18"/>'
      + '<text x="34" y="25" font-size="16">Postgres</text></g>'
    expect(extractUsedIcons(body)).toContain('<symbol id="icon-database"')
  })
})

describe('AssembleHTMLIcons', () => {
  it('body with icons injects the sprite and keeps .icon CSS', () => {
    const body = '<div class="wrap"><header><h1>x</h1></header>'
      + '<ul class="keypoints"><li><svg class="icon"><use href="#icon-check"/></svg> <strong>done</strong> — ok</li></ul></div>'
    const out = assembleHTML('plan', body, '')
    expect(out).toContain('<symbol id="icon-check"')
    expect(out).toContain('.icon')
    expect(out).not.toContain('{{ICONS}}')
  })

  it('body without icons leaves no symbol but keeps .icon CSS', () => {
    const out = assembleHTML('reply', '<div class="wrap"><h1>x</h1></div>', '')
    expect(out).not.toContain('<symbol id="icon-')
    expect(out).toContain('.icon')
  })
})

describe('AssembleHTMLStripsUnknownCSSVars', () => {
  it('strips undefined var() attributes, keeps defined vars and self-bailing fallbacks', () => {
    const body = `<div class="diagram"><svg viewBox="0 0 10 10">
      <rect x="1" y="1" width="8" height="8" fill="var(--bg-accent)"/>
      <rect x="2" y="2" width="6" height="6" stroke="var(--no-such-var)"/>
      <rect x="3" y="3" width="4" height="4" fill="var(--accent)"/>
      <path d="M0 0L10 10" stroke="var(--missing)" fill="var(--also-missing)"/>
      <rect x="4" y="4" width="2" height="2" fill="var(--bg-accent, #fafafa)"/>
    </svg></div>`
    const out = assembleHTML('reply', body, '')
    for (const bad of ['var(--bg-accent)', 'var(--no-such-var)', 'var(--missing)', 'var(--also-missing)']) {
      expect(out).not.toContain(bad)
    }
    expect(out).toContain('fill="var(--accent)"')
    expect(out).toContain('fill="var(--bg-accent, #fafafa)"')
  })
})

describe('EnsureSVGViewBox', () => {
  it('injects viewBox from numeric width/height', () => {
    expect(ensureSVGViewBox('<div class="diagram"><svg width="400" height="200"><rect/></svg></div>'))
      .toContain('viewBox="0 0 400 200"')
  })

  it('strips px suffixes when injecting', () => {
    expect(ensureSVGViewBox('<svg width="400px" height="200px"><rect/></svg>')).toContain('viewBox="0 0 400 200"')
  })

  it('leaves an existing viewBox untouched', () => {
    const out = ensureSVGViewBox('<svg viewBox="0 0 100 100" width="400" height="200"><rect/></svg>')
    expect(out.split('viewBox=').length - 1).toBe(1)
  })

  it('skips percentage dimensions and dimensionless svgs', () => {
    expect(ensureSVGViewBox('<svg width="100%" height="auto"><rect/></svg>')).not.toContain('viewBox=')
    expect(ensureSVGViewBox('<svg><rect/></svg>')).not.toContain('viewBox=')
  })
})

describe('RenderTemplatesDefineFlowDoneTokens', () => {
  it('both templates + shared layers define the flow/done tokens', () => {
    for (const tmpl of [renderTemplatePlan, renderTemplateReply]) {
      expect(tmpl).toContain('--c-flow:')
      expect(tmpl).toContain('--c-done:')
    }
    expect(diagramDefs).toContain('id="cc-arrow-flow"')
    expect(diagramDefs).toContain('fill="#d97706"')
    expect(diagramCSS).toContain('g.done>rect')
    expect(diagramCSS).toContain('g.flow>path')
    expect(diagramCSS).toContain('--c-flow')
    expect(diagramCSS).toContain('--c-done')
  })
})

describe('RenderPrompts_ExpressionContracts', () => {
  it('plan and reply prompts carry the required expression rules', () => {
    const planPrompt = renderSessionPrompt()
    for (const want of ['目标或结论', '影响范围', '风险或约束', '验证状态', '关键决策', '技术准确性优先']) {
      expect(planPrompt).toContain(want)
    }
    const replyPrompt = renderReplySummaryPrompt()
    for (const want of ['已完成', '关键结果', '未完成/风险', '后续', '查看', '尝试', '没有证据', '技术准确性优先']) {
      expect(replyPrompt).toContain(want)
    }
    for (const [name, prompt] of [['plan', planPrompt], ['reply', replyPrompt]] as const) {
      for (const unwanted of ['每次都画一张', '12 岁新手', '关键命令']) {
        expect(prompt).not.toContain(unwanted)
      }
      expect(prompt).toContain('只有存在真实')
      expect(prompt).toContain('才画')
      expect(prompt).toContain('图只表达关系')
      expect(prompt).toContain('文字只表达结论')
      expect(prompt).toContain('测试函数名')
      void name
    }
  })
})

describe('ShouldDiscardPreviewBeforeReplyRender', () => {
  const cases: Array<[string, number, number, boolean, boolean, boolean]> = [
    ['segmented tool reply', 1, 1, false, false, true],
    ['no tools', 0, 1, false, false, false],
    ['no prior segment', 1, 0, false, false, false],
    ['progress card retained', 1, 1, true, false, false],
    ['degraded progress card (logged bug)', 0, 0, true, true, true],
    ['degraded overrides progress', 1, 1, true, true, true],
  ]
  for (const [name, toolCount, segmentStart, inProgress, degraded, want] of cases) {
    it(name, () => {
      expect(shouldDiscardPreviewBeforeReplyRender(toolCount, segmentStart, inProgress, degraded)).toBe(want)
    })
  }
})

describe('DisplayReplyText', () => {
  const mkPreview = (analysisText: string): StreamPreview =>
    ({ analysisText }) as unknown as StreamPreview

  it('prefers the trailing analysis segment, falls back to the full reply', () => {
    expect(displayReplyText(mkPreview('trailing segment'), 'full reply with lead')).toBe('trailing segment')
    expect(displayReplyText(mkPreview(''), 'full reply')).toBe('full reply')
    expect(displayReplyText(mkPreview('  \n\t '), 'full reply')).toBe('full reply')
    expect(displayReplyText(undefined, 'full reply')).toBe('full reply')
  })
})

describe('CleanupInteractiveState_RemovesReplyHTMLTemp', () => {
  it('teardown reaps every recorded cc-plan-render-* temp dir', async () => {
    const e = newTestEngine()
    const key = 'test:user-leak'
    const path1 = mkRenderTemp('<html>1</html>')
    const path2 = mkRenderTemp('<html>2</html>')
    const state = new InteractiveState()
    state.renderedReplyHTML = new Map([['ek1', path1], ['ek2', path2]])
    e.interactiveStates.set(key, state)

    await e.cleanupInteractiveState(key, state)
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && (existsSync(path1) || existsSync(path2))) {
      await new Promise((resolve) => { setTimeout(resolve, 10) })
    }

    expect(existsSync(path1)).toBe(false)
    expect(existsSync(dirnameOf(path1))).toBe(false)
    expect(existsSync(path2)).toBe(false)
    expect(existsSync(dirnameOf(path2))).toBe(false)
  })
})

function dirnameOf(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx > 0 ? p.slice(0, idx) : p
}

describe('sanitizeSVGVars (direct)', () => {
  it('conservatively returns the body when the template defines no variables', () => {
    const body = '<rect fill="var(--anything)"/>'
    expect(sanitizeSVGVars(body, ':root { }')).toBe(body)
  })
})

describe('export button handler wiring', () => {
  it('export lookup honors exportContent, plan-key no-fallback, and lastBaseResponse fallback', async () => {
    let handler: ((sessionKey: string, exportKey: string) => { text: string; ok: boolean }) | undefined
    const p: Platform & { setExportHandler(h: typeof handler): void } = {
      ...createStubPlatform('test'),
      setExportHandler: (h) => { handler = h },
    }
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    const state = new InteractiveState()
    state.exportContent = new Map([['om_1', 'full reply'], ['plan:1', '# plan']])
    state.lastBaseResponse = 'last reply'
    e.interactiveStates.set('test:chat:user1', state)

    await e.start()
    expect(handler).toBeDefined()
    if (handler === undefined) return

    expect(handler('test:chat:user1', 'om_1')).toEqual({ text: 'full reply', ok: true })
    expect(handler('test:chat:user1', 'plan:1')).toEqual({ text: '# plan', ok: true })
    // A missing plan key never falls back to the last reply.
    expect(handler('test:chat:user1', 'plan:9')).toEqual({ text: '', ok: false })
    expect(handler('test:chat:user1', '')).toEqual({ text: 'last reply', ok: true })
    expect(handler('test:other', 'om_1')).toEqual({ text: '', ok: false })
  })
})
