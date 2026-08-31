/**
 * Engine-side i18n handle wiring (Go engine.go platform startup): every
 * platform exposing the I18nHandleReceiver capability receives the engine's
 * I18n instance at mount, so platform-owned user-visible copy (perm card
 * rebuilds, export notices) localizes by config.language; platforms without
 * the capability mount unchanged.
 *
 * @module dsh-feishu-bridge/tests-engine-platform-i18n
 */

import { describe, expect, it } from 'vitest'
import { Engine } from '../../src/engine/engine.js'
import { createStubAgent, createStubPlatform, type StubPlatform } from '../stubs/engine-stubs.js'
import type { I18n } from '../../src/i18n/index.js'

/** A stub platform capturing the handle the engine hands over at mount. */
interface HandlePlatform extends StubPlatform {
  receivedHandle: I18n | undefined
  setI18nHandle(handle: I18n): void
}

function newHandlePlatform(n = 'test'): HandlePlatform {
  const base = createStubPlatform(n)
  const p: HandlePlatform = {
    ...base,
    receivedHandle: undefined,
    setI18nHandle: (handle) => { p.receivedHandle = handle },
  }
  return p
}

describe('engine.start i18n handle wiring', () => {
  it('hands the engine\'s I18n instance to every platform exposing setI18nHandle', async () => {
    const withHandle = newHandlePlatform('wired')
    const withoutHandle = createStubPlatform('plain')
    const e = new Engine('test', createStubAgent(), [withHandle, withoutHandle], '', 'en')

    await e.start()

    expect(withHandle.receivedHandle).toBe(e.i18n)
  })
})
