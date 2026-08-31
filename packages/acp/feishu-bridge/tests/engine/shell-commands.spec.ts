/**
 * /shell command tests ported from cc-connect core engine_cmd_workspace.go
 * cmdShell + engine_test.go TestCmdShell_* (multi-workspace cases excepted:
 * shared bindings are not ported). Also covers the "!" prefix shortcut from
 * engine.go (admin gate, permission-answer precedence) and the registration
 * merge/dispose lifecycle.
 *
 * @module dsh-feishu-bridge/tests-engine-shell-commands
 */

import { mkdtempSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.ts'
import { registerSessionCommands } from '../../src/engine/commands.ts'
import { registerShellCommands } from '../../src/engine/shell-commands.ts'
import { Msg } from '../../src/i18n/index.ts'
import {
  createStubAgent,
  createStubPlatform,
  newPendingAsk,
  newStubMessage,
  testQuestions,
  type StubPlatform,
} from '../stubs/engine-stubs.ts'
import type { Agent, Message } from '../../src/core/types.ts'

function shellMsg(content: string, userID = 'admin'): Message {
  return { ...newStubMessage(), sessionKey: 'test:ch1', userID, replyCtx: 'ctx', content }
}

function newEngine(agent: Agent = createStubAgent()): { e: Engine; p: StubPlatform } {
  const p = createStubPlatform('test')
  const e = new Engine('test', agent, [p], '', 'en')
  e.setAdminFrom('admin')
  const disposeSession = registerSessionCommands(e)
  const disposeShell = registerShellCommands(e)
  void disposeSession
  void disposeShell
  return { e, p }
}

function lastSent(p: StubPlatform): string {
  return p.getSent()[p.getSent().length - 1] ?? ''
}

describe('registerShellCommands', () => {
  it('merges into the session command table and keeps /new dispatchable', () => {
    const p = createStubPlatform('test')
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    const disposeSession = registerSessionCommands(e)
    const disposeShell = registerShellCommands(e)
    try {
      expect(e.commandHandlers?.get('shell')).toBeDefined()
      expect(e.commandHandlers?.get('new')).toBeDefined()
      expect(e.dispatchCommand(p, shellMsg('/new', 'u1'), '/new')).toBe(true)
    } finally {
      disposeShell()
      disposeSession()
    }
  })

  it('disposes back to the session-only table', () => {
    const p = createStubPlatform('test')
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    const disposeSession = registerSessionCommands(e)
    const disposeShell = registerShellCommands(e)
    disposeShell()
    try {
      expect(e.commandHandlers?.get('shell')).toBeUndefined()
      expect(e.commandHandlers?.get('new')).toBeDefined()
      expect(e.dispatchCommand(p, shellMsg('/shell pwd'), '/shell pwd')).toBe(false)
    } finally {
      disposeSession()
    }
  })
})

describe('cmdShell', () => {
  it('empty command replies usage (Go TestCmdShell_EmptyCommand_ShowsUsage)', async () => {
    const { e, p } = newEngine()
    expect(e.dispatchCommand(p, shellMsg('/shell'), '/shell')).toBe(true)
    await vi.waitFor(() => { expect(p.getSent().length).toBeGreaterThanOrEqual(1) })
    expect(lastSent(p)).toBe(e.i18n.t(Msg.ShellUsage))
  })

  it('runs in the command working directory (agent work dir)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-shell-'))
    const { e, p } = newEngine({ ...createStubAgent(), getWorkDir: () => dir } as Agent)
    expect(e.dispatchCommand(p, shellMsg('/shell pwd'), '/shell pwd')).toBe(true)
    await vi.waitFor(() => { expect(lastSent(p)).toContain('```') })
    expect(lastSent(p)).toContain(realpathSync(dir))
    expect(lastSent(p)).toContain('$ pwd')
  })

  it('resolves /sh /exec /run aliases and the /she prefix', async () => {
    const { e, p } = newEngine()
    for (const raw of ['/sh true', '/exec true', '/run true', '/she true']) {
      p.getSent().length = 0
      expect(e.dispatchCommand(p, shellMsg(raw), raw)).toBe(true)
      await vi.waitFor(() => { expect(lastSent(p)).toContain('(no output)') }, { timeout: 5000 })
    }
  })

  it('non-zero exit with output shows the output (Go: err only when output empty)', async () => {
    const { e, p } = newEngine()
    expect(e.dispatchCommand(p, shellMsg('/shell echo boom && false'), '/shell echo boom && false')).toBe(true)
    await vi.waitFor(() => { expect(lastSent(p)).toContain('boom') })
    expect(lastSent(p)).not.toContain('exit status')
  })

  it('non-zero exit without output shows the error', async () => {
    const { e, p } = newEngine()
    expect(e.dispatchCommand(p, shellMsg('/shell false'), '/shell false')).toBe(true)
    await vi.waitFor(() => { expect(lastSent(p)).toContain('exit status 1') })
  })

  it('success without output replies (no output)', async () => {
    const { e, p } = newEngine()
    expect(e.dispatchCommand(p, shellMsg('/shell true'), '/shell true')).toBe(true)
    await vi.waitFor(() => { expect(lastSent(p)).toContain('(no output)') })
  })

  it('truncates output beyond 4000 runes', async () => {
    const { e, p } = newEngine()
    expect(e.dispatchCommand(p, shellMsg('/shell seq 5000 | tr "\\n" "x"'), '/shell seq 5000 | tr "\\n" "x"')).toBe(true)
    await vi.waitFor(() => { expect(lastSent(p)).toContain('...') }, { timeout: 5000 })
    // 3997 runes of payload + '...' + the fenced wrapper stays under 4100 runes.
    expect(Array.from(lastSent(p)).length).toBeLessThan(4100)
  }, 15000)

  it('honors --timeout and replies the timeout message', async () => {
    const { e, p } = newEngine()
    expect(e.dispatchCommand(p, shellMsg('/shell --timeout 1 sleep 5'), '/shell --timeout 1 sleep 5')).toBe(true)
    await vi.waitFor(() => { expect(lastSent(p)).toContain(e.i18n.tf(Msg.CommandTimeout, 'sleep 5').split('`')[0] ?? '⏰') }, { timeout: 5000 })
    expect(lastSent(p)).toContain('sleep 5')
    expect(lastSent(p)).not.toContain('```')
  }, 15000)

  it('requires admin for /shell (privileged gate)', async () => {
    const { e, p } = newEngine()
    expect(e.dispatchCommand(p, shellMsg('/shell pwd', 'stranger'), '/shell pwd')).toBe(true)
    await vi.waitFor(() => { expect(lastSent(p)).toContain(e.i18n.tf(Msg.AdminRequired, '/shell').split('`')[0] ?? '🔒') })
    expect(e.commandHandlers?.get('shell')).toBeDefined()
  })
})

