import { describe, expect, it, vi } from 'vitest'
import {
  couldBeSilentPrefix,
  defaultEventIdleTimeout,
  Engine,
  extractChannelID,
  InteractiveState,
  isSilentReply,
  splitMessage,
  stripTrailingSilent,
} from '../../src/engine/engine.js'
import { Session } from '../../src/engine/session.js'
import {
  createControllableAgent,
  createStubAgent,
  createStubMediaPlatform,
  createStubPlatform,
  newControllableSession,
  newQueuingSession,
  type ControllableAgentSession,
  type StubPlatform,
} from '../stubs/engine-stubs.js'
import type { Agent, Platform } from '../../src/core/types.js'

// Ported from cc-connect core/engine_test.go — M1 scope: core event handling
// (result/text/thinking basics), message queueing (#13), side-channel dedup,
// basic reply paths, idle/stall, cleanup CAS, and session writeback.

function newEngine(agent?: Agent, p?: Platform): { e: Engine; p: StubPlatform } {
  const platform = p ?? createStubPlatform()
  const engine = new Engine('test', agent ?? createStubAgent(), [platform], '', 'en')
  return { e: engine, p: platform as StubPlatform }
}

function msg(overrides: Partial<Parameters<Engine['receiveMessage']>[1]> = {}) {
  return {
    sessionKey: 'test:user1',
    platform: 'test',
    messageID: '',
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

describe('splitMessage', () => {
  it('ASCII short stays one chunk', () => {
    expect(splitMessage('hello', 10)).toEqual(['hello'])
  })

  it('CJK characters split at rune boundary', () => {
    const input = '你好世界测试一二三四'
    expect(Array.from(input)).toHaveLength(10)
    const chunks = splitMessage(input, 5)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toBe('你好世界测')
    expect(chunks[1]).toBe('试一二三四')
  })

  it('emoji split at rune boundary', () => {
    const input = '😀😁😂🤣😄😅'
    expect(Array.from(input)).toHaveLength(6)
    const chunks = splitMessage(input, 3)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toBe('😀😁😂')
    expect(chunks[1]).toBe('🤣😄😅')
  })

  it('prefers newline split', () => {
    const chunks = splitMessage('abcde\nfghij', 8)
    expect(chunks).toEqual(['abcde\n', 'fghij'])
  })

  it('CJK with newline split', () => {
    const chunks = splitMessage('你好\n世界测试一二三四', 5)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks[0]).toBe('你好\n')
  })
})

describe('isSilentReply', () => {
  it.each([
    ['NO_REPLY', true],
    ['no_reply', true],
    ['No_Reply', true],
    ['  NO_REPLY  ', true],
    ['\nNO_REPLY\n', true],
    ['\tNO_REPLY\t', true],
    ['', false],
    ['   ', false],
    ['Hello NO_REPLY', false],
    ['NO_REPLY_EXTRA', false],
    ['X NO_REPLY', false],
    ['NO REPLY', false],
    ['NO_REPL', false],
  ])('%j → %s', (input, want) => {
    expect(isSilentReply(input)).toBe(want)
  })
})

describe('stripTrailingSilent', () => {
  it.each([
    ['Hello\nNO_REPLY', 'Hello', true],
    ['Hello\nno_reply', 'Hello', true],
    ['Some reasoning here NO_REPLY', 'Some reasoning here', true],
    ['Line1\nLine2\nNO_REPLY', 'Line1\nLine2', true],
    ['Done. *NO_REPLY*', 'Done. *NO_REPLY*', false],
    ['Done.**NO_REPLY', 'Done.', true],
    ['Hello\r\nNO_REPLY', 'Hello', true],
    ['Hello NO_REPLY   ', 'Hello', true],
    ['Hello world', 'Hello world', false],
    ['NO_REPLY then more', 'NO_REPLY then more', false],
    ['Hello NO_REPLY_EXTRA', 'Hello NO_REPLY_EXTRA', false],
    ['somethingNO_REPLY', 'somethingNO_REPLY', false],
    ['', '', false],
  ])('%j', (input, want, wantOK) => {
    const [got, ok] = stripTrailingSilent(input)
    expect(ok).toBe(wantOK)
    expect(got).toBe(want)
  })
})

describe('couldBeSilentPrefix', () => {
  it.each([
    ['', true],
    ['   ', true],
    ['N', true],
    ['NO', true],
    ['NO_', true],
    ['NO_RE', true],
    ['NO_REPL', true],
    ['NO_REPLY', true],
    ['no_r', true],
    ['No_Re', true],
    ['  NO_  ', true],
    ['Hello', false],
    ['X', false],
    ['NO_REPLYX', false],
    ['NO-REPLY', false],
    ['NO_Q', false],
  ])('%j → %s', (input, want) => {
    expect(couldBeSilentPrefix(input)).toBe(want)
  })
})

describe('buildSenderPrompt', () => {
  it('Enabled', () => {
    const { e } = newEngine()
    e.setInjectSender(true)
    expect(e.buildSenderPrompt('hello world', 'user123', 'Alice', 'feishu', 'feishu:channel42:user123'))
      .toBe('[feishu-bridge sender_id=user123 sender_name="Alice" platform=feishu chat_id=channel42]\nhello world')
  })

  it('Disabled', () => {
    const { e } = newEngine()
    e.setInjectSender(false)
    expect(e.buildSenderPrompt('hello', 'user1', 'Alice', 'feishu', 'feishu:ch:user1')).toBe('hello')
  })

  it('EmptyUserID', () => {
    const { e } = newEngine()
    e.setInjectSender(true)
    expect(e.buildSenderPrompt('hello', '', 'Bob', 'telegram', 'telegram:ch:user1')).toBe('hello')
  })

  it('EmptyUserName', () => {
    const { e } = newEngine()
    e.setInjectSender(true)
    expect(e.buildSenderPrompt('hello', 'user1', '', 'feishu', 'feishu:ch:user1'))
      .toBe('[feishu-bridge sender_id=user1 platform=feishu chat_id=ch]\nhello')
  })

  it('NameWithSpaces', () => {
    const { e } = newEngine()
    e.setInjectSender(true)
    expect(e.buildSenderPrompt('hi', 'U999', 'Jim Tang', 'slack', 'slack:C012:U999'))
      .toBe('[feishu-bridge sender_id=U999 sender_name="Jim Tang" platform=slack chat_id=C012]\nhi')
  })

  it.each([
    ['telegram', 'telegram:group99:alice', 'group99'],
    ['discord', 'discord:server1:bob', 'server1'],
    ['slack', 'slack:C012345:carol', 'C012345'],
  ])('DifferentPlatforms %s', (platform, sessionKey, wantChat) => {
    const { e } = newEngine()
    e.setInjectSender(true)
    const result = e.buildSenderPrompt('msg', 'uid', 'TestUser', platform, sessionKey)
    expect(result).toContain(`platform=${platform}`)
    expect(result).toContain(`chat_id=${wantChat}`)
  })

  it('SanitizesSpecialChars', () => {
    const { e } = newEngine()
    e.setInjectSender(true)
    const result = e.buildSenderPrompt('hi', 'U1', 'Evil"Name\nInject', 'slack', 'slack:C1:U1')
    expect(result).toContain('sender_name="Evil\'Name Inject"')
  })
})

describe('extractChannelID', () => {
  it.each([
    ['feishu:channel42:user1', 'channel42'],
    ['telegram:group123:user2', 'group123'],
    ['plain', ''],
    ['a:b', 'b'],
    ['a:b:c:d', 'b'],
  ])('%j → %j', (key, want) => {
    expect(extractChannelID(key)).toBe(want)
  })
})

describe('Engine aliases', () => {
  it('Alias', () => {
    const { e } = newEngine()
    e.aliases.set('帮助', '/help')
    e.aliases.set('新建', '/new')
    expect(e.resolveAlias('帮助')).toBe('/help')
    expect(e.resolveAlias('新建 my-session')).toBe('/new my-session')
    expect(e.resolveAlias('random text')).toBe('random text')
  })

  it('ClearAliases', () => {
    const { e } = newEngine()
    e.aliases.set('帮助', '/help')
    e.aliases.clear()
    expect(e.resolveAlias('帮助')).toBe('帮助')
  })
})

describe('stallConfirmed', () => {
  it('re-verifies against the last event arrival', () => {
    const { e } = newEngine()
    const state = new InteractiveState()
    const idle = 2 * 60 * 1000

    state.lastEventAt = 0
    expect(e.stallConfirmed(state, idle * 2, idle), 'want stalled when no event has ever arrived').toBe(true)

    state.lastEventAt = Date.now() - 6000
    expect(e.stallConfirmed(state, Date.now(), idle), 'want NOT stalled when an event arrived recently').toBe(false)

    state.lastEventAt = Date.now() - 3 * 60 * 1000
    expect(e.stallConfirmed(state, Date.now(), idle), 'want stalled past the idle timeout').toBe(true)
  })
})

it('IdleTimeout_Default is 10 minutes', () => {
  expect(defaultEventIdleTimeout).toBe(10 * 60 * 1000)
})

describe('SendToSessionWithAttachments', () => {
  it('delivers text, image, and file', async () => {
    const p = createStubMediaPlatform()
    const { e } = newEngine(createStubAgent(), p)
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx-1'
    e.interactiveStates.set('session-1', state)

    await e.sendToSessionWithAttachments('session-1', 'delivery ready',
      [{ mimeType: 'image/png', data: new Uint8Array([1]), fileName: 'chart.png' }],
      [{ mimeType: 'text/plain', data: new Uint8Array([2]), fileName: 'report.txt' }])

    expect(p.getSent()).toEqual(['delivery ready'])
    expect(p.images).toHaveLength(1)
    expect(p.images[0]!.fileName).toBe('chart.png')
    expect(p.files).toHaveLength(1)
    expect(p.files[0]!.fileName).toBe('report.txt')
  })

  it('UnsupportedPlatform fails before any send', async () => {
    const { e, p } = newEngine()
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx-1'
    e.interactiveStates.set('session-1', state)

    await expect(e.sendToSessionWithAttachments('session-1', 'delivery ready',
      [{ mimeType: 'image/png', data: new Uint8Array([1]), fileName: 'chart.png' }], []))
      .rejects.toThrow(/not supported/)
    expect(p.getSent()).toEqual([])
  })

  it('DisabledByConfig blocks attachments', async () => {
    const p = createStubMediaPlatform()
    const { e } = newEngine(createStubAgent(), p)
    e.setAttachmentSendEnabled(false)
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx-1'
    e.interactiveStates.set('session-1', state)

    await expect(e.sendToSessionWithAttachments('session-1', 'delivery ready', [],
      [{ mimeType: 'text/plain', data: new Uint8Array([2]), fileName: 'report.txt' }]))
      .rejects.toThrow(/disabled by config/)
    expect(p.getSent()).toEqual([])
    expect(p.files).toHaveLength(0)
  })
})

describe('processInteractiveEvents side-channel dedup', () => {
  it('SuppressesDuplicateSideChannelText', async () => {
    const p = createStubMediaPlatform()
    const { e } = newEngine(createStubAgent(), p)
    const sessionKey = 'test:user1'
    const session = e.sessions.getOrCreateActive(sessionKey)
    const agentSession = newControllableSession('s1')
    const state = new InteractiveState()
    state.agentSession = agentSession
    state.platform = p
    state.replyCtx = 'ctx-1'
    e.interactiveStates.set(sessionKey, state)

    const sideText = '已发送 AGENTS.md 文件给你。'
    await e.sendToSessionWithAttachments(sessionKey, sideText, [], [{
      mimeType: 'text/markdown', data: new Uint8Array([1]), fileName: 'AGENTS.md',
    }])

    agentSession.channel.push({ type: 'result', content: sideText, done: true })
    await e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)

    expect(p.getSent()).toEqual([sideText])
  })

  it('DoesNotSuppressDifferentFinalText', async () => {
    const p = createStubMediaPlatform()
    const { e } = newEngine(createStubAgent(), p)
    const sessionKey = 'test:user1'
    const session = e.sessions.getOrCreateActive(sessionKey)
    const agentSession = newControllableSession('s1')
    const state = new InteractiveState()
    state.agentSession = agentSession
    state.platform = p
    state.replyCtx = 'ctx-1'
    e.interactiveStates.set(sessionKey, state)

    await e.sendToSessionWithAttachments(sessionKey, '已发送 AGENTS.md 文件给你。', [], [{
      mimeType: 'text/markdown', data: new Uint8Array([1]), fileName: 'AGENTS.md',
    }])

    const finalText = '文件已发出，另外我也把使用方法整理好了。'
    agentSession.channel.push({ type: 'result', content: finalText, done: true })
    await e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)

    const got = p.getSent()
    expect(got).toHaveLength(2)
    expect(got[0]).not.toBe(got[1])
    expect(got[1]).toBe(finalText)
  })
})

