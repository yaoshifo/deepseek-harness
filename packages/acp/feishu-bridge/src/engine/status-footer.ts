/**
 * Status-footer domain ported from cc-connect: the turn-completion footer
 * builders (Go engine_cmd_misc.go buildStatusFooter /
 * buildStatusFooterElements / buildCompletionUsage / setCompletionDurations /
 * setTokenRate / formatGitBranch / formatMemInfo and the token formatters),
 * and the Codex-style reply footer (Go engine_send.go buildReplyFooter and
 * helpers). The engine delegates here so the turn hot path only swaps call
 * sites (MIGRATION.md M7).
 *
 * @module dsh-feishu-bridge/engine-status-footer
 */

import { execFile, execFileSync } from 'node:child_process'
import { statfsSync } from 'node:fs'
import { homedir, totalmem, freemem } from 'node:os'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import type { Agent, AgentSession } from '../core/types.js'
import { asProviderSwitcher } from '../core/types.js'
import type { CardButton, CardElement, CardMarkdown } from '../card.js'
import type { I18n } from '../i18n/index.js'
import { Msg } from '../i18n/index.js'
import type { SyncUsageFetcher, UsageProvider } from './usage.js'
import { buildHintsCommonElements, buildHintsPanelElements } from './hints-panel.js'
import type { HintUsage } from './hint-usage.js'

const execFileP = promisify(execFile)

// ── per-turn completion usage fields (Go engine completionUsage* fields) ───

/** Mutable per-turn display fields consumed by the status footer (Go engine fields). */
export class CompletionUsageFields {
  /** ctx token usage line (📊). */
  ctxMsg: string = ''
  /** cache hit usage line (🍵). */
  hitMsg: string = ''
  /** provider quota summary with the 💰 prefix (⌛ line shows it stripped). */
  providerMsg: string = ''
  /** RAM/disk usage line (💾, Go completionUsageMsg). */
  memMsg: string = ''
  /** agent processing time (header suffix, Go completionAgentDurationMsg). */
  agentDurationMsg: string = ''
  /** token rate, e.g. "142 t/s" (header suffix, Go completionTokenRateMsg). */
  tokenRateMsg: string = ''
}

/** Turn-token accounting passed to {@link buildCompletionUsage}. */
export interface BuildCompletionUsageArgs {
  totalInputTokens: number
  sdkPlausible: boolean
  selfPct: number
  nonCachedDelta: number
  nonCachedCum: number
  cachedDelta: number
  cachedCum: number
  numTurns: number
  compactionCount: number
}

/** Provider with the optional active-detection capability (Go ActiveDetector). */
type MaybeActiveDetector = UsageProvider & {
  isActive?: (workDir: string) => boolean
}

/** Provider with the optional on-demand fetch (Go SyncUsageFetcher). */
type MaybeSyncFetcher = UsageProvider & Partial<SyncUsageFetcher>

/**
 * Build and store the per-turn completion usage fields (Go
 * buildCompletionUsage): ctx/cache lines when the indicator is on, provider
 * quota summaries, and the RAM/disk line.
 *
 * @param fields - Mutable per-turn fields the footer reads; reset and repopulated here.
 * @param showContextIndicator - Whether to render the 📊 ctx and 🍵 cache lines at all.
 * @param usageProviders - Candidate providers; ones whose isActive rejects the work dir are skipped.
 * @param baseWorkDir - Work dir passed to each provider's active detection.
 * @param args - Turn-token accounting for the ctx/cache lines.
 */
export async function buildCompletionUsage(
  fields: CompletionUsageFields,
  showContextIndicator: boolean,
  usageProviders: UsageProvider[],
  baseWorkDir: string,
  args: BuildCompletionUsageArgs,
): Promise<void> {
  fields.ctxMsg = ''
  fields.hitMsg = ''
  fields.agentDurationMsg = ''
  fields.tokenRateMsg = ''

  if (showContextIndicator) {
    if (args.sdkPlausible && args.totalInputTokens > 0) {
      fields.ctxMsg = formatCtxTokensWithTotal(args.nonCachedDelta, args.nonCachedCum, args.numTurns, '')
      fields.hitMsg = formatCacheHitMsg(args.cachedDelta, args.cachedCum, args.compactionCount)
    } else if (args.selfPct > 0) {
      fields.ctxMsg = `ctx: ~${args.selfPct}%`
    }
  }

  const memInfo = formatMemInfo()
  fields.memMsg = memInfo

  const usageParts: string[] = []
  for (const up of usageProviders) {
    const detector = up as MaybeActiveDetector
    if (typeof detector.isActive === 'function' && !detector.isActive(baseWorkDir)) continue
    const fetcher = up as MaybeSyncFetcher
    const s = typeof fetcher.fetchSummary === 'function'
      ? await fetcher.fetchSummary()
      : (up.refresh(), up.summary())
    if (s !== '') usageParts.push(s)
  }
  fields.providerMsg = usageParts.length > 0 ? `💰 ${usageParts.join(' · ')}` : ''
}

