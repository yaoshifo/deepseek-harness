/**
 * Per-key sliding-window rate limiter, ported from cc-connect
 * core/ratelimit.go.
 *
 * Go→TS mapping (MIGRATION.md D7): sync.Mutex is unnecessary (single-threaded
 * event loop, synchronous allow()); the cleanup goroutine + time.Ticker +
 * stopCh channel become one unref'd setInterval cleared by stop(). unref
 * mirrors the Go goroutine not holding the process open.
 *
 * @module dsh-feishu-bridge/ratelimit
 */

const CLEANUP_INTERVAL_MS = 5 * 60_000

interface RateBucket {
  timestamps: number[]
  lastAccess: number
}

/**
 * Tracks message timestamps per key and rejects requests exceeding the
 * configured limit within the sliding window.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, RateBucket>()
  private readonly maxMessages: number
  private readonly windowMs: number
  private cleanupTimer: ReturnType<typeof setInterval> | undefined

  /**
   * Create a limiter allowing `maxMessages` per `windowMs` milliseconds.
   * Pass maxMessages=0 to disable rate limiting.
   * @param maxMessages - Maximum messages per window; 0 disables limiting.
   * @param windowMs - Sliding window length in milliseconds.
   */
  constructor(maxMessages: number, windowMs: number) {
    this.maxMessages = maxMessages
    this.windowMs = windowMs
    if (maxMessages > 0) {
      this.cleanupTimer = setInterval(() => { this.cleanup() }, CLEANUP_INTERVAL_MS)
      this.cleanupTimer.unref()
    }
  }

  /** Terminate the background cleanup timer. Safe to call multiple times and on a disabled limiter. */
  stop(): void {
    // Mirrors the Go idempotent close(stopCh) guarded by select/default.
    if (this.cleanupTimer !== undefined) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = undefined
    }
  }

  /**
   * Check whether a message from the given key is within the rate limit.
   * @param key - Caller identity (user/chat id).
   * @returns True when allowed (timestamp recorded), false when rate-limited.
   */
  allow(key: string): boolean {
    if (this.maxMessages <= 0) {
      return true
    }

    const now = Date.now()
    let b = this.buckets.get(key)
    if (b === undefined) {
      b = { timestamps: [], lastAccess: 0 }
      this.buckets.set(key, b)
    }
    b.lastAccess = now

    const cutoff = now - this.windowMs
    b.timestamps = b.timestamps.filter(ts => ts > cutoff)

    if (b.timestamps.length >= this.maxMessages) {
      return false
    }
    b.timestamps.push(now)
    return true
  }

  /** Drop buckets untouched for longer than twice the window. */
  private cleanup(): void {
    const now = Date.now()
    const staleThreshold = this.windowMs * 2
    for (const [k, b] of this.buckets) {
      if (now - b.lastAccess > staleThreshold) {
        this.buckets.delete(k)
      }
    }
  }
}
