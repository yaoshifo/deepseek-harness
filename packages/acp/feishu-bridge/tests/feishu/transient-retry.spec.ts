/**
 * Transient retry tests ported from cc-connect platform/feishu
 * transient_retry_test.go: classification table, retry loop semantics
 * (first-attempt success, retry-then-succeed, non-transient bail,
 * exhaustion, cancellation, per-attempt deadline, backoff timing), and the
 * reply/create/patch wrappers over an injectable client.
 *
 * @module dsh-feishu-bridge/tests-feishu-transient-retry
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FeishuPlatform, type FeishuApiClient } from '../../src/feishu/platform.js'
import { feishuBusinessCode, isTransientError, retryTiming, withTransientRetry } from '../../src/feishu/retry.js'

const err = (msg: string): Error => new Error(msg)

/**
 * @larksuiteoapi/node-sdk failure shape: the SDK rethrows the AxiosError
 * whose message is only the HTTP status text and whose Feishu business code
 * rides in `response.data.code`. Production classifiers must read that field.
 */
const apiErr = (code: number, msg = 'This operation triggers the frequency limit'): Error =>
  Object.assign(new Error('Request failed with status code 400'), { response: { data: { code, msg } } })

const rc = { messageID: 'om_root', chatID: 'oc_chat', sessionKey: 'feishu:oc_chat:ou_u' }

const originalTiming = { ...retryTiming }

beforeEach(() => {
  retryTiming.initialDelay = 20
  retryTiming.maxDelay = 100
  retryTiming.requestTimeout = 5000
})

afterEach(() => {
  Object.assign(retryTiming, originalTiming)
  vi.restoreAllMocks()
})

describe('isTransientError', () => {
  const cases: Array<[name: string, error: unknown, want: boolean]> = [
    ['nil', undefined, false],
    ['connection reset by peer', err('write tcp: connection reset by peer'), true],
    ['broken pipe', err('write: broken pipe'), true],
    ['i/o timeout', err('dial tcp: i/o timeout'), true],
    ['TLS handshake timeout', err('net/http: TLS handshake timeout'), true],
    ['connection refused', err('dial tcp 127.0.0.1:443: connection refused'), true],
    ['no such host (permanent)', err('dial tcp: lookup example.invalid: no such host'), false],
    ['server misbehaving', err('lookup example.com: server misbehaving'), true],
    ['fetch failed (node transport)', err('fetch failed'), true],
    ['rate limited 230001', err('feishu: reply failed code=230001 msg=rate limited'), false],
    ['rate limited 230001 (AxiosError body shape)', apiErr(230001, 'rate limited'), false],
    ['patch rate limit 230020 (AxiosError body shape)', apiErr(230020), true],
    // Legacy text-shaped errors (Go port and test fakes) keep classifying.
    ['patch rate limit 230020 (text shape)', err('feishu: patch message code=230020 msg=The message is updated too frequently'), true],
    ['withdrawn message 230011 (AxiosError body shape)', apiErr(230011, 'The message was withdrawn.'), false],
    ['invalid token', err('feishu: reply failed code=99991663'), false],
    ['generic error', err('something went wrong'), false],
    ['context deadline exceeded (per-attempt timeout)', err('context deadline exceeded'), true],
    ['node abort wording', err('This operation was aborted'), true],
  ]
  for (const [name, error, want] of cases) {
    it(name, () => {
      expect(isTransientError(error), name).toBe(want)
    })
  }
})

describe('feishuBusinessCode', () => {
  it('reads the AxiosError response body code (number or string)', () => {
    expect(feishuBusinessCode(apiErr(230020))).toBe('230020')
    expect(feishuBusinessCode(Object.assign(new Error('x'), { response: { data: { code: '230011' } } }))).toBe('230011')
  })

  it('falls back to the code= text shape', () => {
    expect(feishuBusinessCode(err('feishu: patch message code=230020 msg=too frequent'))).toBe('230020')
  })

  it('returns undefined for plain errors and non-error values', () => {
    expect(feishuBusinessCode(err('something went wrong'))).toBeUndefined()
    expect(feishuBusinessCode(null)).toBeUndefined()
  })
})

