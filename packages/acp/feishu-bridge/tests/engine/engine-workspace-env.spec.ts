/**
 * Feishu workspace routing tests ported from cc-connect core/engine_test.go
 * (TestFeishuWorkspaceEnv + TestFeishuWorkspaceEnv_InjectedIntoRelaySessionEnv,
 * feature #18): non-empty workspace fields surface as the typed
 * feishuWorkspace start options (rendered as CC_FEISHU_* lines by the
 * adapter's routing section), and the relay path carries them into the
 * agent.
 */

import { describe, expect, it } from 'vitest'
import { Engine } from '../../src/engine/engine.ts'
import { feishuWorkspaceSection } from '../../src/agent-dsh/adapter.ts'
import { createStubPlatform, newControllableSession } from '../stubs/engine-stubs.ts'
import type { Agent, AgentSession, FeishuWorkspaceInfo, SessionStartOptions } from '../../src/core/types.ts'

function optionsOf(info: FeishuWorkspaceInfo | undefined): SessionStartOptions {
  const e = new Engine('test', envAgent(), [createStubPlatform()], '', 'en')
  e.setFeishuWorkspace(info)
  const session = e.sessions.getOrCreateActive('test:user1')
  return e.buildSessionStartOptions('test:user1', session)
}

/** Agent whose startSession records the last received options (Go sessionEnvRecordingAgent). */
function envAgent(nextSession: AgentSession = newControllableSession('ws-session')): Agent & { lastOptions(): SessionStartOptions | undefined } {
  let last: SessionStartOptions | undefined
  return {
    name: () => 'rec',
    startSession: async (_sessionID: string, options?: SessionStartOptions) => {
      last = options
      return nextSession
    },
    listSessions: async () => [],
    stop: async () => {},
    lastOptions: () => last,
  }
}

describe('Engine feishu workspace routing (#18)', () => {
  it('omits the workspace when unset or all-empty, keeps partial fields verbatim', () => {
    expect(optionsOf(undefined).feishuWorkspace).toBeUndefined()
    expect(optionsOf({ wikiSpaceId: '', folderToken: '', wikiNodeToken: '', description: '' }).feishuWorkspace).toBeUndefined()
    // The routing section lists only the non-empty fields.
    expect(feishuWorkspaceSection(optionsOf({ wikiSpaceId: '7000', folderToken: '', wikiNodeToken: '', description: '' })))
      .toContain('- CC_FEISHU_WIKI_SPACE_ID=7000')
    expect(feishuWorkspaceSection(optionsOf({ wikiSpaceId: '7000', folderToken: 'fldcn1', wikiNodeToken: 'wikcn2', description: 'Team docs' }))).toContain(
      '- CC_FEISHU_WIKI_SPACE_ID=7000\n- CC_FEISHU_FOLDER_TOKEN=fldcn1\n- CC_FEISHU_WIKI_NODE_TOKEN=wikcn2',
    )
    expect(feishuWorkspaceSection(optionsOf({ wikiSpaceId: '', folderToken: 'fldcn1', wikiNodeToken: '', description: '' })))
      .toContain('- CC_FEISHU_FOLDER_TOKEN=fldcn1')
    expect(feishuWorkspaceSection(optionsOf({ wikiSpaceId: '', folderToken: '', wikiNodeToken: '', description: '' }))).toBe('')
  })

  it('carries the workspace fields into relay sessions', async () => {
    const session = newControllableSession('relay-session')
    const agent = envAgent(session)
    const e = new Engine('test', agent, [createStubPlatform()], '', 'en')
    e.setFeishuWorkspace({ wikiSpaceId: '7777', folderToken: '', wikiNodeToken: '', description: 'x' })

    const signal = AbortSignal.timeout(20)
    const done = e.handleRelay(signal, 'other', 'chat1', 'hi')
    // Attach the catch before the timeout can fire — the abort arm rejects
    // as soon as the signal trips, not at the next event.
    const doneP = done.catch(() => undefined)
    await new Promise((resolve) => { setTimeout(resolve, 40) })
    session.channel.push({ type: 'result', content: 'ok', done: true })
    await doneP

    expect(agent.lastOptions()?.feishuWorkspace).toEqual({ wikiSpaceId: '7777', folderToken: '', wikiNodeToken: '', description: 'x' })
    expect(agent.lastOptions()?.sessionKey).toBe('relay:other:chat1')
  })
})
