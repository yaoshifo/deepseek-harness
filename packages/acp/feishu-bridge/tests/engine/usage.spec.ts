/**
 * Usage-provider domain tests ported from cc-connect: usage/glm/glm_test.go
 * (TestFormatSummary), the CreateUsageProvider error path from
 * core/usage_provider.go, and the minimax formatting/fallback behavior that
 * lives untested in usage/minimax/minimax.go (its repo has no minimax test).
 *
 * @module dsh-feishu-bridge/tests-engine-usage
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createUsageProvider,
  formatGlmSummary,
  formatMinimaxRemains,
  type GlmLimitEntry,
  type UsageProvider,
} from '../../src/engine/usage.ts'

/** Go limitEntry literal for a TOKENS_LIMIT session window (unit 3 = hours). */
function sessionLimit(pct: number): GlmLimitEntry {
  return { type: 'TOKENS_LIMIT', unit: 3, number: 5, usage: 0, currentValue: 0, percentage: pct, remaining: 0, nextResetTime: 0 }
}

/** Go limitEntry literal for a weekly TOKENS_LIMIT (unit 6). */
function weeklyLimit(pct: number): GlmLimitEntry {
  return { type: 'TOKENS_LIMIT', unit: 6, number: 1, usage: 0, currentValue: 0, percentage: pct, remaining: 0, nextResetTime: 0 }
}

function mcpLimit(pct: number): GlmLimitEntry {
  return { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 0, currentValue: 0, percentage: pct, remaining: 0, nextResetTime: 0 }
}

/** Stub fetch replying with the given JSON body and status. */
function stubFetch(bodies: Array<{ status?: number; body: string }>) {
  let i = 0
  return vi.fn(async (_url: string, _init?: unknown) => {
    const b = bodies[Math.min(i, bodies.length - 1)]!
    i++
    return {
      ok: (b.status ?? 200) >= 200 && (b.status ?? 200) < 300,
      status: b.status ?? 200,
      text: async () => b.body,
    }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createUsageProvider registry', () => {
  it('rejects an unknown type listing the available ones', () => {
    expect(() => createUsageProvider('nope', {}))
      .toThrow(/unknown usage provider "nope", available: .*(glm|minimax)/)
  })

  it('builds glm and minimax from their factories', () => {
    expect(createUsageProvider('glm', { api_key: 'k' }).name()).toBe('glm')
    expect(createUsageProvider('minimax', { api_key: 'k' }).name()).toBe('minimax')
  })

  it('requires an api_key for glm and minimax', () => {
    expect(() => createUsageProvider('glm', {})).toThrow(/glm: api_key is required/)
    expect(() => createUsageProvider('minimax', {})).toThrow(/minimax: api_key is required/)
  })
})

describe('formatGlmSummary (Go TestFormatSummary)', () => {
  const cases: Array<{ name: string; limits: GlmLimitEntry[]; hasAll: string[]; hasNone: string[] }> = [
    {
      name: 'session+weekly+mcp shows MCP percentage',
      limits: [sessionLimit(9), weeklyLimit(84), mcpLimit(19)],
      hasAll: ['MCP: 19%', 'wk: 84%(9%)'],
      hasNone: [],
    },
    {
      name: 'no TIME_LIMIT omits MCP segment',
      limits: [sessionLimit(9), weeklyLimit(84)],
      hasAll: [],
      hasNone: ['MCP'],
    },
    {
      name: 'mcp high water >=90 warns with exclamation',
      limits: [sessionLimit(9), weeklyLimit(84), mcpLimit(92)],
      hasAll: ['MCP: 92%', '❗'],
      hasNone: [],
    },
    {
      name: 'session only — no weekly, no MCP',
      limits: [sessionLimit(9)],
      hasAll: ['5h: 9%'],
      hasNone: ['weekly', 'MCP'],
    },
    {
      name: 'session + mcp, no weekly — fallback branch shows MCP',
      limits: [sessionLimit(9), mcpLimit(19)],
      hasAll: ['MCP: 19%'],
      hasNone: ['weekly'],
    },
  ]

  for (const c of cases) {
    it(c.name, () => {
      const got = formatGlmSummary(c.limits)
      for (const want of c.hasAll) expect(got, c.name).toContain(want)
      for (const no of c.hasNone) expect(got, c.name).not.toContain(no)
    })
  }

  it('returns empty for no limits and no TOKENS_LIMIT', () => {
    expect(formatGlmSummary([])).toBe('')
    expect(formatGlmSummary([mcpLimit(10)])).toBe('')
  })
})

describe('glm provider', () => {
  const quotaBody = JSON.stringify({
    code: 0,
    data: {
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 9.4 },
        { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 84 },
        { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 19 },
      ],
    },
  })

  it('fetchSummary parses the quota payload into a summary', async () => {
    const fetch = stubFetch([{ body: quotaBody }])
    vi.stubGlobal('fetch', fetch)
    const p = createUsageProvider('glm', { api_key: 'k' })
    const s = await asFetcher(p).fetchSummary()
    expect(s).toContain('wk: 84%(9%)')
    expect(s).toContain('MCP: 19%')
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]![0]).toBe('https://api.z.ai/api/monitor/usage/quota/limit')
    const init = fetch.mock.calls[0]![1] as { headers: Record<string, string> }
    expect(init.headers.Authorization).toBe('Bearer k')
  })

  it('region cn uses the bigmodel quota URL', async () => {
    const fetch = stubFetch([{ body: quotaBody }])
    vi.stubGlobal('fetch', fetch)
    const p = createUsageProvider('glm', { api_key: 'k', region: 'cn' })
    await asFetcher(p).fetchSummary()
    expect(fetch.mock.calls[0]![0]).toBe('https://open.bigmodel.cn/api/monitor/usage/quota/limit')
  })

  it('serves the cache within TTL without a second fetch', async () => {
    const fetch = stubFetch([{ body: quotaBody }])
    vi.stubGlobal('fetch', fetch)
    const p = createUsageProvider('glm', { api_key: 'k' })
    const first = await asFetcher(p).fetchSummary()
    expect(await asFetcher(p).fetchSummary()).toBe(first)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('fetchSummary returns "" on a failed request', async () => {
    vi.stubGlobal('fetch', stubFetch([{ status: 500, body: 'oops' }]))
    const p = createUsageProvider('glm', { api_key: 'k' })
    expect(await asFetcher(p).fetchSummary()).toBe('')
    expect(p.summary()).toBe('')
  })

  it('refresh() populates the cached summary in the background', async () => {
    vi.stubGlobal('fetch', stubFetch([{ body: quotaBody }]))
    const p = createUsageProvider('glm', { api_key: 'k' })
    p.refresh()
    await vi.waitFor(() => { expect(p.summary()).toContain('wk: 84%(9%)') })
  })

  it('isActive matches the glm prefix; default off', () => {
    const p = createUsageProvider('glm', { api_key: 'k' }) as UsageProvider & {
      isActive(dir: string): boolean
      setActiveProvider(name: string): void
    }
    expect(p.isActive('/w')).toBe(false)
    p.setActiveProvider('glm-turbo')
    expect(p.isActive('/w')).toBe(true)
  })
})

