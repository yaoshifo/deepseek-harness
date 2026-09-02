/**
 * Status-footer domain tests ported from cc-connect: core/timerate_test.go
 * (unionDuration / formatTokenRate / tokenRateMessage / formatTurnDuration /
 * buildCompletionUsage-clears-token-rate), the reply-footer engine tests at
 * engine_test.go:1160-1367, formatCtxTokensWithTotal + formatCacheHitMsg +
 * parseSelfReportedCtx (engine_test.go:13540+ / 7800+), formatGitBranch cache
 * (worktree_test.go:225+), and TestSendTurnCompletionCard_JumpLinkFolded
 * (engine_test.go:15397+).
 *
 * @module dsh-feishu-bridge/tests-engine-status-footer
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.ts'
import {
  appendReplyFooter,
  buildCompletionUsage,
  buildReplyFooter,
  buildStatusFooter,
  buildStatusFooterElements,
  compactReplyFooterPath,
  CompletionUsageFields,
  formatCacheHitMsg,
  formatCtxTokensWithTotal,
  formatGitBranch,
  formatMemInfo,
  formatTokenK,
  formatTokenRate,
  formatTurnDuration,
  gitBranchCache,
  parseMemoryPressureFreePct,
  parseSelfReportedCtx,
  replyFooterContextText,
  setCompletionDurations,
  setTokenRate,
  stripCtxSelfReport,
  tokenRateMessage,
  unionDuration,
  type UsageReport,
} from '../../src/engine/status-footer.ts'
import { platformCacheCapacity } from '../../src/feishu/platform.ts'
import type { Interval } from '../../src/engine/status-footer.ts'
import type { Agent, AgentSession, Platform } from '../../src/core/types.ts'
import type { Card, CardElement } from '../../src/card.ts'
import type { UsageProvider } from '../../src/engine/usage.ts'
import { Session } from '../../src/engine/session.ts'
import {
  createStubAgent,
  createStubPlatform,
  newControllableSession,
} from '../stubs/engine-stubs.ts'

// ── unionDuration (Go TestUnionDuration) ───────────────────────────────────

describe('unionDuration', () => {
  const at = (ms: number): number => ms
  const cases: Array<{ name: string; in: Interval[]; want: number }> = [
    { name: 'empty', in: [], want: 0 },
    { name: 'single', in: [{ start: at(0), end: at(1000) }], want: 1000 },
    { name: 'disjoint', in: [{ start: at(0), end: at(1000) }, { start: at(2000), end: at(3000) }], want: 2000 },
    { name: 'overlapping', in: [{ start: at(0), end: at(2000) }, { start: at(1000), end: at(3000) }], want: 3000 },
    // N parallel tools sharing the same window collapse to one window's span.
    {
      name: 'parallel-identical',
      in: [{ start: at(0), end: at(1000) }, { start: at(0), end: at(1000) }, { start: at(0), end: at(1000) }],
      want: 1000,
    },
    { name: 'nested', in: [{ start: at(0), end: at(5000) }, { start: at(1000), end: at(2000) }], want: 5000 },
    { name: 'adjacent-touching', in: [{ start: at(0), end: at(1000) }, { start: at(1000), end: at(2000) }], want: 2000 },
    { name: 'zero-length', in: [{ start: at(0), end: at(0) }], want: 0 },
  ]
  for (const c of cases) {
    it(c.name, () => {
      expect(unionDuration(c.in.map(x => ({ ...x }))), c.name).toBe(c.want)
    })
  }
})

// ── rate / duration formatters (Go TestFormatTokenRate & friends) ──────────

describe('formatTokenRate', () => {
  const cases: Array<[number, string]> = [
    [5, '5.0 t/s'],
    [9.9, '9.9 t/s'],
    [10, '10 t/s'],
    [142, '142 t/s'],
    [999, '999 t/s'],
    [1000, '1.0k t/s'],
    [2500, '2.5k t/s'],
  ]
  for (const [rate, want] of cases) {
    it(`${rate} → ${want}`, () => {
      expect(formatTokenRate(rate)).toBe(want)
    })
  }
})

describe('tokenRateMessage', () => {
  const cases: Array<{ name: string; tokens: number; thinking: number; want: string }> = [
    { name: 'zero tokens', tokens: 0, thinking: 1000, want: '' },
    { name: 'below token floor', tokens: 9, thinking: 1000, want: '' },
    { name: 'below time floor', tokens: 100, thinking: 100, want: '' },
    { name: 'slow rate', tokens: 10, thinking: 2000, want: '5.0 t/s' },
    { name: 'medium rate', tokens: 500, thinking: 1000, want: '500 t/s' },
    { name: 'high rate', tokens: 2500, thinking: 1000, want: '2.5k t/s' },
  ]
  for (const c of cases) {
    it(c.name, () => {
      expect(tokenRateMessage(c.tokens, c.thinking), c.name).toBe(c.want)
    })
  }
})

describe('formatTurnDuration', () => {
  const cases: Array<{ name: string; ms: number; want: string }> = [
    { name: 'zero', ms: 0, want: '' },
    { name: 'negative', ms: -1000, want: '' },
    { name: 'seconds', ms: 45_000, want: '45s' },
    { name: 'seconds-subsec', ms: 59_700, want: '59s' },
    { name: 'exact-minute', ms: 60_000, want: '1m' },
    { name: 'minute-with-seconds', ms: 79_000, want: '1m' },
    { name: 'minute-thirty', ms: 90_000, want: '1m' },
    { name: 'just-under-two-minutes', ms: 119_000, want: '1m' },
    { name: 'two-minutes', ms: 120_000, want: '2m' },
    { name: 'large', ms: 75 * 60_000, want: '75m' },
  ]
  for (const c of cases) {
    it(c.name, () => {
      expect(formatTurnDuration(c.ms), c.name).toBe(c.want)
    })
  }
})

// ── ctx token formatters (Go TestFormatCtxTokensWithTotal / CacheHitMsg) ───

describe('formatTokenK', () => {
  it.each([
    [0, '0'], [999, '999'], [1000, '1k'], [1400, '2k'], [84_000, '84k'],
  ])('%d → %s', (tokens, want) => {
    expect(formatTokenK(tokens)).toBe(want)
  })
})

describe('formatCtxTokensWithTotal', () => {
  it('basic', () => {
    const got = formatCtxTokensWithTotal(1_000, 10_000, 1, '')
    for (const s of ['ctx:', '+1k', '=10k', '1 api']) expect(got).toContain(s)
  })

  it('multi api', () => {
    const got = formatCtxTokensWithTotal(5_000, 50_000, 10, '')
    for (const s of ['+5k', '=50k', '10 api']) expect(got).toContain(s)
  })

  it('appends the duration segment when given', () => {
    expect(formatCtxTokensWithTotal(1_000, 10_000, 2, '12s')).toContain('· 12s')
  })
})

describe('formatCacheHitMsg', () => {
  it('formats delta=cumulative and zip count', () => {
    const got = formatCacheHitMsg(20_000, 90_000, 2)
    for (const s of ['hit:', '+20k', '=90k', '2 zip']) expect(got).toContain(s)
  })
})

describe('parseSelfReportedCtx', () => {
  it.each([
    ['here is my response\n[ctx: ~42%]', 42],
    ['no context here', 0],
    ['response\n[ctx: ~100%]', 100],
    ['response\n[ctx: ~5%]', 5],
    ['', 0],
  ])('%j → %d', (input, want) => {
    expect(parseSelfReportedCtx(input)).toBe(want)
  })
})

describe('stripCtxSelfReport', () => {
  it('removes the indicator line (trailing-space trim stays with the caller, Go parity)', () => {
    expect(stripCtxSelfReport('answer\n[ctx: ~42%]')).toBe('answer')
  })

  it('leaves plain text untouched', () => {
    expect(stripCtxSelfReport('answer')).toBe('answer')
  })
})

// ── reply footer helpers ───────────────────────────────────────────────────

describe('compactReplyFooterPath', () => {
  it('collapses the home prefix to ~', () => {
    expect(compactReplyFooterPath(join(process.env.HOME ?? '/home', 'codes', 'cc-connect')))
      .toBe('~/codes/cc-connect')
  })

  it('keeps the last two segments of an absolute path', () => {
    expect(compactReplyFooterPath('/var/opt/deep/agent-work')).toBe('…/deep/agent-work')
  })
})

describe('appendReplyFooter', () => {
  it('appends as emphasized last line', () => {
    expect(appendReplyFooter('answer', 'a · b')).toBe('answer\n\n*a · b*')
  })

  it('footer-only content stays a bare emphasis line', () => {
    expect(appendReplyFooter('', 'f')).toBe('*f*')
  })

  it('empty footer is a no-op', () => {
    expect(appendReplyFooter('answer', '')).toBe('answer')
  })
})

describe('replyFooterContextText', () => {
  it('computes remaining percent against the baseline-adjusted window', () => {
    expect(replyFooterContextText({
      usedTokens: 181_424,
      baselineTokens: 12_000,
      totalTokens: 50_821_769,
      contextWindow: 258_400,
    }, enI18n())).toBe('31% left')
  })

  it('falls back through total then in+out tokens', () => {
    expect(replyFooterContextText({ usedTokens: 0, baselineTokens: 0, totalTokens: 25, contextWindow: 100 }, enI18n())).toBe('75% left')
    expect(replyFooterContextText({ usedTokens: 0, baselineTokens: 0, totalTokens: 0, inputTokens: 30, outputTokens: 30, contextWindow: 200 }, enI18n())).toBe('70% left')
  })

  it('empty without a window', () => {
    expect(replyFooterContextText({ usedTokens: 5, baselineTokens: 0, totalTokens: 0, contextWindow: 0 }, enI18n())).toBe('')
  })
})

// ── buildCompletionUsage ───────────────────────────────────────────────────

/** Go stubUsageProvider: a UsageProvider with a canned summary. */
function stubUsageProvider(name: string, summaryText: string): UsageProvider {
  return { name: () => name, summary: () => summaryText, refresh: () => {} }
}

