/**
 * Chatroom persona tests: the flattened persona loader and the whole-prompt
 * assembly (Go agent/dsh/persona.go behavior, exercised through the TS
 * builders), plus the adapter's setup-hook wiring (plan D3).
 *
 * @module dsh-feishu-bridge/tests-engine-chatroom-persona
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildChatroomSystemPrompt,
  chatroomLedgerReadPrompt,
  chatroomResearchRolePrompt,
  loadFlattenedPersona,
} from '../src/engine/chatroom-persona.ts'

describe('loadFlattenedPersona', () => {
  it('reads CLAUDE.md and inlines @imports recursively', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-persona-'))
    await writeFile(join(dir, 'CLAUDE.md'), '# Taleb\n\n@essence.md\n\n正文\n', 'utf8')
    await writeFile(join(dir, 'essence.md'), '本质：厚尾。\n', 'utf8')

    const persona = loadFlattenedPersona(dir)
    expect(persona).toContain('# Taleb')
    expect(persona).toContain('本质：厚尾。')
    expect(persona).toContain('正文')
    expect(persona).not.toContain('@essence.md')
  })

  it('returns empty when CLAUDE.md is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-persona-empty-'))
    expect(loadFlattenedPersona(dir)).toBe('')
  })
})

describe('buildChatroomSystemPrompt', () => {
  it('assembles the role persona with contract and persona text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-persona-build-'))
    await writeFile(join(dir, 'CLAUDE.md'), '# Munger\n多元思维格栅。\n', 'utf8')

    const text = buildChatroomSystemPrompt({
      workDir: dir,
      isRole: true,
      isDirect: false,
      isModerator: false,
      research: false,
      ledgerDir: '/data/ledgers/abc',
      platformPrompt: '',
    })
    expect(text).toContain('feishu-bridge')
    expect(text).toContain('feishu_bridge_send')
    expect(text).toContain('把生成的图片或文件发回给用户')
    expect(text).toContain('多角色聊天室的一个参与者')
    expect(text).toContain('共享账本——回答前先读')
    expect(text).toContain('/data/ledgers/abc')
    expect(text).toContain('# Munger')
  })

  it('adds the research contract in research mode, addressing the assistant by sentinel', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-persona-research-'))
    await writeFile(join(dir, 'CLAUDE.md'), '# R\n', 'utf8')
    const text = buildChatroomSystemPrompt({
      workDir: dir,
      isRole: true,
      isDirect: false,
      isModerator: false,
      research: true,
      ledgerDir: '',
      platformPrompt: '',
    })
    expect(text).toContain('研究任务：用预配的助手子群干活')
    // The role never transcribes a long session key: the "assistant"
    // sentinel resolves server-side (a model copying hex keys drops
    // characters — 2026-08-25 oc_ac5db incident).
    expect(text).toContain('child: "assistant"')
    // Check-screen-fetch: the butler pre-fetches common baselines into
    // data/core/ and the ledger; roles must judge the three ledger columns
    // (source/scope/fetched-at) before reusing, spot-check load-bearing
    // data, and re-fetch suspect datasets instead of reusing them.
    for (const want of ['先查再甄别再拉', '三列', 'spot-check', '登记新行', 'DATA_LEDGER', 'data/core/', 'data/<角色名>']) {
      expect(text).toContain(want)
    }
  })

  it('uses the direct contract for 1:1 sessions and no ledger section', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-persona-direct-'))
    await writeFile(join(dir, 'CLAUDE.md'), '# R\n', 'utf8')
    const text = buildChatroomSystemPrompt({
      workDir: dir,
      isRole: false,
      isDirect: true,
      isModerator: false,
      research: false,
      ledgerDir: '/data/ledgers/abc',
      platformPrompt: '',
    })
    expect(text).toContain('1:1 回答用户')
    expect(text).not.toContain('共享账本——回答前先读')
    expect(text).not.toContain('多角色聊天室的一个参与者')
  })
})

describe('cross-chatroom sharing disciplines', () => {
  it('ledger-read prompt names REPORT.md and marks the prior section as an unverified pointer', () => {
    const p = chatroomLedgerReadPrompt('/tmp/ledger')
    expect(p).toContain('REPORT.md')
    expect(p).toContain('前情')
    expect(p).toContain('未经本次讨论验证')
  })

  it('research role prompt carries the three-column reuse discipline', () => {
    const p = chatroomResearchRolePrompt()
    expect(p).toContain('三列')
    expect(p).toContain('spot-check')
    expect(p).toContain('登记新行')
  })
})
