/**
 * Plan/reply HTML render domain (#47/#48), ported from cc-connect
 * core/engine_plan_render.go. The engine forks an isolated render session
 * (RenderQuerier) that turns plan markdown or a completed reply into a
 * single-file light-theme HTML body fragment; this module assembles the full
 * document from the fixed templates and delivers it as a Retina-2x PNG
 * (via the configured render-png script) with fallbacks down to the raw
 * .html file. All failures are logged and swallowed — the markdown card /
 * plain reply already delivered is the user-visible fallback.
 *
 * Concurrency mapping (Go → TS): context cancellation → AbortController;
 * SafeGo goroutines → floating promises; interactiveState.mu → single-threaded
 * async (fields are only mutated from synchronous sections).
 *
 * @module dsh-feishu-bridge/plan-render
 */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { promisify } from 'node:util'

import { newCard, Card, type CardButton, type CardHeader } from '../card.js'
import {
  asCardSender,
  asCardSenderWithUpdate,
  asFileSender,
  asImageSender,
  asImageUploader,
  asProviderSwitcher,
  asRenderQuerier,
  asRenderStatusUpdater,
  asReplyContextReconstructor,
  type ImageAttachment,
  type Platform,
} from '../core/types.js'
import { markdownToSimpleHTML } from '../markdown/markdown-html.js'
import { iconsSpriteFull } from '../lucide/sprite.js'
import { Msg } from '../i18n/keys.js'
import { stripTrailingSilent } from './message-split.js'
import { diagramCSS, diagramDefs, renderSkillPrompt, renderTemplatePlan, renderTemplateReply } from './plan-render-templates.js'
import type { Engine, InteractiveState } from './engine.js'
import type { StreamPreview } from '../streaming.js'

const execFileAsync = promisify(execFile)

/** Render fork produced no stream output (Go ErrRenderStalled); the caller retries. */
export const errRenderStalled = new Error('render query stalled: no stream output')

/** Click-fork timeout (Go defaultPlanRenderTimeout, 600s): effort=max html-skill multi-round flow. */
export const defaultPlanRenderTimeoutMs = 600_000

/** Speculative pre-render timeout cap (Go defaultPreRenderTimeout, 360s). */
export const defaultPreRenderTimeoutMs = 360_000

/** Replies shorter than this (runes) are not speculatively rendered (Go defaultReplyPreRenderLen). */
export const defaultReplyPreRenderLen = 500

/** Per-exec PNG rasterize timeout (Go defaultPngRenderTimeout, 30s). */
const pngRenderTimeoutMs = 30_000

/** Upload/send ceiling so a hung platform cannot pin the fork (Go defaultSendTimeout). */
const sendTimeoutMs = 90_000

/** Chromium is given a second to release memory between PNG attempts (Go 1s backoff). */
const pngRetryBackoffMs = 1_000

/** Rasterize width, matching the html skill's .wrap (max-width 760 + padding 32×2; Go renderPNGWidth). */
export const renderPNGWidth = 824

/** Lifecycle state of a background render task (#47/#48), surfaced on plan/progress cards. */
export type RenderStatus = 'rendering' | 'delivered' | 'cancelled' | 'failed'

/** Latest status of one render task, keyed by exportKey (Go renderStatusEntry). */
export interface RenderStatusEntry {
  kind: 'plan' | 'reply'
  status: RenderStatus
  updatedAt: number
}

/** A sent plan card's platform handle + base card so the status line can be PATCHed in place. */
export interface PlanCardHandle {
  handle: unknown
  baseCard: Card
}

/**
 * Render-session system prompt (Go RenderSessionPrompt): the cc-connect-render
 * SKILL.md in full, plus the stripped-down "render-only session" contract for
 * the plan sub-type. The fork must not re-load the skill or touch project
 * source; its stdout carries only a one-line confirmation.
 *
 * @returns The complete system prompt text for the plan render-session fork.
 */
export function renderSessionPrompt(): string {
  return `${renderSkillPrompt}\n\n---\n\n你是 cc-connect 内部的一个「仅渲染」session，不是主 coding agent——不要去执行 plan、不要改项目源码。

上方已是 cc-connect-render skill 的**完整内容**（含输出格式、预算+去重、组件、画图、红线全部规则）。**禁止**再调用 Skill tool 去加载 cc-connect-render——直接按上方内容执行，省一个来回。

画 SVG 图解时也只写形状元素——**不写 xmlns、不写 <defs><marker>、不写默认 fill/stroke**（箭头用 marker-end="url(#cc-arrow)"，默认填充/描边由模板 CSS 提供）；写了白费输出 token。

## 子型：plan
按 skill 的 plan 子型产出执行者可用的概览，固定信息优先级：目标或结论、影响范围、风险或约束、验证状态、关键决策；没有内容的层次不硬凑。
只有存在真实的调用链、数据流、模块关系、状态变化、前后结构或方案对比时才画图。图只表达关系，文字只表达结论；技术准确性优先，保留决策相关的 specifics（错误码/配置项/用户可见 API/核心文件路径/数字/成功判据/并发·兼容性边界），不保留实现层标识符（函数名/方法名/变量名/字段名/内部 helper 名/测试函数名，不分语言）。

## 输入（在用户消息里给出）
- html_path：你**必须**把 body 片段写入的绝对路径。
- <plan-markdown>：**原始** plan markdown。engine 不预渲染它；你自己提炼成大白话概览。完整技术 plan（Context、文件清单、步骤、验证）已在对话里发过，**不进**片段——片段只放概览。

## Return（隔离红线）
把 body 片段写到 html_path 后，回一行短句，例如：
    片段已写入：<html_path>
绝不返回片段正文——你的 stdout 只被 engine 用来记日志。失败时回一句短错误（如 "写入失败：<原因>"）。`
}

/**
 * Render-session prompt for the speculative reply→HTML auto-deliver at turn
 * end (Go RenderReplySummaryPrompt): same skill text, reply sub-type contract.
 *
 * @returns The complete system prompt text for the reply render-session fork.
 */
export function renderReplySummaryPrompt(): string {
  return `${renderSkillPrompt}\n\n---\n\n你是 cc-connect 内部的一个「仅渲染」session，不是主 coding agent——不要对项目发起新的工具调用。

上方已是 cc-connect-render skill 的**完整内容**（含输出格式、预算+去重、组件、画图、红线全部规则）。**禁止**再调用 Skill tool 去加载 cc-connect-render——直接按上方内容执行，省一个来回。

画 SVG 图解时也只写形状元素——**不写 xmlns、不写 <defs><marker>、不写默认 fill/stroke**（箭头用 marker-end="url(#cc-arrow)"，默认填充/描边由模板 CSS 提供）；写了白费输出 token。

## 子型：reply
按 skill 的 reply 子型产出一屏结果概览。先区分已完成、关键结果、未完成/风险、后续；查看、尝试、分析、推测不能写成已完成，没有证据不得声称已修复或验证通过。
只有存在真实的模块关系、调用链、状态变化、数据流、前后结构或方案对比时才画图。图只表达关系，文字只表达结论；技术准确性优先，保留决策相关的 specifics（错误码/配置项/用户可见 API/核心文件路径/数字/成功判据/并发·兼容性边界），不保留实现层标识符（函数名/方法名/变量名/字段名/内部 helper 名/测试函数名，不分语言）。完整回复已在对话里，**不进**片段。

## 输入（在用户消息里给出）
- html_path：你**必须**把 body 片段写入的绝对路径。
- <plan-rendered-html>：已渲染成 HTML 片段的回复，只作提炼 key-point 概览的素材——不要原样嵌进片段。不要去找 <plan-markdown> 块；原始文本不会发送。

## Return（隔离红线）
把 body 片段写到 html_path 后，回一行短句，例如：
    片段已写入：<html_path>
绝不返回片段正文——你的 stdout 只被 engine 用来记日志。失败时回一句短错误（如 "写入失败：<原因>"）。`
}

