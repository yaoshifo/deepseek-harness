/**
 * Message deduplication and process-start gate, ported from cc-connect
 * core/dedup.go. Go→TS mapping: sync.Mutex is unnecessary (single-threaded
 * event loop, synchronous isDuplicate()); time.Time keys become epoch-ms
 * numbers.
 *
 * @module dsh-feishu-bridge/dedup
 */

const DEDUP_TTL_MS = 60_000

/**
 * Process startup time (epoch ms). Platforms discard messages created before
 * it so replayed/unacknowledged messages are not re-processed after a
 * restart.
 */
export const StartTime: number = Date.now()

/**
 * Tracks recently seen message IDs to prevent duplicate processing.
 */
export class MessageDedup {
  private readonly seen = new Map<string, number>()

  /**
   * Record a message id and report whether it was already seen.
   * @param msgID - Platform message id; empty ids never deduplicate.
   * @returns True when `msgID` was seen within the TTL window.
   */
  isDuplicate(msgID: string): boolean {
    if (msgID === '') {
      return false
    }
    const now = Date.now()
    for (const [k, t] of this.seen) {
      if (now - t > DEDUP_TTL_MS) {
        this.seen.delete(k)
      }
    }
    if (this.seen.has(msgID)) {
      return true
    }
    this.seen.set(msgID, now)
    return false
  }
}

/**
 * Whether a message timestamp predates process startup. A 2-second grace
 * period avoids racing messages sent right at startup.
 * @param msgTime - Message creation time in epoch ms.
 * @returns True when the message is older than StartTime minus the grace period.
 */
export function isOldMessage(msgTime: number): boolean {
  return msgTime < StartTime - 2_000
}