describe('buildCompletionUsage', () => {
  it('builds the ctx and hit lines from plausible SDK tokens', async () => {
    const f = new CompletionUsageFields()
    await buildCompletionUsage(f, true, [], '', {
      totalInputTokens: 10_000, sdkPlausible: true, selfPct: 0,
      nonCachedDelta: 1_000, nonCachedCum: 10_000,
      cachedDelta: 20_000, cachedCum: 90_000,
      numTurns: 3, compactionCount: 2,
    })
    expect(f.ctxMsg).toContain('ctx: +1k=10k')
    expect(f.ctxMsg).toContain('3 api')
    expect(f.hitMsg).toContain('hit: +20k=90k')
    expect(f.hitMsg).toContain('2 zip')
  })

  it('falls back to the self-reported percentage when SDK tokens are implausible', async () => {
    const f = new CompletionUsageFields()
    await buildCompletionUsage(f, true, [], '', {
      totalInputTokens: 0, sdkPlausible: false, selfPct: 42,
      nonCachedDelta: 0, nonCachedCum: 0, cachedDelta: 0, cachedCum: 0,
      numTurns: 0, compactionCount: 0,
    })
    expect(f.ctxMsg).toBe('ctx: ~42%')
    expect(f.hitMsg).toBe('')
  })

  it('suppresses both lines when the indicator is off', async () => {
    const f = new CompletionUsageFields()
    await buildCompletionUsage(f, false, [], '', {
      totalInputTokens: 10_000, sdkPlausible: true, selfPct: 42,
      nonCachedDelta: 1_000, nonCachedCum: 10_000,
      cachedDelta: 0, cachedCum: 0, numTurns: 1, compactionCount: 0,
    })
    expect(f.ctxMsg).toBe('')
    expect(f.hitMsg).toBe('')
  })

  it('collects provider summaries under the 💰 prefix and RAM/disk into 💾', async () => {
    const f = new CompletionUsageFields()
    await buildCompletionUsage(f, false, [stubUsageProvider('glm', 'wk: 50%(10%)')], '', {
      totalInputTokens: 0, sdkPlausible: false, selfPct: 0,
      nonCachedDelta: 0, nonCachedCum: 0, cachedDelta: 0, cachedCum: 0,
      numTurns: 0, compactionCount: 0,
    })
    expect(f.providerMsg).toBe('💰 wk: 50%(10%)')
    expect(f.memMsg).toMatch(/RAM: \d+%( · Disk: \d+%)?/)
  })

  it('clears the per-turn rate alongside its siblings (Go TestBuildCompletionUsageClearsTokenRate)', async () => {
    const f = new CompletionUsageFields()
    setTokenRate(f, 500, 1000)
    expect(f.tokenRateMsg).not.toBe('')
    await buildCompletionUsage(f, false, [], '', {
      totalInputTokens: 0, sdkPlausible: false, selfPct: 0,
      nonCachedDelta: 0, nonCachedCum: 0, cachedDelta: 0, cachedCum: 0,
      numTurns: 0, compactionCount: 0,
    })
    expect(f.tokenRateMsg).toBe('')
    expect(f.agentDurationMsg).toBe('')
  })
})

