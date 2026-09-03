/**
 * Engine test stubs ported from the head of cc-connect core/engine_test.go
 * (~20 stub structs). Behavior matches the Go stubs exactly — only the syntax
 * changed. Expanded per milestone as more ported suites need more stubs.
 *
 * @module dsh-feishu-bridge/tests-stubs
 */

import type {
  Agent,
  AgentSession,
  ButtonOption,
  Event,
  EventChannel,
  ForkQuerierWithProvider,
  Message,
  PendingAsk,
  Platform,
  ProviderSwitcher,
  UserQuestion,
} from '../../src/core/types.ts'
import { EventChannel as EventChannelImpl } from '../../src/core/types.ts'

/** Go stubAgent: empty agent, StartSession returns a stubAgentSession. */
export type StubAgent = Agent

export function createStubAgent(): StubAgent {
  return {
    name: () => 'stub',
    startSession: async () => createStubAgentSession(),
    listSessions: async () => [],
    stop: async () => {},
  }
}

/** Go stubAgentSession: empty session, Events returns a never-fed channel. */
export function createStubAgentSession(): AgentSession {
  return {
    send: async () => {},
    steer: () => {},
    events: () => new EventChannelImpl(),
    currentSessionID: () => 'stub-session',
    alive: () => true,
    close: async () => {},
  }
}

/** Go controllableAgentSession: tests push events onto `.channel` and call
 * `close()` manually. close() is idempotent (channel-closed cleanup may close
 * an already-exited test session).
 */
export interface ControllableAgentSession extends AgentSession {
  /** The push side of the events channel (Go `agentSession.events`). */
  channel: EventChannelImpl
  /** True once close() has run. */
  closed: boolean
  sessionID: string
  aliveFlag: boolean
  sendCalls: string[]
  steerCalls: string[]
  /** Optional Go AgentInterrupter capability for the Interrupt-preference specs. */
  cancelTurn?: () => void
  eventsImpl(): EventChannel
}

export function newControllableSession(id: string): ControllableAgentSession {
  const channel = new EventChannelImpl()
  const s: ControllableAgentSession = {
    channel,
    closed: false,
    sessionID: id,
    aliveFlag: true,
    sendCalls: [],
    steerCalls: [],
    send: async () => {},
    steer: (prompt: string) => {
      s.steerCalls.push(prompt)
    },
    eventsImpl: () => channel,
    events: () => channel,
    currentSessionID: () => s.sessionID,
    alive: () => s.aliveFlag,
    close: async () => {
      if (!s.aliveFlag) return
      s.aliveFlag = false
      channel.close()
      s.closed = true
    },
  }
  return s
}

/** Go controllableAgent: controls which session StartSession returns. */
export type ControllableAgent = Agent & { nextSession?: AgentSession | undefined }

export function createControllableAgent(nextSession?: AgentSession): ControllableAgent {
  return {
    name: () => 'controllable',
    ...(nextSession !== undefined ? { nextSession } : {}),
    startSession: async () => nextSession ?? newControllableSession('default'),
    listSessions: async () => [],
    stop: async () => {},
  }
}

/** Go queuingAgentSession: records Send prompts (sendCalls). */
export function newQueuingSession(id: string): ControllableAgentSession {
  const s = newControllableSession(id)
  s.send = async (prompt: string) => {
    s.sendCalls.push(prompt)
  }
  return s
}

/** Go resultAgentSession: the first Send emits one EventResult. */
export function newResultAgentSession(result: string): ControllableAgentSession {
  const s = newControllableSession('result-session')
  let sentOnce = false
  s.send = async (prompt: string) => {
    s.sendCalls.push(prompt)
    if (!sentOnce) {
      sentOnce = true
      s.channel.push({ type: 'result', content: result, done: true })
    }
  }
  return s
}

/** Go stubPlatformEngine: records Reply/Send texts. */
export interface StubPlatform extends Platform {
  n: string
  sent: string[]
  getSent(): string[]
  clearSent(): void
}

export function createStubPlatform(n = 'test'): StubPlatform {
  const p: StubPlatform = {
    n,
    sent: [],
    name: () => p.n,
    start: async () => {},
    reply: async (_replyCtx: unknown, content: string) => {
      p.sent.push(content)
    },
    send: async (_replyCtx: unknown, content: string) => {
      p.sent.push(content)
    },
    stop: async () => {},
    getSent: () => [...p.sent],
    clearSent: () => {
      p.sent = []
    },
  }
  return p
}

