/**
 * Treemap rendering for the /context map command: shapes the projection
 * snapshot into context-ordered segments (system prompt → per-tool schemas →
 * dropped-nodes placeholder → surface nodes by seq), groups them into the
 * three assembly phases (① system prompt, ② tool schemas, ③ history), lays
 * each phase out as its own squarified band (band width ∝ phase tokens,
 * rectangle area ∝ segment tokens, rectangles in seq order inside a band),
 * and emits the self-contained zero-JS HTML document the command sends as a
 * .html attachment.
 *
 * Every function here is pure over its arguments — the engine-side command
 * only assembles them; no engine state is read. HTML copy is Chinese-only,
 * matching the chart visuals' existing convention (chartspec.ts bucket
 * labels); chat-side command copy routes through the bridge i18n.
 *
 * @module dsh-feishu-bridge/context/treemap
 */

import { capRunes, formatTokens } from './render.ts'
import { BUCKET_COLORS, BUCKET_KEYS, BUCKET_LABELS } from './chartspec.ts'
import type { ContextSnapshotValues, HeaderToolValue, SurfaceCategory, SurfaceNode } from './types.ts'

/** Cap (runes) of a segment's prompt text before per-rectangle fitting. */
const SEGMENT_TEXT_MAX_RUNES = 400

/** Treemap canvas size in CSS pixels (the map scales down on narrow windows). */
const TREEMAP_CANVAS = { w: 1_280, h: 800 } as const

/** Horizontal gap between two phase bands. */
const BAND_GAP = 8

/** Height of a band's header strip (its label row). */
const BAND_HEAD_H = 26

/** A rectangle below either threshold renders as a color block (CSS hides its label). */
const LABEL_MIN_W = 56
const LABEL_MIN_H = 26

/** In-rectangle text metrics (must track the body CSS: 12px/1.35 content, 11px token line). */
const CONTENT_FONT_PX = 12
const CONTENT_LINE_PX = 16.2
const TOKENS_LINE_PX = 16

/** Rectangle padding, both sides summed (`.seg { padding: 4px }`). */
const SEG_PAD_PX = 8

/** The dropped-nodes placeholder's gray (outside the six-bucket palette). */
const DROPPED_COLOR = '#64748b'

/**
 * One treemap rectangle's raw material: a token-priced slice of the request
 * context in assembly order.
 */
export interface TreemapSegment {
  /** Segment discriminant: the envelope parts, the coverage placeholder, or a surface message. */
  kind: 'system' | 'tool' | 'dropped' | 'node'
  /** Heuristic token count; the rectangle's area weight. */
  tokens: number
  /**
   * The segment's prompt text: the system prompt's opening, a tool's
   * name + description, or the message's opening text. Rune-capped here,
   * then fitted to each rectangle's capacity by {@link fitTextToRect}; the
   * hover title carries the full capped text.
   */
  text: string
  /** Surface category ('node' segments only); drives the bucket color. */
  cat?: SurfaceCategory
  /** Session-log sequence number ('node' segments only); shown beside the token count. */
  seq?: number
}

/**
 * One assembly phase of the request context — the treemap's top level. Bands
 * render left to right in {@link treemapBands} order (system → tools →
 * history), so their horizontal position reads as the assembly order.
 */
export interface TreemapBand {
  /** Phase discriminant. */
  kind: 'system' | 'tools' | 'messages'
  /** Ordinal marker shown in the band header (①/②/③). */
  marker: string
  /** Band header label. */
  label: string
  /** Phase token sum; the band's width weight. */
  tokens: number
  /** The phase's segments in assembly order. */
  segments: TreemapSegment[]
}

/** The phase a segment belongs to. */
function bandOf(segment: TreemapSegment): TreemapBand['kind'] {
  switch (segment.kind) {
    case 'system': return 'system'
    case 'tool': return 'tools'
    case 'dropped':
    case 'node': return 'messages'
  }
}

/**
 * Group ordered segments into the three assembly phases, dropping empty
 * phases (a session with no request yet has no tool band). The dropped-nodes
 * placeholder stays inside the messages phase — it is the oldest messages.
 *
 * @param segments - Ordered segments from {@link treemapSegments}.
 * @returns The non-empty phases in assembly order.
 */
