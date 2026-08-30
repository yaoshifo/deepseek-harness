/**
 * The model-facing `lark-cli` tool (named verbatim after the official CLI so
 * every command reference in lark-cli's embedded skills maps literally to a
 * tool call): cc-connect's `cc-connect lark` wrapper (cmd/cc-connect/lark_cmd.go) ported to a dsh tool (plan D4). The
 * tool spawns lark-cli as a child process and injects the caller's project
 * bot credentials — bot mode mints a tenant access token and sets
 * LARKSUITE_CLI_* env, `--as user` / auth subcommands instead prepend
 * `--profile <app_id>` so lark-cli uses its stored user token.
 *
 * The caller agent resolves to its project's credentials through the router
 * — the Go CLI's CC_PROJECT env contract, without env, because
 * ToolRunContext carries the caller agent (Go runLark's CC_PROJECT check and
 * envWithoutCCProject recursion guard are process-env concerns that do not
 * exist here: the daemon never puts CC_PROJECT into any child env).
 *
 * `im +chat-messages-list` bypasses lark-cli and calls the Feishu OpenAPI
 * directly with the project's bot token (Go runChatMessagesListNative):
 * reading messages must use the right bot, and this keeps it independent of
 * lark-cli's single-global-app limitations.
 *
 * @module dsh-feishu-bridge/tools-lark
 */

import { execFile } from 'node:child_process'
import { accessSync, constants as fsConstants } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SubtaskRoute } from './subtask.js'

/** Bot credentials for one project, taken from the plugin config. */
export interface LarkCreds {
  readonly appId: string
  readonly appSecret: string
}

/** The engine, session, and bot credentials a lark tool call is routed to. */
export type LarkRoute = SubtaskRoute & { creds: LarkCreds }

/** Resolves the calling dsh agent to its project's lark routing. */
export type LarkAgentRouter = (agent: unknown) => LarkRoute | undefined

/** One finished lark-cli child process. */
export interface LarkChildResult {
  stdout: string
  stderr: string
  code: number
}

/** Injectable process/IO surface so tests never spawn a real lark-cli. */
export interface LarkRunnerDeps {
  spawn(bin: string, argv: string[], opts: { env: Record<string, string>; cwd?: string; signal?: AbortSignal }): Promise<LarkChildResult>
  fetch(url: string, init?: RequestInit): Promise<Response>
  stat?(path: string): Promise<{ mtimeMs: number } | undefined>
  readFile?(path: string): Promise<string | undefined>
  writeFile?(path: string, data: string): Promise<void>
  /** Extra env merged into every child (e.g. a test PATH). */
  baseEnv?: Record<string, string>
}

/** lark-cli subcommand tokens the model passes through, e.g. ["docs","+search","--query","x"]. */
export interface LarkToolArgs {
  args: string[]
}

const DESCRIPTION =
  'Verbatim pass-through of the official lark-cli against THIS project\'s Feishu bot (credential routing is '
  + 'automatic). Identity defaults to the bot; add "--as user" for user-authorized operations (docs search, '
  + 'wiki members, Base) and "auth login/logout/status" for lark-cli authorization. Everything lark-cli supports '
  + 'is passed through verbatim, e.g. ["docs","+search","--query","迁移"] or ["wiki","+node-create","--space-id","..."]. '
  + 'Output (stdout, plus stderr when non-empty) comes back as the tool result. Before any Feishu domain task '
  + '(docs, sheets, Base, calendar, mail, wiki, IM, tasks, approval, OKR, ...), first discover the domain with '
  + '["skills","list"], then read its guide with ["skills","read","<skill>"] — deeper step-by-step references via '
  + '["skills","read","<skill>/references/<file>.md"], reading only the one the current step needs, never the '
  + 'whole set upfront.'

/** Minimum lark-cli version the credential injection relies on (Go minLarkCLIVersion). */
export const minLarkCLIVersion = '1.0.69'

/** lark-cli probes the npm registry on every run, which hangs on mainland networks. */
const notifierSuppressionEnv: Record<string, string> = {
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
  LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
}

const feishuOpenBaseURL = 'https://open.feishu.cn'
/** Upper bound for --page-limit: 200 pages × 50 messages keeps one tool call bounded. */
export const maxListPages = 200
/** Cooperative tool-call budget (ms) declared for the timeout policy to enforce. */
export const larkToolTimeoutMs = 300_000
/** Per-attempt deadline for the bare TAT mint fetch (ms). */
export const larkTatTimeoutMs = 30_000

