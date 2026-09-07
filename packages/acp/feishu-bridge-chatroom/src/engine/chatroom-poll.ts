/**
 * The chatroom lightning-round barrier: every configured persona gets one
 * cheap single-turn statement (no resident agent, no group) so each role
 * participates in every discussion while only the core cast keeps full
 * agent sessions. Pure in-memory state — the one-shot queries the barrier
 * tracks live in engine memory and cannot survive a restart, so the barrier
 * does not persist either.
 *
 * @module dsh-feishu-bridge/chatroom-poll
 */

/** Which discussion phase a poll round serves. */
export type ChatroomPollRound = 'opening' | 'closing'

/** The in-memory lightning-round barrier state. */
export class ChatroomPoll {
  /** The statement brief the moderator broadcast to every polled role. */
  readonly question: string
  /** Which discussion phase this round serves. */
  readonly round: ChatroomPollRound
  /** Role names whose statements are still awaited. */
  readonly expected = new Set<string>()
  /** Role name → statement text, filled in as one-shot queries resolve. */
  readonly collected = new Map<string, string>()
  private woken = false

  constructor(question: string, round: ChatroomPollRound) {
    this.question = question
    this.round = round
  }

  /**
   * Record a role's statement. done=true means this call completed the
   * barrier (or the timeout already did) — the caller owns the wake and
   * MUST deliver wakeContent to the moderator.
   *
   * @param roleName - The role whose statement is recorded.
   * @param statement - The role's statement text; empty counts as replied.
   * @returns done=true when this call completed the barrier (caller owns
   * the wake and must deliver wakeContent); otherwise done=false.
   */
  accumulate(roleName: string, statement: string): { done: boolean; wakeContent: string } {
    if (this.woken) return { done: false, wakeContent: '' }
    this.collected.set(roleName, statement)
    this.expected.delete(roleName)
    if (this.expected.size > 0) return { done: false, wakeContent: '' }
    this.woken = true
    return { done: true, wakeContent: this.summary() }
  }

  /**
   * Drop a role whose one-shot query failed — no statement can arrive for
   * it, so an empty expected set must complete the barrier here instead of
   * idling to the fallback timeout. The failure is visible in the summary.
   *
   * @param roleName - The role whose query rejected.
   * @returns done=true when this call completed the barrier; otherwise false.
   */
  fail(roleName: string): { done: boolean; wakeContent: string } {
    return this.accumulate(roleName, '（快答失败）')
  }

  /**
   * Timer-side completion; done=false when statements already completed the
   * barrier. Unlike the gather barrier there is no re-arm window: a poll is
   * a short single-turn round, so the still-missing roles degrade to an
   * explicit （未表态） annotation and the closing round remains as the
   * second chance.
   *
   * @returns done=true when the timeout owns the wake, with the summary
   * wake text and the sorted names of roles that never replied.
   */
  timeoutFire(): { done: boolean; wake: string; missing: string[] } {
    if (this.woken) return { done: false, wake: '', missing: [] }
    this.woken = true
    return { done: true, wake: this.summary(), missing: [...this.expected].sort() }
  }

  /**
   * The wake summary: every statement tagged with its role, absent roles
   * annotated so the moderator sees who never replied.
   *
   * @returns the wake text delivered to the moderator.
   */
  summary(): string {
    const header = this.round === 'opening' ? '全员快答完成' : '补盲快答完成'
    const names = [...this.collected.keys(), ...this.expected].sort()
    const body = names.map((n) => {
      const text = this.collected.get(n)
      return `【${n}】${text === undefined || text === '' ? '（未表态）' : text}`
    })
    return `${header}（${this.collected.size}/${names.length}）：\n${body.join('\n')}`
  }
}
