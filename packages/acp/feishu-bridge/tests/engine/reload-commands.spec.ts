/**
 * /reload command tests: registration merge/dispose, exact-match resolver,
 * admin gate, argument validation, missing-script error, the detached spawn
 * contract (setsid + FB_RELOAD_FROM_DAEMON bypass + reply-before-spawn),
 * in-flight refusal, and exit-code failure reporting. The real daemon
 * restart is smoke-tested manually on the launchd deployment (the package's
 * OPERATIONS.md §3.3).
 *
 * @module dsh-feishu-bridge/tests-engine-reload-commands
 */

import { existsSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine } from '../../src/engine/engine.js'
import { registerSessionCommands } from '../../src/engine/commands.js'
import { registerReloadCommands, resolveReloadScript } from '../../src/engine/reload-commands.js'
import { Msg } from '../../src/i18n/index.js'
import {
  createStubAgent,
  createStubPlatform,
  newStubMessage,
  type StubPlatform,
} from '../stubs/engine-stubs.js'
import type { Agent, Message } from '../../src/core/types.js'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, existsSync: vi.fn((p: import('node:fs').PathLike) => actual.existsSync(p)) }
})

import { spawn } from 'node:child_process'

const mockSpawn = vi.mocked(spawn)
const mockExists = vi.mocked(existsSync)

const scriptPath = fileURLToPath(new URL('../../reload.sh', import.meta.url))
const packageRoot = fileURLToPath(new URL('../..', import.meta.url))

/** Captured 'exit'/'error' callbacks of the last fake child. */
const childCbs = new Map<string, (arg: unknown) => void>()
/** Sent-message count observed at the moment spawn was called. */
let sentAtSpawn = -1
let currentPlatform: StubPlatform | undefined

function fakeChild(): { unref: () => void; on: (event: string, cb: (arg: unknown) => void) => void } {
  return {
    unref: vi.fn(),
    on: (event, cb) => { childCbs.set(event, cb) },
  }
}

function reloadMsg(content: string, userID = 'admin'): Message {
  return { ...newStubMessage(), sessionKey: 'test:ch1', userID, replyCtx: 'ctx', content }
}

function newEngine(agent: Agent = createStubAgent()): { e: Engine; p: StubPlatform } {
  const p = createStubPlatform('test')
  const e = new Engine('test', agent, [p], '', 'en')
  e.setAdminFrom('admin')
  registerSessionCommands(e)
  registerReloadCommands(e)
  return { e, p }
}

function lastSent(p: StubPlatform): string {
  return p.getSent()[p.getSent().length - 1] ?? ''
}

let realExistsSync: typeof import('node:fs').existsSync
let logDir: string
let savedLogDir: string | undefined

beforeAll(async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  realExistsSync = actual.existsSync
})

beforeEach(() => {
  mockSpawn.mockReset()
  mockSpawn.mockImplementation(() => {
    sentAtSpawn = currentPlatform?.getSent().length ?? -1
    return fakeChild() as unknown as import('node:child_process').ChildProcess
  })
  mockExists.mockImplementation(p => realExistsSync(p))
  childCbs.clear()
  sentAtSpawn = -1
  logDir = mkdtempSync(join(tmpdir(), 'fb-reload-'))
  savedLogDir = process.env.LOG_DIR
  process.env.LOG_DIR = logDir
})

afterEach(() => {
  if (savedLogDir === undefined) delete process.env.LOG_DIR
  else process.env.LOG_DIR = savedLogDir
  rmSync(logDir, { recursive: true, force: true })
  // Leave the module-level in-flight flag cleared for the next test.
  childCbs.get('exit')?.(0)
})