// ── pure argument classification (ported 1:1 from lark_cmd.go) ────────────

/**
 * Whether args request user identity via `--as user` / `--as=user`.
 *
 * @param args - The lark-cli argument tokens the model passed in.
 * @returns True when the invocation should run under user identity.
 */
export function isAsUser(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    if (a === '--as=user') return true
    if (a === '--as' && args[i + 1] === 'user') return true
  }
  return false
}

/**
 * Whether args target the `auth` resource (login/logout/status/whoami).
 *
 * @param args - The lark-cli argument tokens the model passed in.
 * @returns True when the invocation is an lark-cli auth subcommand.
 */
export function isAuthSubcommand(args: string[]): boolean {
  for (let i = 0; i + 1 < args.length; i++) {
    if ((args[i] ?? '') === 'auth') {
      const sub = args[i + 1] ?? ''
      if (sub === 'login' || sub === 'logout' || sub === 'status' || sub === 'whoami') return true
    }
  }
  return false
}

/**
 * Value of the first `--profile X` / `--profile=X`, or '' when absent/malformed.
 *
 * @param args - The lark-cli argument tokens the model passed in.
 * @returns The first profile value, or '' when no well-formed `--profile` flag is present.
 */
export function extractProfileFlag(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    if (a === '--profile') return args[i + 1] ?? ''
    if (a.startsWith('--profile=')) return a.slice('--profile='.length)
  }
  return ''
}

/**
 * Whether args target `im +chat-messages-list` (the native listing path).
 *
 * @param args - The lark-cli argument tokens the model passed in.
 * @returns True when the invocation should bypass lark-cli for the native OpenAPI listing.
 */
export function isChatMessagesList(args: string[]): boolean {
  for (let i = 0; i + 1 < args.length; i++) {
    if ((args[i] ?? '') === 'im' && args[i + 1] === '+chat-messages-list') return true
  }
  return false
}

/** Parsed subset of +chat-messages-list flags (Go listMsgOpts). */
export interface ListMsgOpts {
  chatId: string
  pageSize: number
  sortType: 'ByCreateTimeAsc' | 'ByCreateTimeDesc'
  format: 'json' | 'ndjson'
  pageAll: boolean
  pageLimit: number
  pageToken: string
}

/**
 * Parse the supported +chat-messages-list flags; unknown flags are ignored.
 *
 * @param args - The lark-cli argument tokens after `im +chat-messages-list`.
 * @returns The parsed options plus a non-empty `error` string on invalid input.
 */
export function parseListMessagesArgs(args: string[]): { opts: ListMsgOpts; error?: string } {
  const opts: ListMsgOpts = { chatId: '', pageSize: 50, sortType: 'ByCreateTimeDesc', format: 'json', pageAll: false, pageLimit: 10, pageToken: '' }
  let hasUserID = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    const next = args[i + 1]
    if (a === '--chat-id' && next !== undefined) { opts.chatId = next; i++ }
    else if (a.startsWith('--chat-id=')) opts.chatId = a.slice('--chat-id='.length)
    else if (a === '--page-size' && next !== undefined) {
      const n = Number.parseInt(next, 10)
      if (Number.isInteger(n)) opts.pageSize = n
      i++
    } else if (a === '--sort' && next !== undefined) {
      opts.sortType = next === 'asc' ? 'ByCreateTimeAsc' : 'ByCreateTimeDesc'
      i++
    } else if (a === '--format' && next !== undefined) {
      // pretty/table/csv degrade to json.
      opts.format = next === 'ndjson' ? 'ndjson' : 'json'
      i++
    } else if (a === '--page-all') opts.pageAll = true
    else if (a === '--page-limit' && next !== undefined) {
      const n = Number.parseInt(next, 10)
      if (Number.isInteger(n)) opts.pageLimit = n
      i++
    } else if (a === '--page-token' && next !== undefined) { opts.pageToken = next; i++ }
    else if (a === '--user-id' || a.startsWith('--user-id=')) hasUserID = true
    else if (a === '--as' && next !== undefined) i++ // identity flag ignored; native read is always bot
  }
  if (hasUserID) return { opts, error: 'native read only supports --chat-id; --user-id (P2P resolution) is not supported' }
  if (opts.chatId === '') return { opts, error: 'missing --chat-id (native read requires a chat ID)' }
  if (opts.pageSize < 1) opts.pageSize = 1
  else if (opts.pageSize > 50) opts.pageSize = 50
  if (opts.pageLimit < 1) opts.pageLimit = 10
  // Cap the walk: a model-supplied --page-limit would otherwise drive
  // thousands of sequential OpenAPI calls with an unbounded result.
  else if (opts.pageLimit > maxListPages) opts.pageLimit = maxListPages
  return { opts }
}

