/**
 * Consumer-surface tests for the `feishu_bridge_chatroom` tool over a REAL
 * Cordis Context + ToolRuntime (the registry is never bypassed), with the
 * chatroom engine functions replaced by spies: each action must route to
 * the correct orchestration primitive with the caller-agent-derived session
 * key (plan D4 — no env), malformed picks fail loud, and registration must
 * dispose cleanly (HMR safety).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentCancelCause, InboxTarget } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { Engine, ProjectStateStore } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { registerChatroomTool } from '../../src/tools/chatroom.ts'
import type { SubtaskRoute } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { applyChatroomEngineConfig } from '../../src/chatroom-config.ts'
import { beginChatroomTopicPick } from '../../src/engine/chatroom-pick.ts'
import {
  chatroomLedgerDir,
  initChatroomLedger,
  readChatroomLedgerHeader,
  updateChatroomReport,
  writeChatroomLedgerEnded,
} from '../../src/engine/chatroom-ledger.ts'
import { chatroomResearchWorkspace } from '../../src/engine/chatroom.ts'
import { createStubAgent, createStubChatroomSpawner, createStubSpawnerPlatform, newStubMessage } from '../stubs/engine-stubs.ts'
import { chatroomState } from '../../src/chatroom-state.ts'
import '../stubs/messages.js'

const signal = new AbortController().signal
const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

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

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly dispose: () => void
  readonly execute: (args: unknown, agent?: Agent) => Promise<ToolExecutionResult>
}

async function harness(route: (agent: unknown) => SubtaskRoute | undefined): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  const agent = stubAgent(ctx, `chatroom-tool-${Math.random()}`)
  ctx.agents.register(agent)
  const dispose = registerChatroomTool(ctx, route)
  const execute = (args: unknown, caller: Agent = agent): Promise<ToolExecutionResult> =>
    ctx.agents.withInitiator(caller, () => ctx.tools.execute({
      signal,
      callId: ToolCallId(`call-${Math.random()}`),
      name: 'feishu_bridge_chatroom',
      arguments: args,
      agent: caller,
    }))
  return { ctx, agent, dispose, execute }
}

function newEngine(): Engine {
  return new Engine('chatroom-test', createStubAgent(), [createStubSpawnerPlatform()], '', 'zh')
}

function value(result: ToolExecutionResult): { status: string; message: string } {
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error('expected a successful value')
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error('expected text content')
  expect(block.text).toBe((result.value as { message: string }).message)
  return result.value as { status: string; message: string }
}

function errorText(result: ToolExecutionResult): string {
  expect(result.isError).toBe(true)
  if (!result.isError) throw new Error('expected an error result')
  const block = result.content[0]
  return block?.type === 'text' ? block.text : ''
}

describe('feishu_bridge_chatroom registration', () => {
  it('registers on ctx.tools and disposes cleanly (HMR safety)', async () => {
    const engine = newEngine()
    const test = await harness(() => ({ engine, sessionKey: 'feishu:oc_hub:ou_1' }))
    expect(test.ctx.tools.get('feishu_bridge_chatroom')?.name).toBe('feishu_bridge_chatroom')
    const schema = test.ctx.tools.get('feishu_bridge_chatroom')?.parameters as {
      properties?: { action?: { enum?: string[] } }
    }
    expect(schema.properties?.action?.enum).toEqual(
      ['start', 'ask', 'gather', 'pick-roles', 'pick-topic', 'ask-human', 'end', 'list', 'note', 'history'],
    )
    test.dispose()
    test.dispose() // idempotent
    expect(test.ctx.tools.get('feishu_bridge_chatroom')).toBeUndefined()
  })
})

describe('feishu_bridge_chatroom action routing', () => {
  it('start reaches startChatroom (fail-fast without configured roles)', async () => {
    const engine = newEngine()
    const test = await harness(() => ({ engine, sessionKey: 'feishu:oc_hub:ou_1' }))
    const res = await test.execute({ action: 'start', message: 'topic', roles: 'taleb,munger' })
    expect(res.isError).toBe(true)
    // The fail-fast unknown-role reply proves startChatroom ran with the
    // caller's session key (roles validated before any spawn).
    expect(errorText(res)).toContain('taleb')
    test.dispose()
  })

  it('start fails loud when the configured user profile is unreadable', async () => {
    const engine = newEngine()
    applyChatroomEngineConfig(engine, { userProfile: '/nonexistent/fb-user-profile.md' }, undefined)
    const test = await harness(() => ({ engine, sessionKey: 'feishu:oc_hub:ou_1' }))
    const res = await test.execute({ action: 'start', message: 'topic', roles: 'taleb,munger' })
    // The profile gate fires before role validation: the unreadable-profile
    // reply, not the unknown-role one.
    expect(errorText(res)).toContain('用户背景')
    expect(errorText(res)).toContain('/nonexistent/fb-user-profile.md')
    test.dispose()
  })

  it('gather/ask/note/ask-human fail loud when their preconditions miss (routing proof)', async () => {
    const engine = newEngine()
    const test = await harness(() => ({ engine, sessionKey: 'feishu:oc_hub:ou_1' }))

    // gather without roles (no chatroom started under the caller's key).
    const gatherRes = await test.execute({ action: 'gather', message: 'q' })
    expect(gatherRes.isError).toBe(true)

    // ask with an unknown role.
    const askRes = await test.execute({ action: 'ask', role: 'ghost', message: 'q' })
    expect(askRes.isError).toBe(true)

    // note without a moderator dir.
    const noteRes = await test.execute({ action: 'note', message: '综述' })
    expect(noteRes.isError).toBe(true)
    expect(errorText(noteRes)).toContain('ledger')

    // ask-human on a non-role session.
    const humanRes = await test.execute({ action: 'ask-human', message: '截止日？' })
    expect(humanRes.isError).toBe(true)

    test.dispose()
  })

  it('rejects malformed picks JSON loudly', async () => {
    const engine = newEngine()
    const test = await harness(() => ({ engine, sessionKey: 'feishu:oc_hub:ou_1' }))
    const res = await test.execute({ action: 'pick-roles', picks: 'not json' })
    expect(res.isError).toBe(true)
    expect(errorText(res)).toContain('malformed')
    test.dispose()
  })

  it('rejects malformed pick items with a schema error, not a TypeError', async () => {
    // Model-produced JSON is a trust boundary: a wrong-typed or missing
    // title/name must fail with a clear schema message instead of a raw
    // "t.title.trim is not a function" from the renderer.
    const p = createStubSpawnerPlatform()
    const engine = new Engine('chatroom-test', createStubAgent(), [p], '', 'zh')
    const rolesDir = await mkdtemp(join(tmpdir(), 'fb-picks-roles-'))
    await mkdir(join(rolesDir, 'taleb'), { recursive: true })
    await writeFile(join(rolesDir, 'taleb', 'CLAUDE.md'), '# taleb\n', 'utf8')
    applyChatroomEngineConfig(engine, { rolesDir }, undefined)
    const test = await harness(() => ({ engine, sessionKey: 'feishu:oc_hub:ou_1' }))
    // Arm the topic picker so the render path is live.
    beginChatroomTopicPick(engine, p, {
      ...newStubMessage(),
      sessionKey: 'feishu:oc_hub:ou_1',
      platform: p.name(),
      userID: 'ou_1',
    })

    const wrongType = await test.execute({ action: 'pick-topic', picks: '[{"title":123,"recommended":true,"blurb":"x"}]' })
    expect(wrongType.isError).toBe(true)
    expect(errorText(wrongType)).toMatch(/title|schema|invalid/i)
    expect(errorText(wrongType)).not.toContain('not a function')

    const missingField = await test.execute({ action: 'pick-topic', picks: '[{"recommended":true,"blurb":"x"}]' })
    expect(missingField.isError).toBe(true)
    expect(errorText(missingField)).toMatch(/title|schema|invalid/i)
    expect(errorText(missingField)).not.toContain('Cannot read propert')

    test.dispose()
  })

  it('fails loud for a foreign caller (no feishu-bridge engine)', async () => {
    const test = await harness(() => undefined)
    const res = await test.execute({ action: 'list' })
    expect(res.isError).toBe(true)
    expect(errorText(res)).toContain('not owned')
    test.dispose()
  })

  it('fails loud for a project with chatroom disabled', async () => {
    const engine = newEngine()
    applyChatroomEngineConfig(engine, {}, { enabled: false })
    const test = await harness(() => ({ engine, sessionKey: 'feishu:oc_hub:ou_1' }))
    const res = await test.execute({ action: 'list' })
    expect(res.isError).toBe(true)
    expect(errorText(res)).toContain('disabled for this project')
    test.dispose()
  })

  it('lists roles from the engine roles dir', async () => {
    const engine = newEngine()
    const test = await harness(() => ({ engine, sessionKey: 'feishu:oc_hub:ou_1' }))
    const v = value(await test.execute({ action: 'list' }))
    expect(v.status).toBe('ok')
    expect(v.message).toContain('no roles configured')
    test.dispose()
  })

  it('pick-roles requires a live picker state', async () => {
    const engine = newEngine()
    const test = await harness(() => ({ engine, sessionKey: 'feishu:oc_hub:ou_1' }))
    const res = await test.execute({ action: 'pick-roles', picks: '[{"name":"taleb","recommended":true,"blurb":"why"}]' })
    expect(res.isError).toBe(true)
    expect(errorText(res)).toContain('picker')
    test.dispose()
  })
})

describe('feishu_bridge_chatroom end moderator guard', () => {
  /** A chatroom with one live role bound under a moderator hub. */
  function armedRoom(engine: Engine): { hubKey: string; roleKey: string } {
    const hubKey = 'feishu:oc_hub:ou_1'
    const roleKey = 'feishu:oc_role-1:ou_1'
    chatroomState(engine.sessions.getOrCreateActive(hubKey)).chatroomModerator = true
    const role = engine.sessions.getOrCreateActive(roleKey)
    role.setParentSessionKey(hubKey)
    chatroomState(role).chatroomHubKey = hubKey
    chatroomState(role).chatroomRoleName = 'taleb'
    return { hubKey, roleKey }
  }

  function newChatroomEngine(): Engine {
    const e = new Engine('chatroom-test', createStubAgent(), [createStubChatroomSpawner()], '', 'zh')
    e.setProjectStateStore(new ProjectStateStore(''))
    return e
  }

  it('rejects end and force from a role session and tears nothing down', async () => {
    const engine = newChatroomEngine()
    const { hubKey, roleKey } = armedRoom(engine)
    const stops = vi.spyOn(engine, 'stopInteractiveSession')
    const test = await harness(() => ({ engine, sessionKey: roleKey }))

    const endRes = await test.execute({ action: 'end' })
    expect(endRes.isError).toBe(true)
    expect(errorText(endRes)).toContain('主持人')

    const forceRes = await test.execute({ action: 'end', force: true })
    expect(forceRes.isError).toBe(true)
    expect(errorText(forceRes)).toContain('主持人')

    // A rejected end must leave the chatroom fully intact: the role stays
    // bound and its own turn was never stopped.
    expect(chatroomState(engine.sessions.getOrCreateActive(roleKey)).chatroomHubKey).toBe(hubKey)
    expect(stops.mock.calls).toHaveLength(0)
    test.dispose()
  })

  it('lets the moderator hub end the chatroom', async () => {
    const engine = newChatroomEngine()
    const { hubKey, roleKey } = armedRoom(engine)
    const test = await harness(() => ({ engine, sessionKey: hubKey }))

    const v = value(await test.execute({ action: 'end' }))

    expect(v.status).toBe('ok')
    expect(v.message).toContain('Chatroom ended')
    expect(chatroomState(engine.sessions.getOrCreateActive(roleKey)).chatroomHubKey).toBe('')
    test.dispose()
  })
})

