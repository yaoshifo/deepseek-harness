/**
 * Bot-to-bot relay ported from cc-connect core/relay.go: the RelayManager
 * that persists relay bindings to `<dataDir>/relay_bindings.json` (the Go
 * file format and directory), routes a relay send to the bound target
 * engine's `handleRelay`, and mirrors the exchange into the group chat for
 * visibility. One instance serves every project's engine.
 *
 * @module dsh-feishu-bridge/relay
 */

import { readFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { atomicWriteFileSync } from '../atomicwrite.js'
import { asReplyContextReconstructor } from '../core/types.js'
import type { Engine } from './engine.js'

/** Default max wait for a relay response (Go relayTimeout). */
export const defaultRelayTimeoutMs = 120 * 1000

/** A bot-to-bot relay binding in a group chat (Go RelayBinding). */
export interface RelayBinding {
  platform: string
  chatID: string
  /** project name → bot display name */
  bots: Record<string, string>
}

/** The payload for a relay send (Go RelayRequest). */
export interface RelayRequest {
  /** Source project name. */
  from: string
  /** Target project name. */
  to: string
  /** Source session key (contains platform + chatID). */
  sessionKey: string
  message: string
}

/** The result of a relay send (Go RelayResponse). */
export interface RelayResponse {
  response: string
}

/** Split a session key into [platform, chatID] (Go parseSessionKeyParts). */
export function parseSessionKeyParts(sessionKey: string): [platform: string, chatID: string] {
  // Format: "platform:chatID:userID"; relay form: "relay:sourceProject:chatID".
  const parts = sessionKey.split(':', 3)
  if (parts.length < 2) {
    throw new Error(`invalid session key format: "${sessionKey}"`)
  }
  if (parts[0] === 'relay' && parts.length === 3) {
    // For relay sessions, chatID is the third part.
    return ['relay', parts[2] ?? '']
  }
  return [parts[0] ?? '', parts[1] ?? '']
}

/**
 * Coordinates bot-to-bot message relay across engines (Go RelayManager).
 * Bindings persist across restarts; engines are runtime-only registrations.
 */
export class RelayManager {
  private readonly engines = new Map<string, Engine>()
  private bindings = new Map<string, RelayBinding>()
  private readonly storePath: string
  private timeoutMs = defaultRelayTimeoutMs

  /**
   * @param dataDir - Root data directory for relay_bindings.json; '' keeps
   * the manager in memory only.
   */
  constructor(dataDir: string) {
    this.storePath = dataDir === '' ? '' : join(dataDir, 'relay_bindings.json')
    if (this.storePath !== '') this.load()
  }

  /** Map a project name to the engine relay sends target (Go RegisterEngine). */
  registerEngine(name: string, e: Engine): void {
    this.engines.set(name, e)
  }

  /** Override the relay response timeout; 0 disables it (Go SetTimeout). */
  setTimeoutMs(ms: number): void {
    this.timeoutMs = ms < 0 ? 0 : ms
  }

  /** The configured relay wait (Go's private timeout field, exposed for tests). */
  relayTimeoutMs(): number {
    return this.timeoutMs
  }

  /**
   * The wait signal bounding one relay send (Go relayContext): undefined
   * when the timeout is disabled.
   */
  relaySignal(): AbortSignal | undefined {
    if (this.timeoutMs <= 0) return undefined
    return AbortSignal.timeout(this.timeoutMs)
  }

  /** Establish (or replace) a relay binding between bots in a group chat. */
  bind(platform: string, chatID: string, bots: Record<string, string>): void {
    this.bindings.set(chatID, { platform, chatID, bots })
    console.info(`relay: binding created (chat_id ${chatID}, bots ${JSON.stringify(bots)})`)
    this.save()
  }

  /** Add a project to an existing binding, or create a new one. */
  addToBind(platform: string, chatID: string, projectName: string): void {
    let binding = this.bindings.get(chatID)
    if (binding === undefined) {
      binding = { platform, chatID, bots: {} }
      this.bindings.set(chatID, binding)
    }
    binding.bots[projectName] = projectName
    console.info(`relay: project added to binding (chat_id ${chatID}, project ${projectName}, bots ${JSON.stringify(binding.bots)})`)
    this.save()
  }

  /** Remove a project from a binding; drops the binding when no bots remain. */
  removeFromBind(chatID: string, projectName: string): boolean {
    const binding = this.bindings.get(chatID)
    if (binding === undefined) return false
    if (Object.hasOwn(binding.bots, projectName)) {
      const { [projectName]: _removed, ...rest } = binding.bots
      binding.bots = rest
      console.info(`relay: project removed from binding (chat_id ${chatID}, project ${projectName}, remaining ${JSON.stringify(binding.bots)})`)
      if (Object.keys(binding.bots).length === 0) {
        this.bindings.delete(chatID)
        console.info(`relay: binding removed (no bots left) (chat_id ${chatID})`)
      }
      this.save()
      return true
    }
    return false
  }

  /** The binding for a chat, or undefined when none. */
  getBinding(chatID: string): RelayBinding | undefined {
    return this.bindings.get(chatID)
  }

  /** Remove the relay binding for a chat. */
  unbind(chatID: string): void {
    this.bindings.delete(chatID)
    console.info(`relay: binding removed (chat_id ${chatID})`)
    this.save()
  }

  /** Whether a project engine is registered. */
  hasEngine(name: string): boolean {
    return this.engines.has(name)
  }

  /** All registered engine names. */
  listEngineNames(): string[] {
    return [...this.engines.keys()]
  }

  /** The other bots bound in the same chat as the given project. */
  listBoundBots(chatID: string, selfProject: string): Record<string, string> {
    const b = this.bindings.get(chatID)
    if (b === undefined) return {}
    const others: Record<string, string> = {}
    for (const [proj, name] of Object.entries(b.bots)) {
      if (proj !== selfProject) others[proj] = name
    }
    return others
  }

  /** Deliver a message from one bot to another and return the response (Go Send). */
  async send(req: RelayRequest): Promise<RelayResponse> {
    let platform: string, chatID: string
    try {
      ;[platform, chatID] = parseSessionKeyParts(req.sessionKey)
    } catch (error) {
      throw new Error(`relay: invalid session key: ${error instanceof Error ? error.message : String(error)}`)
    }

    const binding = this.bindings.get(chatID)
    const targetEngine = this.engines.get(req.to)
    const sourceEngine = this.engines.get(req.from)

    if (binding === undefined) {
      throw new Error('relay: no binding for this chat. Use /bind <project> first')
    }
    if (!Object.hasOwn(binding.bots, req.to)) {
      const bound = Object.keys(binding.bots).filter(proj => proj !== req.from)
      throw new Error(`relay: project "${req.to}" is not bound in this chat. Available targets: ${bound.join(', ')} (use the exact name)`)
    }
    if (targetEngine === undefined) {
      throw new Error(`relay: target engine "${req.to}" not found (is the project running?)`)
    }

    const fromName = binding.bots[req.from] !== undefined && binding.bots[req.from] !== '' ? binding.bots[req.from] : req.from
    const toName = binding.bots[req.to] !== '' ? binding.bots[req.to] : req.to

    // Post the forwarded message to the group chat for visibility.
    const groupSessionKey = `${platform}:${chatID}:relay`
    if (sourceEngine !== undefined) {
      const label = `[${fromName} → ${toName}] ${req.message}`
      await this.sendToGroup(sourceEngine, platform, groupSessionKey, label)
    }

    // Execute the relay: inject the message into the target engine and
    // collect the response.
    let response: string
    try {
      response = await targetEngine.handleRelay(this.relaySignal(), req.from, chatID, req.message)
    } catch (error) {
      throw new Error(`relay: ${error instanceof Error ? error.message : String(error)}`)
    }

    // Post the response to the group chat for visibility.
    const label = `[${toName}] ${truncateRelay(response, 2000)}`
    await this.sendToGroup(targetEngine, platform, groupSessionKey, label)

    return { response }
  }

  /** Send a message to the group chat for visibility (Go sendToGroup). */
  private async sendToGroup(e: Engine, platform: string, sessionKey: string, content: string): Promise<void> {
    for (const p of e.platforms) {
      if (p.name() !== platform) continue
      const rc = asReplyContextReconstructor(p)
      if (rc === undefined) continue
      try {
        const rctx = await rc.reconstructReplyCtx(sessionKey)
        await p.send(rctx, content)
      } catch (error) {
        console.debug(`relay: failed to send group message: ${String(error)}`)
      }
      return
    }
  }

  // ── persistence ─────────────────────────────────────────────────────────

  /** Persist bindings to disk (Go saveLocked). */
  private save(): void {
    if (this.storePath === '') return
    try {
      // Go's on-disk keys: platform, chat_id, bots.
      const raw: Record<string, { platform: string; chat_id: string; bots: Record<string, string> }> = {}
      for (const [chatID, b] of this.bindings) raw[chatID] = { platform: b.platform, chat_id: b.chatID, bots: b.bots }
      mkdirSync(dirname(this.storePath), { recursive: true })
      atomicWriteFileSync(this.storePath, new TextEncoder().encode(JSON.stringify(raw, null, 2)), 0o644)
    } catch (error) {
      console.error(`relay: failed to write bindings (${this.storePath}): ${String(error)}`)
    }
  }

  /** Load bindings from disk (Go load). */
  private load(): void {
    let data: string
    try {
      data = readFileSync(this.storePath, 'utf8')
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code !== 'ENOENT') {
        console.error(`relay: failed to read bindings (${this.storePath}): ${String(error)}`)
      }
      return
    }
    try {
      const raw = JSON.parse(data) as Record<string, { platform: string; chat_id: string; bots: Record<string, string> }> | null
      if (raw !== null) {
        this.bindings = new Map(Object.entries(raw).map(([chatID, b]) => [chatID, {
          platform: b.platform,
          chatID: b.chat_id,
          bots: b.bots,
        }]))
        console.info(`relay: loaded bindings (count ${this.bindings.size})`)
      }
    } catch (error) {
      console.error(`relay: failed to unmarshal bindings (${this.storePath}): ${String(error)}`)
    }
  }
}

/** Truncate a relay response with an ellipsis (Go truncateRelay). */
function truncateRelay(s: string, maxLen: number): string {
  const runes = Array.from(s)
  if (runes.length <= maxLen) return s
  return `${runes.slice(0, maxLen).join('')}…`
}
