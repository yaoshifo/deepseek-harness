/**
 * Skeleton plugin-shape tests: the named function-plugin form (name/inject/
 * Config/apply, no default export) is the loader contract — a default export
 * would drop `inject` and break service injection (postmortem 0001).
 *
 * @module dsh-feishu-bridge-chatroom/tests
 */

import { describe, expect, it } from 'vitest'
import { Config, apply, inject, name } from '../src/index.ts'
import { apply as applyInvariant, inject as invariantInject, name as invariantName } from '../src/invariant.ts'

describe('chatroom plugin skeleton', () => {
  it('is a named function plugin (no default export)', async () => {
    expect(name).toBe('feishu-bridge-chatroom')
    expect(Array.isArray(inject)).toBe(true)
    expect(typeof Config).toBe('function')
    expect(typeof apply).toBe('function')
    const mod = await import('../src/index.ts')
    expect('default' in mod).toBe(false)
  })

  it('applies as a no-op on a plain context', () => {
    expect(() => apply({} as never, {} as never)).not.toThrow()
  })

  it('ships the invariant companion with a skeleton-stage reason', async () => {
    expect(invariantName).toBe('feishu-bridge-chatroom-invariant')
    expect(invariantInject).toEqual(['invariants'])
    expect(typeof applyInvariant).toBe('function')
  })
})
