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
