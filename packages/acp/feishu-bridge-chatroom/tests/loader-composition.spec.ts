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
import SessionStore from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as bridgeEntry from '@deepseek-ai/dsh-feishu-bridge'
import {
  featureStateCodecs,
  lookupMessage,
} from '@deepseek-ai/dsh-feishu-bridge/exports'
import * as chatroomEntry from '../src/index.js'

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
      '- id: feishu-bridge',
      "  name: '@deepseek-ai/dsh-feishu-bridge'",
      '  config:',
      `    dataDir: ${JSON.stringify(join(root, 'data'))}`,
      '    providers: {}',
      '    projects:',
      '      - name: alpha',
      `        workdir: ${JSON.stringify(root)}`,
      '        feishu:',
      // Deliberately malformed app id: the Lark SDK rejects it locally, so
      // the WS transport never leaves the machine while start() still
      // resolves (see the module docblock).
      '          appId: cli_composition',
      '          appSecret: c0mp0sition',
      '- id: feishu-bridge-chatroom',
      "  name: '@deepseek-ai/dsh-feishu-bridge-chatroom'",
      '  config:',
      '    projects:',
      '      alpha: {}',
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-skill', SkillRegistry],
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
    expect(service.projects).toHaveLength(1)
    const engine = service.projects[0]!.engine
    expect(engine.name).toBe('alpha')

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
      ['start', 'ask', 'gather', 'pick-roles', 'pick-topic', 'ask-human', 'end', 'list', 'note'],
    )

    // User-visible: the /chatroom command family on the live engine,
    // resolvable through the engine's command resolver. The short '/cr'
    // alias intentionally stays unasserted here: the full composition also
    // registers the bridge's /cron, whose prefix match wins the resolver
    // chain for the ambiguous two-letter form.
    expect(engine.commandHandlers?.has('chatroom')).toBe(true)
    expect(engine.commandResolver?.('chatroom')).toBe('chatroom')
    expect(engine.commandResolver?.('chatr')).toBe('chatroom')

    // Durable: the chatroom feature-state codec (snapshot v3 section owner).
    expect(featureStateCodecs().some(codec => codec.key === 'chatroom')).toBe(true)

    // User-visible: the chatroom i18n subtable resolves through the bridge's
    // lookup (a missing registration would return the raw key).
    expect(lookupMessage('zh', 'chatroom')).toBe('开启多角色圆桌讨论')

    // Model-visible: the bundled chatroom-moderator skill through the skills
    // provider the plugin mounts from its package directory.
    const skills = await context.skills.list()
    const moderator = skills.find(skill => skill.name === 'feishu-bridge-chatroom-moderator')
    expect(moderator?.provider).toBe('feishu-bridge-chatroom-skills')
  })
})