export function treemapBands(segments: readonly TreemapSegment[]): TreemapBand[] {
  const phases: ReadonlyArray<Pick<TreemapBand, 'kind' | 'marker' | 'label'>> = [
    { kind: 'system', marker: '①', label: '系统提示词' },
    { kind: 'tools', marker: '②', label: '工具定义' },
    { kind: 'messages', marker: '③', label: '历史消息' },
  ]
  const bands: TreemapBand[] = []
  for (const phase of phases) {
    const inside = segments.filter(segment => bandOf(segment) === phase.kind)
    if (inside.length === 0) continue
    bands.push({
      ...phase,
      tokens: inside.reduce((sum, segment) => sum + segment.tokens, 0),
      segments: inside,
    })
  }
  return bands
}

/**
 * Shape the projection snapshot into treemap segments in request-assembly
 * order: the system prompt, then the newest header epoch's tool schemas in
 * declaration order, then one gray placeholder for the dropped-nodes token
 * mass, then the served surface nodes by seq. Zero-token entries are
 * skipped (empty assistant messages price 0 and project to no rectangle).
 *
 * @param snapshot - The live agent session's projection snapshot.
 * @returns The segments in context order; empty without a timeline.
 */
export function treemapSegments(snapshot: ContextSnapshotValues): TreemapSegment[] {
  const timeline = snapshot.timeline
  if (timeline === undefined) return []
  const epoch = snapshot.headers?.headers.at(-1)
  const segments: TreemapSegment[] = []

  if (timeline.current.system > 0) {
    segments.push({
      kind: 'system',
      tokens: timeline.current.system,
      // The prompt itself fills the rectangle; without a header epoch (an
      // older host) the phase name is all there is to show.
      text: capRunes(epoch?.system ?? '', SEGMENT_TEXT_MAX_RUNES) || '系统提示词',
    })
  }
  if (epoch !== undefined) {
    for (const tool of epoch.tools) pushToolSegment(segments, tool)
  }

  // The fold's message buckets cover the FULL live surface while `nodes`
  // serves only the newest tail: the difference is the dropped mass. It
  // renders as one gray rectangle placed where those messages sit (before
  // every served node) so the treemap never under-reports the composition.
  const current = timeline.current
  const messageTotal = current.user + current.inject + current.assistant + current.tool
  const served = timeline.nodes.reduce((sum, node) => sum + node.tokens, 0)
  const droppedTokens = messageTotal - served
  if (timeline.droppedNodes > 0 && droppedTokens > 0) {
    segments.push({
      kind: 'dropped',
      tokens: droppedTokens,
      text: `更早的 ${timeline.droppedNodes} 条消息（约 ${droppedTokens} tokens）`,
    })
  }

  const nodes = timeline.nodes
    .filter(node => node.tokens > 0)
    .slice()
    .sort((a, b) => a.seq - b.seq)
  for (const node of nodes) segments.push(nodeSegment(node))
  return segments
}

/** One tool-schema segment: the name labels the rectangle, the description hovers. */
function pushToolSegment(segments: TreemapSegment[], tool: HeaderToolValue): void {
  if (tool.tokens <= 0) return
  segments.push({
    kind: 'tool',
    tokens: tool.tokens,
    text: capRunes(
      tool.description === undefined ? tool.name : `${tool.name} — ${tool.description}`,
      SEGMENT_TEXT_MAX_RUNES,
    ),
  })
}

/** One surface-node segment: the message's text first, then the tool name, then the call names. */
function nodeSegment(node: SurfaceNode): TreemapSegment {
  const text = node.text !== undefined && node.text !== ''
    ? capRunes(node.text, SEGMENT_TEXT_MAX_RUNES)
    : nodeLabel(node)
  return {
    kind: 'node',
    tokens: node.tokens,
    text,
    cat: node.cat,
    seq: node.seq,
  }
}

/** The in-rectangle fallback text of a surface node without a text block. */
function nodeLabel(node: SurfaceNode): string {
  if (node.tool !== undefined && node.tool !== '') {
    return node.err === true ? `⚠ ${node.tool}` : node.tool
  }
  if (node.calls !== undefined && node.calls.length > 0) {
    return `调用 ${node.calls.join(', ')}`
  }
  if (node.skill !== undefined && node.skill !== '') return node.skill
  if (node.form !== undefined && node.form !== '') return node.form
  return surfaceCategoryLabel(node.cat)
}

