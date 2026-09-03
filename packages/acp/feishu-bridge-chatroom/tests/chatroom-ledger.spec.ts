/**
 * Chatroom ledger tests ported 1:1 from cc-connect
 * core/chatroom_ledger_test.go.
 *
 * @module dsh-feishu-bridge/tests-engine-chatroom-ledger
 */

import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  appendChatroomLedger,
  chatroomLedgerDir,
  hashID,
  initChatroomLedger,
  listChatroomLedgers,
  readChatroomLedgerHeader,
  resolveChatroomInherit,
  updateChatroomReport,
  updateChatroomSubproblems,
  updateChatroomLedgerSynthesis,
  writeChatroomLedgerEnded,
} from '../src/engine/chatroom-ledger.ts'

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

describe('readChatroomLedgerHeader', () => {
  it('parses topic/roles/started from a fresh ledger; ended and prior empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-ledger-'))
    const d = chatroomLedgerDir(root, 'hub-1')
    await initChatroomLedger(d, '该不该 all-in', ['taleb', 'munger'])
    const h = readChatroomLedgerHeader(d)
    expect(h).toBeDefined()
    expect(h?.topic).toBe('该不该 all-in')
    expect(h?.roles).toEqual(['taleb', 'munger'])
    expect(h?.started).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(h?.ended).toBe('')
    expect(h?.endedStatus).toBe('')
    expect(h?.prior).toBe('')
  })

  it('returns undefined for a dir without SYNTHESIS.md', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-ledger-'))
    expect(readChatroomLedgerHeader(join(root, 'ledgers', 'no-such-dir'))).toBeUndefined()
  })
})

describe('writeChatroomLedgerEnded', () => {
  it('appends the ended line into the header, parseable by readChatroomLedgerHeader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-ledger-'))
    const d = chatroomLedgerDir(root, 'hub-1')
    await initChatroomLedger(d, 'topic', ['taleb'])
    await writeChatroomLedgerEnded(d, 'ended')
    const h = readChatroomLedgerHeader(d)
    expect(h?.endedStatus).toBe('ended')
    expect(h?.ended).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    await writeChatroomLedgerEnded(d, 'interrupted')
    const h2 = readChatroomLedgerHeader(d)
    expect(h2?.endedStatus).toBe('interrupted')
    const syn = await read(join(d, 'SYNTHESIS.md'))
    expect(syn.match(/- 结束：/g)).toHaveLength(1) // second write replaces, never duplicates
  })

  it('survives later synthesis updates (stays above the section marker)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-ledger-'))
    const d = chatroomLedgerDir(root, 'hub-1')
    await initChatroomLedger(d, 'topic', ['taleb'])
    await writeChatroomLedgerEnded(d, 'ended')
    await updateChatroomLedgerSynthesis(d, '图景 v2')
    const syn = await read(join(d, 'SYNTHESIS.md'))
    expect(syn).toContain('- 结束：')
    expect(syn).toContain('图景 v2')
    expect(syn.indexOf('- 结束：')).toBeLessThan(syn.indexOf('## 当前图景与进展'))
  })
})

describe('initChatroomLedger prior', () => {
  it('writes the prior pointer line and section above the synthesis marker; no prior content is copied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-ledger-'))
    const d = chatroomLedgerDir(root, 'hub-2')
    const priorDir = chatroomLedgerDir(root, 'hub-1')
    await initChatroomLedger(priorDir, '前一次议题', ['taleb'])
    await updateChatroomLedgerSynthesis(priorDir, '前一次的综述正文')

    await initChatroomLedger(d, '新议题', ['taleb', 'munger'], { topic: '前一次议题', dir: priorDir })
    const syn = await read(join(d, 'SYNTHESIS.md'))
    expect(syn).toContain(`- 前情：继承自 前一次议题（${priorDir}）`)
    expect(syn).toContain('## 前情（继承自 前一次议题，未经本次讨论验证）')
    expect(syn).toContain(priorDir)
    expect(syn).toContain('甄别')
    // Pointer only: the prior discussion body is never copied in.
    expect(syn).not.toContain('前一次的综述正文')
    // Section sits between the header block and the synthesis marker.
    expect(syn.indexOf('## 前情')).toBeGreaterThan(syn.indexOf('- 开始：'))
    expect(syn.indexOf('## 前情')).toBeLessThan(syn.indexOf('## 当前图景与进展'))
  })

  it('keeps the prior section across synthesis updates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-ledger-'))
    const d = chatroomLedgerDir(root, 'hub-2')
    const priorDir = chatroomLedgerDir(root, 'hub-1')
    await initChatroomLedger(priorDir, '前一次议题', ['taleb'])
    await initChatroomLedger(d, '新议题', ['taleb'], { topic: '前一次议题', dir: priorDir })
    await updateChatroomLedgerSynthesis(d, '本次已甄别后的综述')
    const syn = await read(join(d, 'SYNTHESIS.md'))
    expect(syn).toContain('## 前情（继承自 前一次议题')
    expect(syn).toContain('本次已甄别后的综述')
  })

  it('omits every prior artifact when no prior is given', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-ledger-'))
    const d = chatroomLedgerDir(root, 'hub-1')
    await initChatroomLedger(d, 'topic', ['taleb'])
    const syn = await read(join(d, 'SYNTHESIS.md'))
    expect(syn).not.toContain('前情')
  })
})

