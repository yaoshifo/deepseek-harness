/**
 * Usage-provider domain ported from cc-connect: core/usage_provider.go (the
 * provider interface + factory registry) plus the two concrete providers,
 * usage/glm (Z.ai / bigmodel quota API) and usage/minimax (Coding Plan
 * remains API). Providers query their service for plan/quota summaries that
 * the turn-completion footer surfaces as the ⌛ line.
 *
 * @module dsh-feishu-bridge/engine-usage
 */

/** Provider that queries a model-service for plan/quota usage (Go UsageProvider). */
export interface UsageProvider {
  /** Provider identifier (e.g. "glm", "minimax"). */
  name(): string
  /** Most recently cached usage string; '' when nothing fetched yet (non-blocking). */
  summary(): string
  /** Trigger an asynchronous cache refresh (non-blocking, fire-and-forget). */
  refresh(): void
}

/**
 * Optional capability (Go ActiveDetector): the engine only shows this
 * provider's usage when it is the active LLM backend. Providers without it
 * are always shown.
 */
export interface UsageActiveDetector {
  isActive(workDir: string): boolean
  setActiveProvider(name: string): void
}

/**
 * Optional capability (Go SyncUsageFetcher): a blocking on-demand fetch used
 * where the async cache may be cold. Falls back to refresh()+summary() when
 * the provider does not implement it.
 */
export interface SyncUsageFetcher {
  fetchSummary(): Promise<string>
}

/** Creates a UsageProvider from config options (Go UsageProviderFactory). */
export type UsageProviderFactory = (opts: Record<string, unknown>) => UsageProvider

const usageProviderFactories = new Map<string, UsageProviderFactory>()

/** Register a provider factory under the given name (Go RegisterUsageProvider).
 * @param name - Provider type key referenced from the usage_providers config.
 * @param factory - Builds the provider from its config options.
 */
export function registerUsageProvider(name: string, factory: UsageProviderFactory): void {
  usageProviderFactories.set(name, factory)
}

/**
 * Create a UsageProvider by name from the registered factories.
 * @param name - Provider type key from the usage_providers config.
 * @param opts - Provider-specific options (e.g. api_key, region).
 * @returns The provider built by the factory registered under name.
 * @throws When no factory is registered under the name (message lists the available ones).
 */
export function createUsageProvider(name: string, opts: Record<string, unknown>): UsageProvider {
  const factory = usageProviderFactories.get(name)
  if (factory === undefined) {
    throw new Error(`unknown usage provider "${name}", available: ${[...usageProviderFactories.keys()].sort().join(', ')}`)
  }
  return factory(opts)
}

// ── shared provider skeleton ───────────────────────────────────────────────

/** Cache TTL shared by both providers (Go cacheTTL: 5 minutes). */
const cacheTTLms = 5 * 60_000

/**
 * Cached-summary behavior both providers share: summary() reads the cache,
 * refresh() kicks a single in-flight fetch, fetchSummary() returns fresh
 * cached data or fetches synchronously.
 */
abstract class CachedUsageProvider implements UsageProvider, SyncUsageFetcher {
  private cached = ''
  private cachedAt = 0
  private refreshing: Promise<void> | undefined

  abstract name(): string

  /** Fetch the summary from the remote service; '' on failure. */
  protected abstract doFetch(): Promise<string>

  summary(): string {
    return this.cached
  }

  refresh(): void {
    if (this.refreshing !== undefined) return
    if (this.cached !== '' && Date.now() - this.cachedAt < cacheTTLms) return
    this.refreshing = this.doFetch()
      .then((s: string) => {
        if (s !== '') {
          this.cached = s
          this.cachedAt = Date.now()
        }
      })
      .catch(() => {
        // Fetch failures leave the previous summary in place (Go logs and keeps the cache).
      })
      .finally(() => { this.refreshing = undefined })
  }

  async fetchSummary(): Promise<string> {
    if (this.cached !== '' && Date.now() - this.cachedAt < cacheTTLms) return this.cached
    try {
      const s = await this.doFetch()
      if (s !== '') {
        this.cached = s
        this.cachedAt = Date.now()
      }
      return s
    } catch {
      // A failed fetch yields an empty summary (Go returns "" on error).
      return ''
    }
  }
}

/** Response-body contract the providers fetch (the slice of global fetch they use). */
interface FetchResponse {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
}

/** Minimal fetcher shape so tests can stub the transport. */
type FetchFn = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<FetchResponse>

function defaultFetch(url: string, init: { headers: Record<string, string>; signal: AbortSignal }): Promise<FetchResponse> {
  return fetch(url, init)
}

// ── GLM / Z.ai quota provider (usage/glm) ─────────────────────────────────

/** One limit window in the Z.ai quota response (Go limitEntry). */
export interface GlmLimitEntry {
  type: string
  /** 3=hours, 5=minutes, 6=weeks, 1=days. */
  unit: number
  number: number
  usage: number
  currentValue: number
  percentage: number
  remaining: number
  nextResetTime: number
}

