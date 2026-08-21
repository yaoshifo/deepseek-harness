/**
 * Attachment staging tests ported from cc-connect core/attachment_staging_test.go
 * (#8): splice/drain pure functions, stageAttachments persisting bytes to the
 * per-state pending dir, discard semantics (notify / no-notify / empty), and
 * the /new leak fix. The Go AdoptPendingFromPlaceholder cases cover the
 * placeholder→real state swap (chatroom picker carry-over) whose TS
 * equivalent is the getOrCreateInteractiveStateWith merge already covered by
 * the chatroom suites.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.js'
import {
  appendFileRefs,
  appendImageRefs,
  pendingDirFor,
  saveFilesToDir,
  saveImagesToDir,
  spliceStagedAttachments,
  type StagedAttachment,
} from '../../src/engine/attachments.js'
import { createStubAgent, createStubPlatform } from '../stubs/engine-stubs.js'
import { EventChannel } from '../../src/core/types.js'
import type { Agent, AgentSession, Message } from '../../src/core/types.js'

function workDirAgent(workDir: string): Agent & { getWorkDir(): string; setWorkDir(d: string): void } {
  let dir = workDir
  return {
    ...createStubAgent(),
    getWorkDir: () => dir,
    setWorkDir: (d: string) => { dir = d },
  }
}

function msg(overrides: Partial<Message> = {}): Message {
  return {
    sessionKey: 'testchat',
    platform: 'test',
    messageID: 'om_test',
    userID: '',
    userName: '',
    chatName: '',
    chatType: '',
    content: '',
    originalContent: '',
    images: [],
    files: [],
    extraContent: '',
    replyCtx: 'ctx',
    fromVoice: false,
    isSpawnedGroup: false,
    isPermissionAction: false,
    isAskqCardAction: false,
    isCardAction: false,
    parentMessageID: '',
    quotedText: '',
    ...overrides,
  }
}

describe('spliceStagedAttachments', () => {
  it('appends images and files as bullets and leaves empty input unchanged', () => {
    const got = spliceStagedAttachments('look here', ['/p/a.png'], ['/p/x.pdf'])
    expect(got).toContain('look here')
    expect(got).toContain('/p/a.png')
    expect(got).toContain('/p/x.pdf')
    expect(spliceStagedAttachments('hi', [], [])).toBe('hi')
    expect(spliceStagedAttachments('', ['/p/a.png'], [])).toContain('- /p/a.png')
  })
})

describe('drainStagedAttachmentPaths', () => {
  it('splits images and files and is consumed exactly once', () => {
    const s = new InteractiveState()
    s.pendingAttachments = [
      { messageID: 'om_1', kind: 'image', path: '/p/a.png' },
      { messageID: 'om_1', kind: 'image', path: '/p/b.png' },
      { messageID: 'om_2', kind: 'file', path: '/p/x.pdf' },
    ]
    const first = s.drainStagedAttachmentPaths()
    expect(first.imagePaths).toEqual(['/p/a.png', '/p/b.png'])
    expect(first.filePaths).toEqual(['/p/x.pdf'])
    expect(s.pendingAttachments).toHaveLength(0)
    const second = s.drainStagedAttachmentPaths()
    expect(second.imagePaths).toHaveLength(0)
    expect(second.filePaths).toHaveLength(0)
  })
})

describe('save helpers and pendingDirFor', () => {
  it('writes images and files and derives the hashed pending dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'att-'))
    const imgPaths = saveImagesToDir(dir, [
      { mimeType: 'image/png', data: new TextEncoder().encode('IMG') },
      { mimeType: 'image/jpeg', data: new TextEncoder().encode('J'), fileName: 'photo.jpg' },
    ])
    expect(imgPaths).toHaveLength(2)
    expect(readFileSync(imgPaths[0] ?? '', 'utf8')).toBe('IMG')
    expect(imgPaths[1]?.endsWith('photo.jpg')).toBe(true)

    const filePaths = saveFilesToDir(dir, [{ mimeType: 'application/pdf', data: new TextEncoder().encode('PDF'), fileName: 'report.pdf' }])
    expect(readFileSync(filePaths[0] ?? '', 'utf8')).toBe('PDF')

    expect(saveImagesToDir(dir, [])).toEqual([])
    expect(saveFilesToDir(dir, [])).toEqual([])

    expect(appendImageRefs('', ['/a.png'])).toBe('- /a.png')
    expect(appendImageRefs('x', ['/a.png'])).toBe('x\n\n- /a.png')
    expect(appendFileRefs('', ['/a.pdf'])).toBe('(Files saved locally, please read them: /a.pdf)')
    expect(appendFileRefs('x', ['/a.pdf'])).toBe('x\n\n(Files saved locally, please read them: /a.pdf)')

    expect(pendingDirFor('/work', 'key-1')).toBe(pendingDirFor('/work', 'key-1'))
    expect(pendingDirFor('/work', 'key-1')).not.toBe(pendingDirFor('/work', 'key-2'))
    expect(pendingDirFor('/work', 'k').startsWith('/work/.feishu-bridge/pending/')).toBe(true)
  })
})

describe('stageAttachments', () => {
  it('persists the bytes, records the staged entry, and replies', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'stage-'))
    const agent = workDirAgent(workDir)
    const p = createStubPlatform()
    const e = new Engine('test', agent, [p], '', 'en')

    e.stageAttachments(p, msg({
      files: [{ mimeType: 'application/pdf', data: new TextEncoder().encode('PDFDATA'), fileName: 'report.pdf' }],
    }), 'testchat')

    const st = e.interactiveStates.get('testchat')
    expect(st).toBeDefined()
    const pendingDir = st?.pendingDir ?? ''
    expect(pendingDir).not.toBe('')
    expect(st?.pendingAttachments).toHaveLength(1)
    const att = st?.pendingAttachments[0] as StagedAttachment
    expect(att.kind).toBe('file')
    expect(att.messageID).toBe('om_test')
    expect(att.path.startsWith(pendingDir)).toBe(true)
    expect(readFileSync(att.path, 'utf8')).toBe('PDFDATA')
    expect(p.sent.length).toBeGreaterThan(0)
  })

  it('stages a received image through handleMessage and splices it into the next turn', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'stage2-'))
    const p = createStubPlatform()
    const sends: Array<{ prompt: string; images: number }> = []
    let session: AgentSession | undefined
    const agent: Agent & { getWorkDir(): string } = {
      ...createStubAgent(),
      getWorkDir: () => workDir,
      startSession: async () => {
        session = {
          send: async (prompt: string, images) => { sends.push({ prompt, images: images.length }) },
          steer: () => {},
          respondPermission: async () => {},
          events: () => new EventChannel(),
          currentSessionID: () => 's1',
          alive: () => true,
          close: async () => {},
        }
        return session
      },
    }
    const e = new Engine('test', agent, [p], '', 'en')

    // Pure image message: staged, no agent turn.
    e.receiveMessage(p, msg({ images: [{ mimeType: 'image/png', data: new TextEncoder().encode('IMG1') }] }))
    await vi.waitFor(() => { expect(p.sent.length).toBeGreaterThan(0) })
    expect(sends).toHaveLength(0)
    const st = e.interactiveStates.get('testchat')
    expect(st?.pendingAttachments).toHaveLength(1)

    // Follow-up text consumes the staged path.
    e.receiveMessage(p, msg({ content: 'look at this' }))
    await vi.waitFor(() => { expect(sends).toHaveLength(1) })
    expect(sends[0]?.prompt).toContain('look at this')
    expect(sends[0]?.prompt).toMatch(/- \/.*\.png/)
    expect(st?.pendingAttachments).toHaveLength(0)
  })
})

describe('discardStagedAttachments', () => {
  it('clears state, removes the dir, and notifies', async () => {
    const p = createStubPlatform()
    const e = new Engine('test', createStubAgent(), [p], '', 'en')

    const dir = mkdtempSync(join(tmpdir(), 'discard-'))
    writeFileSync(join(dir, 'x.pdf'), 'X')
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'reply-ctx'
    state.pendingDir = dir
    state.pendingAttachments = [{ messageID: 'om_1', kind: 'file', path: join(dir, 'x.pdf') }]

    expect(e.discardStagedAttachments(state, true)).toBe(true)
    expect(state.pendingDir).toBe('')
    expect(state.pendingAttachments).toHaveLength(0)
    await vi.waitFor(() => { expect(existsSync(dir)).toBe(false) })
    expect(p.sent).toHaveLength(1)
  })

  it('notify=false skips the reply', () => {
    const p = createStubPlatform()
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    const dir = mkdtempSync(join(tmpdir(), 'discard2-'))
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'reply-ctx'
    state.pendingDir = dir
    state.pendingAttachments = [{ messageID: 'om_1', kind: 'file', path: join(dir, 'x.pdf') }]
    e.discardStagedAttachments(state, false)
    expect(p.sent).toHaveLength(0)
  })

  it('an empty state is a no-op returning false', () => {
    const p = createStubPlatform()
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'reply-ctx'
    expect(e.discardStagedAttachments(state, true)).toBe(false)
    expect(p.sent).toHaveLength(0)
  })
})

describe('stopInteractiveSession discards the pending dir', () => {
  it('removes the staged files on /new', async () => {
    const p = createStubPlatform()
    const e = new Engine('test', createStubAgent(), [p], '', 'en')

    const dir = mkdtempSync(join(tmpdir(), 'stop-'))
    writeFileSync(join(dir, 'x.pdf'), 'X')
    const key = 'test:chat-1:user-1'
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'reply-ctx'
    state.pendingDir = dir
    state.pendingAttachments = [{ messageID: 'om_1', kind: 'file', path: join(dir, 'x.pdf') }]
    e.interactiveStates.set(key, state)

    expect(e.stopInteractiveSession(key)).toBe(true)
    expect(e.interactiveStates.has(key)).toBe(false)
    await vi.waitFor(() => { expect(existsSync(dir)).toBe(false) })
  })
})
