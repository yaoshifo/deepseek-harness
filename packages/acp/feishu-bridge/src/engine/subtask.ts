/**
 * Subtask gather barrier ported from cc-connect core/engine_subtask.go's
 * subtaskGather type, plus the small pure helpers the engine's subtask
 * methods share. The Engine methods (SpawnSubtask, ReportSubtask, …) live in
 * engine.ts the way Go keeps methods on *Engine.
 *
 * Concurrency mapping (plan D7): Go's per-gather mutex collapses into the
 * single-threaded JS turn — accumulate/timeoutFire never interleave, so the
 * one-shot woken guard is an ordinary field.
 *
 * @module dsh-feishu-bridge/subtask
 */

import type { Session } from './session.ts'

/** Result of recording one child report into the barrier (Go accumulate's three returns). */
export interface GatherAccumulateResult {
  /** True when this call completed the barrier — the caller owns the wake. */
  done: boolean
  /** The full summary text; set only when done. */
  summary: string
  /** True when the barrier already woke — the caller falls through to a normal wake. */
  alreadyWoken: boolean
}

/** Result of the timeout firing (Go timeoutFire's two returns). */
export interface GatherTimeoutResult {
  done: boolean
  summary: string
}

/**
 * In-memory fan-in barrier for a parallel subtask gather: the parent agent
 * calls gather after spawning N children, and the engine accumulates their
 * reports, waking the parent EXACTLY ONCE — when all expected children have
 * reported or the timeout fires. Held on the parent Session as
 * pendingSubtaskGather; not persisted (Go subtaskGather).
 *
 * Identity: keyed by child session key (unique), not display label — two
 * children may share a group name but must not collapse in the barrier.
 */
export class SubtaskGather {
  /** Child session keys still expected to report. */
  readonly expected: Map<string, boolean> = new Map<string, boolean>()
  /** Child key → trimmed result. */
  readonly collected: Map<string, string> = new Map<string, string>()
  /** Child key → display label (for the summary). */
  readonly labels: Map<string, string> = new Map<string, string>()
  /** Fallback wake; stopped on early completion (Go timer). */
  timer: ReturnType<typeof setTimeout> | undefined
  /** One-shot: at most one wake. */
  private woken = false

  /**
   * Record a child's report (Go accumulate). A child not in Expected
   * (spawned after gather) is still recorded in Collected so its result
   * appears in the summary, but does not decrement the countdown. An
   * empty/silent report still counts as "reported".
   *
   * @param childKey - The reporting child's session key.
   * @param childLabel - The reporting child's display label; empty keeps any existing label.
   * @param reply - The child's trimmed result text.
   * @returns Whether this call completed the barrier, the summary when done, and whether the barrier already woke.
   */
  accumulate(childKey: string, childLabel: string, reply: string): GatherAccumulateResult {
    if (this.woken) return { done: false, summary: '', alreadyWoken: true }
    if (childLabel !== '') this.labels.set(childKey, childLabel)
    this.collected.set(childKey, reply)
    this.expected.delete(childKey)
    if (this.expected.size > 0) return { done: false, summary: '', alreadyWoken: false }
    this.woken = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    return { done: true, summary: this.summaryLocked(), alreadyWoken: false }
  }

  /**
   * Fold a child spawned after the barrier armed into Expected (Go
   * addExpected). Returns false when the barrier already woke — the caller
   * handles that child via the normal single wake path. The timer is not
   * reset: late children share the original timeout window so continuous
   * spawning cannot defer the deadline forever.
   *
   * @param childKey - The late-spawned child's session key.
   * @param label - The child's display label for the summary.
   * @returns True when the child was folded into the expected set; false when the barrier already woke.
   */
  addExpected(childKey: string, label: string): boolean {
    if (this.woken) return false
    this.expected.set(childKey, true)
    this.labels.set(childKey, label)
    return true
  }

  /**
   * The timeout firing (Go timeoutFire). If all reports arrived first the
   * barrier already woke — returns done=false. Missing children are listed
   * by label in the summary's preamble.
   *
   * @returns Whether this timeout actually woke the barrier, and the summary to wake with.
   */
  timeoutFire(): GatherTimeoutResult {
    if (this.woken) return { done: false, summary: '' }
    this.woken = true
    let summary = this.summaryLocked()
    const missing = [...this.expected.keys()]
    if (missing.length > 0) {
      const names = missing.map(n => this.labels.get(n) ?? '').sort()
      summary = `（${missing.length} 个子任务超时未回报：${names.join(', ')}；按已收到的继续。）\n\n${summary}`
    }
    return { done: true, summary }
  }

