import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  deleteMemory,
  listMemory,
  readMemory,
  resolveMemoryDir,
  writeMemory,
} from '../src/store.ts'

const CWD = '/home/hm/workspace/ainvest'
const LIMITS = { maxIndexLines: 200, maxIndexBytes: 25_600 }

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'claude-memory-'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

function dir(): string {
  return resolveMemoryDir(root, CWD)
}

async function seed(files: Record<string, string>): Promise<void> {
  await mkdir(dir(), { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir(), name), content)
  }
}

describe('resolveMemoryDir', () => {
  it('nests the memory directory under the Claude project slug', () => {
    expect(resolveMemoryDir('/home/hm/.claude', CWD)).toBe(
      '/home/hm/.claude/projects/-home-hm-workspace-ainvest/memory',
    )
  })
})

describe('name validation', () => {
  it.each(['../evil.md', 'a/b.md', 'a\\b.md', '.', '..', '', '   ', 'MEMORY.md/'])('rejects %s', async (name) => {
    await expect(writeMemory(root, CWD, name, 'x', 's1', LIMITS)).rejects.toThrow(/memory name/)
    await expect(readMemory(root, CWD, name)).rejects.toThrow(/memory name/)
    await expect(deleteMemory(root, CWD, name)).rejects.toThrow(/memory name/)
  })

  it('accepts a plain single-segment name without forcing the .md suffix', async () => {
    const result = await writeMemory(root, CWD, 'plain-name.md', 'body', 's1', LIMITS)
    expect(result.annotations).toEqual([])
  })
})

describe('listMemory', () => {
  it('returns sorted entries for an existing directory', async () => {
    await rm(dir(), { recursive: true, force: true })
    await seed({
      'MEMORY.md': '# Memory Index\n',
      'b-feedback.md': '---\nname: b\n---\nbody',
      'a-project.md': 'body',
    })
    const entries = await listMemory(root, CWD)
    expect(entries?.map(entry => entry.name)).toEqual(['MEMORY.md', 'a-project.md', 'b-feedback.md'])
    expect(entries?.at(1)?.bytes).toBe(4)
    expect(typeof entries?.at(1)?.modified).toBe('string')
  })

  it('returns undefined for a missing directory', async () => {
    expect(await listMemory(root, '/home/hm/workspace/nowhere')).toBeUndefined()
  })
})

describe('readMemory', () => {
  it('reads existing content', async () => {
    expect(await readMemory(root, CWD, 'a-project.md')).toBe('body')
  })

  it('returns undefined for a missing file', async () => {
    expect(await readMemory(root, CWD, 'missing.md')).toBeUndefined()
  })
})

describe('writeMemory', () => {
  it('creates the directory lazily and reports size', async () => {
    await rm(dir(), { recursive: true, force: true })
    const result = await writeMemory(root, CWD, 'fresh.md', 'one\ntwo\n', 's1', LIMITS)
    expect(result.lines).toBe(3)
    expect(result.bytes).toBe(8)
    expect(result.annotations).toEqual([])
    expect(await readMemory(root, CWD, 'fresh.md')).toBe('one\ntwo\n')
  })

  it('leaves no temp residue in the memory directory', async () => {
    const names = await readdir(dir())
    expect(names.every(name => !name.includes('.tmp'))).toBe(true)
  })

  it('backfills provenance fields inside an existing metadata block', async () => {
    const content = [
      '---',
      'name: x',
      'description: d',
      'metadata:',
      '  type: feedback',
      '---',
      'body',
    ].join('\n')
    const result = await writeMemory(root, CWD, 'with-meta.md', content, 'sess-42', LIMITS)
    expect(result.annotations).toEqual(['provenance'])
    const written = await readMemory(root, CWD, 'with-meta.md')
    expect(written).toBe([
      '---',
      'name: x',
      'description: d',
      'metadata:',
      '  type: feedback',
      '  node_type: memory',
      '  originSessionId: sess-42',
      '---',
      'body',
    ].join('\n'))
  })

  it('does not duplicate existing provenance fields', async () => {
    const content = [
      '---',
      'name: x',
      'metadata:',
      '  node_type: memory',
      '  originSessionId: other',
      '---',
      'body',
    ].join('\n')
    const result = await writeMemory(root, CWD, 'has-prov.md', content, 'sess-42', LIMITS)
    expect(result.annotations).toEqual([])
    expect(await readMemory(root, CWD, 'has-prov.md')).toBe(content)
  })

  it('leaves frontmatter without a metadata block untouched', async () => {
    const content = '---\nname: x\ndescription: d\n---\nbody'
    const result = await writeMemory(root, CWD, 'no-meta.md', content, 'sess-42', LIMITS)
    expect(result.annotations).toEqual([])
    expect(await readMemory(root, CWD, 'no-meta.md')).toBe(content)
  })

  it('leaves plain non-frontmatter content untouched', async () => {
    const result = await writeMemory(root, CWD, 'plain.md', 'just a body', 'sess-42', LIMITS)
    expect(result.annotations).toEqual([])
    expect(await readMemory(root, CWD, 'plain.md')).toBe('just a body')
  })
})

describe('MEMORY.md index limits', () => {
  it('warns when the index exceeds the line limit but still writes', async () => {
    await rm(dir(), { recursive: true, force: true })
    const index = Array.from({ length: LIMITS.maxIndexLines + 1 }, (_, i) => `- item ${i}`).join('\n')
    const result = await writeMemory(root, CWD, 'MEMORY.md', index, 's1', LIMITS)
    expect(result.warning).toMatch(/200 lines/)
    expect(await readMemory(root, CWD, 'MEMORY.md')).toBe(index)
  })

  it('warns when the index exceeds the byte limit', async () => {
    await rm(dir(), { recursive: true, force: true })
    const index = `# Memory Index\n\n- ${'x'.repeat(LIMITS.maxIndexBytes)}`
    const result = await writeMemory(root, CWD, 'MEMORY.md', index, 's1', LIMITS)
    expect(result.warning).toMatch(/25600 bytes|bytes/)
  })

  it('does not warn for a normal topic file of any size', async () => {
    const big = 'x'.repeat(60_000)
    const result = await writeMemory(root, CWD, 'big-topic.md', big, 's1', LIMITS)
    expect(result.warning).toBeUndefined()
  })
})

describe('deleteMemory', () => {
  it('deletes an existing file and reports true', async () => {
    await seed({ 'doomed.md': 'x' })
    expect(await deleteMemory(root, CWD, 'doomed.md')).toBe(true)
    expect(await readMemory(root, CWD, 'doomed.md')).toBeUndefined()
  })

  it('returns false for a missing file or directory', async () => {
    expect(await deleteMemory(root, CWD, 'missing.md')).toBe(false)
    expect(await deleteMemory(root, '/home/hm/workspace/nowhere', 'missing.md')).toBe(false)
  })
})
