/**
 * Host-plane suppression registry for workspace-instruction injection.
 *
 * The agent-instructions plugin itself stays serviceless so a preset row can
 * mount it without publishing a process-global service (the agent-presets
 * mount rule); suppression state lives here instead, on a service the host
 * composition mounts beside the plugin. Compositions that never replace a
 * persona wholesale need not mount it — the plugin treats a missing registry
 * as "nothing suppressed".
 *
 * @module @deepseek-ai/dsh-agent-instructions/suppression
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AnonymousEntries, ScopedLayers } from '@deepseek-ai/dsh-scope'
import type { ScopeLayer } from '@deepseek-ai/dsh-scope'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Scoped suppression registry for workspace-instruction injection. */
    agentInstructionSuppression: AgentInstructionSuppression
  }
}

/** One scope's aggregate suppression markers for {@link AgentInstructionSuppression.suppress}. */
interface SuppressionLayer extends ScopeLayer {
  /** Independently disposable suppression registrations; any nonempty set suppresses. */
  readonly suppressors: AnonymousEntries<true>
}

function createSuppressionLayer(): SuppressionLayer {
  const suppressors = new AnonymousEntries<true>()
  return { suppressors, isEmpty: () => suppressors.isEmpty() }
}

/**
 * Registry of scoped suppression markers for workspace-instruction injection.
 * Registering on a service (rather than on the plugin body) exposes the scoped
 * {@link suppress} seam: consumers composing a wholesale-replacement persona call it
 * in their agent setup so the instruction channel stays silent for that agent.
 */
export default class AgentInstructionSuppression extends Service {
  private readonly suppressions = new ScopedLayers<SuppressionLayer>(createSuppressionLayer, () => {})

  constructor(ctx: Context) {
    super(ctx, 'agentInstructionSuppression')
  }

  /**
   * Suppress every workspace-instruction contribution for the calling context's
   * scope: no baseline is composed and filesystem touches inject no dynamic
   * updates, and any pending workspace context is dropped from the inbox.
   * Registrations compose; disposing every returned effect restores injection.
   * The check walks the agent's scope chain, so a marker registered by an
   * enclosing scope also suppresses its descendant agents.
   * @returns the exact Cordis effect disposer.
   */
  suppress(): () => void {
    return this.suppressions.effect(
      this.ctx,
      layer => layer.suppressors.append(true),
      { label: 'agentInstructionSuppression.suppress()', notify: false },
    )
  }

  /**
   * Whether any suppression marker covers this agent: the global layer or any
   * layer along the agent's scope chain.
   * @param agent - the agent whose scope chain is inspected.
   * @returns whether workspace-instruction injection is suppressed for it.
   */
  suppressedFor(agent: Agent): boolean {
    return !this.suppressions.global.suppressors.isEmpty()
      || this.suppressions.chainLayers(agent).some(layer => !layer.suppressors.isEmpty())
  }
}
