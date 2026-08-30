/**
 * The default API client's tenant-access-token minting: tokens are cached
 * against the server-declared `expire` (server tokens live ~2h), refreshed
 * slightly early; a response without `expire` declares no reusable lifetime
 * and is never cached.
 *
 * @module dsh-feishu-bridge/tests-feishu-tenant-token
 */

import { describe, expect, it } from 'vitest'
import { newCachedTenantTokenMinter } from '../../src/feishu/platform.js'

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

describe('newCachedTenantTokenMinter', () => {
  it('reuses the token within the server-declared expiry', async () => {
    let mints = 0
    const fetchFn = async (): Promise<Response> => {
      mints++
      return jsonResponse({ tenant_access_token: 'tat-p', expire: 7200 })
    }
    const mint = newCachedTenantTokenMinter('cli_x', 's', fetchFn as typeof fetch)
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
    const mint = newCachedTenantTokenMinter('cli_y', 's', fetchFn as typeof fetch)
    await mint()
    await mint()
    expect(mints, 'no declared lifetime → no reuse').toBe(2)
  })

  it('keeps minting when the response carries no token', async () => {
    const fetchFn = async (): Promise<Response> => jsonResponse({})
    const mint = newCachedTenantTokenMinter('cli_z', 's', fetchFn as typeof fetch)
    await expect(mint()).resolves.toBe('')
  })
})
