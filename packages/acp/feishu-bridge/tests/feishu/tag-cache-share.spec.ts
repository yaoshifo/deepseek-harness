/**
 * Shared tag-cache-directory tests: Go kept every bot's `<project>_feishu_tag_cache.json`
 * in one shared sessions dir, which is what lets a second bot resolve a tenant
 * tag id its own create cannot return — Feishu answers a name owned by another
 * app with 402 and no duplicate_id, and im/v2 has no List/Get. The bridge
 * therefore passes one `tagCacheDir` for all projects so the sibling fallback
 * keeps working.
 *
 * @module dsh-feishu-bridge/tests-feishu-tag-cache-share
 */

import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { FeishuPlatform, type FeishuApiClient } from '../../src/feishu/platform.js'
import type { CreateTagResult, TagRelationTag } from '../../src/feishu/tag.js'

const tempDirs: string[] = []
afterAll(async () => {
  await Promise.all(tempDirs.map(d => rm(d, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-tagshare-'))
  tempDirs.push(dir)
  return dir
}

/** The dataDir/sessions subdir the assembly creates up front. */
async function ensureSessions(dataDir: string): Promise<string> {
  const dir = join(dataDir, 'sessions')
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * Client whose createTag either succeeds (the app owning the name) or returns
 * the cross-app 402-without-id squat reply. Tag relations are served from an
 * in-memory map so verify-after-bind round-trips.
 */
function tagClient(opts: { createTag: (name: string) => CreateTagResult }): FeishuApiClient & {
  unbound: string[][]
} {
  const bound = new Map<string, string>()
  const unbound: string[][] = []
  return {
    unbound,
    async reply() { return { messageId: 'om_ok' } },
    async create() { return { messageId: 'om_ok' } },
    async createTag({ name }) {
      return opts.createTag(name)
    },
    async getTagRelation({ chatId }) {
      const id = bound.get(chatId)
      const tags: TagRelationTag[] = id === undefined ? [] : [{ id, name: 'harness' }]
      return { code: 0, tags }
    },
    async createTagRelation({ chatId, tagIds }) {
      bound.set(chatId, tagIds[0] ?? '')
      return { code: 0 }
    },
    async updateTagRelation({ chatId, tagIds }) {
      unbound.push(tagIds)
      bound.delete(chatId)
      return { code: 0 }
    },
  }
}

function newPlatform(api: FeishuApiClient, projectName: string, tagCacheDir: string, dataDir: string): FeishuPlatform {
  return new FeishuPlatform({ appID: 'cli_test', appSecret: 's', apiClient: api, projectName, tagCacheDir, dataDir })
}

describe('shared tag cache directory', () => {
  it('a second bot resolves a squatted tag name via the sibling cache', async () => {
    const shared = await tempDir()
    const dataA = await tempDir()
    const dataB = await tempDir()
    // Bot A owns the tenant tag: its create returns the id.
    const apiA = tagClient({ createTag: () => ({ code: 0, id: 'tag_owned' }) })
    // Bot B squats: create hits 402 without duplicate_id (another app owns
    // the name).
    const apiB = tagClient({ createTag: () => ({ code: 402, msg: 'duplicate name in tenant' }) })

    const a = newPlatform(apiA, 'alpha', shared, dataA)
    await a.removeTagFromChat('feishu:oc_a', 'harness')

    // The cache landed in the shared dir, not the per-project sessions dir
    // (the assembly creates both up front).
    expect(await readdir(shared)).toEqual(['alpha_feishu_tag_cache.json'])
    expect(await readdir(await ensureSessions(dataA))).toEqual([])

    const b = newPlatform(apiB, 'beta', shared, dataB)
    await b.removeTagFromChat('feishu:oc_b', 'harness')

    // B resolved the sibling's id and unbound exactly that id.
    expect(apiB.unbound).toEqual([['tag_owned']])
    // B cached the borrowed id under its own file in the same shared dir.
    expect((await readdir(shared)).sort()).toEqual(['alpha_feishu_tag_cache.json', 'beta_feishu_tag_cache.json'])
  })
})
