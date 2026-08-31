import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  deleteMemory,
  listMemory,
  readMemory,
  resolveGlobalMemoryDir,
  resolveMemoryDir,
  updateMemoryIndex,
  writeMemory,
} from '../src/store.ts'

const fsControl = vi.hoisted(() => ({
  /** Paths whose stat throws ENOENT, arming the readdir/stat race for one test. */
  statEnoent: [] as string[],
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async stat(...args: Parameters<typeof actual.stat>): ReturnType<typeof actual.stat> {
      if (fsControl.statEnoent.includes(String(args[0]))) {
        const error = new Error(`ENOENT: no such file or directory, stat '${String(args[0])}'`) as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      }
      return actual.stat(...args)
    },
  }
})

const CWD = '/home/hm/workspace/ainvest'
const LIMITS = { maxIndexLines: 200, maxIndexBytes: 25_600 }

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-'))
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

describe('resolveGlobalMemoryDir', () => {
  it('places the global memory directory directly under the Claude home', () => {
    expect(resolveGlobalMemoryDir('/home/hm/.claude')).toBe('/home/hm/.claude/memory')
  })

  it('supports the same store operations as a project directory', async () => {
    const globalDir = resolveGlobalMemoryDir(root)
    await rm(globalDir, { recursive: true, force: true })
    const result = await writeMemory(globalDir, 'machine-wide-pit', 'body', 's1', LIMITS)
    expect(result.name).toBe('machine-wide-pit.md')
    expect(await readMemory(globalDir, 'machine-wide-pit.md')).toBe('body')
    const indexed = await updateMemoryIndex(globalDir, {
      action: 'upsert',
      name: 'machine-wide-pit',
      title: 'Machine-wide pit',
      hook: 'applies everywhere',
    }, LIMITS)
    expect(indexed.changed).toBe(true)
    expect(await deleteMemory(globalDir, 'machine-wide-pit.md')).toBe(true)
  })
})

describe('name validation', () => {
  it.each(['../evil.md', 'a/b.md', 'a\\b.md', '.', '..', '', '   ', 'MEMORY.md/'])('rejects %s', async (name) => {
    await expect(writeMemory(dir(), name, 'x', 's1', LIMITS)).rejects.toThrow(/memory name/)
    await expect(readMemory(dir(), name)).rejects.toThrow(/memory name/)
    await expect(deleteMemory(dir(), name)).rejects.toThrow(/memory name/)
  })

  it('keeps MEMORY.md exact and reports its stored name', async () => {
    const result = await writeMemory(dir(), 'MEMORY.md', '# Memory Index\n', 's1', LIMITS)
    expect(result.name).toBe('MEMORY.md')
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
    const entries = await listMemory(dir())
    expect(entries?.map(entry => entry.name)).toEqual(['MEMORY.md', 'a-project.md', 'b-feedback.md'])
    expect(entries?.at(1)?.bytes).toBe(4)
    expect(typeof entries?.at(1)?.modified).toBe('string')
  })

  it('returns undefined for a missing directory', async () => {
    expect(await listMemory(resolveMemoryDir(root, '/home/hm/workspace/nowhere'))).toBeUndefined()
  })

  it('skips a file deleted between readdir and stat', async () => {
    const raceDir = resolveMemoryDir(root, '/home/hm/workspace/race')
    await rm(raceDir, { recursive: true, force: true })
    await mkdir(raceDir, { recursive: true })
    await writeFile(join(raceDir, 'MEMORY.md'), '# Memory Index\n')
    await writeFile(join(raceDir, 'gone.md'), 'vanishes before stat')
    await writeFile(join(raceDir, 'stays.md'), 'body')
    fsControl.statEnoent.push(join(raceDir, 'gone.md'))
    const entries = await listMemory(raceDir)
    expect(entries?.map(entry => entry.name)).toEqual(['MEMORY.md', 'stays.md'])
  })
})

describe('readMemory', () => {
  it('reads existing content', async () => {
    expect(await readMemory(dir(), 'a-project.md')).toBe('body')
  })

  it('returns undefined for a missing file', async () => {
    expect(await readMemory(dir(), 'missing.md')).toBeUndefined()
  })

  it('reads an extension-less orphan through its .md spelling', async () => {
    await seed({ orphan: 'legacy body' })
    expect(await readMemory(dir(), 'orphan.md')).toBe('legacy body')
  })

  it('reads a .md file through its extension-less spelling', async () => {
    await seed({ 'spelled.md': 'body' })
    expect(await readMemory(dir(), 'spelled')).toBe('body')
  })

  it('rethrows real IO errors and gives a bare .md name no alternate', async () => {
    await mkdir(join(dir(), 'a-directory'), { recursive: true })
    await expect(readMemory(dir(), 'a-directory.md')).rejects.toThrow()
    await expect(deleteMemory(dir(), 'a-directory.md')).rejects.toThrow()
    expect(await readMemory(dir(), '.md')).toBeUndefined()
    expect(await deleteMemory(dir(), '.md')).toBe(false)
  })
})