/** Stub platform with the M2 preview capabilities, recording card PATCHes. */
function createPreviewRecorderPlatform(): StubPlatform & { messages: string[] } {
  const messages: string[] = []
  return Object.assign(createStubPlatform(), {
    messages,
    async sendPreviewStart(_rc: unknown, content: string): Promise<unknown> {
      messages.push(`start:${content}`)
      return 'preview-handle'
    },
    async updateMessage(_rc: unknown, content: string): Promise<void> {
      messages.push(`update:${content}`)
    },
  })
}

describe('processInteractiveEvents error-reasoned turn', () => {
  it('marks the card failed and reports the error instead of the interim narration', async () => {
    const p = createPreviewRecorderPlatform()
    const { e } = newEngine(createStubAgent(), p)
    e.setDisplayConfig({ toolProgress: true })
    const sessionKey = 'test:user1'
    const session = e.sessions.getOrCreateActive(sessionKey)
    const agentSession = newControllableSession('s1')
    const state = new InteractiveState()
    state.agentSession = agentSession
    state.platform = p
    state.replyCtx = 'ctx-1'
    e.interactiveStates.set(sessionKey, state)

    const narration = '解压会话日志，看最后几条事件。'
    agentSession.channel.push({ type: 'tool_use', toolName: 'bash', toolInput: 'zstd -dc session.jsonl.zstd', toolID: 'call-1', content: '', done: false })
    agentSession.channel.push({ type: 'tool_result', toolResult: 'ok', toolID: 'call-1', content: '', done: false })
    agentSession.channel.push({ type: 'text', content: narration, done: false })
    agentSession.channel.push({ type: 'result', content: narration, errorText: '1301 sensitive content rejected', done: true })
    await e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)

    const finalCard = [...p.messages].reverse().find(m => m.includes('__cc_state__'))
    expect(finalCard, `cards=${JSON.stringify(p.messages)}`).toContain('__cc_state__:failed')
    expect(finalCard).toContain('1301 sensitive content rejected')
    expect(finalCard).not.toContain('__cc_state__:completed')
    // An errored turn never records a clean lastResult the narration could leak through.
    expect(session.getLastResult()).not.toContain(narration)
  })

  it('delivers the error as a plain message without a preview card', async () => {
    const p = createStubPlatform()
    const { e } = newEngine(createStubAgent(), p)
    const sessionKey = 'test:user1'
    const session = e.sessions.getOrCreateActive(sessionKey)
    const agentSession = newControllableSession('s1')
    const state = new InteractiveState()
    state.agentSession = agentSession
    state.platform = p
    state.replyCtx = 'ctx-1'
    e.interactiveStates.set(sessionKey, state)

    agentSession.channel.push({ type: 'result', content: '', errorText: 'No API key for provider', done: true })
    await e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)

    expect(p.getSent().some(m => m.includes('No API key for provider')), `sent=${JSON.stringify(p.getSent())}`).toBe(true)
  })
})

describe('processInteractiveEvents turn token rate', () => {
  it('closes a tool interval on its matching tool_result so the rate spans post-tool generation', async () => {
    const p = createStubMediaPlatform()
    const { e } = newEngine(createStubAgent(), p)
    const sessionKey = 'test:user1'
    const session = e.sessions.getOrCreateActive(sessionKey)
    const agentSession = newControllableSession('s1')
    const state = new InteractiveState()
    state.agentSession = agentSession
    state.platform = p
    state.replyCtx = 'ctx-1'
    e.interactiveStates.set(sessionKey, state)

    const done = e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)
    agentSession.channel.push({ type: 'tool_use', toolName: 'bash', toolInput: 'ls', toolID: 'call-1', content: '', done: false })
    agentSession.channel.push({ type: 'tool_result', toolResult: 'out', toolID: 'call-1', content: '', done: false })
    // Generation after the tool: if the interval closed at the tool_result,
    // this span stays in the thinking time and the rate line renders; if it
    // stayed open until the result, the thinking time collapses under the
    // 200ms floor and tokenRateMsg is ''.
    await new Promise(r => setTimeout(r, 300))
    agentSession.channel.push({ type: 'result', content: 'answer', outputTokens: 300, inputTokens: 500, done: true })
    await done

    expect(e.usage.tokenRateMsg).not.toBe('')
  })
})

describe('processInteractiveEvents channel closed', () => {
  it('notifies the user that the agent process exited', async () => {
    const p = createStubMediaPlatform()
    const { e } = newEngine(createStubAgent(), p)
    const sessionKey = 'test:user1'
    const session = e.sessions.getOrCreateActive(sessionKey)
    const agentSession = newControllableSession('s1')
    const state = new InteractiveState()
    state.agentSession = agentSession
    state.platform = p
    state.replyCtx = 'ctx-1'
    e.interactiveStates.set(sessionKey, state)

    await agentSession.close()
    await e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)

    const notice = e.i18n.t('agent_process_exited')
    expect(p.getSent().some(m => m.includes(notice)), `sent=${JSON.stringify(p.getSent())}`).toBe(true)
  })

  it('stopped session stays silent', async () => {
    const p = createStubMediaPlatform()
    const { e } = newEngine(createStubAgent(), p)
    const sessionKey = 'test:user1'
    const session = e.sessions.getOrCreateActive(sessionKey)
    const agentSession = newControllableSession('s1')
    const state = new InteractiveState()
    state.agentSession = agentSession
    state.platform = p
    state.replyCtx = 'ctx-1'
    e.interactiveStates.set(sessionKey, state)

    state.markStopped()
    await agentSession.close()
    await e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)

    expect(p.getSent()).toEqual([])
  })

  it('engine stop reports the plugin reload instead of a process exit', async () => {
    const p = createStubMediaPlatform()
    const { e } = newEngine(createStubAgent(), p)
    const sessionKey = 'test:user1'
    const session = e.sessions.getOrCreateActive(sessionKey)
    const agentSession = newControllableSession('s1')
    const state = new InteractiveState()
    state.agentSession = agentSession
    state.platform = p
    state.replyCtx = 'ctx-1'
    e.interactiveStates.set(sessionKey, state)

    const done = e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)
    await e.stop()
    await done

    const sent = p.getSent()
    expect(sent.some(m => m.includes(e.i18n.t('plugin_reloaded'))), `sent=${JSON.stringify(sent)}`).toBe(true)
    expect(sent.some(m => m.includes(e.i18n.t('agent_process_exited')))).toBe(false)
  })

  it('engine stop notifies an in-flight turn directly', async () => {
    const p = createStubMediaPlatform()
    const { e } = newEngine(createStubAgent(), p)
    const sessionKey = 'test:user1'
    const agentSession = newControllableSession('s1')
    const state = new InteractiveState()
    state.agentSession = agentSession
    state.platform = p
    state.replyCtx = 'ctx-1'
    state.beginTurn()
    e.interactiveStates.set(sessionKey, state)

    // No processInteractiveEvents loop runs: the stop's notice must not
    // depend on the loop being scheduled before process exit.
    await e.stop()

    const sent = p.getSent()
    expect(sent.some(m => m.includes(e.i18n.t('plugin_reloaded'))), `sent=${JSON.stringify(sent)}`).toBe(true)
    expect(sent.some(m => m.includes(e.i18n.t('agent_process_exited')))).toBe(false)
  })

  it('engine stop notifies an in-flight turn once even when the loop also drains the close', async () => {
    const p = createStubMediaPlatform()
    const { e } = newEngine(createStubAgent(), p)
    const sessionKey = 'test:user1'
    const session = e.sessions.getOrCreateActive(sessionKey)
    const agentSession = newControllableSession('s1')
    const state = new InteractiveState()
    state.agentSession = agentSession
    state.platform = p
    state.replyCtx = 'ctx-1'
    state.beginTurn()
    e.interactiveStates.set(sessionKey, state)

    const done = e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)
    await e.stop()
    await done

    const notice = e.i18n.t('plugin_reloaded')
    const count = p.getSent().filter(m => m.includes(notice)).length
    expect(count, `sent=${JSON.stringify(p.getSent())}`).toBe(1)
  })

  it('delivers partial text plus the exit notice', async () => {
    const p = createStubMediaPlatform()
    const { e } = newEngine(createStubAgent(), p)
    const sessionKey = 'test:user1'
    const session = e.sessions.getOrCreateActive(sessionKey)
    const agentSession = newControllableSession('s1')
    const state = new InteractiveState()
    state.agentSession = agentSession
    state.platform = p
    state.replyCtx = 'ctx-1'
    e.interactiveStates.set(sessionKey, state)

    agentSession.channel.push({ type: 'text', content: 'partial analysis', done: false })
    await agentSession.close()
    await e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)

    const sent = p.getSent()
    expect(sent.some(m => m.includes('partial analysis'))).toBe(true)
    expect(sent.some(m => m.includes(e.i18n.t('agent_process_exited')))).toBe(true)
  })
})