/** Go stubMediaPlatform: also records image/file sends. */
export interface StubMediaPlatform extends StubPlatform {
  images: Message['images']
  files: Message['files']
  sendImage(replyCtx: unknown, img: Message['images'][number]): Promise<void>
  sendFile(replyCtx: unknown, file: Message['files'][number]): Promise<void>
}

export function createStubMediaPlatform(n = 'test'): StubMediaPlatform {
  const base = createStubPlatform(n)
  const media: StubMediaPlatform = {
    ...base,
    images: [],
    files: [],
    sendImage: async (_rc, img) => {
      media.images.push(img)
    },
    sendFile: async (_rc, file) => {
      media.files.push(file)
    },
  }
  return media
}

/** Event factory matching the Go struct-literal shape used across tests. */
export function ev(partial: Partial<Event> & { type: Event['type'] }): Event {
  return { content: '', done: false, ...partial }
}

// ── M3 stubs ─────────────────────────────────────────────────────────────

/**
 * Go stubCardPlatform: records sent cards and their structure for assertion.
 * Mirrors cc-connect core/engine_test.go stubCardPlatform.
 */
export interface StubCardPlatform extends StubPlatform {
  sentCards: unknown[]
  sendCard(replyCtx: unknown, card: unknown): Promise<void>
  replyCard(replyCtx: unknown, card: unknown): Promise<void>
}

export function createStubCardPlatform(n = 'feishu'): StubCardPlatform {
  const base = createStubPlatform(n)
  const p: StubCardPlatform = {
    ...base,
    sentCards: [],
    sendCard: async (_rc, card) => {
      p.sentCards.push(card)
    },
    replyCard: async (_rc, card) => {
      p.sentCards.push(card)
    },
  }
  return p
}

/**
 * Go stubInlineButtonPlatform: records button content and rows.
 * Mirrors cc-connect core/engine_test.go stubInlineButtonPlatform.
 */
export interface StubInlineButtonPlatform extends StubPlatform {
  buttonContent: string
  buttonRows: ButtonOption[][]
  sendWithButtons(replyCtx: unknown, content: string, rows: ButtonOption[][]): Promise<void>
}

export function createStubInlineButtonPlatform(n = 'telegram'): StubInlineButtonPlatform {
  const base = createStubPlatform(n)
  const p: StubInlineButtonPlatform = {
    ...base,
    buttonContent: '',
    buttonRows: [],
    sendWithButtons: async (_rc, content, rows) => {
      p.buttonContent = content
      p.buttonRows = rows
    },
  }
  return p
}

/**
 * Create a parked PendingAsk whose decision a test settles by calling
 * `resolve` (B2 replacement for the Go PendingPermission literals).
 */
export function newPendingAsk(overrides: Partial<PendingAsk> & { request: PendingAsk['request'] }): PendingAsk {
  return {
    answers: new Map(),
    resolve: () => {},
    ...overrides,
  }
}

/** Go testQuestions(): single-question fixture for AskUserQuestion tests. */
export function testQuestions(): UserQuestion[] {
  return [{
    question: 'Which database?',
    header: 'Setup',
    options: [
      { label: 'PostgreSQL', description: 'Recommended for production' },
      { label: 'SQLite', description: 'Lightweight, file-based' },
      { label: 'MySQL', description: 'Popular open-source' },
    ],
    multiSelect: false,
  }]
}

/** Go testMultiQuestions(): two-question fixture for sequential AskUserQuestion. */
export function testMultiQuestions(): UserQuestion[] {
  return [
    {
      question: 'Which database?',
      header: 'Database',
      options: [
        { label: 'PostgreSQL', description: '' },
        { label: 'SQLite', description: '' },
      ],
      multiSelect: false,
    },
    {
      question: 'Which framework?',
      header: 'Framework',
      options: [
        { label: 'Gin', description: '' },
        { label: 'Echo', description: '' },
      ],
      multiSelect: false,
    },
  ]
}