// ── pure title / path helpers ──────────────────────────────────────────────

/**
 * Session-key path sanitizer (Go sanitizeSessionKey): separators and colons become underscores.
 *
 * @param s - Raw session key.
 * @returns The session key with `/`, `\`, and `:` replaced by underscores.
 */
export function sanitizeSessionKey(s: string): string {
  return s.replaceAll('/', '_').replaceAll('\\', '_').replaceAll(':', '_')
}

function planContentHash(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/**
 * Derive a short, filesystem-safe display name from a document title (Go
 * slugifyTitle). CJK is kept; half-width path-unsafe characters are replaced.
 * Returns `fallback` when the title has no usable text.
 *
 * @param title - Raw document title, possibly multi-line Markdown.
 * @param fallback - Value returned when nothing usable remains after sanitizing.
 * @returns The slugified display name.
 */
export function slugifyTitle(title: string, fallback: string): string {
  let line = title.includes('\n') ? title.slice(0, title.indexOf('\n')) : title
  line = line.trim()
  // Strip leading Markdown markers: heading #, blockquote >, list -/*, code
  // fence `, emphasis !, and ordered-list "N." / "N)" prefixes.
  line = line.replace(/^[#>`*\-! \t.]+/, '')
  line = line.replace(/^[0-9.)]+/, '')
  line = line.trim()
  let s = ''
  for (const ch of line) {
    s += '/\\:*?"<>|#'.includes(ch) ? '-' : ch
  }
  const runes = Array.from(s)
  if (runes.length > 40) s = runes.slice(0, 40).join('')
  s = s.replace(/^[- ]+|[- ]+$/g, '')
  s = s.replaceAll('--', '-') // collapse adjacent separators ("#47-#48" → "47-48")
  return s === '' ? fallback : s
}

const htmlTitleRe = /<title[^>]*>([\s\S]*?)<\/title>/is
const htmlH1Re = /<h1[^>]*>([\s\S]*?)<\/h1>/is
const htmlTagRe = /<[^>]*>/g
const markdownHeadingRe = /^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*$/m

/**
 * Strip HTML/SVG tags from a title string, then unescape entities — the order
 * matters, otherwise `&lt;tag&gt;` is restored and then stripped (Go
 * cleanHTMLTitle).
 */
function cleanHTMLTitle(s: string): string {
  return s.replace(htmlTagRe, '').trim().replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim()
}

/**
 * Pull the document title from rendered HTML for the download filename
 * (Go extractHTMLTitle): `<title>` first, then the first `<h1>`; '' when
 * neither yields text.
 *
 * @param data - Rendered HTML source.
 * @returns The extracted title, or '' when neither tag yields text.
 */
export function extractHTMLTitle(data: string): string {
  const tm = htmlTitleRe.exec(data)
  if (tm !== null) {
    const s = cleanHTMLTitle(tm[1] ?? '')
    if (s !== '') return s
  }
  const hm = htmlH1Re.exec(data)
  if (hm !== null) return cleanHTMLTitle(hm[1] ?? '')
  return ''
}

/**
 * Text of the first Markdown heading line (Go extractMarkdownTitle), or ''.
 *
 * @param markdown - Markdown source to scan.
 * @returns The first heading's text, or '' when there is none.
 */
export function extractMarkdownTitle(markdown: string): string {
  const m = markdownHeadingRe.exec(markdown)
  if (m === null) return ''
  return (m[1] ?? '').trim()
}

/**
 * Pick the HTML output path (Go deriveHtmlPath). A non-empty `nameHint`
 * (slugified plan title) becomes the basename; otherwise the plan .md
 * basename, or the session key inside a fresh cc-plan-render-* temp dir for
 * the reply sub-type. Revision > 1 adds a -vN suffix.
 *
 * @param planFilePath - Plan .md path; empty for the reply sub-type.
 * @param sessionKey - Session key, used as the basename when no hint exists.
 * @param nameHint - Slugified title preferred as the basename; may be empty.
 * @param revision - Render revision; > 1 adds a -vN suffix.
 * @returns The absolute HTML output path.
 */
export function deriveHtmlPath(planFilePath: string, sessionKey: string, nameHint: string, revision: number): string {
  const suffix = revision > 1 ? `-v${String(revision)}` : ''
  if (planFilePath !== '') {
    let base = nameHint
    if (base === '') {
      const b = basename(planFilePath)
      const ext = extname(b)
      base = ext !== '' ? b.slice(0, b.length - ext.length) : b
    }
    return join(dirname(planFilePath), `${base}${suffix}.html`)
  }
  let dir: string
  try {
    dir = mkdtempSync(join(tmpdir(), 'cc-plan-render-'))
  } catch {
    dir = tmpdir()
  }
  const base = nameHint !== '' ? nameHint : sanitizeSessionKey(sessionKey)
  return join(dir, `${base}${suffix}.html`)
}

/**
 * Delete a reply-HTML render product: the cc-plan-render-* temp dir (and the
 * .html inside). Guarded — only removes directories whose basename carries
 * the cc-plan-render- prefix; the plan sub-type's sibling .html is a user
 * artifact and is never touched (Go removeRenderedTemp).
 *
 * @param htmlPath - Path of the rendered .html whose temp dir is removed.
 */
export async function removeRenderedTemp(htmlPath: string): Promise<void> {
  if (htmlPath === '') return
  const dir = dirname(htmlPath)
  if (!basename(dir).startsWith('cc-plan-render-')) return
  try {
    await rm(dir, { recursive: true, force: true })
  } catch (error) {
    console.warn(`removeRenderedTemp: remove failed (${dir}): ${String(error)}`)
  }
}

/**
 * Copy src to dst, swallowing all errors (Go copyFileBestEffort): mirrors an
 * assembled plan HTML to its pretty sibling path next to the plan .md. The
 * temp write path remains the delivery source of truth, so a failed copy only
 * means the sibling artifact is missing.
 *
 * @param src - Source file to read.
 * @param dst - Destination path, with parent directories created as needed.
 */
export function copyFileBestEffort(src: string, dst: string): void {
  let data: Buffer
  try {
    data = readFileSync(src)
  } catch (error) {
    console.debug(`plan-render: copy artifact skipped (read src failed) (${src}): ${String(error)}`)
    return
  }
  try {
    mkdirSync(dirname(dst), { recursive: true })
  } catch (error) {
    console.debug(`plan-render: copy artifact skipped (mkdir failed) (${dst}): ${String(error)}`)
    return
  }
  try {
    writeFileSync(dst, data)
  } catch (error) {
    console.debug(`plan-render: copy artifact skipped (write failed) (${dst}): ${String(error)}`)
  }
}

// ── HTML assembly ──────────────────────────────────────────────────────────

const useIconRefRe = /<use\b[^>]*\bhref="#icon-([\w-]+)"/gi
const symbolRe = /<symbol\s+id="([\w-]+)"([^>]*)>([\s\S]*?)<\/symbol>/g

/**
 * Scan the body for `<use href="#icon-xxx">` references and build a minimal
 * Lucide sprite containing only the referenced symbols, ids prefixed with
 * `icon-` (Go extractUsedIcons). Unknown ids are silently skipped (browsers
 * render nothing for unknown `<use>`).
 *
 * @param body - HTML body fragment to scan for icon references.
 * @returns The minimal sprite `<svg>` markup, or '' when no known icon is referenced.
 */
export function extractUsedIcons(body: string): string {
  const refs = [...body.matchAll(useIconRefRe)]
  if (refs.length === 0) return ''
  const seen = new Set<string>()
  for (const m of refs) {
    const name = (m[1] ?? '').toLowerCase()
    if (name !== '') seen.add(name)
  }
  let out = '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>'
  let hit = 0
  for (const sm of iconsSpriteFull.matchAll(symbolRe)) {
    const id = (sm[1] ?? '').toLowerCase()
    if (!seen.has(id)) continue
    out += `<symbol id="icon-${id}"${sm[2] ?? ''}>${sm[3] ?? ''}</symbol>`
    hit++
  }
  out += '</defs></svg>'
  return hit === 0 ? '' : out
}

const cssRootRe = /:root\s*\{([^}]*)\}/s
const cssVarDefRe = /--([A-Za-z0-9_-]+)\s*:/g
const inlineVarAttrReGlobal = /\s+(?:fill|stroke)="var\(--([A-Za-z0-9_-]+)\)"/g

/**
 * Remove inline fill/stroke attributes referencing `:root` variables the
 * template does not define (Go sanitizeSVGVars): an invalid var() would fall
 * back to SVG's default black fill. Values with their own fallback are kept.
 *
 * @param body - HTML body fragment whose inline SVG attributes are inspected.
 * @param tmpl - Template whose `:root` CSS defines the allowed variables.
 * @returns The body with invalid var() attribute references removed.
 */
export function sanitizeSVGVars(body: string, tmpl: string): string {
  const rootMatch = cssRootRe.exec(tmpl)
  const root = rootMatch !== null ? rootMatch[1] ?? '' : ''
  const allowed = new Set<string>()
  for (const m of root.matchAll(cssVarDefRe)) allowed.add(m[1] ?? '')
  if (allowed.size === 0) return body // no variable definitions parsed — leave untouched
  return body.replace(inlineVarAttrReGlobal, (match, name: string) => (allowed.has(name) ? match : ''))
}

const svgOpenTagRe = /<svg\b([^>]*)>/gi
const svgWidthAttrRe = /\bwidth="([\d.]+)(?:px)?"/i
const svgHeightAttrRe = /\bheight="([\d.]+)(?:px)?"/i
const svgHasViewBoxRe = /\bviewbox\b/i

/**
 * Add `viewBox="0 0 W H"` to `<svg>` open tags lacking one but carrying
 * numeric width/height, so scaling keeps the aspect ratio (Go
 * ensureSVGViewBox). Existing viewBox, percentage/non-numeric dimensions, or
 * no dimensions are left untouched.
 *
 * @param body - HTML body fragment containing inline SVG.
 * @returns The body with viewBox attributes added where applicable.
 */
export function ensureSVGViewBox(body: string): string {
  return body.replace(svgOpenTagRe, (tag, attrs: string) => {
    if (svgHasViewBoxRe.test(attrs)) return tag
    const wm = svgWidthAttrRe.exec(attrs)
    const hm = svgHeightAttrRe.exec(attrs)
    if (wm === null || hm === null) return tag
    const w = Number.parseFloat(wm[1] ?? '')
    const h = Number.parseFloat(hm[1] ?? '')
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return tag
    const vb = ` viewBox="0 0 ${String(w)} ${String(h)}"`
    return tag.replace('<svg', `<svg${vb}`)
  })
}

/**
 * Wrap a render-session body fragment in the fixed light-theme template for
 * the sub-type ('plan' | 'reply'; unknown falls back to plan), filling
 * `<title>` from the fragment's first `<h1>` prefixed by `titlePrefix`
 * (Go assembleHTML). This is the #47/#48 acceleration lever: the render
 * session only emits the body fragment, the engine injects the full CSS.
 *
 * @param subtype - 'plan' | 'reply'; unknown values fall back to the plan template.
 * @param bodyFragment - Raw body fragment written by the render session.
 * @param titlePrefix - Prefix prepended to the derived `<title>`.
 * @returns The assembled single-file HTML document.
 */
export function assembleHTML(subtype: string, bodyFragment: string, titlePrefix: string): string {
  const tmpl = subtype === 'reply' ? renderTemplateReply : renderTemplatePlan
  let body = bodyFragment.trim()
  if (body.includes('<style')) {
    console.warn(`render-assemble: body fragment contains <style>; template CSS would duplicate (subtype ${subtype})`)
  }
  let title = ''
  const hm = htmlH1Re.exec(body)
  if (hm !== null) title = cleanHTMLTitle(hm[1] ?? '')
  if (title !== '' && titlePrefix !== '') title = titlePrefix + title
  body = sanitizeSVGVars(body, tmpl)
  body = ensureSVGViewBox(body)
  let out = tmpl.replaceAll('{{BODY}}', body)
  out = out.replaceAll('{{DIAGRAM_CSS}}', diagramCSS)
  out = out.replaceAll('{{DIAGRAM_DEFS}}', diagramDefs)
  out = out.replaceAll('{{ICONS}}', extractUsedIcons(body))
  return out.replaceAll('{{TITLE}}', title)
}

/**
 * Read the body fragment, assemble, and write back in place (Go assembleHTMLInPlace).
 *
 * @param htmlPath - File holding the raw body fragment; overwritten with the assembled document.
 * @param subtype - 'plan' | 'reply' sub-type selecting the template.
 * @param titlePrefix - Prefix prepended to the derived `<title>`.
 */
export async function assembleHTMLInPlace(htmlPath: string, subtype: string, titlePrefix: string): Promise<void> {
  const body = await readFile(htmlPath, 'utf8')
  await writeFile(htmlPath, assembleHTML(subtype, body, titlePrefix), 'utf8')
}

// ── interactiveState render bookkeeping ────────────────────────────────────

/** A render fork's cancel function, tracked for pointer identity (Go renderCancelHandle). */
export interface RenderCancelHandle {
  cancel(): void
}

/**
 * Per-session plan-render throttle (Go shouldRenderPlan): allow only when no
 * render is running, the content changed since the last render (sha256), and
 * enough time elapsed since the last render. Revision 1 is always allowed.
 * Sets planRenderRunning on success — the caller must clear it.
 *
 * @param state - Per-session interactive state; undefined never renders.
 * @param content - Plan markdown content, hashed for change detection.
 * @param revision - ExitPlanMode revision; 1 bypasses hash and throttle checks.
 * @returns Whether a render may start; planRenderRunning is set when true.
 */
export function shouldRenderPlan(state: InteractiveState | undefined, content: string, revision: number): boolean {
  if (state === undefined) return false
  const hash = planContentHash(content)
  if (state.planRenderRunning) return false
  if (revision > 1 && hash === state.lastRenderedPlanHash) return false
  if (revision > 1 && Date.now() - state.lastRenderedPlanAt < 10_000) return false
  state.planRenderRunning = true
  state.lastRenderedPlanHash = hash
  state.lastRenderedPlanAt = Date.now()
  return true
}

/**
 * Release the per-session plan-render lock (Go clearPlanRenderRunning).
 *
 * @param state - Per-session state whose planRenderRunning flag is cleared.
 */
export function clearPlanRenderRunning(state: InteractiveState | undefined): void {
  if (state === undefined) return
  state.planRenderRunning = false
}

/**
 * Add a cancel function to the in-flight set (Go registerRenderCancel).
 *
 * @param state - Per-session interactive state holding the cancel set.
 * @param cancel - The cancel function to track; undefined registers nothing.
 * @returns The handle for later unregistration, or undefined when cancel is undefined.
 */
export function registerRenderCancel(state: InteractiveState, cancel: (() => void) | undefined): RenderCancelHandle | undefined {
  if (cancel === undefined) return undefined
  const h: RenderCancelHandle = { cancel }
  state.renderCancels.push(h)
  return h
}

/**
 * Remove a finished fork's entry so a later cancelRenders cannot invoke it.
 *
 * @param state - Per-session interactive state holding the cancel set.
 * @param handle - Handle returned by registerRenderCancel; undefined is a no-op.
 */
export function unregisterRenderCancel(state: InteractiveState, handle: RenderCancelHandle | undefined): void {
  if (handle === undefined) return
  state.renderCancels = state.renderCancels.filter(h => h !== handle)
}

/**
 * Abort every in-flight render fork for this session (Go cancelRenders):
 * called when the user resumes the session — a stale HTML render is no
 * longer worth burning tokens on.
 *
 * @param state - Per-session state whose in-flight renders are aborted.
 */
export function cancelRenders(state: InteractiveState | undefined): void {
  if (state === undefined) return
  const handles = state.renderCancels
  state.renderCancels = []
  for (const h of handles) h.cancel()
}

/**
 * Record a rendered reply HTML temp path keyed by exportKey so session
 * teardown can reap the cc-plan-render-* temp dirs (Go recordRenderedReply).
 * It is a cleanup manifest, NOT a click cache.
 *
 * @param state - Per-session interactive state receiving the manifest entry.
 * @param exportKey - Export key identifying this turn's reply.
 * @param htmlPath - Absolute path of the rendered reply HTML.
 */
export function recordRenderedReply(state: InteractiveState, exportKey: string, htmlPath: string): void {
  if (exportKey === '' || htmlPath === '') return
  if (state.renderedReplyHTML === undefined) state.renderedReplyHTML = new Map()
  state.renderedReplyHTML.set(exportKey, htmlPath)
}

/**
 * Record the latest render status for exportKey (Go setRenderStatus).
 *
 * @param state - Per-session interactive state receiving the status entry.
 * @param exportKey - Export key identifying the render task.
 * @param kind - Whether the task renders a plan or a reply.
 * @param status - The latest lifecycle status to record.
 */
export function setRenderStatus(state: InteractiveState, exportKey: string, kind: 'plan' | 'reply', status: RenderStatus): void {
  if (exportKey === '' ) return
  if (state.renderStatuses === undefined) state.renderStatuses = new Map()
  state.renderStatuses.set(exportKey, { kind, status, updatedAt: Date.now() })
}

/**
 * Latest render status for exportKey, if any (Go getRenderStatus).
 *
 * @param state - Per-session interactive state holding the status map.
 * @param exportKey - Export key identifying the render task.
 * @returns The recorded status entry, or undefined when none exists.
 */
export function getRenderStatus(state: InteractiveState, exportKey: string): RenderStatusEntry | undefined {
  if (exportKey === '') return undefined
  return state.renderStatuses?.get(exportKey)
}

/**
 * Cache the full (untruncated) plan markdown under exportKey so the plan
 * card's export button can fetch it later (Go storePlanExport). Keyed by
 * "plan:<revision>" per ExitPlanMode revision.
 *
 * @param state - Per-session interactive state receiving the cached content.
 * @param exportKey - Export key the plan card's export button will present.
 * @param fullContent - The full untruncated plan markdown.
 */
export function storePlanExport(state: InteractiveState, exportKey: string, fullContent: string): void {
  if (state.exportContent === undefined) state.exportContent = new Map()
  state.exportContent.set(exportKey, fullContent)
}

/**
 * Snapshot the green card's export key + reply text before the permission
 * prompt detaches the preview (Go captureReplyForExport): prefers the
 * 实时播报 trailing segment, falls back to the full text; records both into
 * exportContent / lastBaseResponse so a button click during the pending
 * window exports this turn's reply, not the previous one.
 *
 * @param sp - The live stream preview carrying the export key and reply text.
 * @param state - Per-session interactive state receiving the snapshot.
 * @returns The captured export key and reply text; both '' when the text is empty.
 */
export function captureReplyForExport(sp: StreamPreview, state: InteractiveState): { exportKey: string; text: string } {
  let exportKey = ''
  const ekp = sp.previewMsgID as { exportKey?: () => string } | undefined
  if (ekp !== undefined && typeof ekp.exportKey === 'function') exportKey = ekp.exportKey()
  let text = sp.analysisText
  if (text.trim() === '') text = sp.fullText
  text = text.trim()
  if (text === '') return { exportKey: '', text: '' }
  const [stripped, ok] = stripTrailingSilent(text)
  if (ok) {
    const s = stripped.trim()
    if (s !== '') text = s
  }
  if (exportKey !== '') {
    if (state.exportContent === undefined) state.exportContent = new Map()
    state.exportContent.set(exportKey, text)
  }
  state.lastBaseResponse = text
  return { exportKey, text }
}

/**
 * Display summary for the speculative auto-deliver (Go displayReplyText):
 * prefer the trailing segment (实时播报), fall back to the full reply.
 *
 * @param sp - The live stream preview, if one exists.
 * @param fullResponse - The full reply text, used when the preview has no analysis segment.
 * @returns The text to feed the reply render.
 */
export function displayReplyText(sp: StreamPreview | undefined, fullResponse: string): string {
  if (sp !== undefined) {
    const at = sp.analysisText.trim()
    if (at !== '') return at
  }
  return fullResponse
}

/**
 * Whether the green preview card will be discarded by the EventResult
 * finalize chain (Go shouldDiscardPreviewBeforeReplyRender): the reply-HTML
 * render then drops the card's exportKey and avoids PATCHing a withdrawn
 * message. Covers degraded streaming and segmented tool replies; the
 * suppressDuplicate branch is computed later in the flow (Go ceiling kept).
 *
 * @param toolCount - Number of tool calls in the turn.
 * @param segmentStart - Index of the current 实时播报 segment start, or 0.
 * @param inProgress - Whether a segmented reply is still streaming.
 * @param degraded - Whether streaming ran in degraded mode.
 * @returns Whether the preview card will be discarded before the reply render.
 */
export function shouldDiscardPreviewBeforeReplyRender(
  toolCount: number, segmentStart: number, inProgress: boolean, degraded: boolean,
): boolean {
  return degraded || (toolCount > 0 && segmentStart > 0 && !inProgress)
}

// ── status text + plan-card PATCH ─────────────────────────────────────────

/**
 * Map a render status to its i18n'd display label with an optional elapsed suffix (Go renderStatusText).
 *
 * @param e - Engine providing the i18n catalog.
 * @param status - The render lifecycle status to label.
 * @param elapsedMs - Elapsed milliseconds; > 0 appends a rounded seconds suffix where the status shows one.
 * @returns The localized status label.
 */
export function renderStatusText(e: Engine, status: RenderStatus, elapsedMs: number): string {
  switch (status) {
    case 'rendering': {
      let text = e.i18n.t(Msg.RenderStatusRendering)
      if (elapsedMs > 0) text += ` ${String(Math.round(elapsedMs / 1000))}s`
      return text
    }
    case 'delivered': {
      let text = e.i18n.t(Msg.RenderStatusDelivered)
      if (elapsedMs > 0) text += ` ${String(Math.round(elapsedMs / 1000))}s`
      return text
    }
    case 'cancelled':
      return e.i18n.t(Msg.RenderStatusCancelled)
    case 'failed':
      return e.i18n.t(Msg.RenderStatusFailed)
  }
}

/**
 * Clone `base` with the status text written into the button row's Note slot
 * (Go cloneCardWithStatusNote) so the status renders as a trailing column on
 * the button row. `base` is not mutated.
 *
 * @param base - The card to clone; undefined yields undefined.
 * @param text - Status text written into the Note slot.
 * @returns The cloned card, or undefined when `base` is undefined.
 */
export function cloneCardWithStatusNote(base: Card | undefined, text: string): Card | undefined {
  if (base === undefined) return undefined
  const elems = [...base.elements]
  for (let i = 0; i < elems.length; i++) {
    const el = elems[i]
    if (el !== undefined && el.kind === 'actions' && el.buttons.length > 0) {
      elems[i] = { ...el, note: text }
      break
    }
  }
  const card = new Card()
  if (base.header !== undefined) card.header = base.header
  card.elements = elems
  return card
}

/**
 * Record the plan render status and PATCH the plan card's status line in
 * place via CardSenderWithUpdate (Go updatePlanCardStatus). No-op when no
 * handle was stored — the markdown card remains the fallback.
 *
 * @param e - Engine providing i18n for the status label.
 * @param state - Per-session state holding the plan-card handles.
 * @param exportKey - Export key identifying the plan card.
 * @param status - The render lifecycle status to record and display.
 * @param elapsedMs - Elapsed milliseconds appended to the label when > 0.
 */
export function updatePlanCardStatus(
  e: Engine, state: InteractiveState | undefined, exportKey: string, status: RenderStatus, elapsedMs: number,
): void {
  if (state === undefined || exportKey === '') return
  setRenderStatus(state, exportKey, 'plan', status)
  const ph = state.planCardRender?.get(exportKey)
  const p = state.platform
  if (ph === undefined || p === undefined) return
  const cu = asCardSenderWithUpdate(p)
  if (cu === undefined) return
  const card = cloneCardWithStatusNote(ph.baseCard, renderStatusText(e, status, elapsedMs))
  if (card === undefined) return
  void cu.updateCardWithHandle(ph.handle, card).catch((error: unknown) => {
    console.warn(`plan-render: status patch failed (${exportKey}, ${status}): ${String(error)}`)
  })
}

/**
 * Record the reply render status and PATCH the tool-progress green card's
 * status line via RenderStatusUpdater (Go patchReplyRenderStatus). The caller
 * resolves platform+replyCtx once so repeated transitions don't re-rebuild.
 *
 * @param e - Engine providing i18n for the status label.
 * @param p - Platform to PATCH through; undefined records status only.
 * @param replyCtx - Reply context addressing the green card.
 * @param state - Per-session state receiving the status entry.
 * @param exportKey - Export key identifying the reply render.
 * @param status - The render lifecycle status to record and display.
 * @param elapsedMs - Elapsed milliseconds appended to the label when > 0.
 */
export function patchReplyRenderStatus(
  e: Engine, p: Platform | undefined, replyCtx: unknown, state: InteractiveState | undefined,
  exportKey: string, status: RenderStatus, elapsedMs: number,
): void {
  if (state === undefined || exportKey === '') return
  setRenderStatus(state, exportKey, 'reply', status)
  if (p === undefined || replyCtx === undefined || replyCtx === null) return
  const ru = asRenderStatusUpdater(p)
  if (ru === undefined) return
  void ru.updateRenderStatus(replyCtx, exportKey, renderStatusText(e, status, elapsedMs)).catch((error: unknown) => {
    console.warn(`reply-render: status patch failed (${exportKey}, ${status}): ${String(error)}`)
  })
}

/**
 * `<title>` prefix distinguishing plan/reply products (Go renderSubtypeTag).
 *
 * @param e - Engine providing the i18n catalog.
 * @param subtype - 'plan' | 'reply'; any other value yields no prefix.
 * @returns The localized prefix ending in '·', or ''.
 */
export function renderSubtypeTag(e: Engine, subtype: string): string {
  switch (subtype) {
    case 'plan':
      return `${e.i18n.t(Msg.RenderTagPlan)}·`
    case 'reply':
      return `${e.i18n.t(Msg.RenderTagReply)}·`
    default:
      return ''
  }
}

// ── fork core ──────────────────────────────────────────────────────────────

/**
 * Shared fork core behind plan-render and reply-html (Go
 * renderContentToHTML): resolve the RenderQuerier + provider, fork the render
 * session with the caller-built prompt + system prompt, then wrap the body
 * fragment it wrote with the fixed template. Failures are logged and
 * swallowed. Returns success; a false result lets the caller clean up the
 * temp dir / retry.
 *
 * @param e - Engine providing the agent, provider config, and logging.
 * @param logTag - Prefix for log lines, e.g. 'plan-render'.
 * @param subtype - 'plan' | 'reply' sub-type selecting the template.
 * @param sessionKey - Session key for logging.
 * @param prompt - User-message prompt carrying html_path and the content.
 * @param systemPrompt - System prompt for the render-session fork.
 * @param htmlPath - Absolute path the fork must write the body fragment to.
 * @param sessionEnv - Extra environment for the forked session.
 * @param signal - Optional abort signal cancelling the fork.
 * @returns Whether the fork produced an assembled HTML file.
 */
export async function renderContentToHTML(
  e: Engine,
  logTag: string,
  subtype: 'plan' | 'reply',
  sessionKey: string,
  prompt: string,
  systemPrompt: string,
  htmlPath: string,
  sessionEnv: string[],
  signal?: AbortSignal,
): Promise<boolean> {
  const rq = asRenderQuerier(e.agent)
  if (rq === undefined) {
    console.debug(`${logTag}: agent does not implement RenderQuerier (${e.agent.name()}, ${sessionKey})`)
    return false
  }

  let providerName = e.planRenderProvider
  if (providerName === '') {
    const ps = asProviderSwitcher(e.agent)
    const active = ps?.getActiveProvider()
    if (active !== undefined) providerName = active.name
  }
  if (providerName === '') {
    console.warn(`${logTag}: no provider resolved, skipping (${sessionKey})`)
    return false
  }

  console.info(`${logTag}: forking render session (${sessionKey}, provider ${providerName}, html_path ${htmlPath})`)

  let out = ''
  try {
    out = await rq.renderQuery(prompt, providerName, systemPrompt, sessionEnv, signal)
  } catch (error) {
    if (error === errRenderStalled) {
      // LLM stall (no stream output): the caller retries — distinct from a
      // user cancel or a real timeout.
      console.info(`${logTag}: stalled, will retry (${sessionKey}, provider ${providerName})`)
      return false
    }
    if (signal?.aborted === true) {
      console.info(`${logTag}: cancelled (${sessionKey})`)
    } else {
      const htmlExists = existsSync(htmlPath)
      console.warn(`${logTag}: failed (${sessionKey}): ${error instanceof Error ? error.message : String(error)} (html_exists=${String(htmlExists)})`)
    }
    return false
  }
  const htmlSize = (await stat(htmlPath).catch(() => undefined))?.size ?? 0
  console.info(`${logTag}: render session completed (${sessionKey}, html_size=${String(htmlSize)}, stdout=${out})`)
  try {
    await assembleHTMLInPlace(htmlPath, subtype, renderSubtypeTag(e, subtype))
  } catch (error) {
    console.warn(`${logTag}: assemble html in place failed (${htmlPath}): ${String(error)}`)
  }
  return true
}

/**
 * Fork an isolated render session to render planMarkdown into HTML (Go
 * renderPlanToHTML). The fork writes to a short ASCII temp path — a
 * CJK/space-laden title path is fragile for the LLM to reproduce verbatim —
 * and the engine best-effort copies the assembled HTML to the pretty sibling
 * path next to the plan .md. Returns the temp write path (delivery source).
 *
 * @param e - Engine used to fork the render session.
 * @param sessionKey - Session key for temp-path derivation and logging.
 * @param planMarkdown - The raw plan markdown to render.
 * @param planFilePath - Plan .md path for the sibling artifact; may be empty.
 * @param revision - ExitPlanMode revision for the -vN suffix.
 * @param sessionEnv - Extra environment for the forked session.
 * @param signal - Optional abort signal cancelling the fork.
 * @returns The temp write path, whether or not the render succeeded.
 */
export async function renderPlanToHTML(
  e: Engine,
  sessionKey: string,
  planMarkdown: string,
  planFilePath: string,
  revision: number,
  sessionEnv: string[],
  signal?: AbortSignal,
): Promise<string> {
  const nameHint = (() => {
    const title = extractMarkdownTitle(planMarkdown)
    return title !== '' ? slugifyTitle(title, '') : ''
  })()
  const writePath = deriveHtmlPath('', sessionKey, '', revision)
  const prompt = `按你的 system-prompt 指令把以下内容渲染成 HTML。\n\n<html_path>${writePath}</html_path>\n\n<plan-markdown>\n${planMarkdown}\n</plan-markdown>`
  const ok = await renderContentToHTML(e, 'plan-render', 'plan', sessionKey, prompt, renderSessionPrompt(), writePath, sessionEnv, signal)
  if (ok) {
    const artifactPath = deriveHtmlPath(planFilePath, sessionKey, nameHint, revision)
    if (artifactPath !== '' && artifactPath !== writePath) copyFileBestEffort(writePath, artifactPath)
  }
  return writePath
}

/**
 * Fork an isolated render session to turn a completed reply into HTML (Go
 * renderReplyToHTML). Reply keeps the SimpleHTML-pre-rendered fragment flow;
 * on failure the temp dir deriveHtmlPath created is removed so it doesn't
 * orphan. Returns the html path (may not exist on failure).
 *
 * @param e - Engine used to fork the render session.
 * @param sessionKey - Session key for temp-path derivation and logging.
 * @param replyContent - The completed reply text to render.
 * @param sessionEnv - Extra environment for the forked session.
 * @param signal - Optional abort signal cancelling the fork.
 * @returns The html path; the file may not exist on failure.
 */
export async function renderReplyToHTML(
  e: Engine,
  sessionKey: string,
  replyContent: string,
  sessionEnv: string[],
  signal?: AbortSignal,
): Promise<string> {
  const htmlPath = deriveHtmlPath('', sessionKey, '', 0)
  const contentHTML = markdownToSimpleHTML(replyContent)
  const prompt = `按你的 system-prompt 指令把以下内容渲染成 HTML。\n\n<html_path>${htmlPath}</html_path>\n\n<plan-rendered-html>\n${contentHTML}\n</plan-rendered-html>`
  const ok = await renderContentToHTML(e, 'reply-html', 'reply', sessionKey, prompt, renderReplySummaryPrompt(), htmlPath, sessionEnv, signal)
  if (!ok) await removeRenderedTemp(htmlPath)
  return htmlPath
}

// ── delivery ──────────────────────────────────────────────────────────────

/**
 * Read the render-session output file and send it as a .html attachment (Go
 * deliverReplyHTML) — the fallback path when PNG rasterization fails or the
 * platform cannot send images.
 *
 * @param _e - Engine; unused, kept for signature parity with the Go port.
 * @param p - Platform that must support FileSender.
 * @param replyCtx - Reply context to address the file message to.
 * @param htmlPath - Path of the assembled HTML file to send.
 * @param signal - Optional abort signal checked before reading and sending.
 */
export async function deliverReplyHTML(_e: Engine, p: Platform, replyCtx: unknown, htmlPath: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw new Error('render delivery aborted')
  let data: Buffer
  try {
    data = await readFile(htmlPath)
  } catch (error) {
    throw new Error(`read rendered html: ${error instanceof Error ? error.message : String(error)}`)
  }
  const fs = asFileSender(p)
  if (fs === undefined) throw new Error(`platform ${p.name()} does not support FileSender`)
  await withTimeout(sendTimeoutMs, () => fs.sendFile(replyCtx, {
    mimeType: 'text/html',
    data: new Uint8Array(data),
    fileName: `${slugifyTitle(extractHTMLTitle(data.toString('utf8')), 'reply')}.html`,
  }))
}

function withTimeout<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`send timed out after ${String(ms)}ms`)) }, ms)
    fn().then((v) => {
      clearTimeout(timer)
      resolve(v)
    }, (error: unknown) => {
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    })
  })
}

