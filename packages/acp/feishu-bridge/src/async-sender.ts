/**
 * Async sender ported from cc-connect core/async_sender.go: serializes
 * platform API calls onto a background consumer (here: a promise-chain drain
 * loop) so the event loop never blocks on a slow Feishu PATCH/Send.
 * Coalescable snapshots queued behind a newer one are skipped.
 *
 * @module dsh-feishu-bridge/async-sender
 */

/** Bounded queue depth (Go asyncSendBufSize). */
const asyncSendBufSize = 256

interface SendRequest {
  /** Operation to execute; absent on barrier no-ops. */
  fn?: () => void | Promise<void>
  /** Resolved when fn returns (barrier). */
  done?: () => void
  /** True ⇒ idempotent full-state snapshot; stale copies queued behind it are skipped. */
  coalescable?: boolean
}

/**
 * Serializes platform API calls onto a single background drain loop; a full
 * queue drops (or inlines) requests instead of blocking the caller.
 */
export class AsyncSender {
  private readonly name: string
  private queue: SendRequest[] = []
  private closed = false
  private draining = false
  private halfWarned = false

  constructor(name: string) {
    this.name = name
  }

  /** Run one request and signal any waiting barrier. */
  private async exec(req: SendRequest): Promise<void> {
    try {
      if (req.fn !== undefined) await req.fn()
    } catch (error) {
      console.error(`async sender ${this.name}: queued fn failed: ${String(error)}`)
    }
    req.done?.()
  }

  /**
   * Consumer loop: before executing a coalescable snapshot (that is not a
   * barrier), drain newer coalescable requests and keep only the last —
   * an ordered request or barrier cuts the run so ordering and barrier
   * completion are preserved. (Go's >50ms debug timing log was not ported.)
   */
  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (!this.closed) {
        let req = this.queue.shift()
        if (req === undefined) break
        while (req.coalescable === true && req.done === undefined) {
          const next = this.queue[0]
          if (next === undefined) break
          if (next.coalescable === true && next.done === undefined) {
            // Newer snapshot available — drop the stale one.
            this.queue.shift()
            req = next
            continue
          }
          break
        }
        await this.exec(req)
      }
    } finally {
      this.draining = false
      // A request enqueued while the last exec was still unwinding.
      if (!this.closed && this.queue.length > 0) void this.drain()
    }
  }

  /**
   * Schedule fn on the consumer. A full queue drops the request with a
   * warning; enqueue never blocks the caller.
   *
   * @param fn - Operation to execute on the consumer.
   */
  enqueue(fn: () => void | Promise<void>): void {
    this.checkQueueDepth()
    if (this.closed) return
    if (this.queue.length >= asyncSendBufSize) {
      console.warn(`async sender queue full, dropping send (queue ${asyncSendBufSize})`)
      return
    }
    this.queue.push({ fn })
    void this.drain()
  }

  /**
   * Schedule an idempotent full-state snapshot (e.g. a streaming PATCH);
   * stale copies queued behind a newer coalescable request are skipped,
   * bounding card lag to ~one RTT instead of the full backlog depth.
   *
   * @param fn - Idempotent full-state snapshot to execute on the consumer.
   */
  enqueueCoalescable(fn: () => void | Promise<void>): void {
    this.checkQueueDepth()
    if (this.closed) return
    if (this.queue.length >= asyncSendBufSize) {
      console.warn(`async sender queue full, dropping send (queue ${asyncSendBufSize})`)
      return
    }
    this.queue.push({ fn, coalescable: true })
    void this.drain()
  }

  /**
   * Like {@link enqueue} but executes fn inline when the queue is full.
   *
   * @param fn - Operation to execute; runs inline when the queue is full.
   */
  enqueueOrInline(fn: () => void | Promise<void>): void {
    this.checkQueueDepth()
    if (this.closed) return
    if (this.queue.length >= asyncSendBufSize) {
      console.warn('async sender queue full, executing inline')
      void fn()
      return
    }
    this.queue.push({ fn })
    void this.drain()
  }

  /** Rising-edge half-full warning with quarter-full hysteresis. */
  private checkQueueDepth(): void {
    const qlen = this.queue.length
    if (qlen > asyncSendBufSize / 2) {
      if (!this.halfWarned) {
        this.halfWarned = true
        console.warn(`async sender queue half full (queue ${qlen}, cap ${asyncSendBufSize})`)
      }
    } else if (qlen <= asyncSendBufSize / 4) {
      this.halfWarned = false
    }
  }

  /** Resolve once all previously enqueued operations have completed. */
  barrier(): Promise<void> {
    if (this.closed) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.queue.push({ fn: () => {}, done: resolve })
      void this.drain()
    })
  }

  /** Shut down the consumer; pending items are discarded. */
  close(): void {
    this.closed = true
  }
}

/**
 * Create a running async sender (Go newAsyncSender).
 *
 * @param name - Label used in failure and queue-depth warnings.
 * @returns A sender whose drain loop starts on the first enqueue.
 */
export function newAsyncSender(name: string): AsyncSender {
  return new AsyncSender(name)
}