/** Record agent processing time for the completion header (Go setCompletionDurations).
 * @param fields - Mutable per-turn fields holding the rendered duration line.
 * @param agentDurationMs - Model-processing wall time; non-positive falls back to the full turn duration.
 * @param turnDurationMs - Full turn wall time, used when the agent duration is unknown.
 */
export function setCompletionDurations(fields: CompletionUsageFields, agentDurationMs: number, turnDurationMs: number): void {
  if (agentDurationMs <= 0) {
    fields.agentDurationMsg = formatTurnDuration(turnDurationMs)
    return
  }
  fields.agentDurationMsg = formatTurnDuration(agentDurationMs)
}

/** Compute and store the per-turn output-token rate (Go setTokenRate).
 * @param fields - Mutable per-turn fields holding the rendered rate line.
 * @param outputTokens - Output tokens produced this turn.
 * @param thinkingTimeMs - Union of the turn's streamed generation spans; 0 for a provider that streamed no deltas omits the rate line.
 */
export function setTokenRate(fields: CompletionUsageFields, outputTokens: number, thinkingTimeMs: number): void {
  fields.tokenRateMsg = tokenRateMessage(outputTokens, thinkingTimeMs)
}

// ── non-model interval union (Go unionDuration) ────────────────────────────

/** A [start, end] wall-clock window in ms (e.g. one streamed generation span). */
export interface Interval {
  start: number
  end: number
}

/**
 * Total wall-clock covered by the union of the given intervals, merging
 * overlaps and adjacencies so parallel tools count once (Go unionDuration).
 *
 * @param intervals - [start, end] windows in milliseconds; order does not matter.
 * @returns Union length in milliseconds; 0 for an empty list.
 */
export function unionDuration(intervals: Interval[]): number {
  const sorted = [...intervals].sort((a, b) => a.start - b.start)
  const first = sorted.shift()
  if (first === undefined) return 0
  let total = 0
  let cur = { ...first }
  for (const it of sorted) {
    if (it.start > cur.end) {
      total += cur.end - cur.start
      cur = { ...it }
      continue
    }
    if (it.end > cur.end) cur.end = it.end
  }
  total += cur.end - cur.start
  return total
}

// ── token / duration formatters ────────────────────────────────────────────

/** Compact token count, e.g. "8.4k" → "84k" style (Go formatTokenK, ceil).
 * @param tokens - Raw token count.
 * @returns The count verbatim below 1000, else thousands rounded up with a "k" suffix.
 */
export function formatTokenK(tokens: number): string {
  if (tokens < 1000) return `${tokens}`
  return `${Math.ceil(tokens / 1000)}k`
}

/** "ctx: +delta=cum · N api [· duration]" (Go formatCtxTokensWithTotal).
 * @param nonCachedDelta - Non-cached input tokens added this turn.
 * @param nonCachedCum - Non-cached input tokens accumulated across turns.
 * @param numTurns - API calls made so far.
 * @param durationStr - Optional duration segment; '' omits the "· duration" part.
 * @returns The formatted ctx line.
 */
export function formatCtxTokensWithTotal(nonCachedDelta: number, nonCachedCum: number, numTurns: number, durationStr: string): string {
  let s = `ctx: +${formatTokenK(nonCachedDelta)}=${formatTokenK(nonCachedCum)} · ${numTurns} api`
  if (durationStr !== '') s += ` · ${durationStr}`
  return s
}

/** "hit: +delta=cum · N zip" (Go formatCacheHitMsg).
 * @param cachedDelta - Cached tokens added this turn.
 * @param cachedCum - Cached tokens accumulated across turns.
 * @param compactionCount - Compactions applied to the session so far.
 * @returns The formatted cache-hit line.
 */
export function formatCacheHitMsg(cachedDelta: number, cachedCum: number, compactionCount: number): string {
  return `hit: +${formatTokenK(cachedDelta)}=${formatTokenK(cachedCum)} · ${compactionCount} zip`
}

/** Whole seconds under a minute, whole minutes above (Go formatTurnDuration).
 * @param ms - Duration in milliseconds; non-positive yields ''.
 * @returns The compact duration string.
 */
export function formatTurnDuration(ms: number): string {
  if (ms <= 0) return ''
  const secs = ms / 1000
  if (secs < 60) return `${Math.floor(secs)}s`
  return `${Math.floor(secs / 60)}m`
}