describe('setCompletionDurations', () => {
  it('records agent duration plus the overhead suffix', () => {
    const f = new CompletionUsageFields()
    setCompletionDurations(f, 10_000, 12_000)
    expect(f.agentDurationMsg).toBe('10s')
  })

  it('falls back to the turn duration without agent timing', () => {
    const f = new CompletionUsageFields()
    setCompletionDurations(f, 0, 90_000)
    expect(f.agentDurationMsg).toBe('1m')
  })
})

// ── formatMemInfo / formatGitBranch ────────────────────────────────────────

describe('formatMemInfo', () => {
  it('renders RAM and Disk percentages', () => {
    const got = formatMemInfo()
    expect(got).toMatch(/^RAM: \d+%/)
    expect(got).toMatch(/Disk: \d+%(❗)?$/)
  })
})

describe('parseMemoryPressureFreePct', () => {
  it('reads the free percentage line from memory_pressure -Q output', () => {
    const out = 'The system has 25769803776 bytes (1572864 pages).\n'
      + 'System-wide memory free percentage: 37%\n'
    expect(parseMemoryPressureFreePct(out)).toBe(37)
  })

  it('returns null when the line is absent', () => {
    expect(parseMemoryPressureFreePct('memory_pressure: operation not permitted\n')).toBeNull()
  })
})

/** Run git in dir with a stable test identity (Go initTestRepo's env). */
function git(dir: string, ...args: string[]): void {
  execFileSync('git', ['-C', dir, ...args], {
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    },
  })
}

describe('formatGitBranch', () => {
  const repos: string[] = []

  afterAll(() => {
    // Temp dirs under TMPDIR are reaped by the OS; nothing to remove by hand.
    void repos
  })

  function initRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'footer-git-'))
    repos.push(dir)
    git(dir, 'init', '-b', 'main')
    writeFileSync(join(dir, 'README.md'), 'hello\n')
    git(dir, 'add', 'README.md')
    git(dir, 'commit', '-m', 'init')
    return dir
  }

  it('reports the branch with no files when clean', async () => {
    const dir = initRepo()
    const { line, files } = await formatGitBranch(dir)
    expect(line).toBe('🌿 main')
    expect(files).toEqual([])
  })

  it('counts uncommitted files when dirty', async () => {
    const dir = initRepo()
    writeFileSync(join(dir, 'a.txt'), 'x')
    writeFileSync(join(dir, 'b.txt'), 'y')
    const { line, files } = await formatGitBranch(dir)
    expect(line).toBe('🌿 main(2 uncommitted)')
    expect(files).toEqual(['a.txt', 'b.txt'])
  })

  it('returns nothing outside a git repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'footer-nogit-'))
    repos.push(dir)
    expect(await formatGitBranch(dir)).toEqual({ line: '', files: [] })
  })

  it('serves the TTL cache without re-running git (Go TestFormatGitBranch_Cache)', async () => {
    const dir = initRepo()
    const first = await formatGitBranch(dir)
    expect(first.line).toBe('🌿 main')
    git(dir, 'checkout', '-b', 'feature')
    // Within the TTL the cached branch is served even though HEAD moved.
    const cached = await formatGitBranch(dir)
    expect(cached.line).toBe('🌿 main')
  })

  it('caps the cache: worktree dirs are unique per task, so the key space is unbounded', () => {
    // Fill past the capacity; the oldest entries must fall out so a
    // long-running daemon holds at most the bounded set of recent dirs.
    const dirs = Array.from({ length: platformCacheCapacity + 10 }, (_, i) => `footer-cap-dir-${i}`)
    for (const [i, dir] of dirs.entries()) {
      gitBranchCache.set(dir, { line: `🌿 b${i}`, files: [], at: Date.now() })
    }
    expect(gitBranchCache.size).toBeLessThanOrEqual(platformCacheCapacity)
    expect(gitBranchCache.has(dirs[0] ?? '')).toBe(false)
    expect(gitBranchCache.has(dirs[dirs.length - 1] ?? '')).toBe(true)
  })
})