/**
 * Resolve the reply context for delivery (Go resolveRenderReplyCtx): prefer
 * state.replyCtx; an async delivery can outlive the turn-end cleanup window
 * that nils it, so rebuild from the sessionKey when the platform supports it.
 * Returns a null replyCtx when reconstruction is unavailable.
 *
 * @param state - Per-session state holding the platform and replyCtx.
 * @param sessionKey - Session key used to rebuild the reply context.
 * @returns The resolved platform and a replyCtx that may be undefined.
 */
export function resolveRenderReplyCtx(state: InteractiveState, sessionKey: string): { platform: Platform | undefined; replyCtx: unknown } {
  const p = state.platform
  if (state.replyCtx !== undefined && state.replyCtx !== null) return { platform: p, replyCtx: state.replyCtx }
  if (p === undefined) return { platform: undefined, replyCtx: undefined }
  const recon = asReplyContextReconstructor(p)
  if (recon !== undefined) {
    try {
      const rebuilt = recon.reconstructReplyCtx(sessionKey)
      console.info(`plan-render: replyCtx nil, reconstructed from sessionKey (${sessionKey})`)
      return { platform: p, replyCtx: rebuilt }
    } catch {
      // fall through to (p, nil)
    }
  }
  return { platform: p, replyCtx: undefined }
}

