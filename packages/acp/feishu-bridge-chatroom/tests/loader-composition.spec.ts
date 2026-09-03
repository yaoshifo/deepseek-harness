/**
 * Real-composition guard (packages/AGENTS.md): the real bridge plugin and the
 * real chatroom plugin boot from a test-only cordis.yml through the actual
 * Loader + Include path — the same machinery a profile uses — and the
 * composed tree shows every model-visible / user-visible face: the
 * `/chatroom` command family on the live engine, the `feishu_bridge_chatroom`
 * tool in the model-facing tool schemas, the feature-state codec, the i18n
 * subtable, and the bundled skills provider. The engine, platform, adapter,
 * and service assemblies are the production ones; only the external Feishu
 * boundary is kept offline — global `fetch` is stubbed for the REST probes
 * the platform runs at startup (tenant token, bot info), and the app id is
 * deliberately malformed so the Lark SDK's WS client rejects it locally and
 * never opens a connection (`start` still resolves, so the real engine-start
 * path completes and `platformsStarted` turns true).
 *
 * @module dsh-feishu-bridge-chatroom/tests-loader-composition
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as bridgeEntry from '@deepseek-ai/dsh-feishu-bridge'
import {
  featureStateCodecs,
  lookupMessage,
} from '@deepseek-ai/dsh-feishu-bridge/exports'
import * as chatroomEntry from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Poll until `test` holds; the offline platform start resolves in ticks. */
async function eventually(test: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!test()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
}