describe('feishu_bridge_chatroom cross-chatroom sharing', () => {
  /** An engine with a spawner, a moderator home, and one role. */
  async function sharingEngine(): Promise<{ engine: Engine; home: string; rolesDir: string }> {
    const engine = new Engine('chatroom-test', createStubAgent(), [createStubChatroomSpawner()], '', 'zh')
    engine.setProjectStateStore(new ProjectStateStore(''))
    const home = await mkdtemp(join(tmpdir(), 'fb-tool-mod-'))
    const rolesDir = await mkdtemp(join(tmpdir(), 'fb-tool-roles-'))
    await mkdir(join(rolesDir, 'taleb'), { recursive: true })
    await writeFile(join(rolesDir, 'taleb', 'CLAUDE.md'), '# taleb\n', 'utf8')
    applyChatroomEngineConfig(engine, { rolesDir, moderatorDir: home, researchWorkspace: home }, undefined)
    return { engine, home, rolesDir }
  }

  it('history fails loud without a moderator dir', async () => {
    const engine = newEngine()
    const test = await harness(() => ({ engine, sessionKey: 'feishu:oc_hub:ou_1' }))
    const res = await test.execute({ action: 'history' })
    expect(res.isError).toBe(true)
    expect(errorText(res)).toContain('moderator')
    test.dispose()
  })

  it('history lists ledgers newest-first with status and reports, and the research-data section when the workspace has a fetch ledger', async () => {
    const { engine, home } = await sharingEngine()
    const oldDir = chatroomLedgerDir(home, 'feishu:oc_old:ou_1')
    await initChatroomLedger(oldDir, '老议题', ['taleb'])
    await writeChatroomLedgerEnded(oldDir, 'ended')
    const newDir = chatroomLedgerDir(home, 'feishu:oc_new:ou_1')
    await initChatroomLedger(newDir, '新议题', ['taleb', 'munger'])
    await updateChatroomReport(newDir, '结论')
    const ws = chatroomResearchWorkspace(engine)
    await mkdir(join(ws, 'data', 'core'), { recursive: true })
    await writeFile(join(ws, 'DATA_LEDGER.md'), '| 数据 | 文件 | 时间 | 来源 | 抓取者 |\n', 'utf8')

    const test = await harness(() => ({ engine, sessionKey: 'feishu:oc_hub:ou_1' }))
    const v = value(await test.execute({ action: 'history' }))
    expect(v.message.indexOf('新议题')).toBeLessThan(v.message.indexOf('老议题'))
    expect(v.message).toContain('unfinished')
    expect(v.message).toContain('ended')
    expect(v.message).toContain('REPORT.md')
    expect(v.message).toContain('DATA_LEDGER.md')
    test.dispose()
  })

  it('history with no recorded chatrooms is an empty ok, not an error', async () => {
    const { engine } = await sharingEngine()
    const test = await harness(() => ({ engine, sessionKey: 'feishu:oc_hub:ou_1' }))
    const v = value(await test.execute({ action: 'history' }))
    expect(v.message).toContain('No past chatrooms')
    test.dispose()
  })

  it('start with inherit seeds the prior pointer into the new ledger', async () => {
    const { engine, home } = await sharingEngine()
    const priorDir = chatroomLedgerDir(home, 'feishu:oc_prior:ou_1')
    await initChatroomLedger(priorDir, '旧议题', ['taleb'])

    const test = await harness(() => ({ engine, sessionKey: 'feishu:oc_hub:ou_1' }))
    const v = value(await test.execute({ action: 'start', message: '新议题', roles: 'taleb', inherit: '旧议题' }))
    expect(v.message).toContain('旧议题')
    const header = readChatroomLedgerHeader(chatroomLedgerDir(home, 'feishu:oc_hub:ou_1'))
    expect(header?.prior).toContain('旧议题')
    test.dispose()
  })

  it('start with an unresolvable inherit fails loud with candidates', async () => {
    const { engine, home } = await sharingEngine()
    await initChatroomLedger(chatroomLedgerDir(home, 'feishu:oc_prior:ou_1'), '旧议题', ['taleb'])

    const test = await harness(() => ({ engine, sessionKey: 'feishu:oc_hub:ou_1' }))
    const res = await test.execute({ action: 'start', message: '新议题', roles: 'taleb', inherit: '不存在' })
    expect(res.isError).toBe(true)
    expect(errorText(res)).toContain('不存在')
    expect(errorText(res)).toContain('旧议题')
    test.dispose()
  })

  it('note with section report writes REPORT.md into the caller hub ledger', async () => {
    const { engine, home } = await sharingEngine()
    const hubKey = 'feishu:oc_hub:ou_1'
    await initChatroomLedger(chatroomLedgerDir(home, hubKey), '议题', ['taleb'])

    const test = await harness(() => ({ engine, sessionKey: hubKey }))
    const v = value(await test.execute({ action: 'note', message: '收尾总结', section: 'report' }))
    expect(v.status).toBe('ok')
    const rep = await readFile(join(chatroomLedgerDir(home, hubKey), 'REPORT.md'), 'utf8')
    expect(rep).toContain('收尾总结')
    test.dispose()
  })
})
