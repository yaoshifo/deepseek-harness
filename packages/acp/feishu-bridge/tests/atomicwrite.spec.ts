import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { atomicWriteFile } from '../src/atomicwrite.js'

// Ported from cc-connect core/atomicwrite_test.go (4 Go tests). t.TempDir()
// becomes mkdtemp(os.tmpdir()).

describe('atomicWriteFile', () => {
  it('Basic', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'feishu-bridge-'))
    const path = join(dir, 'test.txt')
    const data = 'hello world'

    await atomicWriteFile(path, Buffer.from(data), 0o644)

    expect((await readFile(path)).toString()).toBe(data)
  })

  it('Overwrite', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'feishu-bridge-'))
    const path = join(dir, 'test.txt')

    await atomicWriteFile(path, Buffer.from('first'), 0o644)
    await atomicWriteFile(path, Buffer.from('second'), 0o644)

    expect((await readFile(path)).toString()).toBe('second')
  })

  it('Permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'feishu-bridge-'))
    const path = join(dir, 'test.txt')

    await atomicWriteFile(path, Buffer.from('x'), 0o600)

    const info = await stat(path)
    expect(info.mode & 0o777).toBe(0o600)
  })

  it('NoTempLeftOnSuccess', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'feishu-bridge-'))
    const path = join(dir, 'test.txt')

    await atomicWriteFile(path, Buffer.from('data'), 0o644)

    const entries = await readdir(dir)
    for (const e of entries) {
      expect(e).toBe('test.txt')
    }
  })
})