/**
 * Build the List Messages request URL (Go buildListMessagesURL).
 *
 * @param baseURL - The Feishu OpenAPI base URL.
 * @param opts - The parsed listing options to encode as query parameters.
 * @param pageToken - The pagination token from the previous page; '' omits the parameter.
 * @returns The full request URL with encoded query string.
 */
export function buildListMessagesURL(baseURL: string, opts: ListMsgOpts, pageToken: string): string {
  const q = new URLSearchParams()
  q.set('container_id', opts.chatId)
  q.set('container_id_type', 'chat')
  q.set('page_size', String(opts.pageSize))
  q.set('sort_type', opts.sortType)
  q.set('card_msg_content_type', 'raw_card_content')
  if (pageToken !== '') q.set('page_token', pageToken)
  return `${baseURL}/open-apis/im/v1/messages?${q.toString()}`
}

/**
 * Best-effort decode of a message body.content into plain text.
 *
 * @param msgType - The Feishu message type, e.g. `text`, `markdown`, or `post`.
 * @param bodyContent - The raw JSON `body.content` string of the message item.
 * @returns The decoded plain text; '' for unsupported types or unparseable content.
 */
export function decodeMessageText(msgType: string, bodyContent: string): string {
  if (bodyContent === '') return ''
  if (msgType === 'text' || msgType === 'markdown') {
    try {
      return (JSON.parse(bodyContent) as { text?: string }).text ?? ''
    } catch {
      return ''
    }
  }
  if (msgType === 'post') {
    try {
      const v = JSON.parse(bodyContent) as { title?: string; content?: Array<Array<{ tag?: string; text?: string }>> }
      const b = v.title ?? ''
      const parts = (v.content ?? []).flatMap(row => row.filter(node => node.tag === 'text').map(node => node.text ?? ''))
      return b + parts.join('')
    } catch {
      return ''
    }
  }
  return ''
}

/**
 * Project a raw Feishu message item into a stable output shape (Go cleanMessageItem).
 *
 * @param item - One raw message item from the List Messages API.
 * @returns The projected item: ids, timestamps, sender, body content, and decoded text.
 */
export function cleanMessageItem(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof item.message_id === 'string') out.message_id = item.message_id
  if (typeof item.create_time === 'string') out.create_time = item.create_time
  const mt = typeof item.message_type === 'string' && item.message_type !== ''
    ? item.message_type
    : (typeof item.msg_type === 'string' ? item.msg_type : '')
  out.message_type = mt
  if (item.sender !== undefined && typeof item.sender === 'object') out.sender = item.sender
  let bodyContent = ''
  const body = item.body
  if (body !== undefined && typeof body === 'object' && typeof (body as Record<string, unknown>).content === 'string') {
    bodyContent = (body as Record<string, unknown>).content as string
  }
  out.body_content = bodyContent
  out.text = decodeMessageText(mt, bodyContent)
  return out
}

/**
 * Compare dotted versions numerically, ignoring v prefix and git suffixes; sign only.
 *
 * @param a - The left-hand version string.
 * @param b - The right-hand version string.
 * @returns Negative when a < b, positive when a > b, zero when equal.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersionTriple(a)
  const pb = parseVersionTriple(b)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x - y
  }
  return 0
}

function parseVersionTriple(v: string): [number, number, number] {
  const trimmed = v.trim().replace(/^v/, '')
  const bare = trimmed.split('-', 2)[0] ?? ''
  const parts = bare.split('.', 3)
  const out: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < 3 && i < parts.length; i++) {
    const n = Number.parseInt(parts[i] ?? '', 10)
    if (Number.isInteger(n)) out[i] = n
  }
  return out
}

/**
 * Extract the version from `lark-cli --version` output; throws on garbage.
 *
 * @param out - The raw stdout of a `lark-cli --version` run.
 * @returns The stripped version string (no `v` prefix).
 */
