/**
 * Atomic file writing, ported from cc-connect core/atomicwrite.go.
 * os.CreateTemp(dir, ".tmp-*") becomes a `wx`-opened `.tmp-<uuid>` file in
 * the same directory (same guarantees: exclusive create, same-filesystem
 * rename).
 *
 * @module dsh-feishu-bridge/atomicwrite
 */

import { chmod, open, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

/**
 * Write data to a file atomically: write to a temporary file in the same
 * directory, sync, then rename over the target. Prevents data loss or
 * corruption on crash mid-write.
 * @param path - Target file path.
 * @param data - Bytes to write.
 * @param perm - POSIX permission bits (e.g. 0o644) applied to the target.
 * @returns Resolves once the rename has replaced the target.
 */
export async function atomicWriteFile(path: string, data: Uint8Array, perm: number): Promise<void> {
  const dir = dirname(path)
  const tmpPath = join(dir, `.tmp-${randomUUID()}`)
  const tmp = await open(tmpPath, 'wx')
  try {
    await tmp.writeFile(data)
    await tmp.sync()
  } catch (err) {
    await tmp.close().catch(() => undefined) // close failure is irrelevant; the original error wins
    await rm(tmpPath, { force: true }).catch(() => undefined) // a stray .tmp-* file is harmless
    throw err
  }
  await tmp.close()
  try {
    await chmod(tmpPath, perm)
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => undefined) // a stray .tmp-* file is harmless
    throw err
  }
  // Mirrors the Go source: a failed rename propagates and leaves the temp
  // file in place.
  await rename(tmpPath, path)
}
