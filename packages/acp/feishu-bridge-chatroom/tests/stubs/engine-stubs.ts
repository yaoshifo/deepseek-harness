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
  EventChannel,
  Message,
  Platform,
} from '@deepseek-ai/dsh-feishu-bridge/exports'
import { EventChannel as EventChannelImpl } from '@deepseek-ai/dsh-feishu-bridge/exports'

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

/** Go stubPlatformEngine: records Reply/Send texts. */
interface StubPlatform extends Platform {
  n: string
  sent: string[]
  getSent(): string[]
  clearSent(): void
}

function createStubPlatform(n = 'test'): StubPlatform {
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
 * Clear a card stub's recorded cards. The sendCard closure reads the
 * factory-local object's property, so reassigning `stub.sentCards = []` on
 * a spread copy is invisible to it — always clear through this helper.
 */
export function clearCards(stub: { sentCards: unknown[] }): void {
  stub.sentCards = []
}

// ── M5 stubs ──────────────────────────────────────────────────────────────

/** A recorded RenameGroupAny invocation (Go stubRenameCall). */
interface StubRenameCall {
  key: string
  name: string
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

/**
 * Go stubChatroomSpawnerEx: adds the spawnGroupWithOptions path (which real
 * Feishu uses), records cleanup (markSpawnedChatDone), and records
 * RenameGroupAny calls so EndChatroom and the hub rename are observable.
 */
export interface StubChatroomSpawnerEx extends StubChatroomSpawner {
  exOpts: Array<{ workDir: string }>
  exFirst: string[]
  doneKeys: string[]
  renamedAny: StubRenameCall[]
  spawnGroupWithOptions(msg: Message, groupName: string, firstMsg: string, opts: { workDir: string }): Promise<Message>
  markSpawnedChatDone(sessionKey: string): Promise<void>
  setChatPhase(sessionKey: string, phase: import('@deepseek-ai/dsh-feishu-bridge/exports').ChatPhase): Promise<void>
  renameGroup(sessionKey: string, newName: string, signal?: AbortSignal): Promise<void>
  renameGroupAny(sessionKey: string, newName: string, signal?: AbortSignal): Promise<void>
  renamedAnyCalls(): StubRenameCall[]
}

export function createStubChatroomSpawnerEx(n = 'test'): StubChatroomSpawnerEx {
  // Mutate the base object instead of spreading: the base's spawnGroup
  // closure reads its own `count`/`firstMsgs`/`groupNames` properties, so a
  // spread copy would carry stale counter values while the closure kept
  // mutating the original.
  const p = createStubChatroomSpawner(n) as StubChatroomSpawnerEx
  p.exOpts = []
  p.exFirst = []
  p.doneKeys = []
  p.renamedAny = []
  p.spawnGroupWithOptions = async (msg, groupName, firstMsg, opts) => {
    p.exOpts.push({ workDir: opts.workDir })
    p.exFirst.push(firstMsg)
    return p.spawnGroup(msg, groupName, firstMsg)
  }
  p.markSpawnedChatDone = async (sessionKey: string) => {
    p.doneKeys.push(sessionKey)
  }
  // Satisfies ChatPhasePainter so /done's cleanup (and EndChatroom, which
  // drives it) proceeds past the avatar step. "Which roles were cleaned" is
  // observed via doneKeys.
  p.setChatPhase = async () => {}
  p.renameGroup = async () => {}
  p.renameGroupAny = async (key, name) => {
    p.renamedAny.push({ key, name })
  }
  p.renamedAnyCalls = () => [...p.renamedAny]
  return p
}

/**
 * Go stubProgressCardPlatform: adds CardSenderWithUpdate to the chatroom
 * stub so research progress-card sends/PATCHes are observable.
 */
export interface StubProgressCardPlatform extends StubChatroomSpawner {
  updates: string[]
  /** Full card payloads POSTed through sendCardWithHandle, in order. */
  postedCards: unknown[]
  /** Full card payloads PATCHed through updateCardWithHandle, in order. */
  updateCards: unknown[]
  sendCardWithHandle(replyCtx: unknown, card: unknown): Promise<unknown>
  updateCardWithHandle(handle: unknown, card: unknown): Promise<void>
  patchedTitles(): string[]
}

export function createStubProgressCardPlatform(n = 'test'): StubProgressCardPlatform {
  const p = createStubChatroomSpawner(n) as StubProgressCardPlatform
  p.updates = []
  p.postedCards = []
  p.updateCards = []
  p.sendCardWithHandle = async (_replyCtx, card) => {
    p.postedCards.push(card)
    return `handle-${p.postedCards.length}`
  }
  p.updateCardWithHandle = async (_handle, card) => {
    const c = card as RecordedCard
    p.updateCards.push(card)
    p.updates.push(c.header?.title ?? '')
  }
  p.patchedTitles = () => [...p.updates]
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
  header?: { title: string; color: string }
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