export function parseLarkCLIVersionOutput(out: string): string {
  let s = out.trim()
  if (s === '') throw new Error('empty --version output')
  s = s.replace(/^lark-cli version /, '')
  s = (s.split('\n', 2)[0] ?? '').trim()
  const v = s.replace(/^v/, '')
  const major = (v.split('-', 2)[0] ?? '').split('.', 3)
  if (major[0] === undefined || major[0] === '' || !Number.isInteger(Number.parseInt(major[0], 10))) {
    throw new Error(`unparseable --version output: ${JSON.stringify(s)}`)
  }
  return v
}

/**
 * Whether an installed lark-cli version satisfies {@link minLarkCLIVersion}.
 *
 * @param installed - The installed lark-cli version string.
 * @returns The upgrade error when the version is too old, undefined when satisfied.
 */
export function checkLarkCLIVersionAgainstMin(installed: string): Error | undefined {
  if (compareVersions(installed, minLarkCLIVersion) < 0) {
    return new Error(
      `lark-cli version ${installed} is older than required ${minLarkCLIVersion}.\n`
      + 'This version only supports a single app and ignores the injected\n'
      + 'credentials, causing bot calls for non-default projects to use the wrong app.\n'
      + 'Upgrade: npm i -g @larksuite/cli@latest',
    )
  }
  return undefined
}

// ── runner ────────────────────────────────────────────────────────────────

/** Refresh this many seconds before the server-declared expiry. */
const tatRefreshSkewSec = 60

/** Per-app cached tenant access token (server tokens live ~2h). */
const tatCache = new Map<string, { token: string; expiresAt: number }>()

/**
 * Mint (or reuse) a tenant access token with the project's bot credentials.
 * Tokens are cached per app id against the server-declared `expire`; a
 * response without `expire` declares no reusable lifetime and is never
 * cached.
 *
 * @param creds - The project's bot app id and secret.
 * @param deps - The injectable fetch surface used for the OpenAPI call.
 * @returns The tenant access token, valid until it expires server-side.
 */
export async function fetchTenantAccessToken(creds: LarkCreds, deps: LarkRunnerDeps, signal?: AbortSignal): Promise<string> {
  const cached = tatCache.get(creds.appId)
  if (cached !== undefined && Date.now() < cached.expiresAt) return cached.token
  const resp = await deps.fetch(`${feishuOpenBaseURL}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    // Caller signal when present; otherwise bound the bare mint like the
    // other bare fetches.
    ...(signal === undefined ? { signal: AbortSignal.timeout(larkTatTimeoutMs) } : { signal }),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
  })
  const result = await resp.json() as { code?: number; msg?: string; tenant_access_token?: string; expire?: number }
  if (result.code !== 0) throw new Error(`API error ${result.code}: ${result.msg ?? ''}`)
  if (result.tenant_access_token === undefined || result.tenant_access_token === '') {
    throw new Error('empty tenant_access_token in response')
  }
  if (typeof result.expire === 'number' && result.expire > tatRefreshSkewSec) {
    tatCache.set(creds.appId, {
      token: result.tenant_access_token,
      expiresAt: Date.now() + (result.expire - tatRefreshSkewSec) * 1000,
    })
  }
  return result.tenant_access_token
}

/**
 * Try to find a resource token in lark-cli's create-command JSON output.
 *
 * @param output - The raw stdout of a lark-cli create command.
 * @returns The first resource token field found, or '' when absent or the output is not JSON.
 */
export function extractResourceToken(output: string): string {
  let result: {
    data?: {
      doc_id?: string
      token?: string
      app_token?: string
      spread?: { token?: string }
      base?: { base_token?: string }
    }
  }
  try {
    result = JSON.parse(output) as typeof result
  } catch {
    return ''
  }
  const d = result.data ?? {}
  return d.doc_id ?? d.token ?? d.app_token ?? d.spread?.token ?? d.base?.base_token ?? ''
}

/**
 * Map a lark-cli resource command to the Feishu permission type.
 *
 * @param args - The lark-cli argument tokens; the first token names the resource command.
 * @returns The Feishu permission type (`docx`, `sheet`, `bitable`, `wiki`), or '' for unknown resources.
 */
export function extractResourceType(args: string[]): string {
  switch (args[0]) {
    case 'docs': return 'docx'
    case 'sheets': return 'sheet'
    case 'base': return 'bitable'
    case 'wiki': return 'wiki'
    default: return ''
  }
}

async function setOrgVisible(tat: string, token: string, resourceType: string, deps: LarkRunnerDeps): Promise<void> {
  const resp = await deps.fetch(`${feishuOpenBaseURL}/open-apis/drive/v1/permissions/${token}/public?type=${resourceType}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${tat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ share_entity: 'same_tenant' }),
  })
  const result = await resp.json() as { code?: number; msg?: string }
  if (result.code !== 0) throw new Error(`API error ${result.code}: ${result.msg ?? ''}`)
}