/**
 * The advance width of one rune in em units: fullwidth scripts (CJK,
 * hangul, fullwidth forms, emoji) take a full em, everything else about
 * 0.55em — a fixed estimator, not a font metric.
 */
function runeEm(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0
  const wide = (cp >= 0x1100 && cp <= 0x115f)
    || (cp >= 0x2e80 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe4f)
    || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f300 && cp <= 0x1f9ff)
    || (cp >= 0x20000 && cp <= 0x3fffd)
  return wide ? 1 : 0.55
}

/**
 * Fit a prompt text into one rectangle: keep as much of the opening as the
 * box can render (its width × the line count left after the token line) and
 * mark the cut with an ellipsis. Whitespace runs collapse to single spaces,
 * matching the rendered text.
 *
 * @param text - The segment's prompt text (already rune-capped).
 * @param rect - The rectangle the text must fit into.
 * @returns The fitted text; empty when no line fits.
 */
export function fitTextToRect(text: string, rect: TreemapRect): string {
  const widthBudget = rect.w - SEG_PAD_PX
  const lines = Math.floor((rect.h - SEG_PAD_PX - TOKENS_LINE_PX) / CONTENT_LINE_PX)
  if (widthBudget <= 0 || lines < 1) return ''
  const capacity = widthBudget * lines
  const runes = Array.from(text.replace(/\s+/g, ' ').trim())
  let used = 0
  let out = ''
  for (const ch of runes) {
    used += runeEm(ch) * CONTENT_FONT_PX
    if (used > capacity) return `${out}…`
    out += ch
  }
  return out
}

/** One laid-out rectangle: canvas coordinates and size. */
export interface TreemapRect {
  x: number
  y: number
  w: number
  h: number
}

/** One value's scaled area awaiting layout, carrying its input index. */
interface AreaEntry {
  index: number
  area: number
}

/** The worst aspect ratio a candidate row would produce at the given side length. */
function worstRatio(row: readonly AreaEntry[], length: number): number {
  let sum = 0
  let max = 0
  let min = Number.POSITIVE_INFINITY
  for (const entry of row) {
    sum += entry.area
    if (entry.area > max) max = entry.area
    if (entry.area < min) min = entry.area
  }
  const s2 = sum * sum
  const l2 = length * length
  return Math.max((l2 * max) / s2, s2 / (l2 * min))
}

/**
 * Squarified treemap layout (Bruls, Huizing & van Wijk): lays the values out
 * in the given order so rectangle areas are exactly proportional to the
 * values, reading order (columns left→right, stacks top→bottom) follows the
 * input order, and aspect ratios stay as square as the greedy row packing
 * achieves. Values ≤ 0 degenerate to zero-area rectangles at the origin.
 *
 * @param values - Positive weights, one per rectangle, in layout order.
 * @param rect - The canvas to tile.
 * @returns One rectangle per input value, index-aligned.
 */
export function squarify(values: readonly number[], rect: TreemapRect): TreemapRect[] {
  const rects: TreemapRect[] = new Array<TreemapRect>(values.length)
  let total = 0
  const entries: AreaEntry[] = []
  for (const [index, value] of values.entries()) {
    if (value > 0) {
      total += value
      entries.push({ index, area: value })
    } else {
      rects[index] = { x: rect.x, y: rect.y, w: 0, h: 0 }
    }
  }
  if (entries.length === 0 || total <= 0 || rect.w <= 0 || rect.h <= 0) {
    for (const entry of entries) rects[entry.index] = { x: rect.x, y: rect.y, w: 0, h: 0 }
    return rects
  }
  const scale = (rect.w * rect.h) / total
  for (const entry of entries) entry.area *= scale

  let x = rect.x
  let y = rect.y
  let w = rect.w
  let h = rect.h
  let row: AreaEntry[] = []
  const layoutRow = (): void => {
    let sum = 0
    for (const entry of row) sum += entry.area
    if (w >= h) {
      // A vertical column against the left edge, items stacked top→bottom.
      const width = sum / h
      let cy = y
      for (const entry of row) {
        const height = entry.area / width
        rects[entry.index] = { x, y: cy, w: width, h: height }
        cy += height
      }
      x += width
      w -= width
    } else {
      // A horizontal band against the top edge, items laid left→right.
      const height = sum / w
      let cx = x
      for (const entry of row) {
        const width = entry.area / height
        rects[entry.index] = { x: cx, y, w: width, h: height }
        cx += width
      }
      y += height
      h -= height
    }
    row = []
  }

  for (const entry of entries) {
    // Greedily grow the row while the candidate keeps the worst aspect ratio
    // from rising; a rise flushes the row and starts the next one.
    const length = Math.min(w, h)
    if (row.length === 0 || worstRatio([...row, entry], length) <= worstRatio(row, length)) {
      row.push(entry)
    } else {
      layoutRow()
      row.push(entry)
    }
  }
  if (row.length > 0) layoutRow()
  return rects
}

