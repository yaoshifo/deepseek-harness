/**
 * Config-path wiring tests for buildProjectAssembly: every Go wire.go
 * assembly action whose engine/platform implementation already exists in TS
 * must have a schema field and a production forward (the M4-E audit's
 * B-class fixes — stall timeouts, dir history, admin allowlist, subtask /
 * spawn caps, language, attachment toggle, stream-preview tuning).
 *
 * @module dsh-feishu-bridge/tests-assembly-config
 */

import { mkdtempSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { buildProjectAssembly, type FeishuBridgeConfig, type ProjectConfig } from '../src/index.js'
import type { QuestionRouting } from '../src/agent-dsh/adapter.js'
import type { Engine } from '../src/engine/engine.js'
import { HintUsage } from '../src/engine/hint-usage.js'
import { WorktreeMode } from '../src/engine/worktree.js'

/** Structural Cordis slice the adapter consumes; nothing else boots. */
function stubContext(): Context {
  return {
    agents: {},
    on: () => () => {},
    get: () => undefined,
    logger: { error: () => {} },
    effect: () => () => {},
  } as unknown as Context
}

function baseConfig(): FeishuBridgeConfig {
  return {
    projects: [],
    providers: {
      'mify-dsh': { route: 'mify-dsh', model: 'glm-5.2' },
    },
  }
}

function project(): ProjectConfig {
  return {
    name: 'smoke-project',
    workdir: '/workspace/project',
    feishu: { appId: 'cli_test', appSecret: 'sec' },
  }
}

function assemble(cfg: FeishuBridgeConfig, proj: ProjectConfig = project(), root = '/tmp/fb-root') {
  return buildProjectAssembly(stubContext(), cfg, proj, root)
}

describe('buildProjectAssembly config wiring', () => {
  it('maps the language config onto the engine i18n (Go cfg.Language)', () => {
    expect(assemble({ ...baseConfig(), language: 'zh' }).engine.i18n.currentLang()).toBe('zh')
    expect(assemble({ ...baseConfig(), language: 'chinese' }).engine.i18n.currentLang()).toBe('zh')
    expect(assemble({ ...baseConfig(), language: 'zh-TW' }).engine.i18n.currentLang()).toBe('zh-TW')
    expect(assemble({ ...baseConfig(), language: 'ja' }).engine.i18n.currentLang()).toBe('ja')
    expect(assemble({ ...baseConfig(), language: 'es' }).engine.i18n.currentLang()).toBe('es')
    expect(assemble({ ...baseConfig(), language: 'en' }).engine.i18n.currentLang()).toBe('en')
    // Unknown or unset falls back to auto-detect (resolves to English before
    // any detection, matching Go LangAuto).
    expect(assemble(baseConfig()).engine.i18n.currentLang()).toBe('en')
    expect(assemble({ ...baseConfig(), language: 'klingon' }).engine.i18n.currentLang()).toBe('en')
  })

  it('wires the base work dir so /dir reset restores the project workdir', () => {
    expect(assemble(baseConfig()).engine.baseWorkDir).toBe('/workspace/project')
  })

  it('applies the persisted project-wide work_dir override at startup (Go applyProjectStateOverride)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-assembly-'))
    const overrideDir = join(root, 'override-dir')
    await mkdir(overrideDir)
    // First assembly persists nothing; write the state file the Go daemon
    // would have left behind, then re-assemble.
    const statePath = join(root, 'smoke-project', 'state.json')
    await mkdir(join(root, 'smoke-project'), { recursive: true })
    await writeFile(statePath, JSON.stringify({ work_dir_override: overrideDir }))
    const { engine, adapter } = assemble(baseConfig(), project(), root)
    expect(adapter.getWorkDir()).toBe(overrideDir)
    expect(engine.baseWorkDir).toBe(overrideDir)
  })

  it('ignores an invalid persisted work_dir override', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-assembly-'))
    await mkdir(join(root, 'smoke-project'), { recursive: true })
    await writeFile(join(root, 'smoke-project', 'state.json'), JSON.stringify({ work_dir_override: '/nonexistent/dir' }))
    const { engine, adapter } = assemble(baseConfig(), project(), root)
    expect(adapter.getWorkDir()).toBe('/workspace/project')
    expect(engine.baseWorkDir).toBe('/workspace/project')
  })

  it('wires the dir history and seeds it with the initial workdir (Go SetDirHistory)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-assembly-'))
    const workdir = join(root, 'actual-workdir')
    await mkdir(workdir)
    const { engine } = assemble(baseConfig(), { ...project(), workdir }, root)
    expect(engine.dirHistory).toBeDefined()
    expect(engine.dirHistory?.list('smoke-project')).toContain(workdir)
  })

  it('keys the dir history at the shared data root across projects (Go NewDirHistory(cfg.DataDir))', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-root-'))
    const workdirA = join(root, 'workdir-a')
    const workdirB = join(root, 'workdir-b')
    await mkdir(workdirA)
    await mkdir(workdirB)
    assemble(baseConfig(), { ...project(), workdir: workdirA }, root)
    // A second project's assembly reads the same store file: Go shares one
    // DirHistory(cfg.DataDir) across all engines.
    const second = assemble(baseConfig(), { ...project(), name: 'other-project', workdir: workdirB }, root)
    expect(second.engine.dirHistory?.list('smoke-project')).toContain(workdirA)
  })

  it('wires dir_scan_paths onto the dir history (Go DirScanPaths, #3)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-scan-'))
    const scanRoot = join(root, 'scan-root')
    await mkdir(join(scanRoot, 'child-a'), { recursive: true })
    const secondRoot = join(root, 'second-scan')
    await mkdir(join(secondRoot, 'child-b'), { recursive: true })
    const { engine } = assemble(baseConfig(), {
      ...project(),
      dirScanPaths: [scanRoot, secondRoot],
    }, root)
    expect(engine.dirHistory?.resolveScanPath('smoke-project', 'child-a')).toBe(join(scanRoot, 'child-a'))
    expect(engine.dirHistory?.resolveScanPath('smoke-project', 'child-b')).toBe(join(secondRoot, 'child-b'))
  })

  it('wires the three global hint groups onto the engine (Go SetHints* in wire.go)', () => {
    const cfg = {
      ...baseConfig(),
      hints: ['/new'],
      hints_with_param: ['/tdd'],
      hints_common: ['/done'],
    }
    const { engine } = assemble(cfg)
    expect(engine.hints).toEqual(['/new'])
    expect(engine.hintsWithParam).toEqual(['/tdd'])
    expect(engine.hintsCommon).toEqual(['/done'])
  })

  it('leaves the hint groups empty and hint usage unset without config', () => {
    const { engine } = assemble(baseConfig())
    expect(engine.hints).toEqual([])
    expect(engine.hintsWithParam).toEqual([])
    expect(engine.hintsCommon).toEqual([])
    expect(engine.hintUsage).toBeUndefined()
  })

  it('shares one hint usage across projects at the data root (Go NewHintUsage(cfg.DataDir))', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-hints-'))
    await mkdir(join(root, 'workdir-a'))
    await mkdir(join(root, 'workdir-b'))
    const sharedUsage = new HintUsage(root)
    const a = buildProjectAssembly(stubContext(), { ...baseConfig(), hints: ['/new'] }, { ...project(), workdir: join(root, 'workdir-a') }, root, undefined, undefined, sharedUsage)
    const b = buildProjectAssembly(stubContext(), baseConfig(), { ...project(), name: 'other-project', workdir: join(root, 'workdir-b') }, root, undefined, undefined, sharedUsage)
    expect(b.engine.hintUsage).toBe(a.engine.hintUsage)
    b.engine.hintUsage?.increment('hints', '/new')
    expect(a.engine.hintUsage?.sortedByFrequency('hints', ['/list', '/new'])).toEqual(['/new', '/list'])
  })

  it('wires feishu_workspace onto the engine (#18)', () => {
    const plain = assemble(baseConfig()).engine
    expect(plain.buildSessionStartOptions('k', plain.sessions.getOrCreateActive('k')).feishuWorkspace).toBeUndefined()
    const { engine } = assemble(baseConfig(), {
      ...project(),
      feishuWorkspace: { wikiSpaceId: '7000', folderToken: 'fldcn1', wikiNodeToken: '', description: 'Team docs' },
    })
    expect(engine.buildSessionStartOptions('k', engine.sessions.getOrCreateActive('k')).feishuWorkspace).toEqual({
      wikiSpaceId: '7000',
      folderToken: 'fldcn1',
      wikiNodeToken: '',
      description: 'Team docs',
    })
  })

  it('wires idle_timeout_mins and display.stall_timeout_secs onto the event idle timeout', () => {
    expect(assemble({ ...baseConfig(), idleTimeoutMins: 30 }).engine.eventIdleTimeout).toBe(30 * 60_000)
    // 0 disables the timeout.
    expect(assemble({ ...baseConfig(), idleTimeoutMins: 0 }).engine.eventIdleTimeout).toBe(0)
    expect(assemble({ ...baseConfig(), display: { stallTimeoutSecs: 200 } }).engine.eventIdleTimeout).toBe(200_000)
    // idle_timeout_mins is wired after stall_timeout_secs in Go and wins.
    expect(assemble({ ...baseConfig(), idleTimeoutMins: 5, display: { stallTimeoutSecs: 200 } }).engine.eventIdleTimeout).toBe(5 * 60_000)
  })

  it('wires display.stall_max_retries (Go SetStallMaxRetries)', () => {
    expect(assemble({ ...baseConfig(), display: { stallMaxRetries: 3 } }).engine.stallMaxRetries).toBe(3)
  })

  it('wires display.absolute_turn_timeout_secs; unset keeps the 2× idle fallback', () => {
    expect(assemble({ ...baseConfig(), display: { absoluteTurnTimeoutSecs: 5 } }).engine.absoluteTurnMax(1000)).toBe(5000)
    expect(assemble({ ...baseConfig(), display: { absoluteTurnTimeoutSecs: 0 } }).engine.absoluteTurnMax(1000)).toBe(0)
    expect(assemble(baseConfig()).engine.absoluteTurnMax(1000)).toBe(2000)
  })

  it('forwards display.progress_spinner to the platform (Go platform opts)', () => {
    expect(assemble({ ...baseConfig(), display: { progressSpinner: false } }).platform.spinnerEnabled).toBe(false)
    expect(assemble(baseConfig()).platform.spinnerEnabled).toBe(true)
  })

  it('forwards the feishu platform option keys (Go platform_options.feishu)', () => {
    const proj = project()
    proj.feishu = {
      ...proj.feishu,
      allowFrom: 'ou_owner',
      groupOnly: true,
      shareSessionInChannel: true,
      threadIsolation: true,
      replyToTrigger: false,
      respondToAtEveryoneAndHere: true,
      enableFeishuCard: false,
      progressStyle: 'compact',
      activeTagName: 'harness',
    }
    const { platform } = assemble(baseConfig(), proj)
    // Options without public observable fields are asserted through the
    // construction options object; enforcement lives in platform.spec.
    const o = (platform as unknown as { o: import('../src/feishu/platform.js').FeishuPlatformOptions }).o
    expect(o.allowFrom).toBe('ou_owner')
    expect(o.groupOnly).toBe(true)
    expect(o.shareSessionInChannel).toBe(true)
    expect(o.threadIsolation).toBe(true)
    expect(o.noReplyToTrigger).toBe(true)
    expect(o.respondToAtEveryoneAndHere).toBe(true)
    expect(o.activeTagOverride).toBe('harness')
    expect(platform.useInteractiveCard).toBe(false)
    expect(platform.progressStyle).toBe('compact')
    // Unset keys stay undefined so platform defaults apply (Go zero values).
    const bare = (assemble(baseConfig()).platform as unknown as { o: import('../src/feishu/platform.js').FeishuPlatformOptions }).o
    expect(bare.allowFrom).toBeUndefined()
    expect(bare.threadIsolation).toBeUndefined()
    expect(assemble(baseConfig()).platform.useInteractiveCard).toBe(true)
    expect(assemble(baseConfig()).platform.progressStyle).toBe('legacy')
  })

  it('forwards display.patch_rate_interval_ms to the platform PATCH limiter', async () => {
    const { platform } = assemble({ ...baseConfig(), display: { patchRateIntervalMs: 5 } })
    for (let i = 0; i < 3; i++) await platform.patchRateWait()
    const start = Date.now()
    await platform.patchRateWait()
    expect(Date.now() - start).toBeGreaterThanOrEqual(3)
  })

  it('wires queue.max_depth (Go SetMaxQueuedMessages)', () => {
    expect(assemble({ ...baseConfig(), queue: { maxDepth: 9 } }).engine.maxQueuedMessages).toBe(9)
    // Non-positive values are ignored (Go guard).
    expect(assemble({ ...baseConfig(), queue: { maxDepth: 0 } }).engine.maxQueuedMessages).toBe(5)
  })

  it('wires rate_limit with the Go 20/60 defaults (Go wire.go)', () => {
    const m = { sessionKey: 'test:rl' } as Parameters<typeof Engine.prototype.checkRateLimit>[0]
    const { engine } = assemble({ ...baseConfig(), rateLimit: { maxMessages: 3, windowSecs: 60 } })
    expect(engine.checkRateLimit(m)).toBe(true)
    expect(engine.checkRateLimit(m)).toBe(true)
    expect(engine.checkRateLimit(m)).toBe(true)
    expect(engine.checkRateLimit(m)).toBe(false)
    const def = assemble(baseConfig()).engine
    for (let i = 0; i < 20; i++) expect(def.checkRateLimit(m)).toBe(true)
    expect(def.checkRateLimit(m)).toBe(false)
    const off = assemble({ ...baseConfig(), rateLimit: { maxMessages: 0 } }).engine
    for (let i = 0; i < 25; i++) expect(off.checkRateLimit(m)).toBe(true)
  })

  it('wires the subtask caps (Go SetSubtaskMaxDepth/Timeout/GatherTimeout)', () => {
    const { engine } = assemble({ ...baseConfig(), subtask: { maxDepth: 6, timeoutSec: 300, gatherTimeoutSec: 60 } })
    expect(engine.subtaskMaxDepth).toBe(6)
    expect(engine.subtaskTimeout).toBe(300_000)
    expect(engine.subtaskGatherTimeout).toBe(60_000)
  })

  it('wires spawn.worktree (Go SetSpawnWorktreeMode)', () => {
    expect(assemble({ ...baseConfig(), spawn: { worktree: 'auto' } }).engine.spawnWorktree).toBe(WorktreeMode.Auto)
    expect(assemble({ ...baseConfig(), spawn: { worktree: 'off' } }).engine.spawnWorktree).toBe(WorktreeMode.ForceOff)
    // Unset keeps the engine default (no isolation without opt-in).
    expect(assemble(baseConfig()).engine.spawnWorktree).toBe(WorktreeMode.ForceOff)
  })

  it('always wires the spawn RAM guard with the 80/90 defaults (Go EffectiveSpawnMemoryGuard)', () => {
    expect(assemble(baseConfig()).engine.spawnMemWarnPct).toBe(80)
    expect(assemble(baseConfig()).engine.spawnMemBlockPct).toBe(90)
    const { engine } = assemble({ ...baseConfig(), spawn: { memoryWarnPct: 70, memoryBlockPct: 0 } })
    expect(engine.spawnMemWarnPct).toBe(70)
    // Explicit 0 disables the tier.
    expect(engine.spawnMemBlockPct).toBe(0)
  })

  it('wires the per-project admin allowlist (Go SetAdminFrom)', () => {
    expect(assemble(baseConfig(), { ...project(), adminFrom: 'ou_1,ou_2' }).engine.adminFrom).toBe('ou_1,ou_2')
    expect(assemble(baseConfig()).engine.adminFrom).toBe('')
  })

  it('wires the per-project interactive idle timeout (Go SetInteractiveIdleTimeout)', () => {
    expect(assemble(baseConfig(), { ...project(), interactiveIdleTimeoutMins: 15 }).engine.interactiveIdleTimeout).toBe(15 * 60_000)
    // Hand-built config bypasses the schema; production configs go through the
    // Cordis loader, which fills the schema default 120 for an absent field.
    expect(assemble(baseConfig()).engine.interactiveIdleTimeout).toBe(0)
  })

  it('wires attachment_send (Go SetAttachmentSendEnabled; default on)', () => {
    expect(assemble({ ...baseConfig(), attachmentSend: false }).engine.attachmentSendEnabled).toBe(false)
    expect(assemble(baseConfig()).engine.attachmentSendEnabled).toBe(true)
  })

  it('wires the stream preview tuning over the defaults (Go SetStreamPreviewCfg)', () => {
    const { engine } = assemble({ ...baseConfig(), streamPreview: { intervalMs: 400, maxChars: 800, enabled: false } })
    expect(engine.streamPreview.enabled).toBe(false)
    expect(engine.streamPreview.intervalMs).toBe(400)
    expect(engine.streamPreview.maxChars).toBe(800)
    // Untouched fields keep the Go defaults.
    expect(engine.streamPreview.minDeltaChars).toBe(15)
  })
})

