/**
 * Treemap rendering for the /context map command: shapes the projection
 * snapshot into context-ordered segments (system prompt → per-tool schemas →
 * dropped-nodes placeholder → surface nodes by seq), lays them out as a
 * squarified treemap (rect areas ∝ token counts, reading order ≈ context
 * order), and emits the self-contained zero-JS HTML document the command
 * sends as a .html attachment.
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

/** In-rectangle label cap (runes) for node and tool segments. */
const SEGMENT_LABEL_MAX_RUNES = 80

/** Hover-preview cap (runes) for every segment kind. */
const SEGMENT_PREVIEW_MAX_RUNES = 400

/** Treemap canvas size in CSS pixels (the map scales down on narrow windows). */
const TREEMAP_CANVAS = { w: 1_280, h: 800 } as const

/** A rectangle below either threshold renders as a color block (CSS hides its label). */
const LABEL_MIN_W = 56
const LABEL_MIN_H = 26

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
  /** Primary in-rectangle label (first line of the preview material). */
  label: string
  /** Longer hover text (the HTML title attribute), rune-capped. */
  preview: string
  /** Surface category ('node' segments only); drives the bucket color. */
  cat?: SurfaceCategory
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
      label: '系统提示词',
      preview: capRunes(epoch?.system ?? '', SEGMENT_PREVIEW_MAX_RUNES),
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
      label: `更早的 ${timeline.droppedNodes} 条消息`,
      preview: `未进入快照服务范围的 ${timeline.droppedNodes} 条消息，约 ${droppedTokens} tokens（估算差额）`,
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
    label: capRunes(tool.name, SEGMENT_LABEL_MAX_RUNES),
    preview: capRunes(tool.description ?? tool.name, SEGMENT_PREVIEW_MAX_RUNES),
  })
}

/** One surface-node segment: text preview first, then the tool name, then the call names. */
function nodeSegment(node: SurfaceNode): TreemapSegment {
  const label = nodeLabel(node)
  const preview = node.text !== undefined && node.text !== ''
    ? capRunes(node.text, SEGMENT_PREVIEW_MAX_RUNES)
    : label
  return {
    kind: 'node',
    tokens: node.tokens,
    label,
    preview,
    cat: node.cat,
  }
}

/** The in-rectangle label of a surface node. */
function nodeLabel(node: SurfaceNode): string {
  if (node.text !== undefined && node.text !== '') return capRunes(node.text, SEGMENT_LABEL_MAX_RUNES)
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
 * header (title, model, totals), the squarified rectangles (label + token
 * count inside, full preview on hover, CSS hides labels too small to read),
 * and the legend/footer with the six-bucket figures and coverage notes.
 *
 * @param args - Session title/model, the projection snapshot, and the
 *   generation time.
 * @returns The complete HTML document.
 */
export function renderTreemapHTML(args: TreemapHTMLArgs): string {
  const segments = treemapSegments(args.snapshot)
  const rects = squarify(segments.map(segment => segment.tokens), { x: 0, y: 0, w: TREEMAP_CANVAS.w, h: TREEMAP_CANVAS.h })
  const total = args.snapshot.timeline?.current.total ?? segments.reduce((sum, s) => sum + s.tokens, 0)
  const cells = segments.map((segment, i) => {
    const rect = rects[i]
    if (rect === undefined) return ''
    const bare = rect.w < LABEL_MIN_W || rect.h < LABEL_MIN_H ? ' bare' : ''
    return `      <div class="seg${bare}" style="left:${round1(rect.x)}px;top:${round1(rect.y)}px;width:${round1(rect.w)}px;height:${round1(rect.h)}px;background:${segmentColor(segment)}" title="${escapeHtml(segment.preview)}">
        <span class="label">${escapeHtml(segment.label)}</span>
        <span class="tokens">${formatTokens(segment.tokens)}</span>
      </div>`
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
.seg { position: absolute; box-sizing: border-box; overflow: hidden; padding: 4px; border: 1px solid rgba(255,255,255,.6); color: #fff; }
.seg:hover { outline: 2px solid #0f172a; z-index: 1; }
.label { display: block; font-size: 12px; line-height: 1.35; max-height: 3.9em; overflow: hidden; word-break: break-all; }
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
${cells}
  </main>
<footer>
    <div class="legend">${legend(args.snapshot)}</div>
    <p class="note">token 数为启发式估算；矩形面积 ∝ token 数，阅读顺序 ≈ 上下文装配顺序（系统提示词 → 工具定义 → 历史消息）。悬停可看该部分的开头文本。</p>
${droppedNote(args.snapshot)}
  </footer>
</body>
</html>
`
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