/** Minimum samples for a trustworthy rate; below these the number is noise. */
const minTokensForRate = 10
const minThinkingForRateMs = 200

/** Formatted output-tokens-per-second string, or '' for a too-small turn (Go tokenRateMessage).
 * @param outputTokens - Output tokens produced this turn; below the minimum sample size the rate is noise.
 * @param thinkingTimeMs - Union of the turn's streamed generation spans.
 * @returns The formatted rate, or '' when either input is below its minimum.
 */
export function tokenRateMessage(outputTokens: number, thinkingTimeMs: number): string {
  if (outputTokens < minTokensForRate || thinkingTimeMs < minThinkingForRateMs) return ''
  return formatTokenRate(outputTokens / (thinkingTimeMs / 1000))
}

/** Format a tokens-per-second rate (Go formatTokenRate).
 * @param tokensPerSec - Rate to render.
 * @returns The rate with a " t/s" suffix; precision scales with magnitude.
 */
export function formatTokenRate(tokensPerSec: number): string {
  if (tokensPerSec >= 1000) return `${(tokensPerSec / 1000).toFixed(1)}k t/s`
  if (tokensPerSec >= 10) return `${Math.round(tokensPerSec)} t/s`
  return `${tokensPerSec.toFixed(1)} t/s`
}

// ── self-reported context indicator ────────────────────────────────────────

const ctxSelfReportRe = /\n?\[ctx: ~\d+%\]/g

/** Extract the percentage from a self-reported "[ctx: ~XX%]" line (Go parseSelfReportedCtx).
 * @param s - Reply text possibly containing a self-reported ctx line.
 * @returns The reported percentage, or 0 when absent.
 */
export function parseSelfReportedCtx(s: string): number {
  const m = /\[ctx: ~(\d+)%\]/.exec(s)
  return m === null ? 0 : Number.parseInt(m[1] ?? '0', 10)
}

/** Remove self-reported "[ctx: ~N%]" lines from a reply (Go ctxSelfReportRe.ReplaceAllString).
 * @param s - Reply text possibly containing self-reported ctx lines.
 * @returns The reply with those lines removed.
 */
export function stripCtxSelfReport(s: string): string {
  return s.replace(ctxSelfReportRe, '')
}

// ── RAM / disk / git ───────────────────────────────────────────────────────

/**
 * Parse `memory_pressure -Q` output for its "System-wide memory free
 * percentage: N%" line (Go-free darwin counterpart to reading /proc/meminfo).
 *
 * @param out - Full stdout of `memory_pressure -Q`.
 * @returns The free-memory percentage, or null when the line is absent.
 */
export function parseMemoryPressureFreePct(out: string): number | null {
  const m = /System-wide memory free percentage:\s*(\d+)/.exec(out)
  return m === null ? null : Number.parseInt(m[1] ?? '0', 10)
}

/**
 * System RAM used percentage on darwin via `memory_pressure -Q`.
 *
 * @returns The used percentage, or null when the binary is missing or its
 *   output is unparseable, leaving the caller on the `total - freemem` path.
 */
function darwinMemUsedPct(): number | null {
  try {
    const out = execFileSync('memory_pressure', ['-Q'], { encoding: 'utf8' })
    const freePct = parseMemoryPressureFreePct(out)
    return freePct === null ? null : 100 - freePct
  } catch {
    // memory_pressure missing or failed; the caller falls back to totalmem/freemem.
    return null
  }
}

/**
 * "RAM: N%[❗] · Disk: M%[❗]" (Go formatMemInfo). Go read /proc/meminfo and
 * therefore showed no RAM line on macOS; here the RAM segment stays
 * cross-platform — a deliberate divergence so the current macOS deployment
 * still gets the 💾 line. On darwin the used percentage comes from
 * `memory_pressure -Q`: `os.freemem()` there counts only truly free pages,
 * excluding reclaimable inactive/speculative/purgeable/compressed pages that
 * macOS deliberately keeps cached, so `total - freemem` sits near 100% and the
 * ❗ warning never clears.
 *
 * @returns The usage line, with segments joined by " · "; '' when neither is available.
 */
export function formatMemInfo(): string {
  const total = totalmem()
  const parts: string[] = []
  if (total > 0) {
    const usedPct = process.platform === 'darwin' ? darwinMemUsedPct() : null
    const pct = usedPct ?? Math.floor(((total - freemem()) * 100) / total)
    parts.push(`RAM: ${pct}%${pct > 85 ? '❗' : ''}`)
  }
  try {
    const st = statfsSync('/')
    const totalBytes = st.blocks * st.bsize
    const availBytes = st.bavail * st.bsize
    if (totalBytes > 0) {
      const usedPct = Math.floor(((totalBytes - availBytes) * 100) / totalBytes)
      parts.push(`Disk: ${usedPct}%${usedPct > 90 ? '❗' : ''}`)
    }
  } catch {
    // statfs is best-effort; the RAM segment still renders.
  }
  return parts.join(' · ')
}