describe('"!" prefix shortcut', () => {
  it('runs the shell command like /shell', async () => {
    const { e, p } = newEngine()
    void e.handleMessage(p, shellMsg('!echo bang'))
    await vi.waitFor(() => { expect(lastSent(p)).toContain('bang') })
    expect(lastSent(p)).toContain('$ echo bang')
  })

  it('requires admin', async () => {
    const { e, p } = newEngine()
    void e.handleMessage(p, shellMsg('!echo nope', 'stranger'))
    await vi.waitFor(() => { expect(lastSent(p)).toContain(e.i18n.tf(Msg.AdminRequired, '!').split('`')[0] ?? '🔒') })
  })

  it('a pending permission answer wins over the shell path (!yes)', async () => {
    const { e, p } = newEngine()
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'
    state.pendingAsk = newPendingAsk({
      request: { kind: 'questions', questions: testQuestions() },
    })
    e.interactiveStates.set('test:ch1', state)

    void e.handleMessage(p, shellMsg('!yes'))

    // "!yes" is free text for the first unanswered question; with a single
    // question the ask settles (collected answer observable on the map).
    expect(state.pendingAsk?.answers.get(0)?.custom).toBe('!yes')
    // The message never reached the shell executor.
    for (const line of p.getSent()) {
      expect(line).not.toContain('$ !yes')
    }
  })

  it('empty "!" falls through to the agent', () => {
    const { e, p } = newEngine()
    // "!" alone must not be consumed by the shell branch: dispatch falls
    // through to the session path (stub agent replies nothing here, so we
    // only assert no shell output was sent).
    void e.handleMessage(p, shellMsg('!'))
    expect(p.getSent().join('\n')).not.toContain('$')
  })
})
