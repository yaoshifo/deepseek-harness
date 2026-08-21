/**
 * Ported from cc-connect cmd/cc-connect/lark_cmd_test.go (the pure-function
 * tables) plus runner and registration behavior tests: the `feishu_bridge_lark`
 * tool routes by caller agent, injects the project's bot credentials (bot
 * mode mints a TAT; --as user / auth prepend --profile <app_id> and strip
 * LARKSUITE_CLI_*), rejects cross-project --profile escapes, auto-grants
 * org visibility after +create, and serves im +chat-messages-list natively
 * through the OpenAPI. The Go envWithoutCCProject/sanitizedLarkEnv tests are
 * not ported: their recursion trap (~/bin/lark-cli routing back through
 * CC_PROJECT) is a shell-wrapper concern the in-process tool does not have.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentCancelCause, InboxTarget } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { Engine } from '../../src/engine/engine.js'
import { createStubAgent, createStubPlatform } from '../stubs/engine-stubs.js'
import {
  buildListMessagesURL,
  checkLarkCLIVersionAgainstMin,
  cleanMessageItem,
  compareVersions,
  decodeMessageText,
  extractProfileFlag,
  extractResourceToken,
  extractResourceType,
  isAsUser,
  isAuthSubcommand,
  isChatMessagesList,
  parseLarkCLIVersionOutput,
  parseListMessagesArgs,
  registerLarkTool,
  runLarkInvocation,
  type LarkChildResult,
  type LarkRunnerDeps,
} from '../../src/tools/lark.js'

const creds = { appId: 'cli_app', appSecret: 'sec' }

describe('isAsUser', () => {
  it.each([
    ['docs +search --as user', ['docs', '+search', '--as', 'user'], true],
    ['--as=user', ['docs', '+search', '--as=user'], true],
    ['tail --as=user', ['calendar', '+list', '--as=user'], true],
    ['leading --as user', ['--as', 'user', 'docs', '+search'], true],
    ['explicit bot', ['docs', '+create', '--as', 'bot'], false],
    ['no flag', ['docs', '+search'], false],
    ['empty', [], false],
    ['trailing --as', ['docs', '+search', '--as'], false],
    ['positional user token', ['docs', '+search', '--query', 'user'], false],
    ['--as=bot', ['docs', '+create', '--as=bot'], false],
  ])('%s', (_name, args, want) => {
    expect(isAsUser(args)).toBe(want)
  })
})

describe('isAuthSubcommand', () => {
  it.each([
    ['auth login', ['auth', 'login', '--scope', 'x'], true],
    ['auth logout', ['auth', 'logout'], true],
    ['auth status', ['auth', 'status'], true],
    ['auth whoami', ['auth', 'whoami'], true],
    ['auth status --verify', ['auth', 'status', '--verify'], true],
    ['leading flags then auth login', ['--profile', 'x', 'auth', 'login'], true],
    ['docs +search', ['docs', '+search'], false],
    ['calendar auth', ['calendar', 'auth'], false],
    ['bare auth', ['auth'], false],
    ['auth unknown sub', ['auth', 'randomsub'], false],
    ['author', ['author', 'login'], false],
    ['empty', [], false],
  ])('%s', (_name, args, want) => {
    expect(isAuthSubcommand(args)).toBe(want)
  })
})

describe('extractProfileFlag', () => {
  it.each([
    ['spaced', ['docs', '+search', '--profile', 'cli_x'], 'cli_x'],
    ['equals', ['docs', '+search', '--profile=cli_y'], 'cli_y'],
    ['leading', ['--profile', 'cli_z', 'docs'], 'cli_z'],
    ['absent', ['docs', '+search'], ''],
    ['trailing no-value', ['docs', '--profile'], ''],
    ['empty', [], ''],
    ['substring --profiled', ['--profiled', 'value'], ''],
  ])('%s', (_name, args, want) => {
    expect(extractProfileFlag(args)).toBe(want)
  })
})

describe('isChatMessagesList', () => {
  it.each([
    ['im +chat-messages-list', ['im', '+chat-messages-list', '--chat-id', 'oc_x'], true],
    ['im messages delete', ['im', 'messages', 'delete', '--as', 'bot'], false],
    ['im chats', ['im', 'chats'], false],
    ['docs +search', ['docs', '+search', '--as', 'user'], false],
    ['bare without im', ['+chat-messages-list', '--chat-id', 'oc_x'], false],
    ['empty', [], false],
  ])('%s', (_name, args, want) => {
    expect(isChatMessagesList(args)).toBe(want)
  })
})

describe('parseListMessagesArgs', () => {
  it('defaults', () => {
    const { opts, error } = parseListMessagesArgs(['--chat-id', 'oc_x'])
    expect(error).toBeUndefined()
    expect(opts).toEqual({ chatId: 'oc_x', pageSize: 50, sortType: 'ByCreateTimeDesc', format: 'json', pageAll: false, pageLimit: 10, pageToken: '' })
  })

  it('sort asc / as-bot ignored / ndjson + page-all / page-token', () => {
    expect(parseListMessagesArgs(['--chat-id', 'oc_x', '--sort', 'asc']).opts.sortType).toBe('ByCreateTimeAsc')
    expect(parseListMessagesArgs(['--chat-id', 'oc_x', '--as', 'bot']).opts.chatId).toBe('oc_x')
    const paged = parseListMessagesArgs(['--chat-id', 'oc_x', '--format', 'ndjson', '--page-all', '--page-limit', '3'])
    expect(paged.opts.format).toBe('ndjson')
    expect(paged.opts.pageAll).toBe(true)
    expect(paged.opts.pageLimit).toBe(3)
    expect(parseListMessagesArgs(['--chat-id', 'oc_x', '--page-token', 'tok']).opts.pageToken).toBe('tok')
  })

  it('rejects missing chat-id and --user-id', () => {
    expect(parseListMessagesArgs(['--sort', 'asc']).error).toBeDefined()
    expect(parseListMessagesArgs(['--user-id', 'ou_x']).error).toBeDefined()
  })

  it('clamps page-size', () => {
    expect(parseListMessagesArgs(['--chat-id', 'oc_x', '--page-size', '200']).opts.pageSize).toBe(50)
    expect(parseListMessagesArgs(['--chat-id', 'oc_x', '--page-size', '0']).opts.pageSize).toBe(1)
  })
})

describe('buildListMessagesURL', () => {
  it('carries the container, sort, and raw-card params', () => {
    const opts = parseListMessagesArgs(['--chat-id', 'oc_x', '--sort', 'asc', '--page-size', '5']).opts
    const u = buildListMessagesURL('https://open.feishu.cn', opts, '')
    for (const want of ['container_id=oc_x', 'container_id_type=chat', 'page_size=5', 'sort_type=ByCreateTimeAsc', 'card_msg_content_type=raw_card_content']) {
      expect(u).toContain(want)
    }
    expect(buildListMessagesURL('https://open.feishu.cn', opts, 'tok123')).toContain('page_token=tok123')
  })
})

describe('decodeMessageText', () => {
  it.each([
    ['text', 'text', '{"text":"hello"}', 'hello'],
    ['markdown', 'markdown', '{"text":"# hi"}', '# hi'],
    ['post', 'post', '{"title":"T","content":[[{"tag":"text","text":"a"},{"tag":"at","user_id":"u"}],[{"tag":"text","text":"b"}]]}', 'Tab'],
    ['image unsupported', 'image', '{"image_key":"k"}', ''],
    ['invalid json', 'text', '{not json', ''],
  ])('%s', (_name, msgType, body, want) => {
    expect(decodeMessageText(msgType, body)).toBe(want)
  })
})

describe('cleanMessageItem', () => {
  it('projects the stable output shape', () => {
    const cleaned = cleanMessageItem({
      message_id: 'om_1',
      create_time: '1700000000',
      message_type: 'text',
      sender: { id_type: 'open_id', id: 'ou_1', name: '韩明' },
      body: { content: '{"text":"hi"}' },
    })
    expect(cleaned.message_id).toBe('om_1')
    expect(cleaned.text).toBe('hi')
    expect(cleaned.body_content).toBe('{"text":"hi"}')
    expect((cleaned.sender as Record<string, unknown>).id).toBe('ou_1')
  })
})

describe('compareVersions / parseLarkCLIVersionOutput / min check', () => {
  it.each([
    ['older', '1.0.0', '1.0.69', -1],
    ['equal', '1.0.69', '1.0.69', 0],
    ['newer', '1.0.70', '1.0.69', 1],
    ['dirty suffix equal', '1.0.16-1-g018eeb6-dirty', '1.0.16', 0],
    ['v prefix', 'v1.0.69', '1.0.69', 0],
    ['dirty older than min', '1.0.16-1-g018eeb6-dirty', '1.0.69', -1],
    ['minor diff', '1.1.0', '1.0.69', 1],
    ['major diff', '2.0.0', '1.0.69', 1],
  ])('%s', (_name, a, b, want) => {
    const got = compareVersions(a, b)
    expect(got < 0 ? -1 : got > 0 ? 1 : 0).toBe(want)
  })

  it.each([
    ['npm format', 'lark-cli version 1.0.0\n', '1.0.0'],
    ['dirty suffix', 'lark-cli version v1.0.16-1-g018eeb6-dirty\n', '1.0.16-1-g018eeb6-dirty'],
    ['bare', '1.0.69\n', '1.0.69'],
  ])('parses %s', (_name, out, want) => {
    expect(parseLarkCLIVersionOutput(out)).toBe(want)
  })

  it('rejects empty and garbage output', () => {
    expect(() => parseLarkCLIVersionOutput('')).toThrow()
    expect(() => parseLarkCLIVersionOutput('not a version at all\n\nrandom\n')).toThrow()
  })

  it('gates on the minimum version', () => {
    expect(checkLarkCLIVersionAgainstMin('1.0.69')).toBeUndefined()
    expect(checkLarkCLIVersionAgainstMin('1.0.70')).toBeUndefined()
    expect(checkLarkCLIVersionAgainstMin('1.0.69-1-gabcdef-dirty')).toBeUndefined()
    expect(checkLarkCLIVersionAgainstMin('1.0.0')).toBeDefined()
  })
})

describe('extractResourceToken / extractResourceType', () => {
  it('pulls the token from the supported response shapes', () => {
    expect(extractResourceToken('{"data":{"doc_id":"doccn1"}}')).toBe('doccn1')
    expect(extractResourceToken('{"data":{"token":"shtcn1"}}')).toBe('shtcn1')
    expect(extractResourceToken('{"data":{"app_token":"bascn1"}}')).toBe('bascn1')
    expect(extractResourceToken('{"data":{"spread":{"token":"shtcn2"}}}')).toBe('shtcn2')
    expect(extractResourceToken('{"data":{"base":{"base_token":"bascn2"}}}')).toBe('bascn2')
    expect(extractResourceToken('not json')).toBe('')
    expect(extractResourceToken('{"data":{}}')).toBe('')
  })

  it('maps commands to permission types', () => {
    expect(extractResourceType(['docs', '+create'])).toBe('docx')
    expect(extractResourceType(['sheets', '+create'])).toBe('sheet')
    expect(extractResourceType(['base', '+create'])).toBe('bitable')
    expect(extractResourceType(['wiki', '+create'])).toBe('wiki')
    expect(extractResourceType(['im', 'x'])).toBe('')
  })
})

// ── runner behavior ───────────────────────────────────────────────────────

/** Recording spawn + fetch double; version cache IO intentionally absent (check skipped). */
function fakeDeps(overrides: Partial<{ spawn: LarkRunnerDeps['spawn']; fetch: LarkRunnerDeps['fetch'] }> = {}): {
  deps: LarkRunnerDeps
  spawns: Array<{ bin: string; argv: string[]; env: Record<string, string> }>
  fetches: Array<{ url: string; init: RequestInit | undefined }>
} {
  const spawns: Array<{ bin: string; argv: string[]; env: Record<string, string> }> = []
  const fetches: Array<{ url: string; init: RequestInit | undefined }> = []
  const deps: LarkRunnerDeps = {
    baseEnv: { PATH: '/usr/bin', HOME: '/home/u', CC_PROJECT: 'other' },
    async spawn(bin, argv, opts) {
      spawns.push({ bin, argv, env: opts.env })
      if (overrides.spawn !== undefined) return overrides.spawn(bin, argv, opts)
      const r: LarkChildResult = { stdout: 'ok', stderr: '', code: 0 }
      return r
    },
    async fetch(url, init) {
      fetches.push({ url, init })
      if (overrides.fetch !== undefined) return overrides.fetch(url, init)
      const body = url.includes('tenant_access_token')
        ? { code: 0, tenant_access_token: 'tat-0' }
        : { code: 0 }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  }
  return { deps, spawns, fetches }
}

function jsonFetchHandler(bodyFor: (url: string, init?: RequestInit) => unknown): LarkRunnerDeps['fetch'] {
  return async (url, init) => new Response(JSON.stringify(bodyFor(url, init)), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

describe('runLarkInvocation', () => {
  it('bot mode mints a TAT and injects the credential env', async () => {
    const fetch = jsonFetchHandler((url): unknown => url.includes('tenant_access_token')
      ? { code: 0, tenant_access_token: 'tat-1' }
      : { code: 0 })
    const { deps, spawns, fetches } = fakeDeps({ fetch })
    const out = await runLarkInvocation(creds, ['docs', '+search', '--query', 'x'], { deps })
    expect(out).toBe('ok')
    expect(fetches.length).toBe(1)
    expect(spawns).toHaveLength(1)
    const env = spawns[0]?.env ?? {}
    expect(env.LARKSUITE_CLI_APP_ID).toBe('cli_app')
    expect(env.LARKSUITE_CLI_APP_SECRET).toBe('sec')
    expect(env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN).toBe('tat-1')
    expect(env.LARKSUITE_CLI_BRAND).toBe('feishu')
    expect(env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER).toBe('1')
    expect(env.PATH).toBe('/usr/bin')
    // The daemon's routing env never leaks into the child.
    expect(env.CC_PROJECT).toBeUndefined()
  })

  it('user mode prepends --profile and strips LARKSUITE_CLI_*', async () => {
    const { deps, spawns } = fakeDeps()
    await runLarkInvocation(creds, ['docs', '+search', '--as', 'user'], { deps })
    expect(spawns[0]?.argv).toEqual(['--profile', 'cli_app', 'docs', '+search', '--as', 'user'])
    const env = spawns[0]?.env ?? {}
    expect(env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN).toBeUndefined()
    expect(env.LARKSUITE_CLI_APP_ID).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
  })

  it('auth subcommands route through the user path without a TAT fetch', async () => {
    const { deps, spawns, fetches } = fakeDeps()
    await runLarkInvocation(creds, ['auth', 'status'], { deps })
    expect(spawns[0]?.argv).toEqual(['--profile', 'cli_app', 'auth', 'status'])
    expect(fetches).toHaveLength(0)
  })

  it('rejects an explicit --profile from another project', async () => {
    const { deps } = fakeDeps()
    await expect(runLarkInvocation(creds, ['docs', '+search', '--as', 'user', '--profile', 'cli_other'], { deps }))
      .rejects.toThrow(/cross project boundaries/)
  })

  it('accepts an explicit --profile matching this project', async () => {
    const { deps, spawns } = fakeDeps()
    await runLarkInvocation(creds, ['docs', '+search', '--as', 'user', '--profile', 'cli_app'], { deps })
    expect(spawns[0]?.argv).toEqual(['docs', '+search', '--as', 'user', '--profile', 'cli_app'])
  })

  it('auto-grants org visibility after a successful +create', async () => {
    const { deps, spawns, fetches } = fakeDeps()
    const withCreate = { ...deps, spawn: async (bin: string, argv: string[], opts: { env: Record<string, string> }) => {
      spawns.push({ bin, argv, env: opts.env })
      return { stdout: '{"ok":true,"data":{"doc_id":"doccn9"}}', stderr: '', code: 0 }
    } }
    const out = await runLarkInvocation(creds, ['docs', '+create', '--title', 't'], { deps: withCreate })
    expect(out).toContain('doccn9')
    const grant = fetches.find(f => f.url.includes('/permissions/doccn9/public'))
    expect(grant).toBeDefined()
    expect(grant?.init?.method).toBe('PATCH')
    expect(JSON.stringify(grant?.init?.body)).toContain('same_tenant')
  })

  it('create failures skip the grant', async () => {
    const { deps, fetches } = fakeDeps()
    const failCreate = { ...deps, spawn: async () => ({ stdout: 'boom', stderr: 'err', code: 1 }) }
    const out = await runLarkInvocation(creds, ['docs', '+create'], { deps: failCreate })
    expect(out).toContain('boom')
    expect(fetches.filter(f => f.url.includes('tenant_access_token'))).toHaveLength(1)
    expect(fetches.find(f => f.url.includes('/permissions/'))).toBeUndefined()
  })

  it('im +chat-messages-list is served natively without spawning lark-cli', async () => {
    const { deps, spawns, fetches } = fakeDeps({
      fetch: jsonFetchHandler((url) => {
        if (url.includes('tenant_access_token')) return { code: 0, tenant_access_token: 'tat-2' }
        return {
          code: 0,
          data: {
            items: [{ message_id: 'om_1', message_type: 'text', sender: { id: 'ou_1' }, body: { content: '{"text":"hi"}' } }],
            has_more: false,
            page_token: '',
          },
        }
      }),
    })
    const out = await runLarkInvocation(creds, ['im', '+chat-messages-list', '--chat-id', 'oc_x'], { deps })
    expect(spawns).toHaveLength(0)
    const list = fetches.find(f => f.url.includes('/open-apis/im/v1/messages'))
    expect(list).toBeDefined()
    expect(list?.init?.headers).toMatchObject({ Authorization: 'Bearer tat-2' })
    const parsed = JSON.parse(out) as { items: Array<{ message_id: string; text: string }> }
    expect(parsed.items[0]?.message_id).toBe('om_1')
    expect(parsed.items[0]?.text).toBe('hi')
  })

  it('rejects empty args', async () => {
    const { deps } = fakeDeps()
    await expect(runLarkInvocation(creds, [], { deps })).rejects.toThrow(/non-empty/)
  })

  it('surfaces child stderr alongside stdout', async () => {
    const { deps } = fakeDeps({ spawn: async () => ({ stdout: 'out', stderr: 'warn', code: 0 }) })
    expect(await runLarkInvocation(creds, ['docs', '+search'], { deps })).toBe('out\nwarn')
  })
})

// ── registration over a real Cordis Context ───────────────────────────────

const signal = new AbortController().signal
const contexts: Context[] = []

function stubAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  return {
    id: session.id,
    options: {},
    session,
    inbox,
    status: 'idle',
    ctx: new Context(),
    send(_message: UserMessage, _target: InboxTarget, _wakeup: boolean) {},
    runMaintenance: task => task(signal),
    cancel(_cause: AgentCancelCause) {},
    whenIdle: () => Promise.resolve(),
    followup(_message: UserMessage) {},
    steer(_message: UserMessage) {},
    inject(_message: UserMessage) {},
  }
}

type TestRoute = { engine: Engine; sessionKey: string; creds: { appId: string; appSecret: string } }

async function harness(route: (agent: unknown) => TestRoute | undefined, deps?: LarkRunnerDeps) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  const agent = stubAgent(ctx, `lark-tool-${Math.random()}`)
  ctx.agents.register(agent)
  const dispose = registerLarkTool(ctx, route, deps)
  return { ctx, agent, dispose }
}

async function execute(test: { ctx: Context; agent: Agent }, args: unknown): Promise<ToolExecutionResult> {
  return test.ctx.agents.withInitiator(test.agent, () => test.ctx.tools.execute({
    signal,
    callId: CallId(`call-${Math.random()}`),
    name: 'feishu_bridge_lark',
    arguments: args,
    agent: test.agent,
  }))
}

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('feishu_bridge_lark registration', () => {
  it('registers on ctx.tools and disposes cleanly (HMR safety)', async () => {
    const engine = new Engine('test', createStubAgent(), [createStubPlatform()], '', 'en')
    const test = await harness(() => ({ engine, sessionKey: 'test:chat', creds }))
    expect(test.ctx.tools.get('feishu_bridge_lark')?.name).toBe('feishu_bridge_lark')
    test.dispose()
    test.dispose() // idempotent
    expect(test.ctx.tools.get('feishu_bridge_lark')).toBeUndefined()
  })

  it('a foreign caller fails loud', async () => {
    const test = await harness(() => undefined, fakeDeps().deps)
    const result = await execute(test, { args: ['docs', '+search'] })
    expect(result.isError).toBe(true)
  })

  it('routes the caller agent to its project credentials', async () => {
    const engine = new Engine('test', createStubAgent(), [createStubPlatform()], '', 'en')
    const { deps, spawns } = fakeDeps()
    const test = await harness(() => ({ engine, sessionKey: 'test:chat', creds }), deps)
    const result = await execute(test, { args: ['docs', '+search', '--query', 'x'] })
    expect(result.isError).toBe(false)
    expect(spawns).toHaveLength(1)
    expect(spawns[0]?.env?.LARKSUITE_CLI_APP_ID).toBe('cli_app')
  })

  it('version gate reads the mtime-keyed cache and probes on miss', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'lark-ver-'))
    const files = new Map<string, string>()
    const probe = vi.fn(async () => ({ stdout: 'lark-cli version 1.0.69\n', stderr: '', code: 0 }))
    const deps: LarkRunnerDeps = {
      baseEnv: { PATH: '/usr/bin' },
      spawn: probe,
      async fetch(_url, _init) { return new Response('{"code":0,"tenant_access_token":"tat"}', { status: 200 }) },
      async stat() { return { mtimeMs: 123 } },
      async readFile(path) { return files.get(path) },
      async writeFile(path, data) { files.set(path, data) },
    }
    await runLarkInvocation(creds, ['docs', '+search'], { dataDir, deps })
    expect(probe).toHaveBeenCalledTimes(2) // version probe + the actual call
    const cachePath = join(dataDir, 'lark-cli-version.cache')
    expect(files.get(cachePath)).toBe('123|1.0.69')
    // Second call: cache hit, no fresh version probe.
    await runLarkInvocation(creds, ['docs', '+search'], { dataDir, deps })
    expect(probe).toHaveBeenCalledTimes(3)
    // Binary replaced (mtime key changes): probe again, and an old version fails the gate.
    deps.stat = async () => ({ mtimeMs: 456 })
    deps.spawn = vi.fn(async (_bin: string, argv: string[]) =>
      argv[0] === '--version' ? { stdout: 'lark-cli version 1.0.0\n', stderr: '', code: 0 } : { stdout: 'ok', stderr: '', code: 0 })
    await expect(runLarkInvocation(creds, ['docs', '+search'], { dataDir, deps })).rejects.toThrow(/older than required/)
  })
})