describe('writeMemory', () => {
  it('appends .md to an extension-less name and reports the stored name', async () => {
    await rm(dir(), { recursive: true, force: true })
    const result = await writeMemory(dir(), 'slug-only', 'body', 's1', LIMITS)
    expect(result.name).toBe('slug-only.md')
    expect(await readMemory(dir(), 'slug-only.md')).toBe('body')
  })

  it('creates the directory lazily and reports size', async () => {
    await rm(dir(), { recursive: true, force: true })
    const result = await writeMemory(dir(), 'fresh.md', 'one\ntwo\n', 's1', LIMITS)
    expect(result.lines).toBe(3)
    expect(result.bytes).toBe(8)
    expect(result.annotations).toEqual([])
    expect(await readMemory(dir(), 'fresh.md')).toBe('one\ntwo\n')
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
    const result = await writeMemory(dir(), 'with-meta.md', content, 'sess-42', LIMITS)
    expect(result.annotations).toEqual(['provenance'])
    const written = await readMemory(dir(), 'with-meta.md')
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
    const result = await writeMemory(dir(), 'has-prov.md', content, 'sess-42', LIMITS)
    expect(result.annotations).toEqual([])
    expect(await readMemory(dir(), 'has-prov.md')).toBe(content)
  })

  it('leaves frontmatter without a metadata block untouched', async () => {
    const content = '---\nname: x\ndescription: d\n---\nbody'
    const result = await writeMemory(dir(), 'no-meta.md', content, 'sess-42', LIMITS)
    expect(result.annotations).toEqual([])
    expect(await readMemory(dir(), 'no-meta.md')).toBe(content)
  })

  it('leaves plain non-frontmatter content untouched', async () => {
    const result = await writeMemory(dir(), 'plain.md', 'just a body', 'sess-42', LIMITS)
    expect(result.annotations).toEqual([])
    expect(await readMemory(dir(), 'plain.md')).toBe('just a body')
  })
})

describe('MEMORY.md index limits', () => {
  it('warns when the index exceeds the line limit but still writes', async () => {
    await rm(dir(), { recursive: true, force: true })
    const index = Array.from({ length: LIMITS.maxIndexLines + 1 }, (_, i) => `- item ${i}`).join('\n')
    const result = await writeMemory(dir(), 'MEMORY.md', index, 's1', LIMITS)
    expect(result.warning).toMatch(/200 lines/)
    expect(await readMemory(dir(), 'MEMORY.md')).toBe(index)
  })

  it('warns when the index exceeds the byte limit', async () => {
    await rm(dir(), { recursive: true, force: true })
    const index = `# Memory Index\n\n- ${'x'.repeat(LIMITS.maxIndexBytes)}`
    const result = await writeMemory(dir(), 'MEMORY.md', index, 's1', LIMITS)
    expect(result.warning).toMatch(/25600 bytes|bytes/)
  })

  it('does not warn for a normal topic file of any size', async () => {
    const big = 'x'.repeat(60_000)
    const result = await writeMemory(dir(), 'big-topic.md', big, 's1', LIMITS)
    expect(result.warning).toBeUndefined()
  })
})

describe('deleteMemory', () => {
  it('deletes an existing file and reports true', async () => {
    await seed({ 'doomed.md': 'x' })
    expect(await deleteMemory(dir(), 'doomed.md')).toBe(true)
    expect(await readMemory(dir(), 'doomed.md')).toBeUndefined()
  })

  it('deletes through the alternate .md spelling when the exact name misses', async () => {
    await seed({ 'gone-legacy': 'x', 'stays.md': 'x' })
    expect(await deleteMemory(dir(), 'gone-legacy.md')).toBe(true)
    expect(await readMemory(dir(), 'gone-legacy')).toBeUndefined()
    expect(await deleteMemory(dir(), 'stays')).toBe(true)
    expect(await readMemory(dir(), 'stays.md')).toBeUndefined()
  })

  it('returns false for a missing file or directory', async () => {
    expect(await deleteMemory(dir(), 'missing.md')).toBe(false)
    expect(await deleteMemory(resolveMemoryDir(root, '/home/hm/workspace/nowhere'), 'missing.md')).toBe(false)
  })
})