// ── buildStatusFooter / buildStatusFooterElements ──────────────────────────

/** Agent stub carrying the model/effort/workdir caps the footer probes. */
function footerAgent(model: string, effort: string, workDir: string): Agent & {
  getModel(): string
  getReasoningEffort(): string
  getWorkDir(): string
} {
  return {
    ...createStubAgent(),
    getModel: () => model,
    getReasoningEffort: () => effort,
    getWorkDir: () => workDir,
  }
}

describe('buildStatusFooter', () => {
  it('joins every populated line with the Go literal backslash-n', async () => {
    const f = new CompletionUsageFields()
    f.ctxMsg = 'ctx: +1k=10k · 3 api'
    f.hitMsg = 'hit: +20k=90k · 2 zip'
    f.providerMsg = '💰 wk: 50%(10%)'
    f.memMsg = 'RAM: 60% · Disk: 70%'
    const got = await buildStatusFooter('✅ Done', {
      fields: f,
      agent: footerAgent('glm-4.7', 'high', '/w/repo'),
      workspaceDir: '',
      agentSessionID: 'sess-1',
      sessionKey: 'feishu:oc_chat:ou_user',
      editorUrl: '',
    })
    const lines = got.split('\\n')
    expect(lines[0]).toBe('🤖 glm-4.7·high')
    expect(lines[1]).toBe('📊 ctx: +1k=10k · 3 api')
    expect(lines[2]).toBe('🍵 hit: +20k=90k · 2 zip')
    expect(lines.some(l => l.startsWith('📂 repo'))).toBe(true)
    expect(lines).toContain('⌛ wk: 50%(10%)')
    expect(lines).toContain('💾 RAM: 60% · Disk: 70%')
    expect(lines).toContain('sess-1')
    expect(lines).toContain('oc_chat')
  })

  it('joins the route-configured reasoning effort tightly onto the model label', async () => {
    const got = await buildStatusFooter('✅ Done', {
      fields: new CompletionUsageFields(),
      agent: footerAgent('zhipuai/glm-5.3-flash', 'max', ''),
      workspaceDir: '',
      agentSessionID: '',
      sessionKey: '',
      editorUrl: '',
    })
    expect(got).toBe('🤖 zhipuai/glm-5.3-flash·max')
  })

  it('keeps the spaced mode label after the tight effort segment', async () => {
    const agent = {
      ...footerAgent('glm-4.7', 'max', ''),
      getMode: () => 'bypassPermissions',
    }
    const got = await buildStatusFooter('✅ Done', {
      fields: new CompletionUsageFields(),
      agent,
      workspaceDir: '',
      agentSessionID: '',
      sessionKey: '',
      editorUrl: '',
    })
    expect(got).toBe('🤖 glm-4.7·max · YOLO')
  })

  it('appends the editor URL line when configured and a dir exists', async () => {
    const got = await buildStatusFooter('✅ Done', {
      fields: new CompletionUsageFields(),
      agent: footerAgent('m', '', '/w/repo'),
      workspaceDir: '',
      agentSessionID: '',
      sessionKey: 'feishu:oc_c',
      editorUrl: 'https://code.example.com',
    })
    expect(got).toContain('🔗 https://code.example.com/?folder=/w/repo')
  })

  it('returns empty when nothing is populated', async () => {
    const got = await buildStatusFooter('', {
      fields: new CompletionUsageFields(),
      agent: undefined,
      workspaceDir: '',
      agentSessionID: '',
      sessionKey: '',
      editorUrl: '',
    })
    expect(got).toBe('')
  })
})