/** How long a (dir → branch/files) result is reused (Go gitBranchCacheTTL). */
export const gitBranchCacheTTLms = 3000

/** TTL cache so back-to-back completions don't spawn git twice per turn (Go gitBranchCache). */
export const gitBranchCache = new Map<string, { line: string; files: string[]; at: number }>()

/**
 * Branch line + uncommitted file list for the notification footer (Go
 * formatGitBranch): "🌿 <branch>" clean, "🌿 <branch>(N uncommitted)" dirty,
 * or an empty line outside a repo.
 *
 * @param dir - Repository directory; '' yields an empty result.
 * @returns The branch line and uncommitted file basenames, cached per dir for the TTL.
 */
export async function formatGitBranch(dir: string): Promise<{ line: string; files: string[] }> {
  if (dir === '') return { line: '', files: [] }
  const cached = gitBranchCache.get(dir)
  if (cached !== undefined && Date.now() - cached.at < gitBranchCacheTTLms) {
    return { line: cached.line, files: cached.files }
  }
  const result = await formatGitBranchUncached(dir)
  if (result.line !== '') {
    gitBranchCache.set(dir, { ...result, at: Date.now() })
  }
  return result
}

async function formatGitBranchUncached(dir: string): Promise<{ line: string; files: string[] }> {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, timeout: 2000 })
    const branchName = stdout.trim()
    let statusOut: string
    try {
      statusOut = (await execFileP('git', ['status', '--porcelain'], { cwd: dir, timeout: 2000 })).stdout
    } catch {
      return { line: `🌿 ${branchName}`, files: [] }
    }
    let lines = 0
    const files: string[] = []
    for (const l of statusOut.split('\n')) {
      const trimmed = l.replace(/[ \t\r]+$/, '')
      if (trimmed === '') continue
      lines++
      // porcelain: "XY filename" or "XY old -> new"
      if (trimmed.length > 3) {
        let name = trimmed.slice(3)
        const idx = name.indexOf(' -> ')
        if (idx >= 0) name = name.slice(idx + 4)
        files.push(basename(name))
      }
    }
    if (lines === 0) return { line: `🌿 ${branchName}`, files: [] }
    return { line: `🌿 ${branchName}(${lines} uncommitted)`, files }
  } catch {
    return { line: '', files: [] }
  }
}

// ── model / mode labels ────────────────────────────────────────────────────

/** Short display label for the current permission mode (Go formatModeLabel).
 * @param agent - Agent to probe for its mode; undefined or default mode yields ''.
 * @returns The compact mode label (e.g. "YOLO", "plan"), '' when unset.
 */
export function formatModeLabel(agent: Agent | undefined): string {
  const mode = (agent as { getMode?: () => string } | undefined)?.getMode?.() ?? ''
  switch (mode) {
    case 'default': case '': return ''
    case 'bypassPermissions': return 'YOLO'
    case 'plan': return 'plan'
    case 'auto': return 'auto'
    case 'acceptEdits': return 'edits'
    case 'dontAsk': return 'dontAsk'
    default: return mode
  }
}

/**
 * Human-readable model label for the footer (Go currentModelLabel). The TS
 * ProviderSwitcher surface carries only route membership (no model detail),
 * so the ModelSwitcher probe runs first; the switcher's active name is the
 * fallback.
 *
 * @param agent - Agent to probe for its model; undefined yields ''.
 * @returns The model name when known, else the active provider's model or name, else ''.
 */
export function currentModelLabel(agent: Agent | undefined): string {
  const model = (agent as { getModel?: () => string } | undefined)?.getModel?.().trim()
  if (model !== undefined && model !== '') return model
  const active = agent === undefined ? undefined : asProviderSwitcher(agent)?.getActiveProvider()
  if (active === undefined) return ''
  return active.model !== undefined && active.model !== '' ? active.model : active.name
}

/**
 * The "🤖 model[·effort][ · mode]" line shared by both footer builders. The
 * reasoning effort label mirrors the dsh adapter's route-configured
 * `getReasoningEffort` (Go GetReasoningEffort) — the explicit declaration of
 * the effort agents run at; agents without that probe render as before.
 */