describe('registerReloadCommands', () => {
  it('merges into the session command table and keeps /new dispatchable', () => {
    const p = createStubPlatform('test')
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    const disposeSession = registerSessionCommands(e)
    const disposeReload = registerReloadCommands(e)
    try {
      expect(e.commandHandlers?.get('reload')).toBeDefined()
      expect(e.commandHandlers?.get('new')).toBeDefined()
      expect(e.dispatchCommand(p, reloadMsg('/new'), '/new')).toBe(true)
    } finally {
      disposeReload()
      disposeSession()
    }
  })

  it('disposes back to the session-only table', () => {
    const p = createStubPlatform('test')
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    const disposeSession = registerSessionCommands(e)
    const disposeReload = registerReloadCommands(e)
    disposeReload()
    try {
      expect(e.commandHandlers?.get('reload')).toBeUndefined()
      expect(e.commandHandlers?.get('new')).toBeDefined()
      expect(e.dispatchCommand(p, reloadMsg('/reload'), '/reload')).toBe(false)
    } finally {
      disposeSession()
    }
  })

  it('resolves /reload exactly — no prefix resolution that would shadow /rename', () => {
    const { e } = newEngine()
    expect(e.commandResolver?.('reload')).toBe('reload')
    expect(e.commandResolver?.('re')).not.toBe('reload')
    expect(e.commandResolver?.('rel')).not.toBe('reload')
  })
})

