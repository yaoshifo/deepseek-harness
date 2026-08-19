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
  AgentSessionInfo,
  Event,
  EventChannel,
  Message,
  PermissionResult,
  Platform,
} from '../../src/core/types.js'
import { EventChannel as EventChannelImpl } from '../../src/core/types.js'

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
    respondPermission: async () => {},
    events: () => new EventChannelImpl(),
    currentSessionID: () => 'stub-session',
    alive: () => true,
    close: async () => {},
  }
}

/** Go recordingAgentSession: records RespondPermission calls. */
export function createRecordingAgentSession(): RecordingAgentSession {
  const s: RecordingAgentSession = {
    ...createStubAgentSession(),
    lastID: '',
    lastResult: undefined,
    calls: 0,
  }
  s.respondPermission = async (id: string, res: PermissionResult) => {
    s.lastID = id
    s.lastResult = res
    s.calls++
  }
  return s
}

/** Go recordingAgentSession shape. */
export interface RecordingAgentSession extends AgentSession {
  lastID: string
  lastResult: PermissionResult | undefined
  calls: number
}

/**
 * Go controllableAgentSession: tests push events onto `.channel` and call
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
  permResponses: Array<{ requestID: string; result: PermissionResult }>
  sendCalls: string[]
  eventsImpl(): EventChannel
}

export function newControllableSession(id: string): ControllableAgentSession {
  const channel = new EventChannelImpl()
  const s: ControllableAgentSession = {
    channel,
    closed: false,
    sessionID: id,
    aliveFlag: true,
    permResponses: [],
    sendCalls: [],
    send: async () => {},
    respondPermission: async (requestID, result) => {
      s.permResponses.push({ requestID, result })
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
export type ControllableAgent = Agent & { nextSession?: AgentSession }

export function createControllableAgent(nextSession?: AgentSession): ControllableAgent {
  return {
    name: () => 'controllable',
    nextSession,
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

/** Session list stub (Go stubListAgent). */
export function createListAgent(sessions: AgentSessionInfo[]): StubAgent {
  return {
    ...createStubAgent(),
    listSessions: async () => sessions,
  }
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