describe('processInteractiveEvents user stop mid-handler', () => {
  /**
   * Reproduces the 2026-08-22 oc_74a7 incident: a rate-limited Feishu
   * sendPreviewStart holds the preview lock for seconds; the user /done lands
   * while the event loop is parked inside sp.appendProgress. The loop then
   * exits via channel-close without the stop arm, so the card must be
   * finalized by stopInteractiveSession itself — a ⏹ stopped render, and no
   * Running-state PATCH may land after it.
   */
  it('finalizes the preview card on stopInteractiveSession when the loop is mid-handler', async () => {
    const messages: string[] = []
    let releaseStart: (() => void) | undefined
    const startGate = new Promise<void>((resolve) => { releaseStart = () => { resolve() } })
    const p = Object.assign(createStubPlatform(), {
      messages,
      async sendPreviewStart(_rc: unknown, content: string): Promise<unknown> {
        await startGate
        messages.push(`start:${content}`)
        return 'preview-handle'
      },
      async updateMessage(_handle: unknown, content: string): Promise<void> {
        messages.push(`update:${content}`)
      },
      async renderStoppedCard(_rc: unknown, id: unknown): Promise<void> {
        messages.push(`stopped:${String(id)}`)
      },
    })
    const { e } = newEngine(createStubAgent(), p)
    e.setDisplayConfig({ toolProgress: true })
    const sessionKey = 'test:stop-mid-handler'
    const session = e.sessions.getOrCreateActive(sessionKey)
    const agentSession = newControllableSession('s1')
    const state = new InteractiveState()
    state.agentSession = agentSession
    state.platform = p
    state.replyCtx = 'ctx-1'
    e.interactiveStates.set(sessionKey, state)

    const done = e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)
    // Placeholder flush parks holding the preview lock inside sendPreviewStart.
    await new Promise(r => setTimeout(r, 0))
    agentSession.channel.push({ type: 'tool_use', toolName: 'bash', toolInput: 'ls', toolID: 'call-1', content: '', done: false })
    // The loop picks the event up and parks in appendProgress on the lock.
    await new Promise(r => setTimeout(r, 0))

    e.stopInteractiveSession(sessionKey)
    releaseStart!()
    await done
    await new Promise(r => setTimeout(r, 20))

    const stoppedIdx = messages.findIndex(m => m.startsWith('stopped:'))
    expect(stoppedIdx, `messages=${JSON.stringify(messages)}`).toBeGreaterThanOrEqual(0)
    const afterStopped = messages.slice(stoppedIdx + 1).filter(m => m.startsWith('update:') || m.startsWith('start:'))
    expect(afterStopped, `messages=${JSON.stringify(messages)}`).toEqual([])
  })
})

describe('processInteractiveEvents engine stop mid-handler', () => {
  /**
   * Engine.stop() (plugin reload) closes the agent session without resolving
   * the stop arm, so a loop parked mid-handler exits via channel-close with
   * no terminal card and the preview freezes in its Running state across the
   * reload. The stop must finalize the card itself, before platforms stop.
   */
  it('finalizes the preview card on Engine.stop when the loop is mid-handler', async () => {
    const messages: string[] = []
    let releaseStart: (() => void) | undefined
    const startGate = new Promise<void>((resolve) => { releaseStart = () => { resolve() } })
    const p = Object.assign(createStubPlatform(), {
      messages,
      async sendPreviewStart(_rc: unknown, content: string): Promise<unknown> {
        await startGate
        messages.push(`start:${content}`)
        return 'preview-handle'
      },
      async updateMessage(_handle: unknown, content: string): Promise<void> {
        messages.push(`update:${content}`)
      },
      async renderStoppedCard(_rc: unknown, id: unknown): Promise<void> {
        messages.push(`stopped:${String(id)}`)
      },
    })
    const { e } = newEngine(createStubAgent(), p)
    e.setDisplayConfig({ toolProgress: true })
    const sessionKey = 'test:engine-stop-mid-handler'
    const session = e.sessions.getOrCreateActive(sessionKey)
    const agentSession = newControllableSession('s1')
    const state = new InteractiveState()
    state.agentSession = agentSession
    state.platform = p
    state.replyCtx = 'ctx-1'
    state.beginTurn()
    e.interactiveStates.set(sessionKey, state)

    const done = e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)
    await new Promise(r => setTimeout(r, 0))
    agentSession.channel.push({ type: 'tool_use', toolName: 'bash', toolInput: 'ls', toolID: 'call-1', content: '', done: false })
    await new Promise(r => setTimeout(r, 0))

    // markStoppedSync queues on the preview lock held by the gated first
    // flush, so the stop cannot complete until the gate opens.
    const stopping = e.stop()
    releaseStart!()
    await stopping
    await done
    await new Promise(r => setTimeout(r, 20))

    const stoppedIdx = messages.findIndex(m => m.startsWith('stopped:'))
    expect(stoppedIdx, `messages=${JSON.stringify(messages)}`).toBeGreaterThanOrEqual(0)
    const afterStopped = messages.slice(stoppedIdx + 1).filter(m => m.startsWith('update:') || m.startsWith('start:'))
    expect(afterStopped, `messages=${JSON.stringify(messages)}`).toEqual([])
  })
})

/** Preview-recorder platform for the abnormal-exit finalize specs. */
function createAbnormalExitRecorderPlatform(): StubPlatform & { messages: string[] } {
  const messages: string[] = []
  return Object.assign(createStubPlatform(), {
    messages,
    async sendPreviewStart(_rc: unknown, content: string): Promise<unknown> {
      messages.push(`start:${content}`)
      return 'preview-handle'
    },
    async updateMessage(_handle: unknown, content: string): Promise<void> {
      messages.push(`update:${content}`)
    },
    async renderStoppedCard(_rc: unknown, id: unknown): Promise<void> {
      messages.push(`stopped:${String(id)}`)
    },
  })
}

describe('processInteractiveEvents abnormal-exit preview finalization', () => {
  it('fails the preview card when the agent channel closes unexpectedly mid-turn', async () => {
    const p = createAbnormalExitRecorderPlatform()
    const { e } = newEngine(createStubAgent(), p)
    e.setDisplayConfig({ toolProgress: true })
    const sessionKey = 'test:closed-fails-card'
    const session = e.sessions.getOrCreateActive(sessionKey)
    const agentSession = newControllableSession('s1')
    const state = new InteractiveState()
    state.agentSession = agentSession
    state.platform = p
    state.replyCtx = 'ctx-1'
    e.interactiveStates.set(sessionKey, state)

    const done = e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)
    agentSession.channel.push({ type: 'tool_use', toolName: 'bash', toolInput: 'ls', toolID: 'call-1', content: '', done: false })
    await new Promise(r => setTimeout(r, 30))
    await agentSession.close()
    await done
    await new Promise(r => setTimeout(r, 20))

    expect(
      p.messages.some(m => m.includes('__cc_state__:failed')),
      `messages=${JSON.stringify(p.messages)}`,
    ).toBe(true)
  })

  it('renders the failed card on a post-stop event arrival for non-user stops', async () => {
    const messages: string[] = []
    let releaseStart: (() => void) | undefined
    const startGate = new Promise<void>((resolve) => { releaseStart = () => { resolve() } })
    const p = Object.assign(createStubPlatform(), {
      messages,
      async sendPreviewStart(_rc: unknown, content: string): Promise<unknown> {
        await startGate
        messages.push(`start:${content}`)
        return 'preview-handle'
      },
      async updateMessage(_handle: unknown, content: string): Promise<void> {
        messages.push(`update:${content}`)
      },
      async renderStoppedCard(_rc: unknown, id: unknown): Promise<void> {
        messages.push(`stopped:${String(id)}`)
      },
    })
    const { e } = newEngine(createStubAgent(), p)
    e.setDisplayConfig({ toolProgress: true })
    const sessionKey = 'test:post-stop-event-engine'
    const session = e.sessions.getOrCreateActive(sessionKey)
    const agentSession = newControllableSession('s1')
    const state = new InteractiveState()
    state.agentSession = agentSession
    state.platform = p
    state.replyCtx = 'ctx-1'
    e.interactiveStates.set(sessionKey, state)

    const done = e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)
    await new Promise(r => setTimeout(r, 0))
    agentSession.channel.push({ type: 'tool_use', toolName: 'bash', toolInput: 'ls', toolID: 'call-1', content: '', done: false })
    await new Promise(r => setTimeout(r, 0))

    // Non-user stop (external cleanupInteractiveState) while the loop parks
    // mid-handler; one more event is buffered behind the stop.
    state.markStopped()
    agentSession.channel.push({ type: 'tool_use', toolName: 'bash', toolInput: 'pwd', toolID: 'call-2', content: '', done: false })
    releaseStart!()
    await done
    await new Promise(r => setTimeout(r, 20))

    expect(
      messages.some(m => m.includes('__cc_state__:failed')),
      `messages=${JSON.stringify(messages)}`,
    ).toBe(true)
  })

  it('renders the stopped card once on a post-stop event arrival for user stops', async () => {
    const messages: string[] = []
    let releaseStart: (() => void) | undefined
    const startGate = new Promise<void>((resolve) => { releaseStart = () => { resolve() } })
    const p = Object.assign(createStubPlatform(), {
      messages,
      async sendPreviewStart(_rc: unknown, content: string): Promise<unknown> {
        await startGate
        messages.push(`start:${content}`)
        return 'preview-handle'
      },
      async updateMessage(_handle: unknown, content: string): Promise<void> {
        messages.push(`update:${content}`)
      },
      async renderStoppedCard(_rc: unknown, id: unknown): Promise<void> {
        messages.push(`stopped:${String(id)}`)
      },
    })
    const { e } = newEngine(createStubAgent(), p)
    e.setDisplayConfig({ toolProgress: true })
    const sessionKey = 'test:post-stop-event-user'
    const session = e.sessions.getOrCreateActive(sessionKey)
    const agentSession = newControllableSession('s1')
    const state = new InteractiveState()
    state.agentSession = agentSession
    state.platform = p
    state.replyCtx = 'ctx-1'
    e.interactiveStates.set(sessionKey, state)

    const done = e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)
    await new Promise(r => setTimeout(r, 0))
    agentSession.channel.push({ type: 'tool_use', toolName: 'bash', toolInput: 'ls', toolID: 'call-1', content: '', done: false })
    await new Promise(r => setTimeout(r, 0))

    state.userStopped = true
    state.markStopped()
    agentSession.channel.push({ type: 'tool_use', toolName: 'bash', toolInput: 'pwd', toolID: 'call-2', content: '', done: false })
    releaseStart!()
    await done
    await new Promise(r => setTimeout(r, 20))

    expect(messages.filter(m => m.startsWith('stopped:')), `messages=${JSON.stringify(messages)}`).toHaveLength(1)
  })
})

