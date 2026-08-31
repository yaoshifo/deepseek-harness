/**
 * Tenant-token retry tests ported from cc-connect platform/feishu
 * token_retry_test.go. The TS seam is the injectable FeishuApiClient: a
 * stale token surfaces as a 99991663 error, the refresh as
 * fetchTenantAccessToken + withToken. (The Go tests also counted the lark
 * SDK's internal same-token retry — that belongs to the SDK, not this
 * code, so call counts here are ours only.)
 *
 * @module dsh-feishu-bridge/tests-feishu-token-retry
 */

import { describe, expect, it } from 'vitest'
import { FeishuPlatform, newCachedTenantTokenMinter, type FeishuApiClient } from '../../src/feishu/platform.ts'
import { isTenantAccessTokenInvalid } from '../../src/feishu/retry.ts'

function newPlatform(api: FeishuApiClient): FeishuPlatform {
  return new FeishuPlatform({ appID: 'cli_x', appSecret: 's', apiClient: api })
}

const rc = { messageID: 'om_root', chatID: 'oc_chat', sessionKey: 'feishu:oc_chat:ou_u' }

describe('isTenantAccessTokenInvalid', () => {
  const cases: Array<[name: string, err: unknown, want: boolean]> = [
    ['nil', undefined, false],
    ['code 99991663', new Error('feishu: reply failed code=99991663 msg=Invalid access token for authorization'), true],
    ['invalid access token text', new Error('Invalid access token for authorization'), true],
    ['other api error', new Error('feishu: reply failed code=230001 msg=rate limited'), false],
    ['plain error', new Error('something went wrong'), false],
    // SDK verbs surface business codes as AxiosErrors whose message is only
    // "Request failed with status code NNN"; the code rides in response.data.
    ['sdk axios body code 99991663', { message: 'Request failed with status code 400', response: { data: { code: 99991663 } } }, true],
    ['sdk axios body code 99991663 as text', { message: 'Request failed with status code 401', response: { data: { code: '99991663' } } }, true],
    ['sdk axios other body code', { message: 'Request failed with status code 400', response: { data: { code: 230001 } } }, false],
    ['sdk axios no body code', { message: 'Request failed with status code 500' }, false],
  ]
  for (const [name, err, want] of cases) {
    it(name, () => {
      expect(isTenantAccessTokenInvalid(err)).toBe(want)
    })
  }
})

describe('tenant token refresh', () => {
  it('reply refreshes the tenant token after a stale cached token', async () => {
    let authCalls = 0
    let replyCalls = 0
    const api: FeishuApiClient = {
      async reply() {
        replyCalls++
        if (replyCalls === 1) throw new Error('feishu: reply failed code=99991663')
        return undefined
      },
      async create() {
        return undefined
      },
      fetchTenantAccessToken: async () => {
        authCalls++
        return 'fresh-token'
      },
      withToken: (token: string): FeishuApiClient => ({
        ...{} as FeishuApiClient,
        reply: async () => {
          if (token !== 'fresh-token') throw new Error('unexpected token')
          replyCalls++
          return undefined
        },
        create: async () => undefined,
      }),
    }
    await newPlatform(api).reply(rc, 'hello')
    expect(authCalls).toBe(1)
    expect(replyCalls).toBe(2)
  })

  it('create refreshes the tenant token after a stale cached token', async () => {
    let authCalls = 0
    let createCalls = 0
    const api: FeishuApiClient = {
      reply: async () => undefined,
      async create() {
        createCalls++
        if (createCalls === 1) throw new Error('feishu: send failed code=99991663')
        return { messageId: 'om_ok' }
      },
      fetchTenantAccessToken: async () => {
        authCalls++
        return 'fresh'
      },
      withToken: (token: string): FeishuApiClient => ({
        reply: async () => undefined,
        create: async () => {
          if (token !== 'fresh') throw new Error('unexpected token')
          createCalls++
          return { messageId: 'om_ok' }
        },
      }),
    }
    const p = new FeishuPlatform({ appID: 'cli_x', appSecret: 's', apiClient: api, noReplyToTrigger: true })
    await p.send(rc, 'hello')
    expect(authCalls).toBe(1)
    expect(createCalls).toBe(2)
  })

  it('reply does not refresh on a non-token error', async () => {
    let authCalls = 0
    let replyCalls = 0
    const api: FeishuApiClient = {
      async reply() {
        replyCalls++
        throw new Error('feishu: reply failed code=230001 msg=rate limited')
      },
      create: async () => undefined,
      fetchTenantAccessToken: async () => {
        authCalls++
        return 'fresh'
      },
    }
    await expect(newPlatform(api).reply(rc, 'hello')).rejects.toThrow('230001')
    expect(authCalls).toBe(0)
    expect(replyCalls).toBe(1)
  })

  it('errors loudly when the client cannot refresh a stale token', async () => {
    const api: FeishuApiClient = {
      reply: async () => {
        throw new Error('feishu: reply failed code=99991663')
      },
      create: async () => undefined,
    }
    await expect(newPlatform(api).reply(rc, 'hello')).rejects.toThrow('cannot refresh')
  })

  it('stale-token retry re-mints past the minter cache (SDK body-code shape)', async () => {
    // The minter's cached token was just rejected by the server (Feishu can
    // revoke early); the refresh must mint a fresh one, not reuse the cache.
    let mints = 0
    const fetchFn = (async (): Promise<Response> => {
      mints++
      return new Response(JSON.stringify({ tenant_access_token: `tat-${mints}`, expire: 7200 }))
    }) as typeof fetch
    const mint = newCachedTenantTokenMinter('cli_x', 's', fetchFn)
    // Warm the cache: the daemon minted tat-1 earlier and it is still within
    // the server-declared lifetime — but the server revoked it early.
    await expect(mint()).resolves.toBe('tat-1')
    const staleAxios = () => Object.assign(new Error('Request failed with status code 400'), { response: { data: { code: 99991663 } } })
    let replyCalls = 0
    const api: FeishuApiClient = {
      async reply() {
        replyCalls++
        throw staleAxios()
      },
      create: async () => undefined,
      fetchTenantAccessToken: mint,
      withToken: (token: string): FeishuApiClient => ({
        reply: async () => {
          if (token !== 'tat-2') throw staleAxios()
          replyCalls++
          return undefined
        },
        create: async () => undefined,
      }),
    }
    await newPlatform(api).reply(rc, 'hello')
    expect(mints, 'refresh re-minted instead of reusing the cached stale token').toBe(2)
    expect(replyCalls).toBe(2)
  })
})