/**
 * Go stubChatroomSpawner: a card-capable platform that spawns groups with
 * distinct session keys per call (so multi-role chatrooms don't collide) and
 * reconstructs reply contexts for any session key.
 */
export interface StubChatroomSpawner extends StubCardPlatform {
  count: number
  firstMsgs: string[]
  groupNames: string[]
  spawnGroup(msg: Message, groupName: string, firstMsg: string): Promise<Message>
  reconstructReplyCtx(sessionKey: string): Promise<unknown>
}

export function createStubChatroomSpawner(n = 'test'): StubChatroomSpawner {
  const base = createStubCardPlatformFull(n)
  const p: StubChatroomSpawner = {
    ...base,
    count: 0,
    firstMsgs: [],
    groupNames: [],
    spawnGroup: async (msg, groupName, firstMsg) => {
      p.count++
      const key = `test:role-${p.count}`
      p.firstMsgs.push(firstMsg)
      p.groupNames.push(groupName)
      return {
        ...newStubMessage(),
        sessionKey: key,
        platform: p.n,
        userID: msg.userID,
        chatName: groupName,
        replyCtx: `ctx-${key}`,
        content: firstMsg,
      }
    },
    reconstructReplyCtx: async (sessionKey: string) => `ctx-${sessionKey}`,
  }
  // Own card-recording state: the base's sendCard closure reads the base
  // object's property, so a spread copy's `sentCards` reassignment (via
  // clearCards) would be invisible to it. Rebind both to THIS object.
  p.sentCards = []
  p.sendCard = async (_rc, card) => { p.sentCards.push(card) }
  p.replyCard = async (_rc, card) => { p.sentCards.push(card) }
  return p
}

// ── M4 stubs ──────────────────────────────────────────────────────────────

/** A fully-empty Message (Go &Message{} literal used across M4 tests). */
export function newStubMessage(): Message {
  return {
    sessionKey: '',
    platform: '',
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
    replyCtx: undefined,
    fromVoice: false,
    isSpawnedGroup: false,
    isPermissionAction: false,
    isAskqCardAction: false,
    isCardAction: false,
    parentMessageID: '',
    quotedText: '',
  }
}

/** A built card as recorded by the card stubs (src/card.ts Card shape). */
export interface RecordedCard {
  header?: { title: string; color: string; icon?: string }
  elements: Array<{ kind: string; content?: string }>
}

/**
 * Go stubCardPlatform: records sent cards and their structure for assertion,
 * reconstructs reply contexts ("reconstructed-ctx:<key>"), and produces chat
 * jump URLs.
 */
export function createStubCardPlatformFull(n = 'test'): StubCardPlatform & {
  reconstructReplyCtx(sessionKey: string): Promise<unknown>
  chatJumpURL(chatID: string): string
} {
  const base = createStubCardPlatform(n)
  return {
    ...base,
    reconstructReplyCtx: async (sessionKey: string) => `reconstructed-ctx:${sessionKey}`,
    chatJumpURL: (chatID: string) => `https://applink.feishu.cn/client/chat/open?openChatId=${chatID}`,
  }
}

/**
 * Go stubSpawnerPlatform: a card-capable platform that can spawn groups.
 * Each spawn returns a synthetic child message keyed off a monotonic counter.
 */
export interface StubSpawnerPlatform extends StubCardPlatform {
  spawnCount: number
  lastFirst: string
  lastUserID: string
  spawnGroup(msg: Message, groupName: string, firstMsg: string): Promise<Message>
}

export function createStubSpawnerPlatform(n = 'test'): StubSpawnerPlatform {
  const base = createStubCardPlatformFull(n)
  const p: StubSpawnerPlatform = {
    ...base,
    spawnCount: 0,
    lastFirst: '',
    lastUserID: '',
    spawnGroup: async (msg, groupName, firstMsg) => {
      p.spawnCount++
      p.lastFirst = firstMsg
      p.lastUserID = msg.userID
      return {
        ...newStubMessage(),
        sessionKey: 'test:child-chat',
        platform: p.n,
        userID: msg.userID,
        chatName: groupName,
        replyCtx: 'child-ctx',
        content: firstMsg,
      }
    },
  }
  return p
}

/**
 * Go stubSpawnerPinPlatform: a spawner that captures the returned synthetic
 * message (by reference, so mutations are visible) and records pin-panel
 * calls.
 */