describe('buildStatusFooterElements', () => {
  it('folds model/ctx/hit/session into a collapsible panel titled by the usage line', async () => {
    const f = new CompletionUsageFields()
    f.ctxMsg = 'ctx: +1k=10k'
    f.hitMsg = 'hit: +20k=90k'
    f.providerMsg = '💰 wk: 50%(10%)'
    const { headerSuffix, elements } = await buildStatusFooterElements({
      fields: f,
      agent: footerAgent('glm-4.7', '', '/w/repo'),
      workspaceDir: '',
      agentSessionID: 'sess-1',
      sessionKey: 'feishu:oc_chat',
      editorUrl: '',
    })
    expect(headerSuffix).toMatch(/^📁 repo/)
    const panel = elements.find(e => e.kind === 'collapsiblePanel') as unknown as {
      kind: 'collapsiblePanel'
      expanded?: boolean
      title?: string
      elements: CardElement[]
    }
    expect(panel.expanded).toBe(false)
    expect(panel.title).toBe('⌛ wk: 50%(10%)')
    const md = panel.elements.filter(e => e.kind === 'markdown') as Array<{ kind: string; content: string }>
    expect(md.map(m => m.content)).toContain('🤖 glm-4.7')
    expect(md.map(m => m.content)).toContain('📊 ctx: +1k=10k')
    expect(md.map(m => m.content)).toContain('🍵 hit: +20k=90k')
    expect(md.map(m => m.content)).toContain('sess-1')
    expect(md.map(m => m.content)).toContain('oc_chat')
  })

  it('titles the collapsible with the effort-bearing model line when no usage line exists', async () => {
    const f = new CompletionUsageFields()
    f.ctxMsg = 'ctx: +1k=10k'
    const { elements } = await buildStatusFooterElements({
      fields: f,
      agent: footerAgent('zhipuai/glm-5.3-flash', 'max', '/w/repo'),
      workspaceDir: '',
      agentSessionID: '',
      sessionKey: '',
      editorUrl: '',
    })
    const panel = elements.find(e => e.kind === 'collapsiblePanel') as unknown as {
      title?: string
      elements: CardElement[]
    }
    expect(panel.title).toBe('🤖 zhipuai/glm-5.3-flash·max')
  })

  it('keeps 💾 visible when RAM crosses the warning marker', async () => {
    const f = new CompletionUsageFields()
    f.memMsg = 'RAM: 91%❗ · Disk: 70%'
    const { elements } = await buildStatusFooterElements({
      fields: f,
      agent: undefined,
      workspaceDir: '',
      agentSessionID: '',
      sessionKey: '',
      editorUrl: '',
    })
    const md = elements.filter(e => e.kind === 'markdown') as Array<{ content: string }>
    expect(md.map(m => m.content)).toContain('💾 RAM: 91%❗ · Disk: 70%')
  })

  it('collapses 💾 below the warning marker', async () => {
    const f = new CompletionUsageFields()
    f.memMsg = 'RAM: 60%'
    const { elements } = await buildStatusFooterElements({
      fields: f,
      agent: undefined,
      workspaceDir: '',
      agentSessionID: '',
      sessionKey: '',
      editorUrl: '',
    })
    const panel = elements.find(e => e.kind === 'collapsiblePanel') as unknown as { elements: Array<{ content: string }> }
    expect(panel.elements.map(m => m.content)).toContain('💾 RAM: 60%')
  })

  it('adds the editor open button into the collapsed panel', async () => {
    const f = new CompletionUsageFields()
    f.ctxMsg = 'ctx: +1k=10k'
    const { elements } = await buildStatusFooterElements({
      fields: f,
      agent: footerAgent('m', '', '/w/repo'),
      workspaceDir: '',
      agentSessionID: '',
      sessionKey: '',
      editorUrl: 'https://code.example.com',
    })
    const panel = elements.find(e => e.kind === 'collapsiblePanel') as unknown as { elements: CardElement[] }
    const actions = panel.elements.find(e => e.kind === 'actions') as {
      buttons: Array<{ text: string; url?: string }>
    }
    expect(actions.buttons[0]!.text).toBe('Open Editor')
    expect(actions.buttons[0]!.url).toBe('https://code.example.com/?folder=/w/repo')
  })

  it('returns empty for an empty state', async () => {
    const { headerSuffix, elements } = await buildStatusFooterElements({
      fields: new CompletionUsageFields(),
      agent: undefined,
      workspaceDir: '',
      agentSessionID: '',
      sessionKey: '',
      editorUrl: '',
    })
    expect(headerSuffix).toBe('')
    expect(elements).toEqual([])
  })

  it('folds hint buttons into a form-wrapped collapsible and appends common hints (Go buildHintsPanelElements merge)', async () => {
    const f = new CompletionUsageFields()
    f.ctxMsg = 'ctx: +1k=10k'
    const { elements } = await buildStatusFooterElements({
      fields: f,
      agent: footerAgent('m', '', '/w/repo'),
      workspaceDir: '',
      agentSessionID: '',
      sessionKey: '',
      editorUrl: '',
      hints: { hints: ['/new'], hintsWithParam: [], hintsCommon: ['/done'] },
    })
    // Collapsible rides inside status_footer_form so its form_submit hint
    // buttons submit (schema 2.0 form needs a submit descendant).
    const form = elements.find(e => e.kind === 'form') as unknown as {
      name?: string
      elements: CardElement[]
    }
    expect(form.name).toBe('status_footer_form')
    const panel = form.elements.find(e => e.kind === 'collapsiblePanel') as unknown as { elements: CardElement[] }
    const hintActions = panel.elements.find(e => e.kind === 'actions') as {
      buttons: Array<{ text: string; value: string }>
    }
    expect(hintActions.buttons[0]!.text).toBe('/new')
    expect(hintActions.buttons[0]!.value).toBe('cmd:/new')
    // Common hints: trailing always-visible form.
    const commonForm = elements[elements.length - 1] as unknown as { kind: string; name?: string; elements: CardElement[] }
    expect(commonForm.kind).toBe('form')
    expect(commonForm.name).toBe('hints_common_form')
    const commonActions = commonForm.elements[0] as { buttons: Array<{ text: string }> }
    expect(commonActions.buttons[0]!.text).toBe('/done')
  })

  it('renders common hints even when the usage state is otherwise empty', async () => {
    const { elements } = await buildStatusFooterElements({
      fields: new CompletionUsageFields(),
      agent: undefined,
      workspaceDir: '',
      agentSessionID: '',
      sessionKey: '',
      editorUrl: '',
      hints: { hints: [], hintsWithParam: [], hintsCommon: ['/done'] },
    })
    // Go early-returns on a fully empty footer state — hints only ride
    // footers that already carry content (workdir, usage, duration).
    expect(elements).toEqual([])
  })
})

