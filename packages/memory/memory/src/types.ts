/**
 * Type-only declarations for the Claude Code memory compatibility plugin.
 *
 * @module @deepseek-ai/dsh-memory
 */

/**
 * Durable source marker carried by the injected memory-index message. The
 * marker is scope-aware since version 2: a project injection names its slug,
 * a global injection omits the slug and flags the cross-project scope.
 */
export interface DshMemorySource {
  kind: 'dsh-memory'
  /** Source-marker version; structural changes to this shape bump it. */
  version: 2
  /** Which memory directory the injected index was read from. */
  scope: 'project' | 'global'
  /** The Claude Code project slug the injected index belongs to; present only for project scope. */
  project?: string
  /** SHA-1 over the injected index text, before framing or escaping. */
  digest: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-memory': DshMemorySource
  }
}