export interface StubSpawnerPinPlatform extends StubCardPlatform {
  returnedMsg: Message | undefined
  pins: string[]
  spawnGroup(msg: Message, groupName: string, firstMsg: string): Promise<Message>
  addMessagePin(chatID: string, messageID: string): Promise<void>
}

export function createStubSpawnerPinPlatform(n = 'test'): StubSpawnerPinPlatform {
  const base = createStubCardPlatformFull(n)
  const p: StubSpawnerPinPlatform = {
    ...base,
    returnedMsg: undefined,
    pins: [],
    spawnGroup: async (msg, groupName, firstMsg) => {
      const m: Message = {
        ...newStubMessage(),
        sessionKey: 'test:child-chat',
        platform: p.n,
        userID: msg.userID,
        chatName: groupName,
        replyCtx: 'child-ctx',
        content: firstMsg,
        messageID: 'child-msg-1',
      }
      p.returnedMsg = m
      return m
    },
    addMessagePin: async (_chatID, messageID) => {
      p.pins.push(messageID)
    },
  }
  return p
}

/**
 * Go stubTitleRenamePlatform: records RenameGroup / SetGroupIconAvatar /
 * SetChatroomFamilyAvatar calls. RenameGroup rejects an already-aborted
 * signal so tests can reproduce the "rename reused the LLM's expired ctx"
 * regression.
 */
export interface StubTitleRenamePlatform extends StubPlatform {
  renamedKeys: string[]
  renamedNames: string[]
  avatarKeys: string[]
  avatarIcons: string[]
  avatarGroups: string[]
  avatarErr?: Error
  familyHub: string
  familyChildren: string[]
  familyIcon: string
  familyName: string
  familyCalls: number
  renameGroup(sessionKey: string, newName: string, signal?: AbortSignal): Promise<void>
  renameGroupAny(sessionKey: string, newName: string, signal?: AbortSignal): Promise<void>
  setGroupIconAvatar(sessionKey: string, iconName: string, groupName: string): Promise<void>
  setGroupFamilyAvatar(hubKey: string, childKeys: string[], iconName: string, familyName: string): Promise<void>
}

export function createStubTitleRenamePlatform(n = 'test'): StubTitleRenamePlatform {
  const base = createStubPlatform(n)
  const p: StubTitleRenamePlatform = {
    ...base,
    renamedKeys: [],
    renamedNames: [],
    avatarKeys: [],
    avatarIcons: [],
    avatarGroups: [],
    familyHub: '',
    familyChildren: [],
    familyIcon: '',
    familyName: '',
    familyCalls: 0,
    renameGroup: async (key, name, signal) => {
      // Mirror the real renameChat→withTransientRetry: an aborted signal
      // fails even though the HTTP request would have gone through.
      if (signal?.aborted) throw new Error('context canceled')
      p.renamedKeys.push(key)
      p.renamedNames.push(name)
    },
    renameGroupAny: async (key, name, signal) => p.renameGroup(key, name, signal),
    setGroupIconAvatar: async (key, iconName, groupName) => {
      p.avatarKeys.push(key)
      p.avatarIcons.push(iconName)
      p.avatarGroups.push(groupName)
      if (p.avatarErr !== undefined) throw p.avatarErr
    },
    setGroupFamilyAvatar: async (hubKey, childKeys, iconName, familyName) => {
      p.familyHub = hubKey
      p.familyChildren = [...childKeys]
      p.familyIcon = iconName
      p.familyName = familyName
      p.familyCalls++
    },
  }
  return p
}

/** Go noOverwriteStubAgent: the session reports an empty CurrentSessionID. */
export function createNoOverwriteAgent(): Agent {
  return {
    ...createStubAgent(),
    startSession: async () => ({
      ...createStubAgentSession(),
      currentSessionID: () => '',
    }),
  }
}

/** Agent with a settable work dir (Go stubWorkDirAgent). */
export function createWorkDirAgent(workDir: string): Agent & { getWorkDir(): string; setWorkDir(d: string): void } {
  let dir = workDir
  return {
    ...createStubAgent(),
    getWorkDir: () => dir,
    setWorkDir: (d: string) => { dir = d },
  }
}