describe('stopInteractiveSession Interrupt preference', () => {
  it('cancels the in-flight turn through cancelTurn before closing', async () => {
    const { e, p } = newEngine()
    const sessionKey = 'test:interrupt-preference'
    e.sessions.getOrCreateActive(sessionKey)
    const agentSession = newControllableSession('s1')
    const calls: string[] = []
    agentSession.cancelTurn = () => { calls.push('cancel') }
    const originalClose = agentSession.close.bind(agentSession)
    agentSession.close = async () => { calls.push('close'); await originalClose() }
    const state = new InteractiveState()
    state.agentSession = agentSession
    state.platform = p
    state.replyCtx = 'ctx-1'
    e.interactiveStates.set(sessionKey, state)

    expect(e.stopInteractiveSession(sessionKey)).toBe(true)
    expect(calls, `calls=${JSON.stringify(calls)}`).toEqual(['cancel', 'close'])
  })

  it('stops sessions without cancelTurn unchanged', async () => {
    const { e, p } = newEngine()
    const sessionKey = 'test:no-interrupter'
    e.sessions.getOrCreateActive(sessionKey)
    const agentSession = newControllableSession('s1')
    const state = new InteractiveState()
    state.agentSession = agentSession
    state.platform = p
    state.replyCtx = 'ctx-1'
    e.interactiveStates.set(sessionKey, state)

    expect(e.stopInteractiveSession(sessionKey)).toBe(true)
    expect(agentSession.closed).toBe(true)
  })
})

it('processInteractiveEvents persists the agent session ID', async () => {
  const { e, p } = newEngine()
  const path = `${process.env.VITEST_TMPDIR ?? '/tmp'}/fb-persist-${Date.now()}/sessions.json`
  const { SessionManager } = await import('../../src/engine/session.js')
  const sessions = new SessionManager(path)
  const sessionKey = 'test:user-persist'
  const session = sessions.getOrCreateActive(sessionKey)
  const agentSession = newControllableSession('real-session-xyz')
  const state = new InteractiveState()
  state.agentSession = agentSession
  state.platform = p
  state.replyCtx = 'ctx-persist'
  e.interactiveStates.set(sessionKey, state)

  agentSession.channel.push({ type: 'result', content: 'done', done: true })
  await e.processInteractiveEvents(state, session, sessions, sessionKey, 'm1', undefined, state.replyCtx)

  const reloaded = new SessionManager(path)
  expect(reloaded.getOrCreateActive(sessionKey).getAgentSessionID()).toBe('real-session-xyz')
})

it('substantive mid-turn text is not swallowed by a trailing NO_REPLY', async () => {
  const p = createStubMediaPlatform()
  const { e } = newEngine(createStubAgent(), p)
  e.setDisplayConfig({ toolMessages: false })
  const sessionKey = 'test:nr-swallow'
  const session = e.sessions.getOrCreateActive(sessionKey)
  const agentSession = newControllableSession('s1')
  const state = new InteractiveState()
  state.agentSession = agentSession
  state.platform = p
  state.replyCtx = 'ctx-1'
  e.interactiveStates.set(sessionKey, state)

  const substantive = 'Here is my substantive answer for you.'
  agentSession.channel.push({ type: 'text', content: 'working on it', done: false })
  agentSession.channel.push({ type: 'tool_use', toolName: 'Bash', toolInput: 'echo hi', toolID: 't1', content: '', done: false })
  agentSession.channel.push({ type: 'text', content: substantive, done: false })
  agentSession.channel.push({ type: 'result', content: 'NO_REPLY', done: true })

  await e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)

  const delivered = p.getSent().join('\n')
  expect(delivered, `sent=${JSON.stringify(p.getSent())}`).toContain('substantive answer')
})

describe('message queueing', () => {
  it('FIFO metadata only, no agent send at queue time', () => {
    const { e, p } = newEngine(createControllableAgent())
    const sess = newQueuingSession('qs1')
    const key = 'test:user1'
    const state = new InteractiveState()
    state.agentSession = sess
    state.platform = p
    state.replyCtx = 'ctx1'
    e.interactiveStates.set(key, state)

    const ok1 = e.queueMessageForBusySession(p, msg({ sessionKey: key, content: 'msg1', replyCtx: 'ctx-msg1' }), key)
    const ok2 = e.queueMessageForBusySession(p, msg({ sessionKey: key, content: 'msg2', replyCtx: 'ctx-msg2' }), key)

    expect(ok1).toBe(true)
    expect(ok2).toBe(true)
    expect(sess.sendCalls, 'deferred send').toEqual([])
    expect(state.pendingMessages.map(q => q.content)).toEqual(['msg1', 'msg2'])
  })

  it('overflow replies queue-full and keeps FIFO head', () => {
    const { e, p } = newEngine()
    const key = 'test:overflow-user'
    const state = new InteractiveState()
    state.agentSession = newQueuingSession('qs-overflow')
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set(key, state)

    for (let i = 0; i < 5; i++) {
      const ok = e.queueMessageForBusySession(p, msg({ sessionKey: key, content: `msg-${i}` }), key)
      expect(ok).toBe(true)
    }
    expect(state.pendingMessages).toHaveLength(5)

    const ok = e.queueMessageForBusySession(p, msg({ sessionKey: key, content: 'msg-overflow' }), key)
    expect(ok, 'queue-full reply counts as handled').toBe(true)
    expect(state.pendingMessages).toHaveLength(5)
    expect(state.pendingMessages[0]!.content).toBe('msg-0')

    expect(p.getSent()).toHaveLength(6)
  })

  it('no state returns false', () => {
    const { e, p } = newEngine()
    expect(e.queueMessageForBusySession(p, msg({ sessionKey: 'nonexistent:key', content: 'hello' }), 'nonexistent:key')).toBe(false)
  })

  it('dead session returns false', () => {
    const { e, p } = newEngine()
    const sess = newQueuingSession('dead')
    sess.aliveFlag = false
    const key = 'test:dead-session'
    const state = new InteractiveState()
    state.agentSession = sess
    state.platform = p
    e.interactiveStates.set(key, state)

    expect(e.queueMessageForBusySession(p, msg({ sessionKey: key, content: 'hello' }), key)).toBe(false)
  })

  it('nil agent session (startup window) queues fine', () => {
    const { e, p } = newEngine()
    const key = 'test:starting-session'
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set(key, state)

    const ok = e.queueMessageForBusySession(p, msg({ sessionKey: key, content: 'queued during startup' }), key)
    expect(ok).toBe(true)
    expect(state.pendingMessages).toHaveLength(1)
    expect(state.pendingMessages[0]!.content).toBe('queued during startup')
  })

  it('drains queued messages through the event loop', async () => {
    const { e, p } = newEngine()
    e.setDebounceInterval(0)
    const sess = newQueuingSession('qs2')
    const key = 'test:user1'
    const session = e.sessions.getOrCreateActive(key)

    const state = new InteractiveState()
    state.agentSession = sess
    state.platform = p
    state.replyCtx = 'ctx-turn1'
    state.pendingMessages = [{
      platform: p, replyCtx: 'ctx-turn2', messageID: '', content: 'queued-msg',
      images: [], files: [], fromVoice: false, isSpawnedGroup: false,
      userID: '', userName: '', msgPlatform: 'test', msgSessionKey: key,
      chatroomAskSeq: 0, chatroomAwaitAssistant: false,
    }]
    e.interactiveStates.set(key, state)

    // Turn 1 completes; turn 2 events arrive only after the queued Send.
    const turn2 = async (): Promise<void> => {
      sess.channel.push({ type: 'text', content: 'response1', done: false })
      sess.channel.push({ type: 'result', content: 'response1', done: true })
      for (let i = 0; i < 500 && sess.sendCalls.length === 0; i++) {
        await new Promise((resolve) => { setTimeout(resolve, 5) })
      }
      sess.channel.push({ type: 'text', content: 'response2', done: false })
      sess.channel.push({ type: 'result', content: 'response2', done: true })
    }
    void turn2()

    const sendDone = Promise.resolve(undefined)

    await Promise.race([
      e.processInteractiveEvents(state, session, e.sessions, key, 'msg1', sendDone, undefined),
      new Promise((_, reject) => { setTimeout(() => { reject(new Error('timeout')) }, 5000) }),
    ])

    expect(state.pendingMessages).toHaveLength(0)
    expect(sess.sendCalls.length).toBeGreaterThanOrEqual(1)
  })
})