function formatModelLine(agent: Agent | undefined): string {
  const modelLabel = currentModelLabel(agent)
  if (modelLabel === '') return ''
  let s = `🤖 ${modelLabel}`
  const effort = (agent as { getReasoningEffort?: () => string } | undefined)?.getReasoningEffort?.().trim() ?? ''
  if (effort !== '') s += `·${effort}`
  const modeLabel = formatModeLabel(agent)
  if (modeLabel !== '') s += ` · ${modeLabel}`
  return s
}

// ── status footer builders ─────────────────────────────────────────────────

/** Inputs the footer builders read (a structural slice of the engine). */
export interface StatusFooterInputs {  fields: CompletionUsageFields
  agent: Agent | undefined
  workspaceDir: string
  agentSessionID: string
  sessionKey: string
  editorUrl: string
  /** Hint groups + click counts; undefined renders no hint panels. */
  hints?: { hints: string[]; hintsWithParam: string[]; hintsCommon: string[]; usage?: HintUsage | undefined }
}

/** channel ID from "platform:channelID:userID" (Go extractChannelID).
 * @param sessionKey - Composite session key.
 * @returns The middle segment, or '' when the key has no channel part.
 */
export function extractChannelID(sessionKey: string): string {
  const parts = sessionKey.split(':', 3)
  return parts.length >= 2 ? (parts[1] ?? '') : ''
}

/** Resolve the footer's work dir: explicit override, else the agent's cwd. */
function footerDir(inputs: StatusFooterInputs): string {
  const dir = inputs.workspaceDir.trim()
  if (dir !== '') return dir
  return (inputs.agent as { getWorkDir?: () => string } | undefined)?.getWorkDir?.().trim() ?? ''
}

/**
 * Plain-text status footer shared by the completion-notification fallback
 * (Go buildStatusFooter). Lines join with a literal backslash-n exactly as
 * Go does, keeping the fallback a single physical line. The prefix parameter
 * mirrors Go's signature but is never rendered there either — Go passes the
 * "✅ 完成" heading yet the body never appends it, so card-less platforms
 * receive only the status lines.
 *
 * @param _prefix - Unused heading kept for signature parity with Go; never rendered.
 * @param inputs - Footer inputs; the fields, agent, and dirs decide which lines appear.
 * @returns The status lines joined by a literal "\n", '' when no line applies.
 */
export async function buildStatusFooter(_prefix: string, inputs: StatusFooterInputs): Promise<string> {
  const lines: string[] = []

  const modelLine = formatModelLine(inputs.agent)
  if (modelLine !== '') lines.push(modelLine)

  if (inputs.fields.ctxMsg !== '') lines.push(`📊 ${inputs.fields.ctxMsg}`)
  if (inputs.fields.hitMsg !== '') lines.push(`🍵 ${inputs.fields.hitMsg}`)

  const dir = footerDir(inputs)
  if (dir !== '') {
    let s = `📂 ${basename(dir)}`
    const { line, files } = await formatGitBranch(dir)
    if (line !== '') {
      s += ` · ${line.slice('🌿 '.length)}`
      if (files.length > 0) lines.push(`📝 ${files.join(', ')}`)
    }
    lines.push(s)
  }

  if (inputs.fields.providerMsg.startsWith('💰 ')) lines.push(`⌛ ${inputs.fields.providerMsg.slice('💰 '.length)}`)
  if (inputs.fields.memMsg !== '') lines.push(`💾 ${inputs.fields.memMsg}`)
  if (inputs.agentSessionID !== '') lines.push(inputs.agentSessionID)

  const chatID = extractChannelID(inputs.sessionKey)
  if (chatID !== '') lines.push(chatID)

  if (inputs.editorUrl !== '' && dir !== '') {
    lines.push(`🔗 ${inputs.editorUrl}/?folder=${dir}`)
  }

  return lines.join('\\n')
}

/**
 * Structured card elements for the purple completion notification (Go
 * buildStatusFooterElements). Header suffix carries workdir/branch +
 * duration + token rate; the collapsible panel folds model/ctx/cache/RAM/
 * session ids, titled by the provider usage line when present. Hints panels
 * (Go buildHintsPanelElements) fold into the collapsible and wrap it in
 * status_footer_form; common hints append as an always-visible form.
 *
 * @param inputs - Footer inputs; the fields, agent, and dirs decide which elements appear.
 * @returns The header suffix plus card elements; both empty when nothing applies.
 */