/**
 * Shell out to the configured render-png script to rasterize htmlPath into a
 * Retina-2x PNG (Go renderHTMLToPNG). Up to three attempts (chromium
 * OOM-crashes are transient); a partial PNG written before a failure is
 * removed so a retry isn't a no-op.
 *
 * @param e - Engine providing the configured render-png script path.
 * @param htmlPath - The assembled HTML file to rasterize.
 * @param signal - Optional abort signal cancelling between attempts.
 * @returns The written PNG path.
 */
export async function renderHTMLToPNG(e: Engine, htmlPath: string, signal?: AbortSignal): Promise<string> {
  const script = e.planRenderPngScript
  if (script === '') throw new Error('render_png_script not configured')
  if (!existsSync(script)) throw new Error(`render_png_script not found: ${script}`)
  const pngPath = htmlPath.endsWith('.html') ? `${htmlPath.slice(0, -5)}.png` : `${htmlPath}.png`

  const maxAttempts = 3
  let lastErr: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted === true) throw new Error('render-png aborted')
    let ok = false
    try {
      await withTimeout(pngRenderTimeoutMs, () => execFileAsync(script, [htmlPath, pngPath, String(renderPNGWidth), '0', 'fullpage', '2']))
      ok = true
    } catch (error) {
      lastErr = error
    }
    if (ok) return pngPath
    await rm(pngPath, { force: true }).catch(() => undefined)
    if (attempt < maxAttempts) {
      console.warn(`render-image: png render failed, retrying (attempt ${String(attempt)}): ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pngRetryBackoffMs)
        signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
      })
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/**
 * Render htmlPath to a Retina-2x PNG and send it right after the plan /
 * completion card (Go deliverRenderedImage). Prefers a fit_horizontal card
 * (Feishu's msg_type=image caps tall-image height); falls back to a plain
 * image message, then to the .html file.
 *
 * @param e - Engine used for PNG rasterization and the HTML fallback.
 * @param p - Platform delivering the image.
 * @param replyCtx - Reply context to address the message to.
 * @param htmlPath - The assembled HTML file to rasterize.
 * @param signal - Optional abort signal cancelling the delivery.
 */
export async function deliverRenderedImage(
  e: Engine, p: Platform, replyCtx: unknown, htmlPath: string, signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted === true) throw new Error('render delivery aborted')
  let pngPath: string
  try {
    pngPath = await renderHTMLToPNG(e, htmlPath, signal)
  } catch (error) {
    console.warn(`render-image: png render failed, falling back to html (${htmlPath}): ${error instanceof Error ? error.message : String(error)}`)
    await deliverReplyHTML(e, p, replyCtx, htmlPath, signal)
    return
  }
  let pngData: Buffer
  try {
    pngData = await readFile(pngPath)
  } catch (error) {
    console.warn(`render-image: read png failed, falling back to html (${htmlPath}): ${error instanceof Error ? error.message : String(error)}`)
    await deliverReplyHTML(e, p, replyCtx, htmlPath, signal)
    return
  }
  let htmlData: Buffer | undefined
  try {
    htmlData = await readFile(htmlPath)
  } catch {
    htmlData = undefined
  }
  const title = htmlData !== undefined ? extractHTMLTitle(htmlData.toString('utf8')) : ''
  const fileName = `${slugifyTitle(title, 'render')}.png`
  const img: ImageAttachment = { mimeType: 'image/png', data: new Uint8Array(pngData), fileName }

  try {
    const cardSender = asCardSender(p)
    const uploader = asImageUploader(p)
    if (cardSender !== undefined && uploader !== undefined) {
      try {
        const imageKey = await withTimeout(sendTimeoutMs, () => uploader.uploadImage(img))
        // Go: NewCard().ImageFill(imageKey, title) — no card header; the
        // delivered card is just the full-width image.
        const cb = newCard()
        cb.imageFill(imageKey, title)
        await withTimeout(sendTimeoutMs, () => cardSender.sendCard(replyCtx, cb.build()))
        return
      } catch (error) {
        console.warn(`render-image: card path failed, falling back to image message: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const is = asImageSender(p)
    if (is === undefined) {
      console.warn(`render-image: platform cannot send images, falling back to html (${p.name()})`)
      await deliverReplyHTML(e, p, replyCtx, htmlPath, signal)
      return
    }
    await withTimeout(sendTimeoutMs, () => is.sendImage(replyCtx, img))
  } finally {
    await rm(pngPath, { force: true }).catch(() => undefined)
  }
}