describe('event idle timeout', () => {
  it('cleans up the session and notifies', async () => {
    const { e, p } = newEngine()
    e.setEventIdleTimeout(100)
    const key = 'test:idle-user'
    const state = new InteractiveState()
    state.agentSession = newControllableSession('idle-test')
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set(key, state)

    const session = e.sessions.getOrCreateActive(key)
    session.tryLock()

    await Promise.race([
      e.processInteractiveEvents(state, session, e.sessions, key, '', undefined, undefined),
      new Promise((_, reject) => {
        setTimeout(() => { reject(new Error('did not return after idle timeout')) }, 3000)
      }),
    ])

    expect(p.getSent().some(s => s.includes('stopped responding')), `sent=${JSON.stringify(p.getSent())}`).toBe(true)
  })

  it('resets on event', async () => {
    const { e, p } = newEngine()
    e.setEventIdleTimeout(200)
    const key = 'test:idle-reset'
    const state = new InteractiveState()
    state.agentSession = newControllableSession('idle-reset')
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set(key, state)

    const session = e.sessions.getOrCreateActive(key)
    session.tryLock()

    const sess = state.agentSession as ControllableAgentSession
    const done = e.processInteractiveEvents(state, session, e.sessions, key, '', undefined, undefined)

    await new Promise((resolve) => { setTimeout(resolve, 100) })
    sess.channel.push({ type: 'text', content: 'thinking...', done: false })

    await new Promise((resolve) => { setTimeout(resolve, 150) })
    sess.channel.push({ type: 'result', content: 'done', done: true })

    await Promise.race([
      done,
      new Promise((_, reject) => {
        setTimeout(() => { reject(new Error('did not complete after events')) }, 3000)
      }),
    ])

    expect(p.getSent().some(s => s.includes('timed out'))).toBe(false)
  })

  it('disabled when zero', async () => {
    const { e, p } = newEngine()
    e.setEventIdleTimeout(0)
    const key = 'test:idle-zero'
    const sess = newControllableSession('idle-zero')
    const state = new InteractiveState()
    state.agentSession = sess
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set(key, state)

    const session = e.sessions.getOrCreateActive(key)
    session.tryLock()

    const done = e.processInteractiveEvents(state, session, e.sessions, key, '', undefined, undefined)
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    let settled = false
    void done.then(() => { settled = true })
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(settled, 'should not have returned yet — timeout disabled').toBe(false)

    sess.channel.push({ type: 'result', content: 'ok', done: true })
    await Promise.race([
      done,
      new Promise((_, reject) => {
        setTimeout(() => { reject(new Error('did not return after result')) }, 2000)
      }),
    ])
  })
})

describe('cleanup CAS', () => {
  it('skips when the state was replaced', async () => {
    const { e } = newEngine()
    const key = 'test:user1'
    const oldState = new InteractiveState()
    oldState.agentSession = newControllableSession('old')
    const newState = new InteractiveState()
    newState.agentSession = newControllableSession('new')
    e.interactiveStates.set(key, newState)

    await e.cleanupInteractiveState(key, oldState)
    expect(e.interactiveStates.get(key)).toBe(newState)
  })

  it('no deadlock with queued messages and a live session', async () => {
    const { e, p } = newEngine()
    const key = 'test:user-deadlock'
    const agentSession = newControllableSession('watchdog-victim')
    const state = new InteractiveState()
    state.agentSession = agentSession
    state.platform = p
    state.pendingMessages = [{
      platform: p, replyCtx: 'ctx', messageID: 'm1', content: 'queued-1',
      images: [], files: [], fromVoice: false, isSpawnedGroup: false,
      userID: '', userName: '', msgPlatform: 'test', msgSessionKey: key,
      chatroomAskSeq: 0, chatroomAwaitAssistant: false,
    }, {
      platform: p, replyCtx: 'ctx', messageID: 'm2', content: 'queued-2',
      images: [], files: [], fromVoice: false, isSpawnedGroup: false,
      userID: '', userName: '', msgPlatform: 'test', msgSessionKey: key,
      chatroomAskSeq: 0, chatroomAwaitAssistant: false,
    }]
    e.interactiveStates.set(key, state)

    await Promise.race([
      e.cleanupInteractiveState(key, state),
      new Promise((_, reject) => {
        setTimeout(() => { reject(new Error('cleanup deadlocked')) }, 3000)
      }),
    ])

    expect(e.interactiveStates.has(key)).toBe(false)
    expect(agentSession.closed, 'agent session closed').toBe(true)
    expect(state.stopped).toBe(true)
  })

  it('deletes when the expected state matches', async () => {
    const { e } = newEngine()
    const key = 'test:user1'
    const state = new InteractiveState()
    state.agentSession = newControllableSession('s1')
    e.interactiveStates.set(key, state)
    await e.cleanupInteractiveState(key, state)
    expect(e.interactiveStates.has(key)).toBe(false)
  })

  it('unconditional without expected', async () => {
    const { e } = newEngine()
    const key = 'test:user1'
    const state = new InteractiveState()
    state.agentSession = newControllableSession('s1')
    e.interactiveStates.set(key, state)
    await e.cleanupInteractiveState(key)
    expect(e.interactiveStates.has(key)).toBe(false)
  })

  it('concurrent unconditional closes the agent once', async () => {
    const { e } = newEngine()
    const key = 'test:user1'
    const sess = newControllableSession('s1')
    let closeCount = 0
    const origClose = sess.close.bind(sess)
    sess.close = async () => {
      closeCount++
      await origClose()
    }
    const state = new InteractiveState()
    state.agentSession = sess
    e.interactiveStates.set(key, state)

    await Promise.all([e.cleanupInteractiveState(key), e.cleanupInteractiveState(key)])

    expect(closeCount).toBeLessThanOrEqual(1)
    expect(e.interactiveStates.has(key)).toBe(false)
  })

  it('waits for a concurrent teardown before starting a new session', async () => {
    let started = false
    const trackingAgent: Agent = {
      name: () => 'tracking',
      startSession: async () => {
        started = true
        return newControllableSession('new-agent-id')
      },
      listSessions: async () => [],
      stop: async () => {},
    }
    const { e, p } = newEngine(trackingAgent)
    const key = 'test:user-teardown'

    // A close that blocks until released.
    let releaseClose: (() => void) | undefined
    let closeStartedResolve: (() => void) = () => {}
    const closeStartedPromise = new Promise<void>((resolve) => { closeStartedResolve = resolve })
    const oldSession = newControllableSession('old-agent-id')
    const origClose = oldSession.close.bind(oldSession)
    oldSession.close = async () => {
      closeStartedResolve()
      await new Promise<void>((resolve) => { releaseClose = resolve })
      await origClose()
    }

    const state = new InteractiveState()
    state.agentSession = oldSession
    e.interactiveStates.set(key, state)

    const cleanupDone = e.cleanupInteractiveState(key, state)
    await closeStartedPromise

    const sess = e.sessions.newSession(key, 's')
    const createDone = e.getOrCreateInteractiveStateWith(key, p, 'ctx', sess)

    await new Promise((resolve) => { setTimeout(resolve, 200) })
    expect(started, 'new session must not start before teardown completes').toBe(false)

    releaseClose?.()
    await cleanupDone

    const newState = await createDone
    expect(started).toBe(true)
    expect(newState.agentSession?.currentSessionID()).toBe('new-agent-id')
  })

  it('stale goroutine cleanup cannot delete the replacement state', async () => {
    const { e, p } = newEngine(createControllableAgent(newControllableSession('new-agent')))
    const key = 'test:user1'

    const oldSess = newControllableSession('old-agent')
    const oldState = new InteractiveState()
    oldState.agentSession = oldSess
    oldState.platform = p
    oldState.replyCtx = 'ctx'
    e.interactiveStates.set(key, oldState)

    await e.cleanupInteractiveState(key)

    const sessionB = new Session()
    sessionB.agentSessionID = ''
    const newState = await e.getOrCreateInteractiveStateWith(key, p, 'ctx', sessionB)
    expect(e.interactiveStates.get(key)).toBe(newState)

    await e.cleanupInteractiveState(key, oldState)
    expect(e.interactiveStates.get(key), 'replacement state must survive stale cleanup').toBe(newState)
    expect(newState.agentSession?.alive()).toBe(true)
  })
})

describe('session mismatch and writeback', () => {
  it('recycles a stale agent session', async () => {
    const newSess = newControllableSession('new-agent-id')
    const agent = createControllableAgent(newSess)
    const { e, p } = newEngine(agent)
    const key = 'test:user1'

    const oldSess = newControllableSession('old-agent-id')
    const state = new InteractiveState()
    state.agentSession = oldSess
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set(key, state)

    const session = new Session()
    session.agentSessionID = 'new-agent-id'

    const got = await e.getOrCreateInteractiveStateWith(key, p, 'ctx', session)
    expect(got.agentSession).not.toBe(oldSess)
    expect(got.agentSession).toBe(newSess)
    expect(oldSess.closed, 'old session closed after mismatch').toBe(true)
  })

  it('recycles an alive agent after the session ID was cleared (/new)', async () => {
    const newSess = newControllableSession('fresh-id')
    const agent = createControllableAgent(newSess)
    const { e, p } = newEngine(agent)
    const key = 'test:user1'
    const oldSess = newControllableSession('prior-claude-session')
    const state = new InteractiveState()
    state.agentSession = oldSess
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set(key, state)

    const session = new Session()
    session.agentSessionID = ''

    const got = await e.getOrCreateInteractiveStateWith(key, p, 'ctx', session)
    expect(got.agentSession).not.toBe(oldSess)
    expect(got.agentSession).toBe(newSess)
    expect(oldSess.closed).toBe(true)
  })

  it('reuses the existing state when IDs match', async () => {
    const { e, p } = newEngine(createControllableAgent())
    const key = 'test:user1'
    const existingState = new InteractiveState()
    existingState.agentSession = newControllableSession('matching-id')
    existingState.platform = p
    existingState.replyCtx = 'ctx'
    e.interactiveStates.set(key, existingState)

    const session = new Session()
    session.agentSessionID = 'matching-id'

    const got = await e.getOrCreateInteractiveStateWith(key, p, 'ctx', session)
    expect(got).toBe(existingState)
  })

  it('writes back the agent session ID immediately', async () => {
    const sess = newControllableSession('agent-uuid-123')
    const { e, p } = newEngine(createControllableAgent(sess))
    const session = new Session()
    session.agentSessionID = ''

    await e.getOrCreateInteractiveStateWith('test:user1', p, 'ctx', session)
    expect(session.getAgentSessionID()).toBe('agent-uuid-123')
  })

  it('maps the pending session name on writeback', async () => {
    const sess = newControllableSession('agent-uuid-456')
    const { e, p } = newEngine(createControllableAgent(sess))
    const session = e.sessions.newSession('test:user1', '我的自定义会话')

    await e.getOrCreateInteractiveStateWith('test:user1', p, 'ctx', session)
    expect(e.sessions.getSessionName('agent-uuid-456')).toBe('我的自定义会话')
  })

  it('does not overwrite an existing agent session ID', async () => {
    const sess = newControllableSession('new-uuid')
    const { e, p } = newEngine(createControllableAgent(sess))
    const session = new Session()
    session.agentSessionID = 'existing-uuid'

    await e.getOrCreateInteractiveStateWith('test:user1', p, 'ctx', session)
    expect(session.getAgentSessionID()).toBe('existing-uuid')
  })
})