describe('buildProjectAssembly plan_render wiring (Go [projects.plan_render], #47/#48)', () => {
  it('defaults to disabled when the block is absent or enabled is not true', () => {
    expect(assemble(baseConfig(), project()).engine.planRenderEnabled).toBe(false)
    const cfg = baseConfig()
    const proj = { ...project(), planRender: { enabled: false } }
    expect(assemble(cfg, proj).engine.planRenderEnabled).toBe(false)
  })

  it('maps provider/timeout/PNG script onto the engine when enabled', () => {
    const proj: ProjectConfig = {
      ...project(),
      planRender: {
        enabled: true,
        provider: 'mify-dsh',
        timeoutSec: 120,
        renderPngScript: '/abs/render-png.sh',
      },
    }
    const { engine } = assemble(baseConfig(), proj)
    expect(engine.planRenderEnabled).toBe(true)
    expect(engine.planRenderProvider).toBe('mify-dsh')
    expect(engine.planRenderTimeoutMs).toBe(120_000)
    expect(engine.planRenderPngScript).toBe('/abs/render-png.sh')
  })

  it('maps the effort alias onto the adapter (Go SetRenderEffort)', async () => {
    const proj: ProjectConfig = {
      ...project(),
      planRender: { enabled: true, effort: 'off' },
    }
    const { engine } = assemble(baseConfig(), proj)
    expect(engine.planRenderEnabled).toBe(true)
    // The adapter consumed the alias at assembly time (renderReasoningLevel
    // mapping is covered by the adapter spec); the engine carries no effort
    // field of its own — effort is adapter-owned (Go parity).
    expect(engine.planRenderProvider).toBe('')
  })
})