describe('cmdReload', () => {
  it('requires admin for /reload (privileged gate)', async () => {
    const { e, p } = newEngine()
    currentPlatform = p
    expect(e.dispatchCommand(p, reloadMsg('/reload', 'stranger'), '/reload')).toBe(true)
    await vi.waitFor(() => { expect(lastSent(p)).toContain(e.i18n.tf(Msg.AdminRequired, '/reload').split('`')[0] ?? '🔒') })
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('unknown argument replies usage without spawning', async () => {
    const { e, p } = newEngine()
    currentPlatform = p
    expect(e.dispatchCommand(p, reloadMsg('/reload --wat'), '/reload --wat')).toBe(true)
    await vi.waitFor(() => { expect(lastSent(p)).toBe(e.i18n.t(Msg.ReloadUsage)) })
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('missing reload.sh replies the script-missing error without spawning', async () => {
    const { e, p } = newEngine()
    currentPlatform = p
    // Under the source-plane module URL the miss fallback is src/reload.sh.
    const missPath = join(packageRoot, 'src', 'reload.sh')
    mockExists.mockReturnValue(false)
    try {
      expect(e.dispatchCommand(p, reloadMsg('/reload'), '/reload')).toBe(true)
      await vi.waitFor(() => { expect(lastSent(p)).toContain(missPath) })
      expect(mockSpawn).not.toHaveBeenCalled()
    } finally {
      mockExists.mockImplementation(path => realExistsSync(path))
    }
  })

  it('replies "started" before spawning reload.sh detached with the guard bypass', async () => {
    const { e, p } = newEngine()
    currentPlatform = p
    expect(e.dispatchCommand(p, reloadMsg('/reload'), '/reload')).toBe(true)
    await vi.waitFor(() => { expect(mockSpawn).toHaveBeenCalledTimes(1) })
    const [cmd, argv, opts] = mockSpawn.mock.calls[0] ?? []
    expect(cmd).toBe('sh')
    expect(argv).toEqual([scriptPath])
    expect(opts?.detached).toBe(true)
    expect(opts?.stdio?.[0]).toBe('ignore')
    expect(opts?.env?.FB_RELOAD_FROM_DAEMON).toBe('1')
    // The confirmation must precede the spawn: --skip-build restarts within
    // seconds, and a post-restart reply would never arrive.
    expect(sentAtSpawn).toBeGreaterThanOrEqual(1)
    expect(lastSent(p)).toBe(e.i18n.tf(Msg.ReloadStarted, join(logDir, 'feishu-bridge-reload.log')))
  })

  it('passes --skip-build through to the script', async () => {
    const { e, p } = newEngine()
    currentPlatform = p
    expect(e.dispatchCommand(p, reloadMsg('/reload --skip-build'), '/reload --skip-build')).toBe(true)
    await vi.waitFor(() => { expect(mockSpawn).toHaveBeenCalledTimes(1) })
    expect(mockSpawn.mock.calls[0]?.[1]).toEqual([scriptPath, '--skip-build'])
  })

  it('refuses a second /reload while one is in flight, then recovers after failure', async () => {
    const { e, p } = newEngine()
    currentPlatform = p
    expect(e.dispatchCommand(p, reloadMsg('/reload'), '/reload')).toBe(true)
    await vi.waitFor(() => { expect(mockSpawn).toHaveBeenCalledTimes(1) })
    expect(e.dispatchCommand(p, reloadMsg('/reload'), '/reload')).toBe(true)
    await vi.waitFor(() => { expect(lastSent(p)).toBe(e.i18n.t(Msg.ReloadInProgress)) })
    expect(mockSpawn).toHaveBeenCalledTimes(1)

    // The script failed before unload (e.g. build error): the daemon is
    // still alive, the user gets the failure reply, and a retry can spawn.
    childCbs.get('exit')?.(2)
    await vi.waitFor(() => { expect(lastSent(p)).toBe(e.i18n.tf(Msg.ReloadFailed, 2, join(logDir, 'feishu-bridge-reload.log'))) })
    expect(e.dispatchCommand(p, reloadMsg('/reload'), '/reload')).toBe(true)
    await vi.waitFor(() => { expect(mockSpawn).toHaveBeenCalledTimes(2) })
    childCbs.get('exit')?.(0)
  })

  it('a spawn error clears the in-flight flag and reports failure', async () => {
    const { e, p } = newEngine()
    currentPlatform = p
    expect(e.dispatchCommand(p, reloadMsg('/reload'), '/reload')).toBe(true)
    await vi.waitFor(() => { expect(mockSpawn).toHaveBeenCalledTimes(1) })
    childCbs.get('error')?.(new Error('ENOENT'))
    await vi.waitFor(() => { expect(lastSent(p)).toBe(e.i18n.tf(Msg.ReloadFailed, -1, join(logDir, 'feishu-bridge-reload.log'))) })
    expect(e.dispatchCommand(p, reloadMsg('/reload'), '/reload')).toBe(true)
    await vi.waitFor(() => { expect(mockSpawn).toHaveBeenCalledTimes(2) })
  })

  it('a clean script exit sends no failure reply', async () => {
    const { e, p } = newEngine()
    currentPlatform = p
    expect(e.dispatchCommand(p, reloadMsg('/reload'), '/reload')).toBe(true)
    await vi.waitFor(() => { expect(mockSpawn).toHaveBeenCalledTimes(1) })
    const sent = p.getSent().length
    childCbs.get('exit')?.(0)
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(p.getSent().length).toBe(sent)
  })
})

describe('resolveReloadScript', () => {
  it('resolves from the tsdown bundle layout (lib/index.js, no lib/engine/)', () => {
    // The daemon loads the plugin through main: lib/index.js — a single
    // tsdown bundle that inlines every engine module, so import.meta.url is
    // the bundle file itself.
    const from = pathToFileURL(join(packageRoot, 'lib', 'index.js'))
    expect(resolveReloadScript(from)).toBe(scriptPath)
  })

  it('resolves from the source layout (src/engine/<file>)', () => {
    const from = pathToFileURL(join(packageRoot, 'src', 'engine', 'reload-commands.ts'))
    expect(resolveReloadScript(from)).toBe(scriptPath)
  })

  it('falls back to the last candidate when no layout matches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-reload-resolve-'))
    try {
      const from = pathToFileURL(join(dir, 'bundle.js'))
      // Last candidate '../reload.sh' resolves against the module URL's directory.
      expect(resolveReloadScript(from)).toBe(join(tmpdir(), 'reload.sh'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
