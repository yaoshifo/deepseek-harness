/**
 * Feishu API retry plumbing ported from cc-connect platform/feishu/feishu.go
 * (isTransientError / withTransientRetry / isTenantAccessTokenInvalid /
 * patchRateWait's rate.Limiter): exponential backoff with jitter on transient
 * network symptoms, a token-bucket limiter for card PATCHes, and the stale
 * tenant-token detection that triggers one fresh-token retry.
 *
 * Go's typed syscall/net error checks collapse into the same message
 * substrings (Node surfaces transport errors as message text); the
 * per-attempt context deadline becomes a rejecting race labelled "context
 * deadline exceeded" so a stuck call cannot hang the turn.
 *
 * @module dsh-feishu-bridge/feishu-retry
 */

/** Mutable retry timing so tests can shrink the windows (Go vars). */
export const retryTiming = {
  initialDelay: 500,
  maxDelay: 5000,
  maxRetries: 3,
  /** Per-attempt deadline (Go feishuRequestTimeout). */
  requestTimeout: 30_000,
}

/** Feishu's "invalid tenant access token" business code. */
const tenantTokenInvalidCode = '99991663'

/**
 * Render an unknown error as display text (Go err.Error()).
 * @param err - The thrown value.
 * @returns The error's message text.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Whether an error indicates the cached tenant access token went stale.
 * @param err - The thrown value.
 * @returns True when the business code is the invalid-token code (SDK verbs
 *   carry it in the AxiosError body, text errors as `code=NNNNNN`) or the
 *   error text carries the invalid-token wording.
 */
export function isTenantAccessTokenInvalid(err: unknown): boolean {
  if (err === undefined || err === null) return false
  if (feishuBusinessCode(err) === tenantTokenInvalidCode) return true
  return errorMessage(err).toLowerCase().includes('invalid access token')
}

/** Transient network symptoms that warrant a retry. */
const transientSubstrings = [
  'connection reset by peer',
  'broken pipe',
  'i/o timeout',
  'tls handshake timeout',
  'server misbehaving',
  'connection refused',
  // Attempt-deadline races surface as this text and stay retryable: a fresh
  // attempt may pick a healthy connection.
  'context deadline exceeded',
  // Feishu transient backend blip (HTTP 200, business code) — a short
  // backoff retry succeeds; without this the streaming card degrades
  // permanently on a single blip.
  'service unavailable',
  // Node fetch/undici abort wording for the per-attempt timeout race.
  'this operation was aborted',
  'fetch failed',
  // EOF family (Go matched io.EOF / ErrUnexpectedEOF by type): the server
  // closed the connection mid-response.
  'unexpected eof',
]

/** Feishu business code for "update the single messages too frequently" (per-message 5 QPS PATCH limit). */
export const feishuPatchRateLimitCode = '230020'

/**
 * Extract Feishu's business error code regardless of error shape.
 * @larksuiteoapi/node-sdk surfaces API failures as AxiosErrors whose message
 * is only "Request failed with status code NNN" and whose business code rides
 * in `response.data.code`; text-shaped errors embed it as `code=NNNNNN`.
 * @param err - The thrown value.
 * @returns The business code as text, or undefined when none is present.
 */
export function feishuBusinessCode(err: unknown): string | undefined {
  if (err === undefined || err === null) return undefined
  const bodyCode = (err as { response?: { data?: { code?: unknown } } }).response?.data?.code
  if (typeof bodyCode === 'string' && bodyCode !== '') return bodyCode
  if (typeof bodyCode === 'number') return String(bodyCode)
  return /\bcode=(\d+)\b/.exec(errorMessage(err))?.[1]
}

/**
 * Whether the error is transient and should be retried with backoff.
 * @param err - The thrown value.
 * @returns True when the business code is the PATCH rate limit or the error
 * text matches a transient network symptom.
 */