describe('chatroom real Loader composition', () => {
  it('boots bridge + chatroom from cordis.yml and mounts the full product face', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-chatroom-composition-'))
    // The Feishu REST boundary is faked: the platform's startup probes
    // (tenant token, bot info) answer offline; any other URL is a bug in the
    // composition's offline guarantee. The avatar stays empty so no upload
    // follows.
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.includes('tenant_access_token')) {
        return { json: async () => ({ tenant_access_token: 'composition-token' }) } as never
      }
      if (url.includes('/bot/v3/info')) {
        return { json: async () => ({ code: 0, bot: { open_id: 'ou_composition', app_name: 'composition-bot', avatar_url: '' } }) } as never
      }
      throw new Error(`composition spec: unexpected fetch: ${url}`)
    }))

    const configPath = join(root, 'cordis.yml')
    const alphaDir = join(root, 'alpha')
    const betaDir = join(root, 'beta')
    await writeFile(configPath, [
      '- id: agents',
      "  name: '@deepseek-ai/dsh-agent'",
      '- id: sessions',
      "  name: '@deepseek-ai/dsh-session'",
      '- id: system-prompt',
      "  name: '@deepseek-ai/dsh-system-prompt'",
      '- id: tools',
      "  name: '@deepseek-ai/dsh-tools'",
      '- id: skills',
      "  name: '@deepseek-ai/dsh-skill'",
      // The bridge declares sessionProjections in its inject (the /context
      // card reads the registry); dsh-base always mounts it, so the minimal
      // composition mirrors that row or the bridge fiber stays inactive.
      '- id: session-projection',
      "  name: '@deepseek-ai/dsh-session-projection'",
      // The cross-project assertion creates a real agent through the gated
      // project's adapter, so the composition carries the real factory pair
      // dsh-base always mounts (no turns run; the LLM runtime is never
      // called).
      '- id: llm',
      "  name: '@deepseek-ai/dsh-llm'",
      '- id: agent-loop',
      "  name: '@deepseek-ai/dsh-agent-loop'",
      '- id: feishu-bridge',
      "  name: '@deepseek-ai/dsh-feishu-bridge'",
      '  config:',
      `    dataDir: ${JSON.stringify(join(root, 'data'))}`,
      '    providers: {}',
      '    projects:',
      '      - name: alpha',
      `        workdir: ${JSON.stringify(alphaDir)}`,
      '        feishu:',
      // Deliberately malformed app id: the Lark SDK rejects it locally, so
      // the WS transport never leaves the machine while start() still
      // resolves (see the module docblock).
      '          appId: cli_composition',
      '          appSecret: c0mp0sition',
      // A second project the chatroom config gates off: the same real
      // composition must mount its engine but skip the chatroom face on it
      // (its own workdir, so the cwd-scoped skill assertions can tell the
      // two projects apart).
      '      - name: beta',
      `        workdir: ${JSON.stringify(betaDir)}`,
      '        feishu:',
      '          appId: cli_composition2',
      '          appSecret: c0mp0sition',
      '- id: feishu-bridge-chatroom',
      "  name: '@deepseek-ai/dsh-feishu-bridge-chatroom'",
      '  config:',
      '    projects:',
      '      alpha: {}',
      '      beta:',
      '        enabled: false',
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-agent-loop', AgentLoop],
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-skill', SkillRegistry],
      ['@deepseek-ai/dsh-llm', LlmRuntime],
      ['@deepseek-ai/dsh-feishu-bridge', bridgeEntry],
      ['@deepseek-ai/dsh-feishu-bridge-chatroom', chatroomEntry],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    const service = context.get('feishuBridge')
    if (service === undefined) throw new Error('the Loader composition did not mount the feishuBridge service')
    expect(service.projects).toHaveLength(2)
    const engine = service.projects[0]!.engine
    expect(engine.name).toBe('alpha')
    const gatedEngine = service.projects[1]!.engine
    expect(gatedEngine.name).toBe('beta')

    // The offline-faked platform still completed the real start path, so the
    // composition proved the full apply chain (adapter, engine, platform).
    await eventually(() => engine.platformsStarted, 'the composed engine never started its platform')

    // Model-visible: the tool sits in the registry's exported schemas with
    // its full action enum.
    const schema = context.tools.schemas().find(entry => entry.name === 'feishu_bridge_chatroom') as
      | { name: string; parameters?: { properties?: { action?: { enum?: string[] } } } }
      | undefined
    expect(schema).toBeDefined()
    expect(schema?.parameters?.properties?.action?.enum).toEqual(
      ['start', 'ask', 'gather', 'pick-roles', 'pick-topic', 'ask-human', 'end', 'list', 'note', 'history'],
    )

    // User-visible: the /chatroom command family on the live engine,
    // resolvable through the engine's command resolver. The short '/cr'
    // alias intentionally stays unasserted here: the full composition also
    // registers the bridge's /cron, whose prefix match wins the resolver
    // chain for the ambiguous two-letter form.
    expect(engine.commandHandlers?.has('chatroom')).toBe(true)
    expect(engine.commandResolver?.('chatroom')).toBe('chatroom')
    expect(engine.commandResolver?.('chatr')).toBe('chatroom')

    // Gated project: no /chatroom command family, and the tool name sits on
    // the service's per-engine deny registry — the adapter's create-time
    // mask reads that registry (pinned in the bridge's adapter-mcp-mask
    // spec); the registry itself is what this real composition proves.
    expect(gatedEngine.commandHandlers?.has('chatroom')).toBe(false)
    expect(service.deniedToolsOf(gatedEngine)).toEqual(['feishu_bridge_chatroom'])
    expect(service.deniedToolsOf(engine)).toEqual([])

    // Durable: the chatroom feature-state codec (snapshot v3 section owner).
    expect(featureStateCodecs().some(codec => codec.key === 'chatroom')).toBe(true)

    // User-visible: the chatroom i18n subtable resolves through the bridge's
    // lookup (a missing registration would return the raw key).
    expect(lookupMessage('zh', 'chatroom')).toBe('开启多角色圆桌讨论')

    // Model-visible: the bundled chatroom-moderator skill through the skills
    // provider the plugin mounts from its package directory — cwd-scoped to
    // the enabled project's workdir (the gated project's cwd sees nothing).
    const alphaSkills = await context.skills.list({ cwd: alphaDir })
    const moderator = alphaSkills.find(skill => skill.name === 'feishu-bridge-chatroom-moderator')
    expect(moderator?.provider).toBe('feishu-bridge-chatroom-skills')
    expect((await context.skills.list({ cwd: betaDir }))
      .some(skill => skill.name === 'feishu-bridge-chatroom-moderator')).toBe(false)

    // Cross-project cwd (the oc_0ace leak shape): a gated project's session
    // whose workdir falls under the ENABLED project's workdir — a spawn
    // workspace override — still must not see the moderator skill. The
    // per-engine skill denial, applied by the real adapter's setup hook,
    // does the masking; the unscoped view at the same cwd keeps the entry.
    const gatedAdapter = service.projects[1]!.adapter
    const crossSession = await gatedAdapter.startSession('', {
      sessionKey: 'feishu:oc_cross',
      workDir: alphaDir,
    })
    const crossAgent = context.agents.get(SessionId(crossSession.currentSessionID()))
    expect(crossAgent).toBeDefined()
    expect((await context.skills.list({ cwd: alphaDir, scope: crossAgent }))
      .some(skill => skill.name === 'feishu-bridge-chatroom-moderator')).toBe(false)
    expect(alphaSkills.some(skill => skill.name === 'feishu-bridge-chatroom-moderator')).toBe(true)
  })
})