// ── buildReplyFooter (Go engine_send.go) ───────────────────────────────────

function enI18n() {
  return new Engine('t', createStubAgent(), [], '', 'en').i18n
}

function report(usedPercent: number): UsageReport {
  return {
    buckets: [{
      name: 'Rate limit',
      windows: [{ name: 'Primary', usedPercent, windowSeconds: 18_000, resetAfterSeconds: 0 }],
    }],
  }
}

/** AgentSession stub carrying the runtime caps the footer prefers. */
function capSession(caps: {
  model?: string
  effort?: string
  report?: UsageReport
  contextUsage?: Parameters<typeof replyFooterContextText>[0]
  workDir?: string
}): AgentSession {
  const s = newControllableSession('cap-session')
  return {
    ...s,
    ...(caps.model !== undefined ? { getModel: () => caps.model } : {}),
    ...(caps.effort !== undefined ? { getReasoningEffort: () => caps.effort } : {}),
    ...(caps.report !== undefined ? { getUsage: async () => caps.report } : {}),
    ...(caps.contextUsage !== undefined ? { getContextUsage: () => caps.contextUsage } : {}),
    ...(caps.workDir !== undefined ? { getWorkDir: () => caps.workDir } : {}),
  }
}

describe('buildReplyFooter', () => {
  it('joins model, effort, usage, and the compact workdir', async () => {
    const agent = {
      ...footerAgent('gpt-5.4', 'xhigh', join(process.env.HOME ?? '/home', 'codes', 'cc-connect')),
      getUsage: async () => report(0),
    }
    const got = await buildReplyFooter(
      { i18n: enI18n(), cache: { text: '', fetchedAt: 0 } },
      agent, undefined, '', '',
    )
    expect(got).toBe('gpt-5.4 · xhigh · 100% left · ~/codes/cc-connect')
  })

  it('prefers session runtime state over the agent defaults', async () => {
    const agent = footerAgent('agent-model', 'medium', join(process.env.HOME ?? '/home', 'codes', 'agent-default'))
    const session = capSession({
      model: 'gpt-5.4',
      effort: 'xhigh',
      report: report(80),
      contextUsage: {
        usedTokens: 181_424,
        baselineTokens: 12_000,
        totalTokens: 50_821_769,
        contextWindow: 258_400,
      },
      workDir: join(process.env.HOME ?? '/home', 'codes', 'cc-connect'),
    })
    const got = await buildReplyFooter(
      { i18n: enI18n(), cache: { text: '', fetchedAt: 0 } },
      agent, session, '', '31% left',
    )
    expect(got).toBe('gpt-5.4 · xhigh · 31% left · ~/codes/cc-connect')
  })

  it('returns empty for a workdir-only agent', async () => {
    const agent = footerAgent('', '', process.env.HOME ?? '/home')
    const got = await buildReplyFooter(
      { i18n: enI18n(), cache: { text: '', fetchedAt: 0 } },
      agent, undefined, '', '',
    )
    expect(got).toBe('')
  })
})

// ── engine integration: reply footer on real turns ─────────────────────────

/** Drive one full turn through processInteractiveEvents and return sent texts. */
async function runTurn(e: Engine, state: InteractiveState, session: Session, sessionKey: string, content: string): Promise<string[]> {
  const p = state.platform as ReturnType<typeof createStubPlatform> & Platform
  const channel = (state.agentSession as unknown as { channel: { push(ev: unknown): void } }).channel
  channel.push({ type: 'result', content, done: true })
  await e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)
  return p.getSent()
}