/** Whether args contain a resource creation command (`+create`). */
function isCreateCommand(args: string[]): boolean {
  return args.includes('+create')
}

/**
 * Run one lark-cli invocation with the project's bot credentials (Go runLark).
 * Returns the combined child output as the model-facing message; throws on
 * setup failures (missing lark-cli, version too old, token minting failure,
 * cross-project profile escape).
 *
 * @param creds - The project's bot credentials.
 * @param args - The lark-cli argument tokens the model passed in.
 * @param opts - Injectable runner deps, the optional dataDir backing the version cache, and the optional
 *  session work dir the child runs in (lark-cli skill guides express local-file arguments as `@./xxx`
 *  relative to the child's CWD).
 * @returns The combined child output (stdout, plus stderr when non-empty) as the model-facing message.
 */
export async function runLarkInvocation(
  creds: LarkCreds,
  args: string[],
  opts: { dataDir?: string; deps: LarkRunnerDeps; cwd?: string; signal?: AbortSignal },
): Promise<string> {
  if (args.length === 0) throw new Error('lark-cli: args must be a non-empty lark-cli subcommand')

  const deps = opts.deps
  const baseEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(deps.baseEnv ?? process.env)) {
    if (v !== undefined) baseEnv[k] = v
  }
  Object.assign(baseEnv, notifierSuppressionEnv)
  const childOpts = (env: Record<string, string>): { env: Record<string, string>; cwd?: string; signal?: AbortSignal } =>
    ({ env, ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }), ...(opts.signal === undefined ? {} : { signal: opts.signal }) })

  await checkLarkCLIVersion(opts.dataDir, deps, baseEnv)

  // Native chat-message listing: bypass lark-cli entirely.
  if (isChatMessagesList(args)) {
    return runChatMessagesListNative(args, creds, deps, opts.signal)
  }

  if (isAsUser(args) || isAuthSubcommand(args)) {
    // User mode: no LARKSUITE_CLI_* env — any APP_ID in env would flip
    // lark-cli into env-only mode and hide the stored user token. Prepend
    // --profile <app_id> so each project routes to its own stored user
    // credentials. An explicit --profile must match this project's bot
    // (security: it could otherwise point at another project's credentials).
    let childArgs = [...args]
    const supplied = extractProfileFlag(args)
    if (supplied !== '') {
      if (supplied !== creds.appId) {
        throw new Error(
          `--profile "${supplied}" does not match the current project (app_id ${creds.appId}).\n`
          + 'lark-cli does not allow --as user operations to cross project boundaries.\n'
          + 'If the current project is missing an authorized profile, run: lark auth login',
        )
      }
    } else {
      childArgs = ['--profile', creds.appId, ...args]
    }
    const child = await deps.spawn('lark-cli', childArgs, childOpts(sanitizedChildEnv(baseEnv)))
    return childOutput(child)
  }

  // Bot mode: mint a tenant access token and inject it.
  const tat = await fetchTenantAccessToken(creds, deps, opts.signal)
  const env: Record<string, string> = {
    ...sanitizedChildEnv(baseEnv),
    LARKSUITE_CLI_APP_ID: creds.appId,
    LARKSUITE_CLI_APP_SECRET: creds.appSecret,
    LARKSUITE_CLI_BRAND: 'feishu',
    LARKSUITE_CLI_TENANT_ACCESS_TOKEN: tat,
  }

  if (isCreateCommand(args)) {
    const child = await deps.spawn('lark-cli', args, childOpts(env))
    const output = childOutput(child)
    if (child.code === 0) {
      // Auto-grant org visibility after creation; a missing drive scope is
      // silently ignored (Go setOrgVisible failure path).
      const token = extractResourceToken(child.stdout)
      const resourceType = extractResourceType(args)
      if (token !== '' && resourceType !== '') {
        await setOrgVisible(tat, token, resourceType, deps).catch(() => undefined)
      }
    }
    return output
  }

  const child = await deps.spawn('lark-cli', args, childOpts(env))
  return childOutput(child)
}

