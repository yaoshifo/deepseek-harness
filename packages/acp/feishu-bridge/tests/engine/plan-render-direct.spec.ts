/**
 * Length-tiered reply rendering (2026-09-13 chatroom postmortem): every
 * pre-render-eligible reply forked an LLM render session even when the reply
 * was already small enough to deliver as-is, burning a fork per turn.
 * renderReplyToHTML now writes the SimpleHTML fragment directly and assembles
 * the template in place for replies at or below planRenderDirectLen (default
 * 2000 runes); longer replies and a 0 threshold keep the LLM fork.
 *
 * @module dsh-feishu-bridge/tests-plan-render-direct
 */

import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderReplyToHTML } from '../../src/engine/plan-render.ts'
import { createRenderAgent, newRenderEngine } from './plan-render-helpers.ts'
import { createStubMediaPlatform } from '../stubs/engine-stubs.ts'

/** Reply text sized in runes (CJK-safe). */
function replyOf(runes: number): string {
  return '结论：修复完成。'.repeat(Math.ceil(runes / 7)).slice(0, runes)
}

describe('renderReplyToHTML direct tier', () => {
  it('writes the SimpleHTML fragment + template shell without forking a render session', async () => {
    const agent = createRenderAgent()
    const e = newRenderEngine(agent, createStubMediaPlatform('feishu'))
    const reply = replyOf(600)

    const htmlPath = await renderReplyToHTML(e, 'test:chat:direct', reply)

    // No LLM fork: the render agent recorded zero renderQuery calls.
    expect(agent.getCalls()).toHaveLength(0)
    // The html file exists and went through template assembly (full document
    // shell, not the bare fragment).
    expect(existsSync(htmlPath)).toBe(true)
    const html = readFileSync(htmlPath, 'utf8')
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<html lang="zh-CN">')
    // The reply body itself is present in the fragment flow.
    expect(html).toContain('修复完成')
  })

  it('replies beyond the threshold still fork the render session', async () => {
    const agent = createRenderAgent()
    const e = newRenderEngine(agent, createStubMediaPlatform('feishu'))
    const reply = replyOf(2001)

    const htmlPath = await renderReplyToHTML(e, 'test:chat:fork', reply)

    expect(agent.getCalls()).toHaveLength(1)
    expect(existsSync(htmlPath)).toBe(true)
    const html = readFileSync(htmlPath, 'utf8')
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<header><h1>stub</h1></header>')
  })

  it('threshold 0 disables the direct tier: every reply forks', async () => {
    const agent = createRenderAgent()
    const e = newRenderEngine(agent, createStubMediaPlatform('feishu'))
    e.planRenderDirectLen = 0

    await renderReplyToHTML(e, 'test:chat:zero', replyOf(10))

    expect(agent.getCalls()).toHaveLength(1)
  })

  it('the threshold is injectable from the render config', async () => {
    const agent = createRenderAgent()
    const e = newRenderEngine(agent, createStubMediaPlatform('feishu'))
    e.setPlanRenderConfig({ enabled: true, provider: 'p', directLen: 50 })

    // 150 runes > configured 50 → fork, not the 2000 default.
    await renderReplyToHTML(e, 'test:chat:cfg', replyOf(150))

    expect(agent.getCalls()).toHaveLength(1)
  })

  it('a fork-tier render records the originating chat as the render one-shot parent', async () => {
    const agent = createRenderAgent()
    const e = newRenderEngine(agent, createStubMediaPlatform('feishu'))
    const key = 'test:chat:parentlink'
    e.sessions.getOrCreateActive(key).setAgentInfo('cc-hub-native-1', 'dsh', 'hub')

    await renderReplyToHTML(e, key, replyOf(2001))

    expect(agent.getCalls()).toHaveLength(1)
    expect(agent.getCalls()[0]?.parentSession).toBe('cc-hub-native-1')
  })

  it('a render for a chat with no live session leaves parentSession unset', async () => {
    const agent = createRenderAgent()
    const e = newRenderEngine(agent, createStubMediaPlatform('feishu'))

    await renderReplyToHTML(e, 'test:chat:orphan', replyOf(2001))

    expect(agent.getCalls()).toHaveLength(1)
    expect(agent.getCalls()[0]?.parentSession).toBeUndefined()
  })
})