/** The zh display name of one surface category (label fallback only). */
function surfaceCategoryLabel(cat: SurfaceCategory): string {
  switch (cat) {
    case 'user': return '用户消息'
    case 'inject': return '注入内容'
    case 'assistant': return '助手消息'
    case 'tool': return '工具结果'
  }
}

// ── HTML document ──────────────────────────────────────────────────────────

/** Rendering arguments: everything the document shows, resolved by the caller. */
export interface TreemapHTMLArgs {
  /** Session display name for the header. */
  sessionTitle: string
  /** The chat's effective provider route's model name. */
  model: string
  /** Projection snapshot of the chat's live agent session. */
  snapshot: ContextSnapshotValues
  /** Generation time (epoch ms) stamped into the footer. */
  time: number
}

/** Escape a string for HTML text and attribute contexts (embedding boundary). */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** The rectangle's color: the six-bucket palette keyed by segment kind/category. */
function segmentColor(segment: TreemapSegment): string {
  if (segment.kind === 'dropped') return DROPPED_COLOR
  const key = segment.kind === 'system' ? 'system' : segment.kind === 'tool' ? 'tools' : segment.cat ?? 'user'
  return BUCKET_COLORS[BUCKET_KEYS.indexOf(key)] ?? DROPPED_COLOR
}

/**
 * Render the context treemap as a self-contained zero-JS HTML document:
 * header (title, model, totals), one labeled band per assembly phase laid
 * left to right (band width ∝ phase tokens) with the phase's squarified
 * rectangles inside (label + token count, full preview on hover, CSS hides
 * labels too small to read), and the legend/footer with the six-bucket
 * figures and coverage notes.
 *
 * @param args - Session title/model, the projection snapshot, and the
 *   generation time.
 * @returns The complete HTML document.
 */
