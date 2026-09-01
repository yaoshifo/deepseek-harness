/**
 * Session-visible workspace instruction state and dynamic reconciliation.
 *
 * @module @deepseek-ai/dsh-agent-instructions/state
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type { FileSystem, FsVersion } from '@deepseek-ai/dsh-fs'
import { resolve } from 'node:path'
import type { ResolvedConfig } from './config.ts'
import { instructionContentSha1, trimmedInstructionDigest } from './digest.ts'
import {
  ancestorChain,
  descendantDirsBetween,
  findProjectRoot,
  probeScopeInstruction,
  readScopeInstruction,
  relativeDisplay,
  type LoadedInstructionFile,
} from './files.ts'
import {
  candidateScopeKey,
  decodeScopeKey,
  instructionScopeKey,
  renderInstructionChanges,
  USER_GLOBAL_DIRECTORY,
  USER_GLOBAL_FILE,
  type ChangeRenderItem,
  type AgentInstructionChange,
} from './render.ts'

export const name = 'agent-instructions'

/** Durable producer, file, and reconciliation facts for one workspace context. */
export interface AgentInstructionSource {
  kind: 'agent-instructions'
  /** Every workspace context carries instructions read out of a file (the `instructions` context form). */
  form: 'instructions'
  /** Marks the complete startup/resume baseline rather than a later delta. */
  baseline?: true
  /** Discovery, precedence, and budget identity used to validate a resumed baseline. */
  baselineIdentity?: string
  changes: AgentInstructionChange[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'agent-instructions': AgentInstructionSource
  }
}

/** Per-scope metadata cache; instruction prose is deliberately not retained. */
export interface InstructionVersionState {
  path: string
  version: FsVersion
  digest: string
  /**
   * Trimmed-content identity ({@link trimmedInstructionDigest}) used to suppress
   * per-directory duplicates on the metadata fast path without re-reading a sibling.
   */
  trimmedDigest: string
  /**
   * Absolute paths of every imported file inlined into this scope's expanded
   * content. A touch of any of them must force a re-read even when the scope
   * file itself is unchanged, because its rendered content changed.
   */
  imports?: string[]
}

/** Session-isolated fast-path state keyed by logical instruction scope. */
export type InstructionVersionCache = WeakMap<Session, Map<string, InstructionVersionState>>

/** A metadata-cache transition associated with one rendered instruction change. */
export interface InstructionVersionUpdate {
  change: AgentInstructionChange
  state?: InstructionVersionState
}

/** Rendered reconciliation plus its metadata-cache transitions. */
export interface ReconciledInstructionContext {
  context: UserMessage
  versionUpdates: InstructionVersionUpdate[]
}

function workspaceContextHook(text: string, changes: AgentInstructionChange[]): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'agent-instructions', form: 'instructions', changes },
  })
}

/**
 * Build the user-role message for a rendered baseline.
 * @param text - complete plugin-owned system-reminder text.
 * @returns a user-role prefix message.
 */
export function workspaceContextMessage(text: string): Message {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: name },
  })
}