export function isTransientError(err: unknown): boolean {
  if (err === undefined || err === null) return false
  // Feishu PATCH rate limit clears in seconds; classify it before the
  // message scan because the AxiosError shape carries it only in the body.
  if (feishuBusinessCode(err) === feishuPatchRateLimitCode) return true
  const msg = errorMessage(err).toLowerCase()
  return transientSubstrings.some(sub => msg.includes(sub))
}

/** Reject after ms with a "context deadline exceeded"-labelled error. */
function deadline(ms: number): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error('context deadline exceeded')) }, ms)
  })
  return { promise, cancel: () => { if (timer !== undefined) clearTimeout(timer) } }
}

/**
 * Run fn with exponential-backoff retry on transient errors (jitter up to
 * +25% of the delay to avoid thundering-herd retries). Non-transient errors
 * return immediately; the per-attempt deadline bounds each call.
 * @param operation - Operation label used in retry warnings and error messages.
 * @param fn - The API call to attempt.
 * @param signal - Aborts the retry loop between attempts.
 * @returns The value resolved by fn on success.
 */
export async function withTransientRetry<T>(
  operation: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let lastErr: unknown
  let delay = retryTiming.initialDelay
  for (let attempt = 0; attempt <= retryTiming.maxRetries; attempt++) {
    // Per-attempt deadline: a stuck call cannot hang the whole turn.
    const d = deadline(retryTiming.requestTimeout)
    try {
      const result = await Promise.race([fn(), d.promise])
      d.cancel()
      return result
    } catch (error) {
      d.cancel()
      lastErr = error
    }
    if (!isTransientError(lastErr)) {
      throw lastErr
    }
    if (attempt === retryTiming.maxRetries) break
    if (signal?.aborted === true) {
      throw new Error(`${operation} retry cancelled: ${String(signal.reason ?? 'aborted')} (last error: ${String(lastErr)})`)
    }
    // Jitter: up to +25% of the delay to spread concurrent retries.
    const jitter = Math.floor(Math.random() * Math.floor(delay / 4))
    const actualDelay = delay + jitter
    console.warn(`feishu: transient error, retrying ${operation} (attempt ${attempt + 1}/${retryTiming.maxRetries}, delay ${actualDelay}ms): ${String(lastErr)}`)
    await new Promise<void>((resolve) => { setTimeout(resolve, actualDelay) })
    delay = Math.min(delay * 2, retryTiming.maxDelay)
  }
  // Rethrow the original error, not a wrapper: wrapping drops
  // response.data.code, so downstream business-code classifiers (streaming
  // PATCH fallback) would misread an exhausted rate limit as permanent.
  throw lastErr
}

/**
 * Token-bucket rate limiter (Go rate.NewLimiter(rate.Every(interval), burst)):
 * burst calls pass immediately, further calls block until a token refills at
 * one per interval.
 */
export class TokenBucketRateLimiter {
  private readonly intervalMs: number
  private readonly burst: number
  private tokens: number
  private lastRefill: number

  constructor(intervalMs: number, burst: number) {
    this.intervalMs = intervalMs
    this.burst = burst
    this.tokens = burst
    this.lastRefill = Date.now()
  }

  /**
   * Wait until one token is available.
   * @param signal - Rejects the wait when aborted.
   */
  wait(signal?: AbortSignal): Promise<void> {
    if (signal === undefined) return this.waitForToken()
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => { reject(new Error('rate limiter wait aborted')) }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waitForToken().then(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, () => {
        signal.removeEventListener('abort', onAbort)
        reject(new Error('rate limiter wait failed'))
      })
    })
  }

  private waitForToken(): Promise<void> {
    return new Promise<void>((resolve) => {
      const step = (): void => {
        const now = Date.now()
        const elapsed = now - this.lastRefill
        if (elapsed > 0) {
          this.tokens = Math.min(this.burst, this.tokens + elapsed / this.intervalMs)
          this.lastRefill = now
        }
        if (this.tokens >= 1) {
          this.tokens -= 1
          resolve()
          return
        }
        const needMs = Math.ceil((1 - this.tokens) * this.intervalMs)
        setTimeout(step, Math.max(needMs, 1))
      }
      step()
    })
  }
}