describe('turn reply footer (Go engine_test.go 1160-1367)', () => {
  const home = process.env.HOME ?? '/home'

  function newFooterEngine(agent: Agent, enabled: boolean): { e: Engine; p: ReturnType<typeof createStubPlatform> } {
    const p = createStubPlatform('telegram')
    const e = new Engine('test', agent, [p], '', 'en')
    e.setReplyFooterEnabled(enabled)
    return { e, p }
  }

  function setupState(e: Engine, agentSession: AgentSession, sessionKey: string): InteractiveState {
    const state = new InteractiveState()
    state.agentSession = agentSession
    state.platform = e.platforms[0]
    state.replyCtx = 'ctx-footer'
    e.interactiveStates.set(sessionKey, state)
    return state
  }

  it('appends the footer when enabled', async () => {
    const agent = {
      ...footerAgent('gpt-5.4', 'xhigh', join(home, 'codes', 'cc-connect')),
      getUsage: async () => report(0),
    }
    const { e } = newFooterEngine(agent, true)
    const sessionKey = 'telegram:user-footer'
    const session = e.sessions.getOrCreateActive(sessionKey)
    setupState(e, newControllableSession('s-footer'), sessionKey)
    const sent = await runTurn(e, e.interactiveStates.get(sessionKey)!, session, sessionKey, 'answer')
    expect(sent).toEqual(['answer\n\n*gpt-5.4 · xhigh · 100% left · ~/codes/cc-connect*'])
  })

  it('does not append the footer when disabled', async () => {
    const agent = {
      ...footerAgent('gpt-5.4', 'xhigh', join(home, 'codes', 'cc-connect')),
      getUsage: async () => report(0),
    }
    const { e } = newFooterEngine(agent, false)
    const sessionKey = 'telegram:user-footer-off'
    const session = e.sessions.getOrCreateActive(sessionKey)
    setupState(e, newControllableSession('s-footer-off'), sessionKey)
    const sent = await runTurn(e, e.interactiveStates.get(sessionKey)!, session, sessionKey, 'answer')
    expect(sent).toEqual(['answer'])
  })

  it('prefers session runtime state', async () => {
    const agent = {
      ...footerAgent('agent-model', 'medium', join(home, 'codes', 'agent-default')),
      getUsage: async () => report(80),
    }
    const { e } = newFooterEngine(agent, true)
    const sessionKey = 'telegram:user-footer-runtime'
    const session = e.sessions.getOrCreateActive(sessionKey)
    setupState(e, capSession({
      model: 'gpt-5.4',
      effort: 'xhigh',
      report: report(0),
      contextUsage: {
        usedTokens: 181_424,
        baselineTokens: 12_000,
        totalTokens: 50_821_769,
        contextWindow: 258_400,
      },
      workDir: join(process.env.HOME ?? '/home', 'codes', 'cc-connect'),
    }), sessionKey)
    const sent = await runTurn(e, e.interactiveStates.get(sessionKey)!, session, sessionKey, 'answer')
    expect(sent).toEqual(['answer\n\n*gpt-5.4 · xhigh · 31% left · ~/codes/cc-connect*'])
  })

  it('suppresses the footer for a workdir-only agent', async () => {
    const agent = footerAgent('', '', home)
    const { e } = newFooterEngine(agent, true)
    const sessionKey = 'telegram:user-footer-workdir-only'
    const session = e.sessions.getOrCreateActive(sessionKey)
    setupState(e, newControllableSession('s-footer-workdir-only'), sessionKey)
    const sent = await runTurn(e, e.interactiveStates.get(sessionKey)!, session, sessionKey, 'answer')
    expect(sent).toEqual(['answer'])
  })
})

// ── engine integration: the purple completion card ─────────────────────────

/** Card-update platform recording handle sends (Go stubCardUpdatePlatform). */
function createCardUpdatePlatform() {
  const base = createStubPlatform('feishu')
  const handleCards: Card[] = []
  const p = {
    ...base,
    handleCards,
    chatJumpURL: (chatID: string) => `https://applink.feishu.cn/client/chat/open?openChatId=${chatID}`,
    sendCardWithHandle: async (_rc: unknown, card: Card): Promise<string> => {
      handleCards.push(card)
      return `h${handleCards.length}`
    },
    updateCardWithHandle: async () => {},
  }
  return p
}