export async function buildStatusFooterElements(inputs: StatusFooterInputs): Promise<{ headerSuffix: string; elements: CardElement[] }> {
  const visible: CardElement[] = []
  const collapsed: CardElement[] = []
  let headerSuffix = ''

  const dir = footerDir(inputs)
  let uncommittedFiles: string[] = []
  if (dir !== '') {
    let s = basename(dir)
    const { line, files } = await formatGitBranch(dir)
    if (line !== '') {
      s += ` · ${line.slice('🌿 '.length)}`
      uncommittedFiles = files
    }
    headerSuffix = `📁 ${s}`
  }
  if (inputs.fields.agentDurationMsg !== '') {
    headerSuffix = headerSuffix !== '' ? `${headerSuffix} · ${inputs.fields.agentDurationMsg}` : inputs.fields.agentDurationMsg
  }
  if (inputs.fields.tokenRateMsg !== '') {
    headerSuffix = headerSuffix !== '' ? `${headerSuffix} · ${inputs.fields.tokenRateMsg}` : inputs.fields.tokenRateMsg
  }

  const usageCollapsibleTitle = inputs.fields.providerMsg.startsWith('💰 ')
    ? `⌛ ${inputs.fields.providerMsg.slice('💰 '.length)}`
    : ''

  const modelLine = formatModelLine(inputs.agent)
  if (modelLine !== '') {
    if (usageCollapsibleTitle !== '') collapsed.push({ kind: 'markdown', content: modelLine })
  }

  if (inputs.fields.ctxMsg !== '') collapsed.push({ kind: 'markdown', content: `📊 ${inputs.fields.ctxMsg}` })
  if (inputs.fields.hitMsg !== '') collapsed.push({ kind: 'markdown', content: `🍵 ${inputs.fields.hitMsg}` })

  if (inputs.fields.memMsg !== '') {
    // RAM/disk goes visible when it carries the ❗ warning, else folded.
    const el: CardMarkdown = { kind: 'markdown', content: `💾 ${inputs.fields.memMsg}` }
    if (inputs.fields.memMsg.includes('❗')) visible.push(el)
    else collapsed.push(el)
  }

  if (inputs.agentSessionID !== '') collapsed.push({ kind: 'markdown', content: inputs.agentSessionID })
  const chatID = extractChannelID(inputs.sessionKey)
  if (chatID !== '') collapsed.push({ kind: 'markdown', content: chatID })

  if (uncommittedFiles.length > 0) {
    collapsed.push({ kind: 'markdown', content: `📄 ${uncommittedFiles.join(' · ')}` })
  }

  if (inputs.editorUrl !== '' && dir !== '') {
    const btn: CardButton = {
      text: 'Open Editor',
      type: 'default',
      value: '',
      url: `${inputs.editorUrl}/?folder=${dir}`,
    }
    collapsed.push({ kind: 'actions', buttons: [btn], layout: 'row' })
  }

  if (headerSuffix === '' && visible.length === 0 && collapsed.length === 0) {
    return { headerSuffix: '', elements: [] }
  }

  // Hints panels fold into the main collapsible (Go buildHintsPanelElements
  // merge); the form wrapper lets the form_submit buttons submit (schema 2.0
  // forms need a submit descendant, so it only appears with hints).
  const hintPanels = inputs.hints === undefined
    ? []
    : buildHintsPanelElements(inputs.hints.hints, inputs.hints.hintsWithParam, inputs.hints.usage)
  collapsed.push(...hintPanels)

  const result = [...visible]
  if (collapsed.length > 0) {
    const collapsibleTitle = usageCollapsibleTitle !== ''
      ? usageCollapsibleTitle
      : (modelLine !== '' ? modelLine : '▸ 详细信息')
    const panel: CardElement = {
      kind: 'collapsiblePanel',
      expanded: false,
      title: collapsibleTitle,
      elements: collapsed,
    }
    result.push(hintPanels.length > 0
      ? { kind: 'form', name: 'status_footer_form', elements: [panel] }
      : panel)
  }
  if (collapsed.length === 0 && modelLine !== '') {
    result.push({ kind: 'markdown', content: modelLine })
  }
  // Common hints stay always-visible at the card bottom (Go hints_common_form).
  if (inputs.hints !== undefined) {
    const commonElements = buildHintsCommonElements(inputs.hints.hintsCommon, inputs.hints.usage)
    if (commonElements.length > 0) {
      result.push({ kind: 'form', name: 'hints_common_form', elements: commonElements })
    }
  }
  return { headerSuffix, elements: result }
}

// ── Codex-style reply footer (Go engine_send.go) ───────────────────────────

/** Quota window in a UsageReport (Go UsageWindow, subset the footer reads). */
export interface UsageWindow {
  name: string
  usedPercent: number
  windowSeconds: number
  resetAfterSeconds: number
}

/** One bucket of quota windows (Go UsageBucket). */
export interface UsageBucket {
  name: string
  windows: UsageWindow[]
}

/** Agent-level quota report (Go UsageReport, subset the footer reads). */
export interface UsageReport {
  email?: string
  accountID?: string
  userID?: string
  plan?: string
  buckets: UsageBucket[]
}