export function renderTreemapHTML(args: TreemapHTMLArgs): string {
  const segments = treemapSegments(args.snapshot)
  const bands = treemapBands(segments)
  const total = args.snapshot.timeline?.current.total ?? segments.reduce((sum, s) => sum + s.tokens, 0)
  const weightTotal = bands.reduce((sum, band) => sum + band.tokens, 0)
  // The last band takes the rounded remainder so the bands tile the canvas
  // exactly instead of leaving a fractional sliver.
  const innerW = TREEMAP_CANVAS.w - BAND_GAP * Math.max(0, bands.length - 1)
  const contentH = TREEMAP_CANVAS.h - BAND_HEAD_H
  let left = 0
  const bandMarkup = bands.map((band, index) => {
    const width = index === bands.length - 1
      ? TREEMAP_CANVAS.w - left
      : round1(innerW * (band.tokens / weightTotal))
    const rects = squarify(band.segments.map(segment => segment.tokens), { x: 0, y: 0, w: width, h: contentH })
    const cells = band.segments.map((segment, i) => {
      const rect = rects[i]
      return rect === undefined ? '' : rectMarkup(segment, rect)
    }).join('\n')
    const block = `    <div class="band band-${band.kind}" style="left:${round1(left)}px;width:${round1(width)}px">
      <div class="band-head">${band.marker} ${band.label} · ${formatTokens(band.tokens)}</div>
${cells}
    </div>`
    left += width + BAND_GAP
    return block
  }).join('\n')
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>上下文树图 · ${escapeHtml(args.sessionTitle)}</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; font-family: -apple-system, "PingFang SC", "Segoe UI", sans-serif; background: #f1f5f9; color: #0f172a; }
header { padding: 20px 24px 8px; }
h1 { margin: 0 0 4px; font-size: 18px; }
.meta { margin: 0; color: #64748b; font-size: 13px; }
#map { position: relative; width: ${TREEMAP_CANVAS.w}px; height: ${TREEMAP_CANVAS.h}px; margin: 12px 24px; background: #e2e8f0; }
.band { position: absolute; top: 0; height: ${TREEMAP_CANVAS.h}px; background: #cbd5e1; }
.band-head { box-sizing: border-box; height: ${BAND_HEAD_H}px; padding: 4px 6px 0; font-size: 11px; font-weight: 600; color: #334155; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.seg { position: absolute; box-sizing: border-box; overflow: hidden; padding: 4px; border: 1px solid rgba(255,255,255,.6); color: #fff; }
.seg:hover { outline: 2px solid #0f172a; z-index: 1; }
.label { display: block; font-size: 12px; line-height: 1.35; overflow: hidden; word-break: break-all; }
.tokens { display: block; margin-top: 2px; font-size: 11px; opacity: .85; }
.bare .label, .bare .tokens { visibility: hidden; }
footer { padding: 4px 24px 24px; font-size: 13px; color: #334155; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 4px 0 8px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
.note { margin: 2px 0; color: #64748b; }
@media (prefers-color-scheme: dark) {
  body { background: #0b1220; color: #e2e8f0; }
  #map { background: #1e293b; }
  .band { background: #334155; }
  .band-head { color: #cbd5e1; }
  footer { color: #94a3b8; }
}
</style>
</head>
<body>
<header>
  <h1>上下文树图 · ${escapeHtml(args.sessionTitle)}</h1>
  <p class="meta">${escapeHtml(args.model)} · 估算 ${formatTokens(total)} tokens · 生成于 ${formatTime(args.time)}</p>
</header>
<main id="map">
${bandMarkup}
  </main>
<footer>
    <div class="legend">${legend(args.snapshot)}</div>
    <p class="note">token 数为启发式估算；色带宽度 ∝ 该阶段 token，矩形面积 ∝ 该块 token。①→②→③ 自左向右即上下文装配顺序，阶段内矩形按会话顺序排列（#数字为会话日志 seq）。悬停可看该部分的开头文本。</p>
${droppedNote(args.snapshot)}
  </footer>
</body>
</html>
`
}

/** One rectangle's markup: coordinates are relative to its band, below the header strip. */
function rectMarkup(segment: TreemapSegment, rect: TreemapRect): string {
  const bare = rect.w < LABEL_MIN_W || rect.h < LABEL_MIN_H ? ' bare' : ''
  const figure = segment.seq === undefined
    ? formatTokens(segment.tokens)
    : `#${segment.seq} · ${formatTokens(segment.tokens)}`
  return `      <div class="seg${bare}" style="left:${round1(rect.x)}px;top:${round1(BAND_HEAD_H + rect.y)}px;width:${round1(rect.w)}px;height:${round1(rect.h)}px;background:${segmentColor(segment)}" title="${escapeHtml(segment.text)}">
        <span class="label">${escapeHtml(fitTextToRect(segment.text, rect))}</span>
        <span class="tokens">${figure}</span>
      </div>`
}

/** One legend entry per six-bucket key with its current figure. */
function legend(snapshot: ContextSnapshotValues): string {
  const current = snapshot.timeline?.current
  return BUCKET_KEYS.map((key, i) => {
    const figure = current === undefined ? '' : ` ${formatTokens(current[key])}`
    return `<span><i class="swatch" style="background:${BUCKET_COLORS[i]}"></i>${BUCKET_LABELS[i]}${figure}</span>`
  }).join('')
}

/** The dropped-nodes coverage note; empty when every live node is served. */
function droppedNote(snapshot: ContextSnapshotValues): string {
  const timeline = snapshot.timeline
  if (timeline === undefined || timeline.droppedNodes <= 0) return ''
  return `    <p class="note">另有 ${timeline.droppedNodes} 条更早消息未进入快照服务范围（树图开头灰色块为它们的 token 估算差额）。</p>\n`
}

/** Round a layout coordinate to one decimal (avoids 12.000000000000002px). */
function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** zh-CN timestamp for the footer. */
function formatTime(time: number): string {
  return new Date(time).toLocaleString('zh-CN', { hour12: false })
}