describe('withTransientRetry', () => {
  it('succeeds on the first attempt', async () => {
    let calls = 0
    await withTransientRetry('test', async () => {
      calls++
    })
    expect(calls).toBe(1)
  })

  it('retries on transient then succeeds', async () => {
    let calls = 0
    await withTransientRetry('test', async () => {
      calls++
      if (calls <= 2) throw err('write tcp: connection reset by peer')
    })
    expect(calls).toBe(3)
  })

  it('does not retry non-transient errors', async () => {
    let calls = 0
    await expect(withTransientRetry('test', async () => {
      calls++
      throw err('feishu: reply failed code=230001 msg=rate limited')
    })).rejects.toThrow('230001')
    expect(calls).toBe(1)
  })

  it('gives up after max retries', async () => {
    let calls = 0
    const error = await withTransientRetry('test', async () => {
      calls++
      throw err('unexpected EOF')
    }).catch((e: unknown) => e)
    expect(calls).toBe(retryTiming.maxRetries + 1)
    expect(String(error)).toContain('failed after')
    expect(String(error)).toContain('unexpected EOF')
  })

  it('respects abort cancellation during backoff', async () => {
    const controller = new AbortController()
    let calls = 0
    const error = await withTransientRetry('test', async () => {
      calls++
      if (calls === 1) controller.abort()
      throw err('connection reset by peer')
    }, controller.signal).catch((e: unknown) => e)
    expect(String(error)).toContain('retry cancelled')
  })

  it('per-attempt timeout is retried and bounds total time', async () => {
    retryTiming.requestTimeout = 50
    const start = Date.now()
    let calls = 0
    await expect(withTransientRetry('test', () => new Promise<void>((_resolve, reject) => {
      calls++
      // Hang until the per-attempt deadline rejects the race.
      setTimeout(() => { reject(new Error('late success — should be unreachable before deadline')) }, 1000)
    }))).rejects.toThrow('failed after')
    const elapsed = Date.now() - start
    expect(calls).toBe(retryTiming.maxRetries + 1)
    expect(elapsed).toBeLessThan(3000)
  })

  it('backoff timing spaces retries', async () => {
    retryTiming.initialDelay = 60
    retryTiming.maxDelay = 120
    const stamps: number[] = []
    await withTransientRetry('test', async () => {
      stamps.push(Date.now())
      if (stamps.length <= 2) throw err('unexpected EOF')
    })
    const first = (stamps[1] ?? 0) - (stamps[0] ?? 0)
    const second = (stamps[2] ?? 0) - (stamps[1] ?? 0)
    // Base 60ms (±25% jitter) then 120ms (±25% jitter).
    expect(first).toBeGreaterThanOrEqual(55)
    expect(second).toBeGreaterThanOrEqual(110)
  })
})

/** Fake client whose reply/create/patch throw per-call schedules. */
function scheduledClient(schedule: {
  reply?: Array<Error | undefined>
  create?: Array<Error | undefined>
  patch?: Array<Error | undefined>
}): FeishuApiClient & { counts: { reply: number; create: number; patch: number } } {
  const counts = { reply: 0, create: 0, patch: 0 }
  const pick = (list: Array<Error | undefined> | undefined, i: number): Error | undefined =>
    list !== undefined && i < list.length ? list[i] : undefined
  return {
    counts,
    async reply() {
      const e = pick(schedule.reply, counts.reply)
      counts.reply++
      if (e !== undefined) throw e
      return { messageId: 'om_ok' }
    },
    async create() {
      const e = pick(schedule.create, counts.create)
      counts.create++
      if (e !== undefined) throw e
      return { messageId: 'om_ok' }
    },
    async patch(params) {
      const e = pick(schedule.patch, counts.patch)
      counts.patch++
      if (e !== undefined) throw e
      void params
    },
  }
}

function newPlatform(api: FeishuApiClient, noReplyToTrigger = false): FeishuPlatform {
  return new FeishuPlatform({ appID: 'cli_x', appSecret: 's', apiClient: api, noReplyToTrigger })
}

describe('API wrappers retry on transient errors', () => {
  it('reply retries on connection reset then succeeds', async () => {
    const api = scheduledClient({ reply: [err('write tcp: connection reset by peer'), undefined] })
    await newPlatform(api).reply(rc, 'hello')
    expect(api.counts.reply).toBe(2)
  })

  it('create retries on transient network error', async () => {
    const api = scheduledClient({ create: [err('dial tcp: i/o timeout'), undefined] })
    await newPlatform(api, true).send(rc, 'hello')
    expect(api.counts.create).toBe(2)
  })

  it('reply does not retry on non-transient API errors', async () => {
    const api = scheduledClient({ reply: [err('feishu: reply failed code=230001 msg=rate limited')] })
    await expect(newPlatform(api).reply(rc, 'hello')).rejects.toThrow('230001')
    expect(api.counts.reply).toBe(1)
  })

  it('a withdrawn reply target falls back to a standalone chat message (SDK body-code shape)', async () => {
    const api = scheduledClient({ reply: [apiErr(230011, 'The message was withdrawn.')] })
    await newPlatform(api).reply(rc, 'hello')
    expect(api.counts.reply).toBe(1)
    expect(api.counts.create).toBe(1)
  })

  it('patch message retries on transient error', async () => {
    const api = scheduledClient({ patch: [apiErr(230020), undefined] })
    const p = newPlatform(api)
    const handle = await p.sendPreviewStart(rc, { kind: 'text', text: 'body' })
    await p.updateMessage(handle, { kind: 'text', text: 'body', status: { state: 'completed', ts: '12:00:01', toolCallSeq: 0 } })
    expect(api.counts.patch).toBe(2)
  })

  it('transient retry then token refresh then success', async () => {
    let authCalls = 0
    let replyCalls = 0
    const api: FeishuApiClient = {
      async reply() {
        replyCalls++
        if (replyCalls === 1) throw err('write tcp: connection reset by peer')
        if (replyCalls === 2) throw err('feishu: reply failed code=99991663')
        return undefined
      },
      create: async () => undefined,
      fetchTenantAccessToken: async () => {
        authCalls++
        return 'fresh'
      },
      withToken: (token: string): FeishuApiClient => ({
        reply: async () => {
          if (token !== 'fresh') throw new Error('unexpected token')
          replyCalls++
          return undefined
        },
        create: async () => undefined,
      }),
    }
    await newPlatform(api).reply(rc, 'hello')
    expect(authCalls).toBe(1)
    expect(replyCalls).toBe(3)
  })
})
