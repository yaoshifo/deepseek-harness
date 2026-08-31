/**
 * The process-wide registry of feature-state codecs. A codec owns one key of
 * `Session.featureState` — the opaque bag persisted under `featureState` in
 * the version-3 sessions.json snapshot: it projects its section on save and
 * declares which parts of it survive a conversation reset (`/new`, idle
 * reset) by carrying them itself. The registry is module-level (not a cordis
 * service) because Session and SessionManager are non-cordis classes; the
 * registering plugin's apply wires its codec per process and reverses the
 * registration through ctx.effect.
 *
 * @module dsh-feishu-bridge/feature-state
 */

import type { Session } from './session.ts'

/**
 * Owner of one `featureState` key: how the section persists and which part
 * of it survives a conversation reset.
 */
export interface FeatureStateCodec {
  /** The featureState key this codec owns (one codec per key). */
  readonly key: string
  /**
   * Project the codec's section for serialization; undefined means nothing
   * is persisted under the key and the key is omitted from the snapshot.
   * @param session - The session whose feature state is being saved.
   * @returns the JSON-safe section value, or undefined when empty.
   */
  encode(session: Session): unknown
  /**
   * Carry the reset-surviving subset of the section from the replaced record
   * onto its successor (called at the end of carryChatScopedState).
   * @param from - The previous active record for the same chat key.
   * @param to - The fresh record adopting the chat-scoped state.
   */
  carry(from: Session, to: Session): void
}

/**
 * Live registrations, one entry per registerFeatureStateCodec call (the same
 * codec object may appear several times). Cordis HMR reload re-runs apply
 * before the old fiber's disposers drain, and tests mount the plugin on
 * several contexts at once: both re-register the SAME codec object, so the
 * codec stays registered until every registration is disposed (a different
 * codec object under the same key stays an error).
 *
 * Process-global on purpose: the package ships as two self-contained
 * bundles (lib/index.js and the ./exports face, lib/exports.js), each with
 * its own copy of this module — a module-level array would split into two
 * registries, and a sibling plugin registering through ./exports would be
 * invisible to the engine's snapshot/carry consultations.
 */
const registrations: FeatureStateCodec[] =
  ((globalThis as { __DSH_FEISHU_CODECS__?: FeatureStateCodec[] }).__DSH_FEISHU_CODECS__ ??= [])

/**
 * Register a feature-state codec; the bridge consults the registry on every
 * save and conversation reset.
 * @param codec - The codec to register; another codec object already holding
 * the same key throws (a second registration of the same object is the
 * reload/multi-app case and is reference-counted).
 * @returns Disposer removing one registration of the codec.
 */
export function registerFeatureStateCodec(codec: FeatureStateCodec): () => void {
  if (registrations.some(registered => registered.key === codec.key && registered !== codec)) {
    throw new Error(`feature-state: codec key '${codec.key}' is already registered`)
  }
  registrations.push(codec)
  return () => {
    const index = registrations.lastIndexOf(codec)
    if (index < 0) return
    registrations.splice(index, 1)
  }
}

/**
 * The registered codecs, in first-registration order (repeated registration
 * of one codec object lists it once).
 *
 * @returns a read-only view of the codec registry.
 */
export function featureStateCodecs(): readonly FeatureStateCodec[] {
  const seen = new Set<string>()
  const unique: FeatureStateCodec[] = []
  for (const codec of registrations) {
    if (seen.has(codec.key)) continue
    seen.add(codec.key)
    unique.push(codec)
  }
  return unique
}