/** Go stubStartSessionAgent: records StartSession calls, fails for given IDs. */
function createStartSessionAgent(failIDs: Record<string, Error> = {}): Agent & { calls: string[] } {
  const calls: string[] = []
  const agent: Agent & { calls: string[] } = {
    calls,
    name: () => 'stub',
    startSession: async (sessionID: string) => {
      calls.push(sessionID)
      const fail = failIDs[sessionID]
      if (fail !== undefined) throw fail
      return newControllableSession(`${sessionID === '' ? 'fresh' : sessionID}-sess`)
    },
    listSessions: async () => [],
    stop: async () => {},
  }
  return agent
}

describe('resume fallback', () => {
  it('falls back to a fresh session on resume failure', async () => {
    const agent = createStartSessionAgent({ 'old-session-id': new Error('Prompt is too long') })
    const { e, p } = newEngine(agent)

    const session = e.sessions.getOrCreateActive('test:user1')
    session.setAgentSessionID('old-session-id', 'stub')

    const state = await e.getOrCreateInteractiveStateWith('test:user1', p, 'ctx', session)
    expect(state.agentSession).toBeDefined()
    expect(agent.calls).toEqual(['old-session-id', ''])
  })

  it('notifies the user about the degraded resume', async () => {
    const agent = createStartSessionAgent({ 'old-session-id': new Error('Prompt is too long') })
    const { e, p } = newEngine(agent)

    const session = e.sessions.getOrCreateActive('test:user1')
    session.setAgentSessionID('old-session-id', 'stub')

    await e.getOrCreateInteractiveStateWith('test:user1', p, 'ctx', session)

    for (let i = 0; i < 200 && p.getSent().length === 0; i++) {
      await new Promise((resolve) => { setTimeout(resolve, 5) })
    }
    expect(p.getSent()[0]).toContain('fresh session')
  })

  it('fresh session without a saved ID starts fresh', async () => {
    const agent = createStartSessionAgent()
    const { e, p } = newEngine(agent)
    const session = e.sessions.getOrCreateActive('test:user2')

    const state = await e.getOrCreateInteractiveStateWith('test:user2', p, 'ctx', session)
    expect(state.agentSession).toBeDefined()
    expect(agent.calls).toEqual([''])
  })

  it('saved session ID resumes exactly that session', async () => {
    const agent = createStartSessionAgent()
    const { e, p } = newEngine(agent)
    const session = e.sessions.getOrCreateActive('test:user3')
    session.setAgentSessionID('saved-session-id', 'stub')

    const state = await e.getOrCreateInteractiveStateWith('test:user3', p, 'ctx', session)
    expect(state.agentSession).toBeDefined()
    expect(agent.calls).toEqual(['saved-session-id'])
  })
})

describe('startAgentLocked options/mode injection', () => {
  it('no crosstalk across concurrent starts: each startSession sees its own options', async () => {
    const { e } = newEngine()
    const captured: Array<{ id: string; key: string }> = []
    const agent: Agent = {
      name: () => 'options-snapshot',
      startSession: async (sessionID: string, options) => {
        const snap: ControllableAgentSession = newControllableSession(sessionID)
        captured.push({ id: sessionID, key: options?.sessionKey ?? '' })
        return snap
      },
      listSessions: async () => [],
      stop: async () => {},
    }

    const n = 24
    await Promise.all(Array.from({ length: n }, (_, i) => {
      const key = `feishu:oc_${i}`
      return e.startAgentLocked(agent, key, { sessionKey: key }, '')
    }))
    expect(captured).toHaveLength(n)
    for (const snap of captured) {
      expect(snap.key).toBe(snap.id)
    }
  })

  it('undefined options start a plain session', async () => {
    const { e } = newEngine()
    let seen = 'unset'
    const agent: Agent = {
      name: () => 'options-snapshot',
      startSession: async (sessionID: string, options) => {
        seen = options === undefined ? 'plain' : 'typed'
        return newControllableSession(sessionID)
      },
      listSessions: async () => [],
      stop: async () => {},
    }

    await e.startAgentLocked(agent, 'resume-1', undefined, '')
    expect(seen).toBe('plain')
  })

  it('injects a non-empty mode override', async () => {
    const { e } = newEngine()
    let modeSet = ''
    let called = false
    type ModeAgent = Agent & { setSessionMode(mode: string): void }
    const agent: ModeAgent = {
      name: () => 'mode-recording',
      startSession: async (sessionID: string) => newControllableSession(sessionID),
      listSessions: async () => [],
      stop: async () => {},
      setSessionMode(mode: string) {
        modeSet = mode
        called = true
      },
    }

    await e.startAgentLocked(agent, 's1', undefined, 'default')
    expect(called).toBe(true)
    expect(modeSet).toBe('default')
  })

  it('empty mode override does not call setSessionMode', async () => {
    const { e } = newEngine()
    let called = false
    type ModeAgent = Agent & { setSessionMode(): void }
    const agent: ModeAgent = {
      name: () => 'mode-recording',
      startSession: async (sessionID: string) => newControllableSession(sessionID),
      listSessions: async () => [],
      stop: async () => {},
      setSessionMode() { called = true },
    }

    await e.startAgentLocked(agent, 's1', undefined, '')
    expect(called).toBe(false)
  })
})

describe('eventsNeedResync', () => {
  it('defaults true on placeholder states', () => {
    const { e, p } = newEngine()
    e.ensureInteractiveStateForQueueing('key1', p, 'ctx')
    const state = e.interactiveStates.get('key1')
    expect(state).toBeDefined()
    expect(state!.eventsNeedResync).toBe(true)
  })

  it('cleared on a clean result', async () => {
    const { e, p } = newEngine()
    const sess = newControllableSession('resync-clean')
    const session = e.sessions.getOrCreateActive('test:resync:u1')
    session.tryLock()

    const state = new InteractiveState()
    state.agentSession = sess
    state.platform = p
    state.replyCtx = 'ctx'
    state.eventsNeedResync = true

    sess.channel.push({ type: 'result', content: 'done', done: true })
    await e.processInteractiveEvents(state, session, e.sessions, 'test:resync:u1', '', Promise.resolve(undefined), 'ctx')
    expect(state.eventsNeedResync).toBe(false)
  })
})

describe('drainEvents (EventChannel)', () => {
  it('returns promptly on a closed channel', () => {
    const sess = newControllableSession('drain-closed')
    sess.channel.push({ type: 'tool_use', content: 'a', done: false })
    sess.channel.push({ type: 'tool_use', content: 'b', done: false })
    sess.channel.close()
    expect(() => { sess.channel.drain() }).not.toThrow()
  })

  it('discards buffered events on an open channel', async () => {
    const sess = newControllableSession('drain-open')
    sess.channel.push({ type: 'tool_use', content: 'a', done: false })
    sess.channel.drain()
    sess.channel.push({ type: 'tool_use', content: 'b', done: false })
    const got = await sess.channel.receive()
    expect(got.done).toBe(false)
    expect(!got.done && got.event.content).toBe('b')
  })
})

describe('idle reaper', () => {
  it('disabled when timeout is zero', () => {
    const { e } = newEngine()
    e.setInteractiveIdleTimeout(0)
    const state = new InteractiveState()
    state.lastActivity = Date.now() - 100_000
    e.interactiveStates.set('test:reap', state)
    e.reapIdleInteractiveStates()
    expect(e.interactiveStates.has('test:reap')).toBe(true)
  })
})

/** Stub platform with preview start/update capture (permission-spec pattern). */
function newPreviewCaptureEngine(): { e: Engine; updates: string[]; starts: string[] } {
  const p = createStubPlatform()
  const updates: string[] = []
  const starts: string[] = []
  const preview = p as typeof p & {
    sendPreviewStart(rc: unknown, content: string): Promise<unknown>
    updateMessage(handle: unknown, content: string): Promise<void>
  }
  preview.sendPreviewStart = async (_rc, content) => {
    starts.push(content)
    return `handle-${starts.length}`
  }
  preview.updateMessage = async (_handle, content) => {
    updates.push(content)
  }
  const e = new Engine('test', createStubAgent(), [p], '', 'en')
  e.setDisplayConfig({ toolProgress: true })
  return { e, updates, starts }
}