// ── speculative reply auto-deliver (Go renderAndDeliverReply) ─────────────

/**
 * Fork a render session that turns replyContent into HTML→PNG (falling back
 * to .html) and delivers it into the session (Go renderAndDeliverReply).
 * Best-effort with single-flight via state.preRenderRunning; a cancelled
 * render (new turn / card button → cancelRenders) or failed fork silently
 * skips delivery. Retries once when the first attempt stalls or times out
 * without producing a file (upstream LLM jitter).
 *
 * @param e - Engine used to fork and deliver the render.
 * @param state - Per-session state guarding single-flight and cancel tracking.
 * @param sessionKey - Session key for context reconstruction and logging.
 * @param replyContent - The completed reply text to render.
 * @param exportKey - Export key under which status and temp paths are recorded.
 */
export function renderAndDeliverReply(
  e: Engine,
  state: InteractiveState | undefined,
  sessionKey: string,
  replyContent: string,
  exportKey: string,
): void {
  if (state === undefined || replyContent === '') return
  if (state.preRenderRunning) return
  state.preRenderRunning = true
  state.preRenderingKey = exportKey
  const sessionEnv = [...state.sessionEnv]

  const parentCtl = new AbortController()
  const handle = registerRenderCancel(state, () => { parentCtl.abort() })
  void (async () => {
    try {
      let timeout = e.planRenderTimeoutMs
      if (timeout <= 0) timeout = defaultPlanRenderTimeoutMs
      if (timeout > defaultPreRenderTimeoutMs) timeout = defaultPreRenderTimeoutMs

      const { platform, replyCtx } = resolveRenderReplyCtx(state, sessionKey)
      const renderStart = Date.now()
      patchReplyRenderStatus(e, platform, replyCtx, state, exportKey, 'rendering', 0)
      // Periodically refresh the elapsed "rendering" status so the user does
      // not mistake a slow render for a hang; stopped before the final PATCH
      // so a late tick cannot reorder statuses.
      let progressStop = false
      const progressInflight: Array<Promise<void>> = []
      const ticker = setInterval(() => {
        progressInflight.push(Promise.resolve().then(() => { patchReplyRenderStatus(e, platform, replyCtx, state, exportKey, 'rendering', Date.now() - renderStart) }))
      }, 30_000)
      const stopProgress = (): void => {
        if (progressStop) return
        progressStop = true
        clearInterval(ticker)
      }

      const maxAttempts = 2
      let hp = ''
      let succeeded = false
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const attemptCtl = new AbortController()
        const onParentAbort = (): void => { attemptCtl.abort() }
        parentCtl.signal.addEventListener('abort', onParentAbort, { once: true })
        const timer = setTimeout(() => { attemptCtl.abort() }, timeout)
        try {
          hp = await renderReplyToHTML(e, sessionKey, replyContent, sessionEnv, attemptCtl.signal)
        } finally {
          clearTimeout(timer)
          parentCtl.signal.removeEventListener('abort', onParentAbort)
        }
        if (existsSync(hp)) {
          succeeded = true
          break
        }
        if (parentCtl.signal.aborted) break // user opened a new turn — stop retrying
        if (attempt < maxAttempts) {
          console.info(`reply-html: first attempt produced no file, retrying (${sessionKey})`)
        }
      }
      if (!succeeded) {
        stopProgress()
        const status: RenderStatus = parentCtl.signal.aborted ? 'cancelled' : 'failed'
        patchReplyRenderStatus(e, platform, replyCtx, state, exportKey, status, 0)
        return
      }
      recordRenderedReply(state, exportKey, hp)
      console.info(`reply-html-pre: rendered (${sessionKey}, exportKey ${exportKey}, html_path ${hp})`)
      if (platform === undefined || replyCtx === undefined) {
        stopProgress()
        console.warn(`reply-html-pre: skip deliver, no replyCtx (${sessionKey})`)
        patchReplyRenderStatus(e, platform, replyCtx, state, exportKey, 'failed', 0)
      } else {
        try {
          await deliverRenderedImage(e, platform, replyCtx, hp, parentCtl.signal)
          stopProgress()
          patchReplyRenderStatus(e, platform, replyCtx, state, exportKey, 'delivered', Date.now() - renderStart)
        } catch (error) {
          stopProgress()
          console.warn(`reply-html-pre: deliver failed (${sessionKey}): ${String(error)}`)
          patchReplyRenderStatus(e, platform, replyCtx, state, exportKey, 'failed', 0)
        }
      }
      await Promise.allSettled(progressInflight)
      void removeRenderedTemp(hp)
    } finally {
      state.preRenderRunning = false
      state.preRenderingKey = ''
      unregisterRenderCancel(state, handle)
    }
  })()
}