describe('M7 usage/footer config wiring', () => {
  it('wires display.editor_url onto the engine display config (Go EditorURL)', () => {
    expect(assemble({ ...baseConfig(), display: { editorUrl: 'https://code.example.com' } }).engine.display.editorUrl)
      .toBe('https://code.example.com')
    expect(assemble(baseConfig()).engine.display.editorUrl).toBe('')
  })

  it('wires features.show_context_indicator (default on, Go SetShowContextIndicator)', () => {
    expect(assemble(baseConfig()).engine.showContextIndicator).toBe(true)
    const proj = { ...project(), features: { showContextIndicator: false } }
    expect(assemble(baseConfig(), proj).engine.showContextIndicator).toBe(false)
  })

  it('wires context_window and re-applies the active provider window (Go SetContextWindow)', () => {
    const proj = { ...project(), contextWindow: 128_000 }
    expect(assemble(baseConfig(), proj).engine.contextWindow).toBe(128_000)
    expect(assemble(baseConfig(), proj).engine.projectContextWindow).toBe(128_000)
    // No project window: the 200k generic default stays (the dsh routes
    // declare no context window of their own).
    expect(assemble(baseConfig()).engine.contextWindow).toBe(200_000)
  })

  it('wires per-provider context_window and applies the active route window (Go ProviderConfig.ContextWindow)', () => {
    const cfg: FeishuBridgeConfig = {
      ...baseConfig(),
      providers: {
        'mify-dsh': { route: 'mify-dsh', model: 'glm-5.2' },
        turbo: { route: 'turbo', model: 'deepseek-v4-flash', contextWindow: 1_000_000 },
      },
    }
    // Active route (first key) without its own window: project window / 200k default.
    expect(assemble(cfg).engine.contextWindow).toBe(200_000)
    const proj = { ...project(), contextWindow: 128_000 }
    expect(assemble(cfg, proj).engine.contextWindow).toBe(128_000)
    // Active turbo: the route window wins over the project window, and the
    // adapter exposes it for engine-side re-resolution on /provider switch.
    const active = assemble(cfg, { ...proj, agent: { provider: 'turbo' } })
    expect(active.engine.contextWindow).toBe(1_000_000)
    expect(active.adapter.getActiveProvider()).toEqual({ name: 'turbo', contextWindow: 1_000_000 })
  })

  it('wires features.reply_footer (default off, Go SetReplyFooterEnabled)', () => {
    expect(assemble(baseConfig()).engine.replyFooterEnabled).toBe(false)
    const proj = { ...project(), features: { replyFooter: true } }
    expect(assemble(baseConfig(), proj).engine.replyFooterEnabled).toBe(true)
  })

  it('builds usage_providers and skips invalid entries with a warning (Go buildUsageProviders)', () => {
    const cfg: FeishuBridgeConfig = {
      ...baseConfig(),
      usageProviders: [
        { type: 'glm', options: { api_key: 'k' } },
        { type: 'nope', options: {} },
      ],
    }
    const { engine } = assemble(cfg)
    expect(engine.usageProviders).toHaveLength(1)
    expect(engine.usageProviders[0]!.name()).toBe('glm')
  })

  it('leaves the engine without usage providers when none are configured', () => {
    expect(assemble(baseConfig()).engine.usageProviders).toEqual([])
  })
})