/**
 * Go forkPreparerAgent: a work-dir agent whose PrepareForkSession records
 * its arguments and returns the configured error.
 */
export function createForkPreparerAgent(workDir: string, forkErr: Error | undefined): Agent & {
  prepared: boolean
  gotOrigID: string
  gotParentWorkDir: string
  gotChildWorkDir: string
  prepareForkSession(origID: string, parentWorkDir: string, childWorkDir: string): Promise<void>
} {
  const base = createWorkDirAgent(workDir)
  const a = {
    ...base,
    prepared: false,
    gotOrigID: '',
    gotParentWorkDir: '',
    gotChildWorkDir: '',
    prepareForkSession: async (origID: string, parentWorkDir: string, childWorkDir: string): Promise<void> => {
      a.prepared = true
      a.gotOrigID = origID
      a.gotParentWorkDir = parentWorkDir
      a.gotChildWorkDir = childWorkDir
      if (forkErr !== undefined) throw forkErr
    },
  }
  return a
}

/**
 * Recorded state of a stub group-name agent (Go stubGroupNameAgent's mutexed
 * fields). Kept in a shared object so spreading the agent (to override
 * startSession) preserves the recorded state — a spread copy of inline
 * fields would never see the closure's writes.
 */
export interface GroupNameAgentState {
  gotPrompt: string
  gotProvider: string
  gotWorkDir: string
  callCount: number
}

/**
 * Go stubGroupNameAgent: satisfies ForkQuerierWithProvider, recording
 * LightweightQuery calls and returning a canned response/error. When
 * blockUntilSignal is set, the query only returns once the caller's signal
 * aborts — reproducing "the LLM used exactly the full ctx timeout".
 */
export function createGroupNameAgent(opts: {
  resp?: string
  err?: Error
  blockUntilSignal?: boolean
}): Agent & { state: GroupNameAgentState } & ForkQuerierWithProvider {
  const state: GroupNameAgentState = { gotPrompt: '', gotProvider: '', gotWorkDir: '', callCount: 0 }
  return {
    ...createStubAgent(),
    state,
    forkQuery: async () => '',
    forkSessionWithProvider: async () => '',
    lightweightQuery: async (prompt: string, provider: string, signal?: AbortSignal, workDir?: string) => {
      state.gotPrompt = prompt
      state.gotProvider = provider
      state.gotWorkDir = workDir ?? ''
      state.callCount++
      if (opts.blockUntilSignal === true && signal !== undefined) {
        if (signal.aborted) return opts.resp ?? ''
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
      }
      if (opts.err !== undefined) throw opts.err
      return opts.resp ?? ''
    },
  }
}

/** Go stubGroupNameAgentSwitcher: adds ProviderSwitcher with an active provider and per-chat overrides. */
export function createGroupNameSwitcherAgent(
  activeName: string, opts: { resp?: string; err?: Error },
): Agent & { state: GroupNameAgentState } & ForkQuerierWithProvider & ProviderSwitcher {
  const base = createGroupNameAgent(opts)
  const overrides = new Map<string, string>()
  return {
    ...base,
    setProviders: () => {},
    setActiveProvider: () => false,
    setSessionProvider: (key: string, name: string) => {
      if (name === '') overrides.delete(key)
      else overrides.set(key, name)
      return true
    },
    getActiveProvider: (sessionKey?: string) => ({
      name: (sessionKey !== undefined && sessionKey !== '' ? overrides.get(sessionKey) : undefined) ?? activeName,
    }),
    listProviders: () => [],
  }
}

/**
 * Go blockingSendAgentSession: Send signals sendStarted then blocks until
 * unblock resolves; the test pushes the turn's result event itself.
 */
export interface BlockingSendAgentSession extends ControllableAgentSession {
  sendStarted: Promise<void>
  unblock: () => void
}

export function newBlockingSendSession(id: string): BlockingSendAgentSession {
  const s = newControllableSession(id)
  let signalSend!: () => void
  const sendStarted = new Promise<void>((resolve) => { signalSend = resolve })
  let unblock!: () => void
  const unblockP = new Promise<void>((resolve) => { unblock = resolve })
  s.send = async () => {
    signalSend()
    await unblockP
  }
  return { ...s, sendStarted, unblock }
}
