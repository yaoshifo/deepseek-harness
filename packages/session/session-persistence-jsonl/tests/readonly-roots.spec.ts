import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionId as makeSessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { SessionAlreadyExistsError } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { eventLines, generationLogPath } from '../src/format.ts'
import { meta, oneTurnLog, releasedV1OneTurnLog } from '../../session-persistence/tests/contract.ts'

const dirs: string[] = []

async function freshRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jsonl-ro-'))
  dirs.push(dir)
  return dir
}

/** Create + append + close: persist one whole log through the write handle. */
async function writeLog(
  persistence: SessionPersistence,
  m: SessionHeader,
  events: readonly SessionEvent[],
): Promise<void> {
  const handle = await persistence.create(m)
  try {
    await handle.append(events)
  } finally {
    await handle.close()
  }
}

/** Open a read handle, read the whole log, and close. */
async function readAll(
  persistence: SessionPersistence,
  id: SessionId,
): Promise<{ meta: SessionHeader; events: readonly SessionEvent[] }> {
  const handle = await persistence.open(id, 'read')
  try {
    return { meta: handle.header, events: (await handle.read()).events }
  } finally {
    await handle.close()
  }
}

/** Seed one session into `root` through a throwaway backend, then dispose it. */
async function seedSession(root: string, id: string, cwd: string): Promise<void> {
  const seeder = new Context()
  await seeder.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  try {
    await writeLog(seeder.sessionPersistence, meta(id, cwd), oneTurnLog())
  } finally {
    await seeder.fiber.dispose()
  }
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('JsonlSessionPersistence: read-only extra roots', () => {
  it('lists sessions from the writable root and read-only roots together', async () => {
    const primary = await freshRoot()
    const external = await freshRoot()
    await seedSession(external, 'foreign-session', '/work')

    const ctx = new Context()
    await ctx.plugin(JsonlSessionPersistence, { root: primary, readOnlyRoots: [external], compression: 'none' })
    try {
      await writeLog(ctx.sessionPersistence, meta('local-session', '/work'), oneTurnLog())

      const listed = await ctx.sessionPersistence.list()
      expect(listed.map(snapshot => snapshot.header.id))
        .toEqual(expect.arrayContaining(['local-session', 'foreign-session']))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reads a read-only root session through stat and open read without touching it', async () => {
    const primary = await freshRoot()
    const external = await freshRoot()
    await seedSession(external, 'foreign-session', '/work/external')

    const ctx = new Context()
    await ctx.plugin(JsonlSessionPersistence, { root: primary, readOnlyRoots: [external], compression: 'none' })
    try {
      const snapshot = await ctx.sessionPersistence.stat(makeSessionId('foreign-session'))
      expect(snapshot?.header).toMatchObject({ id: 'foreign-session', cwd: '/work/external' })
      expect(snapshot?.sizeBytes).toBeGreaterThan(0)

      const read = await readAll(ctx.sessionPersistence, makeSessionId('foreign-session'))
      expect(read.meta.id).toBe('foreign-session')
      expect(read.events.map(event => event.type)).toEqual(oneTurnLog().map(event => event.type))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses write-opening and re-creating sessions stored under a read-only root', async () => {
    const primary = await freshRoot()
    const external = await freshRoot()
    await seedSession(external, 'foreign-session', '/work')

    const ctx = new Context()
    await ctx.plugin(JsonlSessionPersistence, { root: primary, readOnlyRoots: [external], compression: 'none' })
    try {
      await expect(ctx.sessionPersistence.open(makeSessionId('foreign-session'), 'write'))
        .rejects.toThrow(/refusing write open.*read-only root/u)

      // The writable root keeps working: creating and write-opening its own sessions is unaffected.
      await writeLog(ctx.sessionPersistence, meta('local-session', '/work'), oneTurnLog())
      const appended = await ctx.sessionPersistence.open(makeSessionId('local-session'), 'write')
      await appended.close()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses creating a session whose id already exists under a read-only root', async () => {
    const primary = await freshRoot()
    const external = await freshRoot()
    await seedSession(external, 'foreign-session', '/work')

    const ctx = new Context()
    await ctx.plugin(JsonlSessionPersistence, { root: primary, readOnlyRoots: [external], compression: 'none' })
    try {
      await expect(ctx.sessionPersistence.create(meta('foreign-session', '/work')))
        .rejects.toThrow(SessionAlreadyExistsError)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails loudly when one session id appears under two roots', async () => {
    const primary = await freshRoot()
    const external = await freshRoot()
    await seedSession(external, 'shared-id', '/work')
    await seedSession(primary, 'shared-id', '/work')

    const ctx = new Context()
    await ctx.plugin(JsonlSessionPersistence, { root: primary, readOnlyRoots: [external], compression: 'none' })
    try {
      await expect(ctx.sessionPersistence.list())
        .rejects.toThrow(/duplicate JSONL session id "shared-id" appears in multiple project directories/u)
      await expect(ctx.sessionPersistence.open(makeSessionId('shared-id'), 'read'))
        .rejects.toThrow(/duplicate JSONL session id "shared-id"/u)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('lists a released v0 generation under a read-only root without mutating it', async () => {
    const primary = await freshRoot()
    const external = await freshRoot()
    const id = 'old-foreign'
    const sourcePath = generationLogPath(external, '/legacy', makeSessionId(id), 0, 'none')
    await mkdir(dirname(sourcePath), { recursive: true })
    const source = Buffer.from(
      `${JSON.stringify({
        type: 'session',
        version: 0,
        id,
        createdAt: 1000,
        cwd: '/legacy',
        delegationDepth: 0,
      })}\n${eventLines(releasedV1OneTurnLog())}\n`,
    )
    await writeFile(sourcePath, source)

    const ctx = new Context()
    await ctx.plugin(JsonlSessionPersistence, { root: primary, readOnlyRoots: [external], compression: 'none' })
    try {
      const listed = await ctx.sessionPersistence.list()
      expect(listed.map(snapshot => snapshot.header.id)).toContain(id)
      expect(await readFile(sourcePath)).toEqual(source)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('skips a v0 generation the format catalog refuses, exactly as under the writable root', async () => {
    const primary = await freshRoot()
    const external = await freshRoot()
    // `origin: 'oneshot'` is one of the recorded v0 schema snapshot refusals
    // (see .agents/skills/feishu-session-log-triage); the catalog marks the
    // header malformed and listing skips it. Read-only roots share that rule.
    const id = 'refused-v0'
    const sourcePath = generationLogPath(external, '/legacy', makeSessionId(id), 0, 'none')
    await mkdir(dirname(sourcePath), { recursive: true })
    await writeFile(sourcePath, Buffer.from(
      `${JSON.stringify({
        type: 'session',
        version: 0,
        id,
        createdAt: 1000,
        cwd: '/legacy',
        origin: 'oneshot',
        delegationDepth: 0,
      })}\n${eventLines(releasedV1OneTurnLog())}\n`,
    ))

    const ctx = new Context()
    await ctx.plugin(JsonlSessionPersistence, { root: primary, readOnlyRoots: [external], compression: 'none' })
    try {
      const listed = await ctx.sessionPersistence.list()
      expect(listed.map(snapshot => snapshot.header.id)).not.toContain(id)
      await expect(ctx.sessionPersistence.stat(makeSessionId(id))).resolves.toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects invalid read-only root configuration at load', async () => {
    const primary = await freshRoot()
    const external = await freshRoot()

    const duplicatesWritable = new Context()
    await expect(duplicatesWritable.plugin(JsonlSessionPersistence, {
      root: primary,
      readOnlyRoots: [primary],
      compression: 'none',
    })).rejects.toThrow(/duplicates the writable root/u)
    await duplicatesWritable.fiber.dispose()

    const duplicatesItself = new Context()
    await expect(duplicatesItself.plugin(JsonlSessionPersistence, {
      root: primary,
      readOnlyRoots: [external, external],
      compression: 'none',
    })).rejects.toThrow(/duplicates another read-only root/u)
    await duplicatesItself.fiber.dispose()

    const absent = new Context()
    await expect(absent.plugin(JsonlSessionPersistence, {
      root: primary,
      readOnlyRoots: [join(external, 'missing')],
      compression: 'none',
    })).rejects.toThrow(/is not a readable directory/u)
    await absent.fiber.dispose()
  })
})