function isWorkspaceContextSource(
  source: unknown,
): source is { kind: 'agent-instructions'; changes: unknown[] } {
  return typeof source === 'object' && source !== null
    && 'kind' in source && source.kind === 'agent-instructions'
    && 'changes' in source && Array.isArray(source.changes)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function workspaceInstructionChanges(source: { changes: unknown[] }): AgentInstructionChange[] {
  const changes: AgentInstructionChange[] = []
  for (const value of source.changes) {
    if (!isRecord(value)) continue
    if (value.action !== 'set' && value.action !== 'replace' && value.action !== 'remove') continue
    if (typeof value.scope !== 'string' || typeof value.path !== 'string') continue
    if (value.digest !== undefined && typeof value.digest !== 'string') continue
    changes.push({
      action: value.action,
      scope: value.scope,
      path: value.path,
      ...value.digest !== undefined ? { digest: value.digest } : {},
    })
  }
  return changes
}

function sameInstructionChange(a: AgentInstructionChange, b: AgentInstructionChange): boolean {
  return a.action === b.action
    && a.scope === b.scope
    && a.path === b.path
    && a.digest === b.digest
}

function visibleInstructionChanges(
  agent: Agent,
  authorityMessages: readonly UserMessage[],
): Map<string, AgentInstructionChange> {
  const visibleSeqs = new Set(agent.session.surface.nodes)
  const visible = new Map<string, AgentInstructionChange>()
  for (const [seq, event] of agent.session.events.entries()) {
    if (event.type !== 'user/message' || !isWorkspaceContextSource(event.data.source)) continue
    const changes = workspaceInstructionChanges(event.data.source)
    for (const change of changes) {
      if (visibleSeqs.has(seq)) visible.set(change.scope, change)
    }
  }
  for (const message of authorityMessages) {
    if (!isWorkspaceContextSource(message.source)) continue
    for (const change of workspaceInstructionChanges(message.source)) {
      visible.set(change.scope, change)
    }
  }
  return visible
}

/**
 * Convert retained baseline files into comparison and metadata-cache state.
 * @param files - baseline files that survived rendering.
 * @returns latest baseline changes and provider versions keyed by logical scope.
 */
export function baselineInstructionState(files: LoadedInstructionFile[]): {
  changes: Map<string, AgentInstructionChange>
  versions: Map<string, InstructionVersionState>
} {
  const changes = new Map<string, AgentInstructionChange>()
  const versions = new Map<string, InstructionVersionState>()
  for (const file of files) {
    const digest = instructionContentSha1(file.content)
    const change: AgentInstructionChange = {
      action: 'set',
      scope: instructionScopeKey(file.displayPath),
      path: file.displayPath,
      digest,
    }
    changes.set(change.scope, change)
    if (file.version !== undefined) {
      versions.set(change.scope, {
        path: file.displayPath,
        version: file.version,
        digest,
        trimmedDigest: trimmedInstructionDigest(file.content),
        ...file.imports === undefined || file.imports.length === 0 ? {} : { imports: file.imports },
      })
    }
  }
  return { changes, versions }
}

function versionStatesFor(session: Session, cache: InstructionVersionCache): Map<string, InstructionVersionState> {
  let states = cache.get(session)
  if (states === undefined) {
    states = new Map()
    cache.set(session, states)
  }
  return states
}

/**
 * Keep only cache updates represented by rendered changes.
 * @param updates - proposed updates from one or more reconciliations.
 * @param renderedChanges - transitions retained by the renderer.
 * @returns updates represented by an exact retained transition.
 */
export function retainedInstructionVersionUpdates(
  updates: readonly InstructionVersionUpdate[],
  renderedChanges: readonly AgentInstructionChange[],
): InstructionVersionUpdate[] {
  return updates.filter(update => renderedChanges.some(change => sameInstructionChange(update.change, change)))
}

/**
 * Apply metadata-cache transitions without retaining instruction prose.
 * @param session - owning session.
 * @param updates - ordered set/delete transitions.
 * @param cache - session-isolated metadata cache.
 */
export function applyInstructionVersionUpdates(
  session: Session,
  updates: readonly InstructionVersionUpdate[],
  cache: InstructionVersionCache,
): void {
  if (updates.length === 0) return
  const states = versionStatesFor(session, cache)
  for (const update of updates) {
    if (update.state === undefined) states.delete(update.change.scope)
    else states.set(update.change.scope, update.state)
  }
  if (states.size === 0) cache.delete(session)
}

function relativeScope(projectRoot: string, dir: string): string {
  const scope = relativeDisplay(projectRoot, dir)
  return scope.length === 0 ? '.' : scope
}

/**
 * Compare visible state with provider-visible files and render transitions.
 * @param agent - session owner whose visible surface supplies durable state.
 * @param resolved - normalized plugin configuration.
 * @param versionCache - per-session scope metadata used to skip unchanged reads.
 * @param fileSystem - provider used for current file probes.
 * @param options - authoritative claimed context, pending scope hints, touched paths, and baseline participation.
 * @returns rendered context plus deferred cache updates, or undefined when unchanged/unavailable.
 */
export async function reconcileInstructionContext(
  agent: Agent,
  resolved: ResolvedConfig,
  versionCache: InstructionVersionCache,
  fileSystem: FileSystem,
  options: {
    authorityMessages: readonly UserMessage[]
    scopeMessages: readonly UserMessage[]
    touchedPaths: readonly string[]
    includeBaselineScopes: boolean
    excludedBaselineScopes?: ReadonlySet<string>
    projectRoot?: string
    signal?: AbortSignal
  },
): Promise<ReconciledInstructionContext | undefined> {
  const session = agent.session
  const effective = visibleInstructionChanges(agent, options.authorityMessages)
  /* v8 ignore next -- normal agents carry an absolute session cwd. */
  const cwd = session.header.cwd ?? process.cwd()
  // TODO(frozen-project-root): retain the baseline root for the loop instance;
  // recomputing it after marker edits reinterprets the existing relative scope keys.
  const projectRoot = options.projectRoot
    ?? await findProjectRoot(cwd, resolved.projectRootMarkers, fileSystem, options.signal)
  const scopes = new Set<string>()
  const baselineScopes = new Set<string>()
  const addDirScopes = (target: Set<string>, directory: string): void => {
    for (const candidate of resolved.instructionFileCandidates) target.add(candidateScopeKey(directory, candidate))
    for (const candidate of resolved.localInstructionFileCandidates) target.add(candidateScopeKey(directory, candidate))
  }
  const addProjectScopes = (target: Set<string>, dir: string): void => {
    addDirScopes(target, relativeScope(projectRoot, dir))
  }
  baselineScopes.add(candidateScopeKey(USER_GLOBAL_DIRECTORY, USER_GLOBAL_FILE))
  for (const dir of ancestorChain(projectRoot, cwd)) addProjectScopes(baselineScopes, dir)
  if (options.includeBaselineScopes) {
    for (const scope of baselineScopes) scopes.add(scope)
  }
  for (const message of options.scopeMessages) {
    /* v8 ignore next -- the plugin passes its workspace-only pending projection. */
    if (!isWorkspaceContextSource(message.source)) continue
    for (const change of workspaceInstructionChanges(message.source)) {
      if (!options.includeBaselineScopes && baselineScopes.has(change.scope)) continue
      scopes.add(change.scope)
    }
  }
  for (const scope of effective.keys()) {
    if (!options.includeBaselineScopes && baselineScopes.has(scope)) continue
    const { directory } = decodeScopeKey(scope)
    if (directory === USER_GLOBAL_DIRECTORY) scopes.add(candidateScopeKey(USER_GLOBAL_DIRECTORY, USER_GLOBAL_FILE))
    else addDirScopes(scopes, directory)
  }
  for (const touchedPath of options.touchedPaths) {
    for (const dir of descendantDirsBetween(cwd, touchedPath)) addProjectScopes(scopes, dir)
  }

  const versions = versionStatesFor(session, versionCache)
  // A touched path that an expanded scope imported is not a candidate file in
  // any directory, so it reaches its owning scope through the version cache's
  // import records instead of directory discovery.
  const touchedImportPaths = new Set(options.touchedPaths.map(touchedPath => resolve(cwd, touchedPath)))
  const importsTouched = (state: InstructionVersionState): boolean =>
    state.imports !== undefined && state.imports.some(importPath => touchedImportPaths.has(importPath))
  if (touchedImportPaths.size > 0) {
    for (const [scope, state] of versions) {
      if (importsTouched(state)) scopes.add(scope)
    }
  }
  const seenAbsolutePaths = new Set<string>()
  // Per-directory trimmed-content identities kept so far this pass, iterated in
  // candidate order (base before local); a later sibling matching an earlier one
  // is a duplicate and is dropped or removed rather than rendered twice.
  const keptTrimmedByDir = new Map<string, Set<string>>()
  const registerKeptTrimmed = (directory: string, digest: string): boolean => {
    let digests = keptTrimmedByDir.get(directory)
    if (digests === undefined) {
      digests = new Set()
      keptTrimmedByDir.set(directory, digests)
    }
    if (digests.has(digest)) return true
    digests.add(digest)
    return false
  }
  const items: ChangeRenderItem[] = []
  const versionUpdates: InstructionVersionUpdate[] = []
  const pushRemoval = (scope: string, path: string): void => {
    const change: AgentInstructionChange = { action: 'remove', scope, path }
    items.push({ change, file: { absolutePath: `removed:${scope}`, displayPath: path, content: '' } })
    versionUpdates.push({ change })
  }
  // Drop a scope without loading it: remove any rendered copy, else forget stale metadata.
  const suppressScope = (scope: string): void => {
    const previous = effective.get(scope)
    if (previous === undefined || previous.action === 'remove') versions.delete(scope)
    else pushRemoval(scope, previous.path)
  }
  const scopesByDirectory = new Map<string, string[]>()
  for (const scope of scopes) {
    const { directory } = decodeScopeKey(scope)
    const directoryScopes = scopesByDirectory.get(directory)
    if (directoryScopes === undefined) scopesByDirectory.set(directory, [scope])
    else directoryScopes.push(scope)
  }
  const firstExisting = resolved.candidateSelection === 'first-existing'
  type CandidateSlot = 'base' | 'local'
  // A candidate name resolves to its earliest configured list, so a name
  // carried by both lists occupies the base slot.
  const candidateSlot = (scope: string): { slot: CandidateSlot; index: number } => {
    const { candidateName } = decodeScopeKey(scope)
    const baseIndex = resolved.instructionFileCandidates.indexOf(candidateName)
    if (baseIndex >= 0) return { slot: 'base', index: baseIndex }
    return { slot: 'local', index: resolved.localInstructionFileCandidates.indexOf(candidateName) }
  }
  for (const [directory, directoryScopes] of scopesByDirectory) {
    // first-existing needs deterministic candidate order to pick and re-pick the
    // winning sibling; all-existing keeps the insertion order it dedups on today.
    const orderedScopes = firstExisting
      ? [...directoryScopes].sort((left, right) => {
        const a = candidateSlot(left)
        const b = candidateSlot(right)
        if (a.slot !== b.slot) return a.slot === 'base' ? -1 : 1
        return (a.index < 0 ? Number.MAX_SAFE_INTEGER : a.index) - (b.index < 0 ? Number.MAX_SAFE_INTEGER : b.index)
      })
      : directoryScopes
    const probedScopes: string[] = []
    for (const scope of orderedScopes) {
      // first-existing skips this optimization: a baseline-excluded winner still
      // holds its list's slot, and probing it keeps the winner decision current
      // when the excluded-scope cache predates this pass.
      if (options.excludedBaselineScopes !== undefined
        && !firstExisting
        && baselineScopes.has(scope)
        && options.excludedBaselineScopes.has(scope)) {
        suppressScope(scope)
      } else {
        probedScopes.push(scope)
      }
    }
    const itemStart = items.length
    const versionUpdateStart = versionUpdates.length
    const addedAbsolutePaths: string[] = []
    const priorVersions = new Map(probedScopes.map(scope => [scope, versions.get(scope)]))
    const winnerHeld: Record<CandidateSlot, boolean> = { base: false, local: false }
    for (const scope of probedScopes) {
      const previous = effective.get(scope)
      const slot = firstExisting ? candidateSlot(scope) : undefined
      if (slot !== undefined && winnerHeld[slot.slot]) {
        // A later candidate of a list whose winner was already found this pass:
        // suppress it regardless of content, removing any rendered copy.
        suppressScope(scope)
        continue
      }
      const probe = await probeScopeInstruction(scope, projectRoot, resolved, fileSystem, options.signal)
      if (probe.kind === 'unavailable') {
        if (previous === undefined || previous.action === 'remove') continue
        // Same-directory candidates form one deduplicated authority group. If an
        // active member cannot be observed, preserve the entire last-good group;
        // cache warmth must never decide whether a sibling transition is emitted.
        items.splice(itemStart)
        versionUpdates.splice(versionUpdateStart)
        for (const [candidateScope, prior] of priorVersions) {
          if (prior === undefined) versions.delete(candidateScope)
          else versions.set(candidateScope, prior)
        }
        for (const absolutePath of addedAbsolutePaths) seenAbsolutePaths.delete(absolutePath)
        keptTrimmedByDir.delete(directory)
        break
      }
      if (probe.kind === 'absent') {
        suppressScope(scope)
        continue
      }
      const { file: probedFile } = probe
      // A present probe wins its list even when the content read later fails.
      if (slot !== undefined) winnerHeld[slot.slot] = true
      if (seenAbsolutePaths.has(probedFile.absolutePath)) continue
      seenAbsolutePaths.add(probedFile.absolutePath)
      addedAbsolutePaths.push(probedFile.absolutePath)
      const cached = versions.get(scope)
      if (
        cached !== undefined
        && cached.path === probedFile.displayPath
        && cached.version === probedFile.version
        // An unchanged scope file with a touched import still re-renders: its
        // expanded content changed even though its own bytes did not.
        && !importsTouched(cached)
        && previous !== undefined
        && previous.action !== 'remove'
        && previous.path === cached.path
        && previous.digest === cached.digest
      ) {
        // Unchanged and previously rendered: keep it, but an earlier sibling that
        // now matches its trimmed content makes this the duplicate to remove.
        if (registerKeptTrimmed(directory, cached.trimmedDigest)) pushRemoval(scope, previous.path)
        continue
      }

      const file = await readScopeInstruction(probedFile, resolved.maxSourceBytes, fileSystem, options.signal)
      if (file === undefined) continue
      const currentDigest = instructionContentSha1(file.content)
      const trimmedDigest = trimmedInstructionDigest(file.content)
      if (registerKeptTrimmed(directory, trimmedDigest)) {
        // A distinct file whose trimmed content already appeared earlier in this
        // directory: drop it, removing any copy that was previously rendered.
        if (previous !== undefined && previous.action !== 'remove') pushRemoval(scope, previous.path)
        else versions.delete(scope)
        continue
      }
      const nextVersion: InstructionVersionState = {
        path: file.displayPath,
        version: probedFile.version,
        digest: currentDigest,
        trimmedDigest,
        ...file.imports === undefined || file.imports.length === 0 ? {} : { imports: file.imports },
      }
      if (previous !== undefined && previous.action !== 'remove' && previous.path === file.displayPath && previous.digest === currentDigest) {
        versions.set(scope, nextVersion)
        continue
      }
      const action = previous === undefined || previous.action === 'remove' ? 'set' : 'replace'
      const change: AgentInstructionChange = {
        action,
        scope,
        path: file.displayPath,
        digest: currentDigest,
      }
      items.push({ change, file })
      versionUpdates.push({ change, state: nextVersion })
    }
  }
  if (items.length === 0) return undefined
  const rendered = renderInstructionChanges(items, resolved.maxBytes)
  // When no transition survived rendering (tiny budgets render notice-only
  // text), emit nothing and commit nothing — the uncommitted versions make the
  // next pass retry instead of spamming notice-only contexts.
  if (rendered.text.length === 0 || rendered.changes.length === 0) return undefined
  return {
    context: workspaceContextHook(rendered.text, rendered.changes),
    versionUpdates: retainedInstructionVersionUpdates(versionUpdates, rendered.changes),
  }
}
