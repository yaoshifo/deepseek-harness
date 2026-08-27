/**
 * Feature-state codec registry behavior (the bridge-owned mechanism): one
 * codec per featureState key, reference-counted re-registration, and the
 * serialize/carry consultation points. The chatroom codec's own projection
 * and reset-carry semantics moved with it to the chatroom package.
 *
 * @module dsh-feishu-bridge/tests-engine-feature-state
 */

import { describe, expect, it } from 'vitest'
import { Session } from '../../src/engine/session.js'
import {
  featureStateCodecs,
  registerFeatureStateCodec,
  type FeatureStateCodec,
} from '../../src/engine/feature-state.js'

const noopCodec = (key: string): FeatureStateCodec => ({
  key,
  encode: () => undefined,
  carry: () => {},
})

describe('feature-state codec registry', () => {
  it('registers, lists, and unregisters a codec', () => {
    const codec = noopCodec('spec-probe')
    const dispose = registerFeatureStateCodec(codec)
    expect(featureStateCodecs().some(registered => registered.key === 'spec-probe')).toBe(true)
    dispose()
    expect(featureStateCodecs().some(registered => registered.key === 'spec-probe')).toBe(false)
  })

  it('holds codecs for several keys side by side', () => {
    const disposeA = registerFeatureStateCodec(noopCodec('spec-a'))
    const disposeB = registerFeatureStateCodec(noopCodec('spec-b'))
    expect(featureStateCodecs().map(codec => codec.key)).toEqual(['spec-a', 'spec-b'])
    disposeA()
    expect(featureStateCodecs().map(codec => codec.key)).toEqual(['spec-b'])
    disposeB()
    expect(featureStateCodecs()).toHaveLength(0)
  })

  it('rejects a duplicate key', () => {
    const dispose = registerFeatureStateCodec(noopCodec('spec-dup'))
    expect(() => registerFeatureStateCodec(noopCodec('spec-dup'))).toThrow(/already registered/)
    dispose()
  })

  it('reference-counts re-registrations of the same codec object (HMR reload, multi-app mounts)', () => {
    const codec = noopCodec('spec-shared')
    const disposeOne = registerFeatureStateCodec(codec)
    const disposeTwo = registerFeatureStateCodec(codec)
    expect(featureStateCodecs().filter(registered => registered.key === 'spec-shared')).toHaveLength(1)
    disposeOne()
    expect(featureStateCodecs().some(registered => registered.key === 'spec-shared')).toBe(true)
    disposeTwo()
    expect(featureStateCodecs().some(registered => registered.key === 'spec-shared')).toBe(false)
  })

  it('tolerates a double dispose', () => {
    const dispose = registerFeatureStateCodec(noopCodec('spec-twice'))
    dispose()
    dispose()
    expect(featureStateCodecs().some(registered => registered.key === 'spec-twice')).toBe(false)
  })
})
