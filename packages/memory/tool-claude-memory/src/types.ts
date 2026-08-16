/**
 * Type-only declarations for the Claude Code memory compatibility plugin.
 *
 * @module @deepseek-ai/dsh-tool-claude-memory
 */

/** Durable source marker carried by the injected memory-index message. */
export interface ClaudeMemorySource {
  kind: 'claude-memory'
  /** Source-marker version; structural changes to this shape bump it. */
  version: 1
  /** The Claude Code project slug the injected index belongs to. */
  project: string
  /** SHA-1 over the injected index text, before framing or escaping. */
  digest: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'claude-memory': ClaudeMemorySource
  }
}
