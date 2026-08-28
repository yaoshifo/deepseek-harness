/**
 * installLogTimestamps: wall-clock prefix on console lines, idempotent
 * across plugin reloads.
 *
 * @module dsh-feishu-bridge/tests-log-timestamps
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { installLogTimestamps } from '../src/log-timestamps.js'

describe('installLogTimestamps', () => {
  // Spy first, then install: the wrapper binds the spied function as its
  // original, so the spy records the timestamp-prefixed argument list.
  const spy = vi.spyOn(console, 'info').mockImplementation(() => {})

  afterEach(() => {
    spy.mockClear()
  })

  it('prefixes console lines with the local wall-clock timestamp', () => {
    installLogTimestamps()
    console.info('feishu: preview card sent', 'om_x')
    expect(spy).toHaveBeenCalledTimes(1)
    const call: unknown[] = spy.mock.calls[0] ?? []
    const first: unknown = call[0]
    expect(String(first)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(call.slice(1)).toEqual(['feishu: preview card sent', 'om_x'])
  })

  it('is idempotent across reloads — no stacked prefixes', () => {
    // The install is process-wide and irreversible by design; this file
    // runs isolated in its own worker, so the patched console leaks no
    // further than this spec.
    installLogTimestamps()
    installLogTimestamps()
    console.info('again')
    expect(spy).toHaveBeenCalledTimes(1)
    const call: unknown[] = spy.mock.calls[0] ?? []
    expect(String(call[0])).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })
})
