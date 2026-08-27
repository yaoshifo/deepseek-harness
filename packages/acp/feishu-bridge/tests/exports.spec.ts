/**
 * The plugin-extension export face: the subpath
 * `@deepseek-ai/dsh-feishu-bridge/exports` resolves (tsconfig paths in the
 * source plane, package exports after build) and carries exactly the
 * sibling-plugin symbols — the narrow face chatroom and future plugins
 * consume instead of deep src imports.
 *
 * @module dsh-feishu-bridge/tests-exports
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  Engine,
  EventChannel,
  FeishuBridgeService,
  ProjectStateStore,
  SessionManager,
  asCardSender,
  asGroupRenamer,
  asReplyContextReconstructor,
  atomicWriteFileSync,
  bareBridgeDispatch,
  cleanupOneChat,
  ctxBridgeDispatch,
  declareToolFamily,
  emptyMessage,
  jumpButtonsMarkdown,
  lookupMessage,
  maxGroupNameRunes,
  newCard,
  parentJumpButtons,
  registerFeatureStateCodec,
  registerMessages,
  registerSessionCommands,
  WorktreeMode,
} from '@deepseek-ai/dsh-feishu-bridge/exports'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('the plugin-extension export face', () => {
  it('exposes the service face and dispatch helpers sibling plugins consume', () => {
    expect(typeof FeishuBridgeService).toBe('function')
    expect(typeof SessionManager).toBe('function')
    expect(typeof registerSessionCommands).toBe('function')

    const bare = bareBridgeDispatch()
    // No listeners: the built-in base (the last dispatch argument) runs.
    expect(bare.waterfall('feishuBridge/permission-policy', { options: undefined }, () => true)).toBe(true)
    expect(emptyMessage().sessionKey).toBe('')

    const ctx = new Context()
    contexts.push(ctx)
    const face = ctxBridgeDispatch(ctx)
    expect(typeof face.serial).toBe('function')
  })

  it('exposes the shared engine symbols and registration helpers', () => {
    expect(jumpButtonsMarkdown([]).ok).toBe(false)
    expect(parentJumpButtons('k', 'name', { name: () => 'p' } as never)).toEqual([])

    // A missing key falls back to the key itself (the i18n contract).
    expect(lookupMessage('en', 'face_spec_missing_key' as never)).toBe('face_spec_missing_key')

    const undeclare = declareToolFamily('face_spec_tool', 'agent')
    expect(typeof undeclare).toBe('function')
    undeclare()
  })

  it('exposes the engine class, stores, and capability symbols feature modules drive', async () => {
    expect(typeof Engine).toBe('function')
    expect(typeof ProjectStateStore).toBe('function')
    expect(typeof EventChannel).toBe('function')
    expect(typeof cleanupOneChat).toBe('function')
    expect(typeof WorktreeMode.ForceOff).toBe('number')
    expect(typeof asCardSender).toBe('function')
    expect(typeof asGroupRenamer).toBe('function')
    expect(typeof asReplyContextReconstructor).toBe('function')
    expect(maxGroupNameRunes).toBe(60)

    // The card builder face the chatroom pickers render through.
    const card = newCard().title('t', 'blue').markdown('m').build()
    expect(card.header?.title).toBe('t')

    // An engine constructs through the face (the chatroom suites' harness shape).
    const engine = new Engine('face-spec', { name: () => 'stub', startSession: async () => ({}) } as never, [], '', 'en')
    expect(engine.platformsStarted).toBe(false)

    // The persisted-state helpers: atomic writes and the codec registry.
    const dir = await mkdtemp(join(tmpdir(), 'fb-exports-'))
    try {
      const store = new ProjectStateStore(join(dir, 'state.json'))
      expect(store.workDirOverride()).toBe('')
      atomicWriteFileSync(join(dir, 'sessions.json'), new TextEncoder().encode('{}'), 0o644)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
    const disposeCodec = registerFeatureStateCodec({ key: 'face-spec-codec', encode: () => undefined, carry: () => {} })
    disposeCodec()

    const disposeMessages = registerMessages({ en: { face_spec_sub: 'sub' } })
    expect(lookupMessage('en', 'face_spec_sub')).toBe('sub')
    disposeMessages()
  })
})