interface GlmQuotaResponse {
  code: number
  data?: { limits?: GlmLimitEntry[] }
}

const glmDefaultQuotaURL = 'https://api.z.ai/api/monitor/usage/quota/limit'
const glmCnQuotaURL = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit'
const glmFetchTimeoutMs = 10_000

class GlmProvider extends CachedUsageProvider implements UsageActiveDetector {
  private readonly apiKey: string
  private readonly quotaURL: string
  private readonly fetchFn: FetchFn
  private activeProviderName = ''

  constructor(apiKey: string, quotaURL: string, fetchFn: FetchFn) {
    super()
    this.apiKey = apiKey
    this.quotaURL = quotaURL
    this.fetchFn = fetchFn
  }

  name(): string {
    return 'glm'
  }

  isActive(_workDir: string): boolean {
    return this.activeProviderName.startsWith('glm')
  }

  setActiveProvider(name: string): void {
    this.activeProviderName = name
  }

  protected async doFetch(): Promise<string> {
    const resp = await this.fetchFn(this.quotaURL, {
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(glmFetchTimeoutMs),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return formatGlmSummary((JSON.parse(await resp.text()) as GlmQuotaResponse).data?.limits ?? [])
  }
}

/** Short label for a GLM limit window (Go unitLabel). */
function glmUnitLabel(e: GlmLimitEntry): string {
  switch (e.unit) {
    case 3: return `${e.number}h`
    case 5: return `${e.number}min`
    case 6: return 'weekly'
    case 1: return `${e.number}d`
    default: return 'session'
  }
}

/** First entry matching type and unit (unit=-1 = any). */
function findGlmLimit(limits: GlmLimitEntry[], type: string, unit: number): GlmLimitEntry | undefined {
  return limits.find(e => e.type === type && (unit === -1 || e.unit === unit))
}

function formatGlmResetTime(ms: number): string {
  if (ms <= 0) return ''
  const remaining = ms - Date.now()
  if (remaining <= 0) return ''
  const hours = remaining / 3_600_000
  const d = Math.floor(hours / 24)
  const h = Math.floor(hours) % 24
  return d > 0 ? `${d}d${h}h` : `${h}h`
}

function isWorkHours(): boolean {
  const h = new Date().getHours()
  return h >= 14 && h < 18
}

/**
 * MCP/tools monthly quota segment carried under a TIME_LIMIT entry (Go
 * mcpSegment); '' for accounts without MCP quota.
 */
function glmMcpSegment(limits: GlmLimitEntry[]): string {
  const mcp = findGlmLimit(limits, 'TIME_LIMIT', -1)
  if (mcp === undefined) return ''
  const pct = Math.floor(mcp.percentage)
  return ` · MCP: ${pct}%${pct >= 90 ? '❗' : ''}`
}

/**
 * Render the GLM quota windows as a one-line summary (Go formatSummary):
 * weekly window when present ("wk: N%(M%)"), else the session window
 * ("5h: M%"); plus the MCP segment, nearest reset, and the work-hours marker.
 *
 * @param limits - Quota entries from the GLM API response.
 * @returns The one-line summary, '' when no usable session window exists.
 */
export function formatGlmSummary(limits: GlmLimitEntry[]): string {
  if (limits.length === 0) return ''
  const session = findGlmLimit(limits, 'TOKENS_LIMIT', 3) ?? findGlmLimit(limits, 'TOKENS_LIMIT', -1)
  if (session === undefined) return ''

  const pct = Math.floor(session.percentage)
  let nearestReset = formatGlmResetTime(session.nextResetTime)

  const weekly = findGlmLimit(limits, 'TOKENS_LIMIT', 6)
  if (weekly !== undefined && weekly !== session) {
    const weeklyPct = Math.floor(weekly.percentage)
    let s = `wk: ${weeklyPct}%(${pct}%)`
    if (weeklyPct >= 90) s += '❗'
    s += glmMcpSegment(limits)
    const weeklyReset = formatGlmResetTime(weekly.nextResetTime)
    if (weeklyReset !== '') nearestReset = weeklyReset
    if (nearestReset !== '') s += ` ↻${nearestReset}`
    if (isWorkHours()) s += ' ⛔️'
    return s
  }
  let s = `${glmUnitLabel(session)}: ${pct}%`
  s += glmMcpSegment(limits)
  if (nearestReset !== '') s += ` ↻${nearestReset}`
  if (isWorkHours()) s += ' ⛔️'
  return s
}

registerUsageProvider('glm', (opts) => {
  const apiKey = opts.api_key
  if (typeof apiKey !== 'string' || apiKey === '') throw new Error('glm: api_key is required')
  const quotaURL = opts.region === 'cn' ? glmCnQuotaURL : glmDefaultQuotaURL
  return new GlmProvider(apiKey, quotaURL, defaultFetch)
})

// ── MiniMax Coding Plan provider (usage/minimax) ───────────────────────────

interface MinimaxRemain {
  model_name: string
  current_interval_total_count: number
  /** This API uses the "usage" field to mean "remaining". */
  current_interval_usage_count: number
  current_interval_remaining_count: number
  current_weekly_total_count: number
  current_weekly_usage_count: number
}

interface MinimaxRemainsResponse {
  base_resp?: { status_code?: number; status_msg?: string }
  data?: { model_remains?: MinimaxRemain[] }
  /** Some endpoints return model_remains at the top level. */
  model_remains?: MinimaxRemain[]
}

const minimaxGlobalURLs = [
  'https://api.minimax.io/v1/api/openplatform/coding_plan/remains',
  'https://api.minimax.io/v1/coding_plan/remains',
]
const minimaxCnURLs = [
  'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains',
  'https://api.minimaxi.com/v1/coding_plan/remains',
]
const minimaxFetchTimeoutMs = 15_000
/** The CN API returns model-call counts; 1 prompt = 15 model calls. */
const modelCallsPerPrompt = 15

class MinimaxProvider extends CachedUsageProvider implements UsageActiveDetector {
  private readonly apiKey: string
  private readonly region: string
  private readonly fetchFn: FetchFn
  private activeProviderName = ''

  constructor(apiKey: string, region: string, fetchFn: FetchFn) {
    super()
    this.apiKey = apiKey
    this.region = region
    this.fetchFn = fetchFn
  }

  name(): string {
    return 'minimax'
  }

  isActive(_workDir: string): boolean {
    return this.activeProviderName === 'minimax'
  }

  setActiveProvider(name: string): void {
    this.activeProviderName = name
  }

  protected async doFetch(): Promise<string> {
    const urls = this.region === 'cn' ? minimaxCnURLs : minimaxGlobalURLs
    let lastErr: unknown = undefined
    for (const url of urls) {
      try {
        return await this.tryURL(url)
      } catch (error) {
        lastErr = error
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('minimax usage fetch failed')
  }

  private async tryURL(url: string): Promise<string> {
    const resp = await this.fetchFn(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(minimaxFetchTimeoutMs),
    })
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`authentication failed (HTTP ${resp.status})`)
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const rr = JSON.parse(await resp.text()) as MinimaxRemainsResponse
    const code = rr.base_resp?.status_code ?? 0
    if (code !== 0) throw new Error(`API error ${code}: ${rr.base_resp?.status_msg ?? ''}`)

    const remains = rr.data?.model_remains ?? rr.model_remains ?? []
    const chosen = remains.find(r => r.current_interval_total_count > 0)
    if (chosen === undefined) throw new Error('no usable model_remains entry')
    return formatMinimaxRemains(chosen, this.region)
  }
}

/**
 * Render one MiniMax remains entry (the tail of Go tryURL): prompts used
 * percentage plus the weekly segment when the weekly total is non-zero.
 * The CN region converts model-call counts to prompts (÷15).
 *
 * @param remain - One model's remains entry from the Coding Plan API.
 * @param region - 'cn' converts model-call counts to prompts; any other value keeps raw counts.
 * @returns The prompts summary, '' when the interval total is zero after conversion.
 */
export function formatMinimaxRemains(remain: MinimaxRemain, region: string): string {
  let total = remain.current_interval_total_count
  // Prefer the explicit remaining count; fall back to the usage field (this
  // API uses it to mean "remaining").
  let remaining = remain.current_interval_remaining_count !== 0
    ? remain.current_interval_remaining_count
    : remain.current_interval_usage_count
  let weeklyTotal = remain.current_weekly_total_count
  let weeklyRemaining = remain.current_weekly_usage_count
  if (region === 'cn') {
    total = Math.floor(total / modelCallsPerPrompt)
    remaining = Math.floor(remaining / modelCallsPerPrompt)
    weeklyTotal = Math.floor(weeklyTotal / modelCallsPerPrompt)
    weeklyRemaining = Math.floor(weeklyRemaining / modelCallsPerPrompt)
  }
  if (total <= 0) return ''
  const usedPct = 100 - Math.floor((remaining * 100) / total)
  let s = `${remaining}/${total} prompts (${usedPct}%)`
  if (weeklyTotal > 0) {
    const weeklyPct = Math.floor(((weeklyTotal - weeklyRemaining) * 100) / weeklyTotal)
    s += ` · weekly: ${weeklyRemaining}/${weeklyTotal}`
    if (weeklyPct >= 90) s += '❗'
  }
  return s
}

registerUsageProvider('minimax', (opts) => {
  const apiKey = opts.api_key
  if (typeof apiKey !== 'string' || apiKey === '') throw new Error('minimax: api_key is required')
  const region = typeof opts.region === 'string' ? opts.region : ''
  return new MinimaxProvider(apiKey, region, defaultFetch)
})