/** Context-window usage snapshot (Go ContextUsage). */
export interface ContextUsage {
  usedTokens: number
  baselineTokens: number
  totalTokens?: number
  inputTokens?: number
  outputTokens?: number
  contextWindow: number
}

/** AgentSession runtime caps the reply footer probes (Go optional interfaces). */
type FooterCapSession = AgentSession & Partial<{
  getModel(): string
  getReasoningEffort(): string
  getUsage(): Promise<UsageReport | undefined>
  getContextUsage(): ContextUsage | undefined
  getWorkDir(): string
}>

type FooterCapAgent = Agent & Partial<{
  getModel(): string
  getReasoningEffort(): string
  getUsage(): Promise<UsageReport | undefined>
  getWorkDir(): string
}>

/** Cache for the agent-level usage fetch (Go replyFooterUsageCache, 30s TTL). */
export interface ReplyFooterUsageCache {
  text: string
  fetchedAt: number
}

const replyFooterUsageCacheTTLms = 30_000

/** Dependencies buildReplyFooter needs from the engine. */
export interface ReplyFooterDeps {
  i18n: I18n
  cache: ReplyFooterUsageCache
}

/** Session-level model, else the agent's (Go replyFooterModel). */
function replyFooterModel(session: FooterCapSession | undefined, agent: FooterCapAgent | undefined): string {
  const fromSession = session?.getModel?.().trim()
  if (fromSession !== undefined && fromSession !== '') return fromSession
  return agent?.getModel?.().trim() ?? ''
}

/** Session-level reasoning effort, else the agent's (Go replyFooterReasoningEffort). */
function replyFooterReasoningEffort(session: FooterCapSession | undefined, agent: FooterCapAgent | undefined): string {
  const fromSession = session?.getReasoningEffort?.().trim()
  if (fromSession !== undefined && fromSession !== '') return fromSession
  return agent?.getReasoningEffort?.().trim() ?? ''
}

/** "N% left" from a quota report's primary window (Go formatReplyFooterUsage). */
function formatReplyFooterUsage(report: UsageReport | undefined, i18n: I18n): string {
  const window = selectUsageWindows(report)
  if (window === undefined) return ''
  const remaining = Math.min(100, Math.max(0, 100 - window.usedPercent))
  return i18n.tf(Msg.ReplyFooterRemaining, remaining)
}

/** The primary (5h) then weekly windows of the first bucket that has any (Go selectUsageWindows).
 * @param report - Agent-level quota report; undefined yields undefined.
 * @returns The bucket's 5h window, else its weekly window, else its first, else undefined.
 */
export function selectUsageWindows(report: UsageReport | undefined): UsageWindow | undefined {
  if (report === undefined) return undefined
  for (const bucket of report.buckets) {
    if (bucket.windows.length === 0) continue
    let primary: UsageWindow | undefined
    let secondary: UsageWindow | undefined
    for (const w of bucket.windows) {
      if (w.windowSeconds === 18_000) primary = w
      else if (w.windowSeconds === 604_800 && secondary === undefined) secondary = w
    }
    if (primary === undefined && bucket.windows.length > 0) primary = bucket.windows[0]
    if (secondary === undefined && bucket.windows.length > 1) secondary = bucket.windows[1]
    if (primary !== undefined) return primary
  }
  return undefined
}

/**
 * Quota remaining text with the session-level report, else the cached agent
 * report (Go replyFooterUsageText).
 */
async function replyFooterUsageText(
  deps: ReplyFooterDeps,
  session: FooterCapSession | undefined,
  agent: FooterCapAgent | undefined,
): Promise<string> {
  if (typeof session?.getUsage === 'function') {
    const report = await session.getUsage()
    return formatReplyFooterUsage(report, deps.i18n)
  }
  if (typeof agent?.getUsage !== 'function') return ''
  if (deps.cache.fetchedAt !== 0 && Date.now() - deps.cache.fetchedAt < replyFooterUsageCacheTTLms) {
    return deps.cache.text
  }
  let text = ''
  try {
    text = formatReplyFooterUsage(await agent.getUsage(), deps.i18n)
  } catch {
    text = deps.cache.fetchedAt !== 0 ? deps.cache.text : ''
  }
  deps.cache.text = text
  deps.cache.fetchedAt = Date.now()
  return text
}

/** "N% left" from a ContextUsage snapshot (Go replyFooterContextText).
 * @param usage - Context-window snapshot; undefined yields ''.
 * @param i18n - Locale used for the "N% left" phrasing.
 * @returns The remaining percentage line, '' when usage cannot be derived.
 */
