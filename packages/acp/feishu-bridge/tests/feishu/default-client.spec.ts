/**
 * The default API client's SDK wiring: the SDK client is constructed with
 * its token cache disabled and every verb carries an explicit Authorization
 * header minted by our own minter. Without disableTokenCache the SDK's
 * formatPayload overwrites the header with its own cached token, so the
 * stale-token refresh (withTenantToken) would silently reuse the revoked
 * token; with it, our minter is the single token authority.
 *
 * @module dsh-feishu-bridge/tests-feishu-default-client
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { retryTiming } from '../../src/feishu/retry.ts'

const h = vi.hoisted(() => {
  const clientParams: Record<string, unknown>[] = []
  const replyOpts: Array<Record<string, unknown> | undefined> = []
  return { clientParams, replyOpts }
})

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class {
    constructor(params: Record<string, unknown>) { h.clientParams.push(params) }
    im = {
      message: {
        reply: async (_payload: unknown, opts?: Record<string, unknown>) => {
          h.replyOpts.push(opts)
          return { data: { message_id: 'om_ok' } }
        },
      },
    }
  },
  AppType: { SelfBuild: 0 },
  Domain: { Feishu: 0 },
  withTenantToken: (token: string) => ({ headers: { Authorization: `Bearer ${token}` } }),
}))

import { FeishuPlatform } from '../../src/feishu/platform.ts'

const rc = { messageID: 'om_root', chatID: 'oc_chat', sessionKey: 'feishu:oc_chat:ou_u' }

beforeEach(() => {
  h.clientParams.length = 0
  h.replyOpts.length = 0
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ tenant_access_token: 'tat-p', expire: 7200 }), { status: 200 })))
})

describe('defaultApiClient SDK wiring', () => {
  it('disables the SDK token cache so explicit Authorization headers survive', async () => {
    const p = new FeishuPlatform({ appID: 'cli_x', appSecret: 's' })
    await p.reply(rc, 'hello')
    expect(h.clientParams[0]?.disableTokenCache).toBe(true)
  })

  it('every verb request carries a token minted by the platform minter', async () => {
    const p = new FeishuPlatform({ appID: 'cli_x', appSecret: 's' })
    await p.reply(rc, 'hello')
    expect(h.replyOpts[0]?.headers).toMatchObject({ Authorization: 'Bearer tat-p' })
  })

  it('the bare-HTTP bot-info probe is bounded by a deadline', { timeout: 4000 }, async () => {
    // A black-hole connection on the bare fetch must abort at the per-attempt
    // deadline; without it the WS start (and every startup behind it) hangs
    // on the stuck probe.
    vi.stubGlobal('fetch', vi.fn((url: unknown, init?: RequestInit) => {
      if (String(url).includes('bot/v3/info')) {
        // A fetch stub honors the abort signal like the real one.
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => { reject(new Error('This operation was aborted')) })
        })
      }
      return Promise.resolve(new Response(JSON.stringify({ tenant_access_token: 'tat-p', expire: 7200 }), { status: 200 }))
    }))
    const saved = retryTiming.requestTimeout
    retryTiming.requestTimeout = 50
    try {
      const p = new FeishuPlatform({ appID: 'cli_x', appSecret: 's' })
      const t0 = Date.now()
      // start() awaits probeBotInfo before the WS start; the mocked SDK has
      // no WSClient, so reaching it rejects — proof the probe settled.
      await expect(p.start(() => {})).rejects.toThrow()
      expect(Date.now() - t0).toBeLessThan(3000)
    } finally {
      retryTiming.requestTimeout = saved
    }
  })
})
