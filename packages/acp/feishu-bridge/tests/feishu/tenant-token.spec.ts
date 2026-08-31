/**
 * The default API client's tenant-access-token minting: tokens are cached
 * against the server-declared `expire` (server tokens live ~2h), refreshed
 * slightly early; a response without `expire` declares no reusable lifetime
 * and is never cached.
 *
 * @module dsh-feishu-bridge/tests-feishu-tenant-token
 */

import { describe, expect, it } from 'vitest'
import { newCachedTenantTokenMinter } from '../../src/feishu/platform.ts'

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

describe('newCachedTenantTokenMinter', () => {
  it('reuses the token within the server-declared expiry', async () => {
    let mints = 0
    const fetchFn = async (): Promise<Response> => {
      mints++
      return jsonResponse({ tenant_access_token: 'tat-p', expire: 7200 })
    }
    const mint = newCachedTenantTokenMinter('cli_x', 's', fetchFn)
    await expect(mint()).resolves.toBe('tat-p')
    await expect(mint()).resolves.toBe('tat-p')
    expect(mints, 'the quoted chain minted one token for both messages').toBe(1)
  })

  it('re-mints when the response declares no expiry', async () => {
    let mints = 0
    const fetchFn = async (): Promise<Response> => {
      mints++
      return jsonResponse({ tenant_access_token: 'tat-p' })
    }
    const mint = newCachedTenantTokenMinter('cli_y', 's', fetchFn)
    await mint()
    await mint()
    expect(mints, 'no declared lifetime → no reuse').toBe(2)
  })

  it('keeps minting when the response carries no token', async () => {
    const fetchFn = async (): Promise<Response> => jsonResponse({})
    const mint = newCachedTenantTokenMinter('cli_z', 's', fetchFn)
    await expect(mint()).resolves.toBe('')
  })

  it('invalidate drops the cache so the next call re-mints', async () => {
    let mints = 0
    const fetchFn = async (): Promise<Response> => {
      mints++
      return jsonResponse({ tenant_access_token: `tat-${mints}`, expire: 7200 })
    }
    const mint = newCachedTenantTokenMinter('cli_x', 's', fetchFn)
    await expect(mint()).resolves.toBe('tat-1')
    await expect(mint()).resolves.toBe('tat-1')
    expect(mints).toBe(1)
    ;(mint as { invalidate: () => void }).invalidate()
    await expect(mint()).resolves.toBe('tat-2')
    expect(mints).toBe(2)
  })

  it('concurrent cold-start mints share one in-flight request', async () => {
    let mints = 0
    let release!: (r: Response) => void
    const gate = new Promise<Response>((resolve) => { release = resolve })
    const fetchFn = async (): Promise<Response> => {
      mints++
      return gate
    }
    const mint = newCachedTenantTokenMinter('cli_c', 's', fetchFn as typeof fetch)
    const callers = [mint(), mint(), mint()]
    release(jsonResponse({ tenant_access_token: 'tat-c', expire: 7200 }))
    for (const call of callers) await expect(call).resolves.toBe('tat-c')
    expect(mints, 'every concurrent caller shares the one in-flight mint').toBe(1)
  })
})
