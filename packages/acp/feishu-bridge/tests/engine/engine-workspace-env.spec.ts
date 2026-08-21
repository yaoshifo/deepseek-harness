/**
 * Feishu workspace env tests ported from cc-connect core/engine_test.go
 * (TestFeishuWorkspaceEnv + TestFeishuWorkspaceEnv_InjectedIntoRelaySessionEnv,
 * feature #18): non-empty workspace fields surface as CC_FEISHU_* entries in
 * the per-session env, and the relay path carries them into the agent.
 */

import { describe, expect, it } from 'vitest'
import { Engine } from '../../src/engine/engine.js'
import { createStubPlatform, newControllableSession } from '../stubs/engine-stubs.js'
import type { Agent, FeishuWorkspaceInfo } from '../../src/core/types.js'

function envOf(info: FeishuWorkspaceInfo | undefined): string[] {
  const e = new Engine('test', envAgent(), [createStubPlatform()], '', 'en')
  e.setFeishuWorkspace(info)
  const session = e.sessions.getOrCreateActive('test:user1')
  return e.buildSessionEnv('test:user1', session)
}

/** Agent whose setSessionEnv records the last injected env (Go sessionEnvRecordingAgent). */
function envAgent(nextSession = newControllableSession('ws-session')): Agent & { env(): string[]; setSessionEnv(env: string[]): void } {
  let lastEnv: string[] = []
  return {
    name: () => 'rec',
    startSession: async () => nextSession,
    listSessions: async () => [],
    stop: async () => {},
    setSessionEnv: (env: string[]) => { lastEnv = [...env] },
    env: () => lastEnv,
  }
}

describe('Engine feishu workspace env (#18)', () => {
  it('emits only non-empty CC_FEISHU_* fields', () => {
    expect(envOf(undefined).filter(v => v.startsWith('CC_FEISHU_'))).toEqual([])
    expect(envOf({ wikiSpaceId: '', folderToken: '', wikiNodeToken: '', description: '' })
      .filter(v => v.startsWith('CC_FEISHU_'))).toEqual([])
    expect(envOf({ wikiSpaceId: '7000', folderToken: '', wikiNodeToken: '', description: '' })
      .filter(v => v.startsWith('CC_FEISHU_'))).toEqual(['CC_FEISHU_WIKI_SPACE_ID=7000'])
    expect(envOf({ wikiSpaceId: '7000', folderToken: 'fldcn1', wikiNodeToken: 'wikcn2', description: 'Team docs' })
      .filter(v => v.startsWith('CC_FEISHU_'))).toEqual([
      'CC_FEISHU_WIKI_SPACE_ID=7000',
      'CC_FEISHU_FOLDER_TOKEN=fldcn1',
      'CC_FEISHU_WIKI_NODE_TOKEN=wikcn2',
      'CC_FEISHU_WORKSPACE_DESC=Team docs',
    ])
    expect(envOf({ wikiSpaceId: '', folderToken: 'fldcn1', wikiNodeToken: '', description: '' })
      .filter(v => v.startsWith('CC_FEISHU_'))).toEqual(['CC_FEISHU_FOLDER_TOKEN=fldcn1'])
  })

  it('injects the workspace env into relay sessions', async () => {
    const session = newControllableSession('relay-session')
    const agent = envAgent(session)
    const e = new Engine('test', agent, [createStubPlatform()], '', 'en')
    e.setFeishuWorkspace({ wikiSpaceId: '7777', folderToken: '', wikiNodeToken: '', description: 'x' })

    const signal = AbortSignal.timeout(20)
    const done = e.handleRelay(signal, 'other', 'chat1', 'hi')
    await new Promise((resolve) => { setTimeout(resolve, 40) })
    session.channel.push({ type: 'result', content: 'ok', done: true })
    await done.catch(() => undefined)

    const value = (name: string): string => agent.env().find(v => v.startsWith(`${name}=`))?.slice(name.length + 1) ?? ''
    expect(value('CC_FEISHU_WIKI_SPACE_ID')).toBe('7777')
    expect(value('CC_FEISHU_WORKSPACE_DESC')).toBe('x')
    expect(value('CC_FEISHU_FOLDER_TOKEN')).toBe('')
  })
})