describe('formatMinimaxRemains', () => {
  const globalEntry = {
    model_name: 'abab',
    current_interval_total_count: 500,
    current_interval_usage_count: 400,
    current_interval_remaining_count: 0,
    current_weekly_total_count: 1000,
    current_weekly_usage_count: 950,
  }

  it('formats prompts with the used percentage and weekly segment', () => {
    // remaining falls back to the usage count field (this API means "remaining").
    expect(formatMinimaxRemains(globalEntry, ''))
      .toBe('400/500 prompts (20%) · weekly: 950/1000')
  })

  it('warns when the weekly usage crosses 90%', () => {
    expect(formatMinimaxRemains({ ...globalEntry, current_weekly_usage_count: 50 }, ''))
      .toContain('❗')
  })

  it('cn region converts model-call counts to prompts (÷15)', () => {
    const cn = {
      model_name: 'm',
      current_interval_total_count: 7500,
      current_interval_usage_count: 6000,
      current_interval_remaining_count: 0,
      current_weekly_total_count: 0,
      current_weekly_usage_count: 0,
    }
    expect(formatMinimaxRemains(cn, 'cn')).toBe('400/500 prompts (20%)')
  })

  it('omits the weekly segment when the weekly total is zero', () => {
    const noWeekly = { ...globalEntry, current_weekly_total_count: 0, current_weekly_usage_count: 0 }
    expect(formatMinimaxRemains(noWeekly, '')).toBe('400/500 prompts (20%)')
  })
})

describe('minimax provider', () => {
  const remainsBody = JSON.stringify({
    base_resp: { status_code: 0, status_msg: '' },
    data: {
      current_subscribe_title: 't',
      plan_name: 'p',
      model_remains: [{
        model_name: 'abab',
        current_interval_total_count: 500,
        current_interval_usage_count: 400,
        current_interval_remaining_count: 0,
        current_weekly_total_count: 1000,
        current_weekly_usage_count: 950,
      }],
    },
  })

  it('falls back to the second URL when the first fails', async () => {
    const fetch = stubFetch([{ status: 404, body: '' }, { body: remainsBody }])
    vi.stubGlobal('fetch', fetch)
    const p = createUsageProvider('minimax', { api_key: 'k' })
    const s = await asFetcher(p).fetchSummary()
    expect(s).toBe('400/500 prompts (20%) · weekly: 950/1000')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('authentication failure surfaces an error and yields an empty summary', async () => {
    vi.stubGlobal('fetch', stubFetch([{ status: 401, body: '' }]))
    const p = createUsageProvider('minimax', { api_key: 'bad' })
    expect(await asFetcher(p).fetchSummary()).toBe('')
  })

  it('isActive matches minimax exactly; default off', () => {
    const p = createUsageProvider('minimax', { api_key: 'k' }) as UsageProvider & {
      isActive(dir: string): boolean
      setActiveProvider(name: string): void
    }
    expect(p.isActive('/w')).toBe(false)
    p.setActiveProvider('minimax')
    expect(p.isActive('/w')).toBe(true)
    p.setActiveProvider('minimax-cn')
    expect(p.isActive('/w')).toBe(false)
  })
})

/** Narrow a provider to the optional sync-fetch capability (Go SyncUsageFetcher). */
function asFetcher(p: UsageProvider): { fetchSummary(): Promise<string> } {
  const f = p as UsageProvider & { fetchSummary?: () => Promise<string> }
  if (typeof f.fetchSummary !== 'function') throw new Error('provider lacks fetchSummary')
  return f as UsageProvider & { fetchSummary(): Promise<string> }
}