// ── plan render fork (Go engine_events.go ExitPlanMode SafeGo body) ───────

/**
 * Fire-and-forget the plan→HTML render for an ExitPlanMode revision (Go
 * engine_events.go plan-render branch): registers the cancel synchronously,
 * retries once when the first attempt produces no file (stall/timeout), then
 * delivers the image and PATCHes the plan card status. Runs in addition to
 * the markdown plan card, which is the always-available fallback.
 *
 * @param e - Engine used to fork and deliver the render.
 * @param state - Per-session state receiving cancel registration and the render-lock release.
 * @param sessionKey - Session key for context reconstruction and logging.
 * @param sentPlanContent - The plan markdown already shown on the card.
 * @param planFilePath - Plan .md path for the sibling artifact.
 * @param revision - ExitPlanMode revision number.
 * @param exportKey - Export key identifying this plan render.
 */
export function launchPlanRender(
  e: Engine,
  state: InteractiveState,
  sessionKey: string,
  sentPlanContent: string,
  planFilePath: string,
  revision: number,
  exportKey: string,
): void {
  const renderEnv = [...state.sessionEnv]
  let timeout = e.planRenderTimeoutMs
  if (timeout <= 0) timeout = defaultPlanRenderTimeoutMs

  const parentCtl = new AbortController()
  const handle = registerRenderCancel(state, () => { parentCtl.abort() })
  void (async () => {
    try {
      const renderStart = Date.now()
      updatePlanCardStatus(e, state, exportKey, 'rendering', 0)
      const maxAttempts = 2
      let htmlPath = ''
      let succeeded = false
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const attemptCtl = new AbortController()
        const onParentAbort = (): void => { attemptCtl.abort() }
        parentCtl.signal.addEventListener('abort', onParentAbort, { once: true })
        const timer = setTimeout(() => { attemptCtl.abort() }, timeout)
        try {
          htmlPath = await renderPlanToHTML(e, sessionKey, sentPlanContent, planFilePath, revision, renderEnv, attemptCtl.signal)
        } finally {
          clearTimeout(timer)
          parentCtl.signal.removeEventListener('abort', onParentAbort)
        }
        if (existsSync(htmlPath)) {
          succeeded = true
          break
        }
        if (parentCtl.signal.aborted) break // user opened a new turn — stop retrying
        if (attempt < maxAttempts) {
          console.info(`plan-html: first attempt produced no file, retrying (${sessionKey})`)
        }
      }
      if (!succeeded) {
        const status: RenderStatus = parentCtl.signal.aborted ? 'cancelled' : 'failed'
        updatePlanCardStatus(e, state, exportKey, status, 0)
        await removeRenderedTemp(htmlPath)
        return
      }
      const { platform, replyCtx } = resolveRenderReplyCtx(state, sessionKey)
      if (platform === undefined || replyCtx === undefined) {
        console.warn(`plan-render: skip deliver, no replyCtx (${sessionKey})`)
        updatePlanCardStatus(e, state, exportKey, 'failed', 0)
        await removeRenderedTemp(htmlPath)
        return
      }
      console.info(`plan-render: delivering image (${sessionKey}, html_path ${htmlPath})`)
      try {
        await deliverRenderedImage(e, platform, replyCtx, htmlPath, parentCtl.signal)
        updatePlanCardStatus(e, state, exportKey, 'delivered', Date.now() - renderStart)
      } catch (error) {
        console.warn(`plan-render: deliver failed (${sessionKey}): ${String(error)}`)
        updatePlanCardStatus(e, state, exportKey, 'failed', 0)
      }
      await removeRenderedTemp(htmlPath)
    } finally {
      clearPlanRenderRunning(state)
      unregisterRenderCancel(state, handle)
    }
  })()
}