describe('updateMemoryIndex', () => {
  it('creates MEMORY.md with the header and one pointer line when missing', async () => {
    await rm(dir(), { recursive: true, force: true })
    const result = await updateMemoryIndex(dir(), {
      action: 'upsert',
      name: 'a-project',
      title: 'A project',
      hook: 'hook a',
    }, LIMITS)
    expect(result).toMatchObject({ name: 'a-project.md', action: 'upsert', changed: true })
    expect(result.warning).toBeUndefined()
    expect(await readMemory(dir(), 'MEMORY.md')).toBe(
      '# Memory Index\n\n- [A project](a-project.md) — hook a\n',
    )
  })

  it('replaces the existing pointer line in place and keeps the other lines', async () => {
    await rm(dir(), { recursive: true, force: true })
    await seed({
      'MEMORY.md': '# Memory Index\n\n- [A project](a-project.md) — old hook\n- [B](b.md) — hook b\n',
    })
    const result = await updateMemoryIndex(dir(), {
      action: 'upsert',
      name: 'a-project.md',
      title: 'A project',
      hook: 'new hook',
    }, LIMITS)
    expect(result.changed).toBe(true)
    expect(await readMemory(dir(), 'MEMORY.md')).toBe(
      '# Memory Index\n\n- [A project](a-project.md) — new hook\n- [B](b.md) — hook b\n',
    )
  })

  it('appends after the last non-empty line when no pointer exists', async () => {
    await rm(dir(), { recursive: true, force: true })
    await seed({ 'MEMORY.md': '# Memory Index\n\n- [B](b.md) — hook b\n' })
    await updateMemoryIndex(dir(), {
      action: 'upsert',
      name: 'c-topic',
      title: 'C topic',
      hook: 'hook c',
    }, LIMITS)
    expect(await readMemory(dir(), 'MEMORY.md')).toBe(
      '# Memory Index\n\n- [B](b.md) — hook b\n- [C topic](c-topic.md) — hook c\n',
    )
  })

  it('collapses duplicate pointer lines into one rendered with the .md spelling', async () => {
    await rm(dir(), { recursive: true, force: true })
    await seed({
      'MEMORY.md': '# Memory Index\n\n- [Old](legacy-name) — one\n- [Dup](legacy-name) — two\n- [B](b.md) — hook b\n',
    })
    await updateMemoryIndex(dir(), {
      action: 'upsert',
      name: 'legacy-name.md',
      title: 'New',
      hook: 'merged',
    }, LIMITS)
    expect(await readMemory(dir(), 'MEMORY.md')).toBe(
      '# Memory Index\n\n- [New](legacy-name.md) — merged\n- [B](b.md) — hook b\n',
    )
  })

  it('removes the pointer line and reports the resulting index', async () => {
    await rm(dir(), { recursive: true, force: true })
    await seed({ 'MEMORY.md': '# Memory Index\n\n- [A](a-project.md) — hook a\n- [B](b.md) — hook b\n' })
    const result = await updateMemoryIndex(dir(), { action: 'remove', name: 'a-project' }, LIMITS)
    expect(result).toMatchObject({ name: 'a-project.md', action: 'remove', changed: true })
    expect(await readMemory(dir(), 'MEMORY.md')).toBe('# Memory Index\n\n- [B](b.md) — hook b\n')
  })

  it('remove matches the extension-less link spelling too', async () => {
    await rm(dir(), { recursive: true, force: true })
    await seed({ 'MEMORY.md': '# Memory Index\n\n- [A](legacy-name) — hook\n' })
    const result = await updateMemoryIndex(dir(), { action: 'remove', name: 'legacy-name.md' }, LIMITS)
    expect(result.changed).toBe(true)
    expect(await readMemory(dir(), 'MEMORY.md')).toBe('# Memory Index\n\n')
  })

  it('remove is a no-op that leaves the index untouched when the pointer is missing', async () => {
    await rm(dir(), { recursive: true, force: true })
    const content = '# Memory Index\n\n- [B](b.md) — hook b\n'
    await seed({ 'MEMORY.md': content })
    const result = await updateMemoryIndex(dir(), { action: 'remove', name: 'missing.md' }, LIMITS)
    expect(result.changed).toBe(false)
    expect(result.lines).toBe(content.split('\n').length)
    expect(await readMemory(dir(), 'MEMORY.md')).toBe(content)
  })

  it('remove on a missing MEMORY.md reports changed=false without creating it', async () => {
    await rm(dir(), { recursive: true, force: true })
    const result = await updateMemoryIndex(dir(), { action: 'remove', name: 'anything.md' }, LIMITS)
    expect(result).toMatchObject({ changed: false, lines: 0, bytes: 0 })
    expect(await readMemory(dir(), 'MEMORY.md')).toBeUndefined()
  })

  it('rejects MEMORY.md and invalid names as the index key', async () => {
    await expect(updateMemoryIndex(dir(), {
      action: 'upsert', name: 'MEMORY.md', title: 'T', hook: 'h',
    }, LIMITS)).rejects.toThrow(/memory name/)
    await expect(updateMemoryIndex(dir(), {
      action: 'remove', name: '../evil.md',
    }, LIMITS)).rejects.toThrow(/memory name/)
  })

  it('warns when the resulting index exceeds the line budget', async () => {
    await rm(dir(), { recursive: true, force: true })
    const lines = Array.from({ length: LIMITS.maxIndexLines }, (_, i) => `- [T${i}](t${i}.md) — h`)
    await seed({ 'MEMORY.md': `# Memory Index\n\n${lines.join('\n')}\n` })
    const result = await updateMemoryIndex(dir(), {
      action: 'upsert',
      name: 'overflow',
      title: 'O',
      hook: 'h',
    }, LIMITS)
    expect(result.warning).toMatch(/200 lines/)
  })
})