describe('updateChatroomReport', () => {
  it('writes REPORT.md whole-file; a second note replaces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-ledger-'))
    const d = chatroomLedgerDir(root, 'hub-1')
    await initChatroomLedger(d, 'topic', ['taleb'])
    await updateChatroomReport(d, '结论一：图景完整。')
    let rep = await read(join(d, 'REPORT.md'))
    expect(rep).toContain('# 聊天室报告')
    expect(rep).toContain('结论一：图景完整。')
    await updateChatroomReport(d, '结论二：修正版。')
    rep = await read(join(d, 'REPORT.md'))
    expect(rep).toContain('结论二：修正版。')
    expect(rep).not.toContain('结论一')
  })
})

describe('chatroomLedgerDir run suffix', () => {
  it('first run keeps the legacy layout; later runs get -<run> suffixes', () => {
    const dir = '/tmp/fb-ledger-home'
    expect(chatroomLedgerDir(dir, 'hub-1')).toBe(join(dir, 'ledgers', hashID('hub-1')))
    expect(chatroomLedgerDir(dir, 'hub-1', 1)).toBe(join(dir, 'ledgers', hashID('hub-1')))
    expect(chatroomLedgerDir(dir, 'hub-1', 2)).toBe(join(dir, 'ledgers', `${hashID('hub-1')}-2`))
    expect(chatroomLedgerDir(dir, 'hub-1', 7)).toBe(join(dir, 'ledgers', `${hashID('hub-1')}-7`))
  })
})

/** Create one ledger dir with a controlled started line (init writes nowClock). */
async function seedLedger(root: string, name: string, topic: string, started: string): Promise<string> {
  const d = join(root, 'ledgers', name)
  await mkdir(d, { recursive: true })
  await writeFile(join(d, 'SYNTHESIS.md'), [
    `# 聊天室账本：${topic}`,
    '',
    `- 议题：${topic}`,
    '- 角色：taleb',
    `- 开始：${started}`,
    '',
    '## 当前图景与进展',
    '',
    '（空）',
    '',
  ].join('\n'), 'utf8')
  return d
}

describe('listChatroomLedgers', () => {
  it('lists newest-first, detects report files, skips dirs without SYNTHESIS.md', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-ledger-'))
    const old = await seedLedger(root, 'aaaa', '老议题', '2026-09-01 10:00:00')
    const mid = await seedLedger(root, 'bbbb-2', '裸辞议题', '2026-09-02 10:00:00')
    await seedLedger(root, 'cccc', '无头目录', '') // started missing → sorts oldest
    await mkdir(join(root, 'ledgers', 'dddd'), { recursive: true }) // no SYNTHESIS.md → skipped
    await writeFile(join(mid, 'REPORT.md'), '# 聊天室报告\n', 'utf8')
    await writeFile(join(mid, 'summary.html'), '<html></html>', 'utf8')
    await writeChatroomLedgerEnded(old, 'interrupted')

    const list = listChatroomLedgers(join(root, 'ledgers'))
    expect(list.map(l => l.header.topic)).toEqual(['裸辞议题', '老议题', '无头目录'])
    expect(list[0]?.dir).toBe(mid)
    expect(list[0]?.reports).toEqual(['REPORT.md', 'summary.html'])
    expect(list[1]?.header.endedStatus).toBe('interrupted')
    expect(list[0]?.header.endedStatus).toBe('')

    const limited = listChatroomLedgers(join(root, 'ledgers'), 2)
    expect(limited).toHaveLength(2)
    expect(listChatroomLedgers(join(root, 'no-such-root'))).toEqual([])
  })
})

describe('resolveChatroomInherit', () => {
  it('bare ref = newest; exact dir name; topic substring newest-first; undefined when no match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-ledger-'))
    const ledgers = join(root, 'ledgers')
    await seedLedger(root, 'aaaa', '老议题 裸辞', '2026-09-01 10:00:00')
    await seedLedger(root, 'bbbb-2', '裸辞议题', '2026-09-02 10:00:00')

    expect(resolveChatroomInherit(ledgers, '')?.header.topic).toBe('裸辞议题')
    expect(resolveChatroomInherit(ledgers, 'bbbb-2')?.header.topic).toBe('裸辞议题')
    expect(resolveChatroomInherit(ledgers, 'aaaa')?.header.topic).toBe('老议题 裸辞')
    // Substring matches the newest first.
    expect(resolveChatroomInherit(ledgers, '裸辞')?.header.topic).toBe('裸辞议题')
    expect(resolveChatroomInherit(ledgers, '不存在')).toBeUndefined()
    expect(resolveChatroomInherit(join(root, 'no-such-root'), '')).toBeUndefined()
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