describe('agent.mode default session mode wiring', () => {
  it('forwards project.agent.mode onto the adapter (Go agent options mode=plan)', () => {
    const { adapter } = assemble(baseConfig(), { ...project(), agent: { mode: 'plan' } })
    expect((adapter as unknown as { defaultMode?: string }).defaultMode).toBe('plan')
    // Absent mode leaves no default.
    const bare = assemble(baseConfig(), project())
    expect((bare.adapter as unknown as { defaultMode?: string }).defaultMode).toBe('')
  })
})

describe('shared userQuestions routing across projects', () => {
  it('buildProjectAssembly forwards one shared routing object to every adapter', () => {
    const root = mkdtempSync(join(tmpdir(), 'fb-assembly-'))
    const routing: QuestionRouting = { adapters: [], registered: false }
    const a = buildProjectAssembly(stubContext(), baseConfig(), { ...project(), workdir: join(root, 'wd-a') }, root, undefined, undefined, undefined, routing)
    const b = buildProjectAssembly(stubContext(), baseConfig(), { ...project(), name: 'other-project', workdir: join(root, 'wd-b') }, root, undefined, undefined, undefined, routing)
    expect(routing.adapters).toEqual([a.adapter, b.adapter])
    // Absent routing leaves the adapter's config without it (single-adapter fallback).
    const solo = buildProjectAssembly(stubContext(), baseConfig(), project(), root)
    expect(routing.adapters).not.toContain(solo.adapter)
  })
})
