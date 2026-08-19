/**
 * Chatroom ledger tests ported 1:1 from cc-connect
 * core/chatroom_ledger_test.go.
 *
 * @module dsh-feishu-bridge/tests-engine-chatroom-ledger
 */

import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  appendChatroomLedger,
  chatroomLedgerDir,
  initChatroomLedger,
  updateChatroomSubproblems,
  updateChatroomLedgerSynthesis,
} from '../../src/engine/chatroom-ledger.js'

const read = async (p: string): Promise<string> => readFile(p, 'utf8')

describe('chatroomLedgerDir', () => {
  it('stable per hub key, distinct across hubs, a directory under ledgers/', () => {
    const dir = '/tmp/fb-ledger-home'
    const d1 = chatroomLedgerDir(dir, 'feishu:oc_abc:user-1')
    const d2 = chatroomLedgerDir(dir, 'feishu:oc_abc:user-1')
    expect(d1).toBe(d2)
    expect(chatroomLedgerDir(dir, 'feishu:oc_xyz:user-1')).not.toBe(d1)
    // Directory, not a file — must NOT end with a .md filename.
    expect(d1.endsWith('.md')).toBe(false)
    expect(d1.startsWith(join(dir, 'ledgers') + '/')).toBe(true)
  })
})

describe('initChatroomLedger', () => {
  it('writes the three ledger files with topic/roles headers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-ledger-'))
    const d = chatroomLedgerDir(root, 'hub-1')
    await initChatroomLedger(d, '该不该 all-in', ['taleb', 'munger'])
    for (const name of ['SYNTHESIS.md', 'SUBPROBLEMS.md', 'RECORD.md']) {
      await expect(read(join(d, name))).resolves.toBeTruthy()
    }
    const syn = await read(join(d, 'SYNTHESIS.md'))
    for (const want of ['该不该 all-in', 'taleb', 'munger', '## 当前图景与进展']) {
      expect(syn).toContain(want)
    }
    const sub = await read(join(d, 'SUBPROBLEMS.md'))
    expect(sub).toContain('## 子问题清单')
    const rec = await read(join(d, 'RECORD.md'))
    expect(rec).toContain('## 讨论记录')
  })
})

describe('appendChatroomLedger', () => {
  it('appends to RECORD.md only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-ledger-'))
    const d = chatroomLedgerDir(root, 'hub-1')
    await initChatroomLedger(d, 'topic', ['taleb'])
    await appendChatroomLedger(d, 'taleb', '厚尾下平均会骗人')
    const rec = await read(join(d, 'RECORD.md'))
    expect(rec).toContain('【taleb】')
    expect(rec).toContain('厚尾下平均会骗人')
    // Append must not touch SYNTHESIS or SUBPROBLEMS.
    const syn = await read(join(d, 'SYNTHESIS.md'))
    expect(syn).not.toContain('厚尾下平均会骗人')
    const sub = await read(join(d, 'SUBPROBLEMS.md'))
    expect(sub).not.toContain('厚尾下平均会骗人')
  })
})

describe('updateChatroomLedgerSynthesis', () => {
  it('replaces the synthesis section, preserving header and record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-ledger-'))
    const d = chatroomLedgerDir(root, 'hub-1')
    await initChatroomLedger(d, 'topic', ['taleb', 'munger'])
    await appendChatroomLedger(d, 'taleb', 'entry-one')
    await appendChatroomLedger(d, 'munger', 'entry-two')

    await updateChatroomLedgerSynthesis(d, '图景：taleb 指出厚尾风险；munger 待补。')
    const s = await read(join(d, 'SYNTHESIS.md'))
    expect(s).toContain('图景：taleb 指出厚尾风险')
    expect(s).toContain('topic') // header preserved
    const rec = await read(join(d, 'RECORD.md'))
    expect(rec).toContain('entry-one')
    expect(rec).toContain('entry-two')

    // A second update replaces (not duplicates) the synthesis.
    await updateChatroomLedgerSynthesis(d, '图景 v2：双方已覆盖风险与机会。')
    const s2 = await read(join(d, 'SYNTHESIS.md'))
    expect(s2).toContain('图景 v2')
    expect(s2).not.toContain('图景：taleb 指出厚尾')
  })

  it('errors when the section marker is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-ledger-'))
    await expect(updateChatroomLedgerSynthesis(root, 'x')).rejects.toThrow()
  })
})

describe('updateChatroomSubproblems', () => {
  it('overwrites (never appends)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-ledger-'))
    const d = chatroomLedgerDir(root, 'hub-1')
    await initChatroomLedger(d, 'topic', ['taleb'])

    await updateChatroomSubproblems(d, '1. 择时\n2. 仓位\n3. 退出')
    const b = await read(join(d, 'SUBPROBLEMS.md'))
    expect(b).toContain('择时')
    expect(b).toContain('退出')

    await updateChatroomSubproblems(d, 'A. 只剩一条')
    const b2 = await read(join(d, 'SUBPROBLEMS.md'))
    expect(b2).toContain('只剩一条')
    expect(b2).not.toContain('择时')
  })
})