/**
 * Reap recorded reply-HTML temp dirs at session teardown (Go cleanupInteractiveState render segment).
 *
 * @param state - Per-session state whose recorded reply-HTML paths are reaped.
 */
export async function cleanupRenderedReplyHTML(state: InteractiveState | undefined): Promise<void> {
  if (state === undefined) return
  const paths = state.renderedReplyHTML
  state.renderedReplyHTML = undefined
  if (paths === undefined) return
  for (const htmlPath of paths.values()) await removeRenderedTemp(htmlPath)
}

// ── plan card (Go engine_send.go sendPlanContent card path) ───────────────

/**
 * Send the plan markdown card with its export button (Go sendPlanCard): when
 * the platform supports CardSenderWithUpdate, the card is sent with a handle
 * and its base recorded under exportKey so the render status can PATCH it.
 * The returned promise settles only after the card send completed (or fell
 * back) — callers must await it before sending the permission card so the
 * chat order stays plan → approval (Go sends synchronously, same guarantee).
 *
 * @param e - Engine used for the plain-text fallback.
 * @param p - Platform to send the card through.
 * @param replyCtx - Reply context to address the card to.
 * @param state - Per-session state recording the card handle; undefined forces the plain path.
 * @param exportKey - Export key under which the card handle is recorded.
 * @param content - The plan markdown card body.
 * @param header - Card header; undefined forces the plain path.
 * @param buttons - Action buttons (e.g. export) appended to the card.
 * @returns Promise settling after the card (or its fallback) was sent.
 */