/**
 * Build the child's base env: drop inherited LARKSUITE_CLI_* entries so
 * injected values fully own them. The notifier suppressions are ours and
 * always re-applied.
 */
function sanitizedChildEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('LARKSUITE_CLI_') && !(k in notifierSuppressionEnv)) continue
    out[k] = v
  }
  return out
}

function childOutput(child: LarkChildResult): string {
  const parts = [child.stdout.trim()]
  if (child.stderr.trim() !== '') parts.push(child.stderr.trim())
  const output = parts.filter(p => p !== '').join('\n')
  return output === '' ? `(lark-cli exited with code ${child.code})` : output
}

/** Version gate with an on-disk mtime cache (Go checkLarkCLIVersion); fail-open on probe issues. */
async function checkLarkCLIVersion(dataDir: string | undefined, deps: LarkRunnerDeps, baseEnv: Record<string, string>): Promise<void> {
  if (deps.stat === undefined || dataDir === undefined || dataDir === '') return
  const bin = lookPath('lark-cli')
  if (bin === '') throw new Error('lark-cli not found in PATH')
  let info: { mtimeMs: number } | undefined
  try {
    info = await deps.stat(bin)
  } catch {
    return // stat failed: skip the check (Go parity)
  }
  if (info === undefined) return
  const mtimeKey = String(info.mtimeMs)
  const cachePath = join(dataDir, 'lark-cli-version.cache')
  const cached = await readVersionCache(deps, cachePath, mtimeKey)
  if (cached !== undefined) {
    const err = checkLarkCLIVersionAgainstMin(cached)
    if (err !== undefined) throw err
    return
  }
  let installed: string
  try {
    const probe = await deps.spawn(bin, ['--version'], { env: sanitizedChildEnv(baseEnv) })
    installed = parseLarkCLIVersionOutput(probe.stdout)
  } catch {
    return // probe failed or unparseable: the gate must not block all lark calls
  }
  await writeVersionCache(deps, cachePath, mtimeKey, installed)
  const err = checkLarkCLIVersionAgainstMin(installed)
  if (err !== undefined) throw err
}

async function readVersionCache(deps: LarkRunnerDeps, cachePath: string, wantMtimeKey: string): Promise<string | undefined> {
  if (deps.readFile === undefined) return undefined
  try {
    const data = await deps.readFile(cachePath)
    if (data === undefined) return undefined
    const parts = data.trim().split('|', 2)
    if (parts.length !== 2 || parts[0] !== wantMtimeKey) return undefined
    return parts[1]
  } catch {
    return undefined
  }
}

async function writeVersionCache(deps: LarkRunnerDeps, cachePath: string, mtimeKey: string, version: string): Promise<void> {
  if (deps.writeFile === undefined) return
  try {
    await mkdir(dirname(cachePath), { recursive: true })
    await deps.writeFile(cachePath, `${mtimeKey}|${version}`)
  } catch {
    // cache write failure is never fatal; the next call re-probes
  }
}

/**
 * Resolve a binary through PATH (Go exec.LookPath).
 *
 * @param bin - The executable name to locate.
 * @returns The first executable candidate path, or '' when not found.
 */
export function lookPath(bin: string): string {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir === '') continue
    const candidate = join(dir, bin)
    try {
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // try the next PATH entry
    }
  }
  return ''
}