describe('sendTurnCompletionCard', () => {
  it('folds the parent jump link inside the collapsible panel (Go TestSendTurnCompletionCard_JumpLinkFolded)', async () => {
    const p = createCardUpdatePlatform()
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    const parentKey = 'feishu:oc_parent'
    const childKey = 'feishu:oc_child'
    const child = e.sessions.getOrCreateActive(childKey)
    child.setParentSessionKey(parentKey)

    const state = new InteractiveState()
    await e.sendTurnCompletionCard(state, p, 'ctx', child, childKey, '')
    expect(p.handleCards).toHaveLength(1)
    const urls = collectJumpLinkURLs(p.handleCards[0]!)
    expect(urls).toEqual([expect.stringContaining('openChatId=oc_parent')])
    expect(jumpLinkInsideCollapsible(p.handleCards[0]!)).toBe(true)
  })

  it('sends the purple card with the status footer fields and stores the handle state', async () => {
    const p = createCardUpdatePlatform()
    const e = new Engine('test', footerAgent('glm-4.7', '', ''), [p], '', 'en')
    e.usage.ctxMsg = 'ctx: +1k=10k · 3 api'
    e.usage.providerMsg = '💰 wk: 50%(10%)'
    e.usage.memMsg = 'RAM: 60%'
    setCompletionDurations(e.usage, 12_000, 15_000)

    const sessionKey = 'feishu:oc_chat'
    const session = e.sessions.getOrCreateActive(sessionKey)
    const state = new InteractiveState()
    await e.sendTurnCompletionCard(state, p, 'ctx', session, sessionKey, '/w/repo')
    expect(p.handleCards).toHaveLength(1)
    const card = p.handleCards[0]!
    expect(card.header?.color).toBe('purple')
    expect(card.header?.title).toContain('12s')
    const panel = card.elements.find(el => el.kind === 'collapsiblePanel') as unknown as { title?: string; elements: Array<{ content: string }> }
    expect(panel.title).toBe('⌛ wk: 50%(10%)')
    expect(panel.elements.map(m => m.content)).toContain('🤖 glm-4.7')
    expect(panel.elements.map(m => m.content)).toContain('📊 ctx: +1k=10k · 3 api')
    expect(state.notificationHandle).toBe('h1')
    expect(state.notificationHeaderSuffix).toBe(card.header?.title)
  })

  it('suppresses the card when the platform reports completion notices disabled', async () => {
    const p = { ...createCardUpdatePlatform(), completionNoticeEnabled: (): boolean => false }
    const e = new Engine('test', footerAgent('glm-4.7', '', '/w/repo'), [p], '', 'en')
    e.usage.ctxMsg = 'ctx: +1k=10k'
    const state = new InteractiveState()
    await e.sendTurnCompletionCard(state, p, 'ctx', e.sessions.getOrCreateActive('feishu:oc_gate'), 'feishu:oc_gate', '/w/repo')
    expect(p.handleCards).toHaveLength(0)
    expect(state.notificationHandle).toBeUndefined()
  })

  it('keeps sending the card when the platform reports completion notices enabled', async () => {
    const p = { ...createCardUpdatePlatform(), completionNoticeEnabled: (): boolean => true }
    const e = new Engine('test', footerAgent('glm-4.7', '', '/w/repo'), [p], '', 'en')
    e.usage.ctxMsg = 'ctx: +1k=10k'
    const state = new InteractiveState()
    await e.sendTurnCompletionCard(state, p, 'ctx', e.sessions.getOrCreateActive('feishu:oc_gate_on'), 'feishu:oc_gate_on', '/w/repo')
    expect(p.handleCards).toHaveLength(1)
    expect(state.notificationHandle).toBe('h1')
  })

  it('skips the card when nothing is populated', async () => {
    const p = createCardUpdatePlatform()
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    const state = new InteractiveState()
    await e.sendTurnCompletionCard(state, p, 'ctx', e.sessions.getOrCreateActive('feishu'), 'feishu', '')
    expect(p.handleCards).toHaveLength(0)
    expect(state.notificationHandle).toBeUndefined()
  })

  it('falls back to the completion notifier on card-less platforms', async () => {
    const notifications: string[] = []
    const p = {
      ...createStubPlatform('telegram'),
      sendCompletionNotification: async (_rc: unknown, msg: string) => {
        notifications.push(msg)
      },
    }
    const e = new Engine('test', footerAgent('glm-4.7', '', '/w/repo'), [p], '', 'en')
    e.usage.ctxMsg = 'ctx: +1k=10k'
    await e.sendTurnCompletionCard(new InteractiveState(), p, 'ctx', e.sessions.getOrCreateActive('telegram:u1'), 'telegram:u1', '')
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toContain('🤖 glm-4.7')
    expect(notifications[0]).toContain('📊 ctx: +1k=10k')
  })

  it('suppresses the text fallback when the platform reports completion notices disabled', async () => {
    const notifications: string[] = []
    const p = {
      ...createStubPlatform('telegram'),
      sendCompletionNotification: async (_rc: unknown, msg: string) => {
        notifications.push(msg)
      },
      completionNoticeEnabled: (): boolean => false,
    }
    const e = new Engine('test', footerAgent('glm-4.7', '', '/w/repo'), [p], '', 'en')
    e.usage.ctxMsg = 'ctx: +1k=10k'
    await e.sendTurnCompletionCard(new InteractiveState(), p, 'ctx', e.sessions.getOrCreateActive('telegram:u_gate'), 'telegram:u_gate', '')
    expect(notifications).toHaveLength(0)
  })

  it('subtask diff elements are appended after the footer elements', async () => {
    const p = createCardUpdatePlatform()
    const e = new Engine('test', footerAgent('m', '', ''), [p], '', 'en')
    e.usage.ctxMsg = 'ctx: +1k=10k'
    const sessionKey = 'feishu:oc_child'
    const session = e.sessions.getOrCreateActive(sessionKey)
    session.setSubtaskDepth(1)
    // The diff runs against the turn's workspaceDir; point it at a repo with
    // uncommitted changes.
    const dir = mkdtempSync(join(tmpdir(), 'footer-diff-'))
    git(dir, 'init', '-b', 'main')
    writeFileSync(join(dir, 'README.md'), 'hello\n')
    git(dir, 'add', 'README.md')
    git(dir, 'commit', '-m', 'init')
    writeFileSync(join(dir, 'a.txt'), 'x')
    await e.sendTurnCompletionCard(new InteractiveState(), p, 'ctx', session, sessionKey, dir)
    const card = p.handleCards[0]!
    const md = collectMarkdown(card)
    expect(md.some(c => c.includes('a.txt') || c.includes('1 file changed') || c.includes('+1'))).toBe(true)
  })
})

function collectJumpLinkURLs(card: Pick<Card, 'elements'>): string[] {
  const urls: string[] = []
  const walk = (elements: CardElement[]): void => {
    for (const el of elements) {
      if (el.kind === 'markdown') {
        for (const m of el.content.matchAll(/\]\(([^)]+)\)/g)) urls.push(m[1] ?? '')
      } else if (el.kind === 'form' || el.kind === 'collapsiblePanel') {
        walk((el as { elements: CardElement[] }).elements)
      }
    }
  }
  walk(card.elements)
  return urls
}

function jumpLinkInsideCollapsible(card: Card): boolean {
  const inner = card.elements.find(el => el.kind === 'collapsiblePanel') as { elements: CardElement[] } | undefined
  return inner !== undefined && collectJumpLinkURLs({ elements: inner.elements }).length > 0
}

function collectMarkdown(card: Card): string[] {
  const out: string[] = []
  const walk = (elements: CardElement[]): void => {
    for (const el of elements) {
      if (el.kind === 'markdown') out.push(el.content)
      else if (el.kind === 'form' || el.kind === 'collapsiblePanel') walk((el as { elements: CardElement[] }).elements)
    }
  }
  walk(card.elements)
  return out
}