export function sendPlanCard(
  e: Engine,
  p: Platform,
  replyCtx: unknown,
  state: InteractiveState | undefined,
  exportKey: string,
  content: string,
  header: CardHeader | undefined,
  buttons: CardButton[],
): Promise<void> {
  if (state !== undefined && header !== undefined) {
    const cu = asCardSenderWithUpdate(p)
    if (cu !== undefined) {
      const baseCard = new Card()
      baseCard.header = header
      baseCard.elements = [{ kind: 'markdown', content }]
      if (buttons.length > 0) baseCard.elements.push({ kind: 'actions', buttons, layout: 'row' })
      return cu.sendCardWithHandle(replyCtx, baseCard).then((handle) => {
        if (state.planCardRender === undefined) state.planCardRender = new Map()
        state.planCardRender.set(exportKey, { handle, baseCard })
        return undefined
      }, (error: unknown) => {
        console.warn(`plan card send with handle failed, falling back to plain card: ${String(error)}`)
        return sendPlanCardPlain(e, p, replyCtx, content, header, buttons)
      })
    }
  }
  return sendPlanCardPlain(e, p, replyCtx, content, header, buttons)
}

async function sendPlanCardPlain(
  e: Engine, p: Platform, replyCtx: unknown, content: string,
  header: CardHeader | undefined, buttons: CardButton[],
): Promise<void> {
  const cs = asCardSender(p)
  if (cs !== undefined && header !== undefined) {
    try {
      await cs.sendCard(replyCtx, buildPlanCard(content, header, buttons))
      return
    } catch {
      // fall through to plain text
    }
  }
  await e.send(p, replyCtx, content)
}

function buildPlanCard(content: string, header: CardHeader, buttons: CardButton[]): Card {
  const card = new Card()
  card.header = header
  card.elements = [{ kind: 'markdown', content }]
  if (buttons.length > 0) card.elements.push({ kind: 'actions', buttons, layout: 'row' })
  return card
}