/** Native chat-message listing through the Feishu OpenAPI (Go runChatMessagesListNative). */
async function runChatMessagesListNative(args: string[], creds: LarkCreds, deps: LarkRunnerDeps, signal?: AbortSignal): Promise<string> {
  const { opts, error } = parseListMessagesArgs(args)
  if (error !== undefined) throw new Error(error)
  const tat = await fetchTenantAccessToken(creds, deps, signal)

  const allItems: Array<Record<string, unknown>> = []
  let pageToken = opts.pageToken
  let hasMore = false
  let pages = 0
  const maxPages = opts.pageAll ? opts.pageLimit : 1
  for (;;) {
    const resp = await deps.fetch(buildListMessagesURL(feishuOpenBaseURL, opts, pageToken), {
      headers: { Authorization: `Bearer ${tat}` },
      ...(signal === undefined ? {} : { signal }),
    })
    const payload = await resp.json() as {
      code?: number
      msg?: string
      data?: { items?: Array<Record<string, unknown>>; page_token?: string; has_more?: boolean }
    }
    if (payload.code !== 0) throw new Error(`Feishu API ${payload.code}: ${payload.msg ?? ''}`)
    allItems.push(...(payload.data?.items ?? []))
    hasMore = payload.data?.has_more === true
    pageToken = payload.data?.page_token ?? ''
    pages++
    if (!opts.pageAll || !hasMore || pages >= maxPages) break
  }

  if (opts.format === 'ndjson') {
    return allItems.map(item => JSON.stringify(cleanMessageItem(item))).join('\n')
  }
  const out = {
    items: allItems.map(item => cleanMessageItem(item)),
    has_more: hasMore,
    page_token: pageToken,
  }
  return JSON.stringify(out)
}

// ── tool registration ─────────────────────────────────────────────────────

/**
 * Register the `lark-cli` tool on `ctx.tools`.
 *
 * @param ctx - registrant context carrying the tool registry.
 * @param route - resolves the calling agent to its engine + credentials.
 * @param deps - injectable process/IO surface; defaults to real child_process + fetch.
 * @param dataDir - directory for the lark-cli version cache; omit to skip the version gate.
 * @returns the exact disposer that unregisters the tool.
 */
export function registerLarkTool(ctx: Context, route: LarkAgentRouter, deps?: LarkRunnerDeps, dataDir?: string): () => void {
  const runnerDeps: LarkRunnerDeps = deps ?? defaultLarkDeps()
  return ctx.tools.register(defineTool({
    name: 'lark-cli',
    description: DESCRIPTION,
    parameters: {
      args: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'lark-cli subcommand tokens passed through verbatim, e.g. ["docs","+search","--query","报告"].',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, enum: ['ok'] },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    timeoutMs: larkToolTimeoutMs,
    async execute(args, exec) {
      const target = route(exec.agent)
      if (target === undefined) {
        throw new Error('lark-cli: the calling session is not owned by a feishu-bridge project')
      }
      // lark-cli skill guides express local-file arguments as `@./xxx` relative
      // to the child's CWD — run the child in the session's work dir, the same
      // resolution base the send tool uses for relative attachment paths.
      const cwd = target.engine.sessionWorkDir(target.sessionKey)
      const message = await runLarkInvocation(target.creds, args.args, {
        deps: runnerDeps,
        ...(dataDir !== undefined ? { dataDir } : {}),
        ...(cwd !== '' ? { cwd } : {}),
        signal: exec.signal,
      })
      return { status: 'ok' as const, message }
    },
  }))
}

/**
 * Real child_process + fetch runner surface.
 *
 * @returns The deps that spawn real lark-cli children and call the real Feishu OpenAPI.
 */
export function defaultLarkDeps(): LarkRunnerDeps {
  const execFileAsync = promisify(execFile)
  return {
    async spawn(bin, argv, opts) {
      try {
        const r = (await execFileAsync(bin, argv, {
          env: opts.env,
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          ...(opts.signal === undefined ? {} : { signal: opts.signal }),
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
        })) as { stdout?: string; stderr?: string }
        return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: 0 }
      } catch (error) {
        const e = error as { stdout?: string; stderr?: string; code?: number; message?: string }
        if (e.stdout !== undefined || e.stderr !== undefined) {
          return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 }
        }
        // ENOENT and spawn failures surface as stderr text.
        return { stdout: '', stderr: e.message ?? String(error), code: 1 }
      }
    },
    fetch: (url, init) => fetch(url, init),
    stat: async (path) => {
      try {
        const s = await stat(path)
        return { mtimeMs: s.mtimeMs }
      } catch {
        return undefined
      }
    },
    readFile: async (path) => {
      try {
        return await readFile(path, 'utf8')
      } catch {
        return undefined
      }
    },
    writeFile: async (path, data) => {
      await writeFile(path, data, 'utf8')
    },
  }
}