describe('todo_write progress section', () => {
  async function runTurn(e: Engine, events: Array<Record<string, unknown>>): Promise<void> {
    const sess = newControllableSession('todo-turn')
    const key = 'test:todo-section'
    const session = e.sessions.getOrCreateActive(key)
    const state = new InteractiveState()
    state.agentSession = sess
    state.platform = e.platforms[0]
    state.replyCtx = 'ctx'
    e.interactiveStates.set(key, state)
    for (const ev of events) sess.channel.push(ev as never)
    await e.processInteractiveEvents(state, session, e.sessions, key, 'm1', Promise.resolve(undefined), 'ctx')
  }

  it('renders todo_write items in the pinned todo section of the preview card', async () => {
    const { e, updates } = newPreviewCaptureEngine()
    await runTurn(e, [
      { type: 'tool_use', toolName: 'todo_write', toolID: 't1', toolInput: JSON.stringify({ todos: [
        { content: '分析需求', status: 'completed' },
        { content: '实现修复', status: 'in_progress' },
      ] }), content: '', done: false },
      { type: 'tool_result', toolID: 't1', toolName: 'todo_write', toolResult: 'ok', content: '', done: true },
      { type: 'result', content: 'done', done: true },
    ])
    const last = updates.at(-1) ?? ''
    expect(last, `updates=${JSON.stringify(updates)}`).toContain('✅ 分析需求')
    expect(last).toContain('🔄 实现修复')
  })

  it('clears the todo section when todo_write replaces the list with an empty one', async () => {
    const { e, updates } = newPreviewCaptureEngine()
    await runTurn(e, [
      { type: 'tool_use', toolName: 'todo_write', toolID: 't1', toolInput: JSON.stringify({ todos: [{ content: '分析需求', status: 'completed' }] }), content: '', done: false },
      { type: 'tool_use', toolName: 'todo_write', toolID: 't2', toolInput: '{"todos":[]}', content: '', done: false },
      { type: 'tool_result', toolID: 't2', toolName: 'todo_write', toolResult: 'ok', content: '', done: true },
      { type: 'result', content: 'done', done: true },
    ])
    const last = updates.at(-1) ?? ''
    expect(last, `updates=${JSON.stringify(updates)}`).not.toContain('✅ 分析需求')
  })

  it('renders the todo section on a queued follow-up turn (fresh preview card)', async () => {
    const { e, updates, starts } = newPreviewCaptureEngine()
    const sess = newControllableSession('todo-queued')
    const key = 'test:todo-queued'
    const session = e.sessions.getOrCreateActive(key)
    const state = new InteractiveState()
    state.agentSession = sess
    state.platform = e.platforms[0]
    state.replyCtx = 'ctx'
    e.interactiveStates.set(key, state)

    // A message queued while turn 1 runs: turn 1's result handler hands the
    // loop to it via the in-loop queued arm.
    const platform = e.platforms[0] as Platform
    expect(e.queueMessageForBusySession(platform, msg({ sessionKey: key, content: 'todo turn' }), key)).toBe(true)

    // Turn 2's live events are pushed from the session's send hook: the
    // queued arm drains the channel BEFORE send, so events pushed at send
    // time mirror the real arrival order. Real adapters push asynchronously
    // (LLM stream), so defer past the loop's receive re-arm.
    const origSend = sess.send.bind(sess)
    const session2 = sess as unknown as { send(prompt: string, images: never[], files: never[]): Promise<void> }
    session2.send = (prompt: string, images: never[], files: never[]) => {
      if (prompt.includes('todo turn')) {
        setTimeout(() => {
          sess.channel.push({ type: 'tool_use', toolName: 'todo_write', toolID: 't2', toolInput: JSON.stringify({ todos: [
            { content: '排查根因', status: 'completed' },
            { content: '修复验证', status: 'in_progress' },
          ] }), content: '', done: false } as never)
          sess.channel.push({ type: 'tool_result', toolResult: 'ok', content: '', done: true } as never)
          sess.channel.push({ type: 'result', content: '清单已建', done: true } as never)
        }, 10)
      }
      return origSend(prompt, images, files)
    }

    sess.channel.push({ type: 'tool_use', toolName: 'bash', toolInput: '{"command":"echo hi"}', toolID: 't1', content: '', done: false } as never)
    sess.channel.push({ type: 'tool_result', toolResult: 'hi', content: '', done: true } as never)
    sess.channel.push({ type: 'result', content: 'turn one done', done: true } as never)

    await e.processInteractiveEvents(state, session, e.sessions, key, 'm1', Promise.resolve(undefined), 'ctx')
    await new Promise((r) => { setTimeout(r, 50) })

    const last = updates.at(-1) ?? ''
    expect(starts.length, `starts=${JSON.stringify(starts)}`).toBe(2)
    expect(last, `updates=${JSON.stringify(updates)}`).toContain('✅ 排查根因')
    expect(last).toContain('🔄 修复验证')
    expect(last).toContain('清单已建')
    // The queued turn's card starts clean: turn 1's entry does not leak.
    expect(last).not.toContain('bash')
  })
})

describe('quiet-mode thinking preview (cc-connect parity)', () => {
  /**
   * Quiet-mode preview-capture engine: thinkingMessages off (quiet), tool
   * progress on — the live 开发虾 project config. cc-connect's quiet mode
   * suppresses thinking *messages* but still streams the 💭 section and the
   * 思考中 card-header state.
   */
  function newQuietCaptureEngine(): { e: Engine; updates: string[] } {
    const { e, updates } = newPreviewCaptureEngine()
    e.setDisplayConfig({ thinkingMessages: false })
    return { e, updates }
  }

  /**
   * Drive one quiet-mode turn with pacing: each element of `stages` is a
   * batch of events, and `progressFlushInterval` (300ms) elapses between
   * batches so throttled progress flushes (the 思考中 header PATCHes) land
   * before the next state change, as they do over real multi-second thinking.
   */
  async function runQuietTurn(e: Engine, stages: Array<Array<Record<string, unknown>>>): Promise<void> {
    const sess = newControllableSession('quiet-turn')
    const key = 'test:quiet-thinking'
    const session = e.sessions.getOrCreateActive(key)
    const state = new InteractiveState()
    state.agentSession = sess
    state.platform = e.platforms[0]
    state.replyCtx = 'ctx'
    e.interactiveStates.set(key, state)
    const loop = e.processInteractiveEvents(state, session, e.sessions, key, 'm1', Promise.resolve(undefined), 'ctx')
    stages.forEach((batch, i) => {
      if (i > 0) setTimeout(() => { for (const ev of batch) sess.channel.push(ev as never) }, i * 400)
      else for (const ev of batch) sess.channel.push(ev as never)
    })
    setTimeout(() => { sess.channel.push({ type: 'result', content: 'done', done: true } as never) }, stages.length * 400 + 100)
    await loop
  }

  it('thinking deltas set the 思考中 header state in quiet mode', async () => {
    const { e, updates } = newQuietCaptureEngine()
    await runQuietTurn(e, [
      [
        { type: 'tool_use', toolName: 'Bash', toolID: 't1', toolInput: 'ls', content: '', done: false },
        { type: 'tool_result', toolID: 't1', toolName: 'Bash', toolResult: 'ok', content: '', done: true },
      ],
      [{ type: 'thinking_delta', content: 'pondering the next step', done: false }],
    ])
    expect(updates.some(u => u.startsWith('__cc_state__:thinking')), `updates=${JSON.stringify(updates)}`).toBe(true)
  })

  it('the full thinking block clears the 思考中 header in quiet mode', async () => {
    const { e, updates } = newQuietCaptureEngine()
    await runQuietTurn(e, [
      [
        { type: 'tool_use', toolName: 'Bash', toolID: 't1', toolInput: 'ls', content: '', done: false },
        { type: 'tool_result', toolID: 't1', toolName: 'Bash', toolResult: 'ok', content: '', done: true },
      ],
      [{ type: 'thinking_delta', content: 'pondering', done: false }],
      [{ type: 'thinking', content: 'pondering the whole plan out loud', done: false }],
    ])
    // The delta set the header; the completed block must drop it again —
    // no lingering 思考中 after thinking ends, and no thinking *message*
    // is sent in quiet mode.
    expect(updates.some(u => u.startsWith('__cc_state__:thinking')), `updates=${JSON.stringify(updates)}`).toBe(true)
    const lastPreComplete = updates.filter(u => !u.startsWith('__cc_state__:completed')).at(-1) ?? ''
    expect(lastPreComplete, `updates=${JSON.stringify(updates)}`).not.toContain('💭')
    expect(lastPreComplete.startsWith('__cc_state__:thinking')).toBe(false)
  })

  it('a new tool call clears the 思考中 header (safety net)', async () => {
    const { e, updates } = newQuietCaptureEngine()
    await runQuietTurn(e, [
      [
        { type: 'tool_use', toolName: 'Bash', toolID: 't1', toolInput: 'ls', content: '', done: false },
        { type: 'tool_result', toolID: 't1', toolName: 'Bash', toolResult: 'ok', content: '', done: true },
      ],
      [{ type: 'thinking_delta', content: 'pondering', done: false }],
      [{ type: 'tool_use', toolName: 'Read', toolID: 't2', toolInput: 'a.ts', content: '', done: false }],
    ])
    expect(updates.some(u => u.startsWith('__cc_state__:thinking')), `updates=${JSON.stringify(updates)}`).toBe(true)
    const lastPreComplete = updates.filter(u => !u.startsWith('__cc_state__:completed')).at(-1) ?? ''
    expect(lastPreComplete, `updates=${JSON.stringify(updates)}`).not.toContain('💭')
    expect(lastPreComplete.startsWith('__cc_state__:thinking')).toBe(false)
  })
})

describe('rate limit (Go checkRateLimit)', () => {
  it('third message in the window replies rate-limited and is dropped', async () => {
    const { e, p } = newEngine()
    const key = 'test:rl-user'
    const state = new InteractiveState()
    state.agentSession = newQueuingSession('qs-rl')
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set(key, state)
    // Busy session: allowed messages queue instead of starting a turn.
    const session = e.sessions.getOrCreateActive(key)
    expect(session.tryLock()).toBe(true)

    e.setRateLimitCfg(2, 60_000)
    void e.handleMessage(p, msg({ sessionKey: key, content: 'one' }))
    void e.handleMessage(p, msg({ sessionKey: key, content: 'two' }))
    expect(state.pendingMessages).toHaveLength(2)

    void e.handleMessage(p, msg({ sessionKey: key, content: 'three' }))
    await vi.waitFor(() => { expect(p.getSent().join('\n')).toContain('⏳') })
    expect(state.pendingMessages, 'rate-limited message never queues').toHaveLength(2)
  })

  it('limiter absent passes everything (Go nil rateLimiter)', () => {
    const { e } = newEngine()
    const m = msg({ sessionKey: 'test:any', content: 'x' })
    for (let i = 0; i < 30; i++) expect(e.checkRateLimit(m)).toBe(true)
  })
})