export function replyFooterContextText(usage: ContextUsage | undefined, i18n: I18n): string {
  if (usage === undefined || usage.contextWindow <= 0) return ''
  let usedTokens = usage.usedTokens
  if (usedTokens <= 0) {
    if ((usage.totalTokens ?? 0) > 0) usedTokens = usage.totalTokens ?? 0
    else if ((usage.inputTokens ?? 0) > 0 || (usage.outputTokens ?? 0) > 0) {
      usedTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
    } else return ''
  }
  const baseline = Math.max(0, usage.baselineTokens)
  if (usage.contextWindow <= baseline) return i18n.tf(Msg.ReplyFooterRemaining, 0)
  const effectiveWindow = usage.contextWindow - baseline
  const effectiveUsed = Math.max(0, usedTokens - baseline)
  const remaining = Math.max(0, effectiveWindow - effectiveUsed)
  const left = Math.min(100, Math.max(0, Math.round((remaining / effectiveWindow) * 100)))
  return i18n.tf(Msg.ReplyFooterRemaining, left)
}

/** Footer workdir: override, then session, then agent (Go replyFooterWorkDir). */
function replyFooterWorkDir(session: FooterCapSession | undefined, agent: FooterCapAgent | undefined, workspaceDir: string): string {
  let dir = workspaceDir.trim()
  if (dir === '') dir = session?.getWorkDir?.().trim() ?? ''
  if (dir === '') dir = agent?.getWorkDir?.().trim() ?? ''
  return dir === '' ? '' : compactReplyFooterPath(dir)
}

/** ~ for home, else the last two path segments (Go compactReplyFooterPath).
 * @param path - Absolute path to shorten.
 * @returns The display path: '~'-prefixed under home, "…/parent/leaf" elsewhere, '' for blank input.
 */
export function compactReplyFooterPath(path: string): string {
  const trimmed = path.trim()
  if (trimmed === '') return ''
  const home = homedir()
  if (trimmed === home) return '~'
  if (trimmed.startsWith(`${home}/`)) return `~${trimmed.slice(home.length)}`
  if (trimmed.startsWith('/')) {
    const parts = trimmed.replace(/\/+$/, '').split('/').filter(p => p !== '')
    if (parts.length === 0) return '/'
    if (parts.length === 1) return parts[0] ?? ''
    return `…/${parts.slice(-2).join('/')}`
  }
  return trimmed
}

/** Append the footer as an emphasized last line (Go appendReplyFooter).
 * @param content - Reply body; trailing newlines are trimmed before joining.
 * @param footer - Footer text; '' returns the trimmed content unchanged.
 * @returns The reply with the footer in emphasis on a new last line.
 */
export function appendReplyFooter(content: string, footer: string): string {
  if (footer === '') return content
  const trimmed = content.replace(/\n+$/, '')
  if (trimmed === '') return `*${footer}*`
  return `${trimmed}\n\n*${footer}*`
}

/**
 * The Codex-style reply footer (Go buildReplyFooter): "model · effort ·
 * context-left (or quota) · workdir", suppressed when only the workdir is
 * known. The dsh adapter exposes no UsageReporter/ContextUsageReporter, so
 * production footers carry model/effort/workdir; the usage paths stay for
 * agents that grow those caps (recorded in FEATURE-PARITY.md #11).
 *
 * @param deps - Engine dependencies: the i18n locale and the usage-summary cache.
 * @param agent - Agent probed for model/effort/workdir when the session lacks them.
 * @param session - Session whose model/effort/workdir take precedence over the agent's.
 * @param workspaceDir - Explicit workdir override; blank falls back to session then agent.
 * @param contextLeft - Precomputed "N% left" context text; blank triggers the quota fetch.
 * @returns The dot-joined footer parts, '' when no status part is known.
 */
export async function buildReplyFooter(
  deps: ReplyFooterDeps,
  agent: FooterCapAgent | undefined,
  session: FooterCapSession | undefined,
  workspaceDir: string,
  contextLeft: string,
): Promise<string> {
  const parts: string[] = []
  let hasStatus = false
  const model = replyFooterModel(session, agent)
  if (model !== '') {
    parts.push(model)
    hasStatus = true
  }
  const effort = replyFooterReasoningEffort(session, agent)
  if (effort !== '') {
    parts.push(effort)
    hasStatus = true
  }
  const left = contextLeft.trim()
  if (left !== '') {
    parts.push(left)
    hasStatus = true
  } else {
    const usage = await replyFooterUsageText(deps, session, agent)
    if (usage !== '') {
      parts.push(usage)
      hasStatus = true
    }
  }
  const dir = replyFooterWorkDir(session, agent, workspaceDir)
  if (dir !== '') parts.push(dir)
  if (!hasStatus) return ''
  return parts.join(' · ')
}