  /** Build the wake message: each child's report, label-tagged (Go summaryLocked). */
  private summaryLocked(): string {
    let sb = '[子任务汇总] 以下为各子任务回报结果，请综合后统一回复：\n\n'
    const keys = [...this.collected.keys()].sort()
    for (const k of keys) {
      const label = this.labels.get(k) ?? k
      const r = this.collected.get(k) ?? ''
      sb += `【${label}】${r === '' ? '（无内容 / NO_REPLY）' : r}\n\n`
    }
    return sb
  }
}

/**
 * Short attribution label for a spawned child session (Go childLabel).
 *
 * @param s - The child session to label.
 * @returns The session's trimmed name, falling back to its id when unnamed.
 */
export function childLabel(s: Session): string {
  const name = s.getName().trim()
  if (name !== '') return name
  return s.id
}

/**
 * Whitelist an extracted error field may carry: ASCII identifier characters
 * only and at most 32 runes, so a provider-controlled value can smuggle no
 * prose into the brief (2026-09-09/10 Zhipu 1301 cascade: provider error
 * wording re-entering a parent agent's context tripped the same moderation
 * block on the parent's next request).
 */
const EXTRACT_FIELD_RE = /^[A-Za-z0-9_.-]{1,32}$/

/** Operator advice per known error code; unknown codes fall to the generic line. */
const FAILURE_ADVICE: Readonly<Record<string, string>> = {
  '1301': '内容拦截：重试大概率再触发，建议调整任务或换模型路由',
  '429': '限流：建议稍候重试',
  '401': '认证失败：重试无意义，建议报告用户检查密钥配置',
  '403': '授权不足：重试无意义，建议报告用户检查权限',
}

/** Trailing Zhipu-style request-id bracket segment, e.g. [202609100805161ffc25f1025c4f2a]. */
const REQUEST_ID_TAIL_RE = /\[(2026[0-9]{10,}[0-9a-f]+)\][^0-9a-zA-Z]*$/

/**
 * Fixed-template failure brief for messages that inject a failed subtask or
 * role turn into another agent's context. The error's original text and the
 * turn's partial streamed output never ride along: any detection of which
 * errors are "dangerous" is itself a guess about provider output, so the
 * only discriminator is the structural fact that the turn errored. Dynamic
 * content is limited to regex-extracted, whitelist-validated code and
 * request id plus a per-code advice line from our own table. Zero throw
 * paths: pure string scanning, no JSON.parse.
 *
 * @param errorText - The errored turn's raw error text (any shape).
 * @returns The brief to inject in place of the raw error text.
 */
export function failureBriefForAgentContext(errorText: string): string {
  let code = ''
  const codeField = /"code":"([^"]*)"/.exec(errorText)
  if (codeField !== null) code = codeField[1] ?? ''
  if (code === '') {
    const codePrefix = /^\[(\d{1,8})\]/.exec(errorText)
    if (codePrefix !== null) code = codePrefix[1] ?? ''
  }
  let requestId = ''
  const ridField = /"request_id":"([0-9a-zA-Z]{8,64})"/.exec(errorText)
  if (ridField !== null) requestId = ridField[1] ?? ''
  if (requestId === '') {
    const ridTail = REQUEST_ID_TAIL_RE.exec(errorText)
    if (ridTail !== null) requestId = ridTail[1] ?? ''
  }
  const advice = FAILURE_ADVICE[code] ?? (code.startsWith('5') && code.length === 3
    ? '平台故障：可稍后重试'
    : '未识别错误：详情见子会话日志判断可否重试')
  const codePart = code !== '' && EXTRACT_FIELD_RE.test(code) ? `code=${code}` : 'code=未分类'
  const idPart = requestId !== '' && /^[0-9a-zA-Z]{8,64}$/.test(requestId) ? `；请求 ID：${requestId}` : ''
  return `[failure ${codePart}] 子任务回合中断（${advice}）。错误原文与半截输出未随附（防下游连锁误判），完整原文见父群汇报卡片与子会话日志；可用 feishu_bridge_subtask（action: send）追问该子任务获取进展${idPart}。`
}