describe('absolute turn timeout (Go watchdog hard cap)', () => {
  it('absoluteTurnMax defaults to 2× idle; explicit set applies, 0 disables', () => {
    const { e } = newEngine()
    expect(e.absoluteTurnMax(1000)).toBe(2000)
    e.setAbsoluteTurnTimeoutSecs(5)
    expect(e.absoluteTurnMax(1000)).toBe(5000)
    e.setAbsoluteTurnTimeoutSecs(0)
    expect(e.absoluteTurnMax(1000)).toBe(0)
  })

  it('isResearchSession matches research assistants and research-hub roles', () => {
    const { e } = newEngine()
    expect(e.isResearchSession(undefined)).toBe(false)
    const role = e.sessions.getOrCreateActive('test:role')
    expect(e.isResearchSession(role)).toBe(false)
    const hub = e.sessions.getOrCreateActive('test:hub')
    hub.chatroomResearch = true
    role.chatroomHubKey = 'test:hub'
    expect(e.isResearchSession(role)).toBe(true)
    const assistant = e.sessions.getOrCreateActive('test:assistant')
    assistant.researchAssistant = true
    expect(e.isResearchSession(assistant)).toBe(true)
  })

  it('hard cap kills a trickle-forever turn on the next event', async () => {
    const { e, p } = newEngine()
    e.setEventIdleTimeout(400)
    const key = 'test:hard-cap'
    const sess = newControllableSession('hard-cap')
    const state = new InteractiveState()
    state.agentSession = sess
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set(key, state)
    const session = e.sessions.getOrCreateActive(key)
    session.tryLock()

    const done = e.processInteractiveEvents(state, session, e.sessions, key, '', undefined, undefined)
    // Trickle events every 150 ms (< idle 400 ms) keep the stall path from
    // firing; the hard cap is 3 × (2 × idle) = 2400 ms.
    const trickle = setInterval(() => {
      sess.channel.push({ type: 'text', content: 'tick', done: false } as never)
    }, 150)
    try {
      await Promise.race([
        done,
        new Promise((_, reject) => { setTimeout(() => { reject(new Error('hard cap did not fire')) }, 8000) }),
      ])
    } finally {
      clearInterval(trickle)
    }
    expect(p.getSent().some(s => s.includes('exceeded the maximum turn duration')), `sent=${JSON.stringify(p.getSent())}`).toBe(true)
    expect(e.interactiveStates.has(key)).toBe(false)
  })

  it('queued takeover resets the hard-cap clock (per-turn, not per-run)', async () => {
    const { e, p } = newEngine()
    e.setEventIdleTimeout(600)
    const key = 'test:hard-cap-queued'
    const sess = newQueuingSession('hard-cap-queued')
    const state = new InteractiveState()
    state.agentSession = sess
    state.platform = p
    state.replyCtx = 'ctx'
    state.pendingMessages = [{
      platform: p, replyCtx: 'ctx-turn2', messageID: '', content: 'queued-msg',
      images: [], files: [], fromVoice: false, isSpawnedGroup: false,
      userID: '', userName: '', msgPlatform: 'test', msgSessionKey: key,
      chatroomAskSeq: 0, chatroomAwaitAssistant: false,
    }]
    e.interactiveStates.set(key, state)
    const session = e.sessions.getOrCreateActive(key)
    session.tryLock()

    const done = e.processInteractiveEvents(state, session, e.sessions, key, 'msg1', Promise.resolve(undefined), undefined)
    const trickle = setInterval(() => {
      sess.channel.push({ type: 'text', content: 'tick', done: false } as never)
    }, 150)
    try {
      // Turn 1 runs ~500 ms (hard cap is 3 × (2 × 600) = 3600 ms), then the
      // queued message takes over as a fresh turn.
      await new Promise((resolve) => { setTimeout(resolve, 500) })
      sess.channel.push({ type: 'result', content: 'turn1', done: true } as never)
      for (let i = 0; i < 200 && sess.sendCalls.length === 0; i++) {
        await new Promise((resolve) => { setTimeout(resolve, 5) })
      }
      expect(sess.sendCalls.length, 'queued message must take over').toBe(1)

      // ~3.85 s from run start: past the run-level deadline (3.6 s) but before
      // the takeover's own deadline (~0.5 s + 3.6 s = 4.1 s). The per-turn
      // reset must keep turn 2 alive here.
      await new Promise((resolve) => { setTimeout(resolve, 3350) })
      let settled = false
      void done.then(() => { settled = true })
      await new Promise((resolve) => { setTimeout(resolve, 20) })
      expect(settled, 'turn 2 must survive past the run-level deadline').toBe(false)
      expect(p.getSent().some(s => s.includes('exceeded the maximum turn duration'))).toBe(false)

      // The reset cap still bites: past the takeover's own 3.6 s, the next
      // trickle event force-cleans the session.
      await Promise.race([
        done,
        new Promise((_, reject) => { setTimeout(() => { reject(new Error('hard cap did not fire on the second turn')) }, 5000) }),
      ])
      expect(p.getSent().some(s => s.includes('exceeded the maximum turn duration'))).toBe(true)
      expect(e.interactiveStates.has(key)).toBe(false)
    } finally {
      clearInterval(trickle)
    }
  })

  it('research sessions lift the hard cap (Go researchExempt)', async () => {
    const { e, p } = newEngine()
    e.setEventIdleTimeout(400)
    e.setAbsoluteTurnTimeoutSecs(1)
    const key = 'test:hard-cap-research'
    const sess = newControllableSession('hard-cap-research')
    const state = new InteractiveState()
    state.agentSession = sess
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set(key, state)
    const session = e.sessions.getOrCreateActive(key)
    session.researchAssistant = true
    session.tryLock()

    const done = e.processInteractiveEvents(state, session, e.sessions, key, '', undefined, undefined)
    // Hard cap would be 3 s without the exemption; trickle past it.
    const trickle = setInterval(() => {
      sess.channel.push({ type: 'text', content: 'tick', done: false } as never)
    }, 150)
    await new Promise((resolve) => { setTimeout(resolve, 3400) })
    let settled = false
    void done.then(() => { settled = true })
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(settled, 'research turn must survive past the hard cap').toBe(false)
    clearInterval(trickle)
    sess.channel.push({ type: 'result', content: 'done', done: true } as never)
    await done
    expect(p.getSent().some(s => s.includes('exceeded the maximum turn duration'))).toBe(false)
  })
})

describe('processInteractiveEvents native signals (tool failure / compaction / todo snapshots)', () => {
  function newQuietState() {
    const p = createPreviewRecorderPlatform()
    const { e } = newEngine(createStubAgent(), p)
    e.setDisplayConfig({ toolMessages: false, toolProgress: true })
    const sessionKey = 'test:user1'
    const session = e.sessions.getOrCreateActive(sessionKey)
    const agentSession = newControllableSession('s1')
    const state = new InteractiveState()
    state.agentSession = agentSession
    state.platform = p
    state.replyCtx = 'ctx-1'
    e.interactiveStates.set(sessionKey, state)
    return { e, p, session, state, agentSession, sessionKey }
  }

  it('marks the tool entry failed when the projection carries toolSuccess=false', async () => {
    const { e, p, session, state, agentSession, sessionKey } = newQuietState()
    agentSession.channel.push({ type: 'tool_use', toolName: 'bash', toolInput: 'ls', toolID: 'call-1', content: '', done: false })
    agentSession.channel.push({ type: 'tool_result', toolResult: 'exit 1', toolID: 'call-1', toolSuccess: false, content: '', done: false })
    agentSession.channel.push({ type: 'result', content: 'done', done: true })
    await e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)

    expect(p.messages.join('\n')).toContain('🔴调用失败：1/1')
  })

  it('keeps the entry green without toolSuccess (absent = success for other emitters)', async () => {
    const { e, p, session, state, agentSession, sessionKey } = newQuietState()
    agentSession.channel.push({ type: 'tool_use', toolName: 'bash', toolInput: 'ls', toolID: 'call-1', content: '', done: false })
    agentSession.channel.push({ type: 'tool_result', toolResult: 'ok', toolID: 'call-1', content: '', done: false })
    agentSession.channel.push({ type: 'result', content: 'done', done: true })
    await e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)

    expect(p.messages.join('\n')).not.toContain('🔴调用失败')
  })

  it('counts a compaction event on state and the card summary line', async () => {
    const { e, p, session, state, agentSession, sessionKey } = newQuietState()
    agentSession.channel.push({ type: 'compaction', content: '', done: false })
    agentSession.channel.push({ type: 'result', content: 'done', done: true })
    await e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)

    expect(state.compactionCount).toBe(1)
    expect(p.messages.join('\n')).toContain('🗜上下文压缩：1次')
  })

  it('sends the compaction summary to chat when no preview card is active', async () => {
    const { e, p, session, state, agentSession, sessionKey } = newQuietState()
    e.setDisplayConfig({ toolMessages: false, toolProgress: false })
    agentSession.channel.push({ type: 'compaction', content: '', done: false })
    agentSession.channel.push({ type: 'result', content: 'done', done: true })
    await e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)

    expect(p.getSent().some(s => s.includes('🗜 Context auto-compacted'))).toBe(true)
  })

  it('replaces the todo section from a todo_update event', async () => {
    const { e, p, session, state, agentSession, sessionKey } = newQuietState()
    agentSession.channel.push({ type: 'todo_update', todos: [{ content: 'ship it', status: 'in_progress' }], content: '', done: false })
    agentSession.channel.push({ type: 'result', content: 'done', done: true })
    await e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)

    expect(p.messages.join('\n')).toContain('🔄 ship it')
  })

  it('ignores a subagent child todo_update on the parent card', async () => {
    const { e, p, session, state, agentSession, sessionKey } = newQuietState()
    agentSession.channel.push({ type: 'todo_update', todos: [{ content: 'child-only', status: 'pending' }], fromSubagent: true, content: '', done: false })
    agentSession.channel.push({ type: 'result', content: 'done', done: true })
    await e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)

    expect(p.messages.join('\n')).not.toContain('child-only')
  })
})
