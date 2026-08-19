/**
 * Provider helpers ported from cc-connect core/provider.go. Only
 * {@link getProviderModel} survives the port: it feeds the predict-next
 * label, resolving the model configured for a named provider route.
 * GetProviderModels/SetProviderModel are not ported — their consumer is the
 * /model command family, whose model-per-route detail stays in the profile
 * llm config in this plugin (MIGRATION.md D2).
 *
 * @module dsh-feishu-bridge/provider
 */

/** A provider table row carrying an optional model (the assembly's route table). */
export interface ProviderModelRow {
  name: string
  model?: string
}

/**
 * The model configured for the named provider, or the fallback when the
 * provider is unknown or carries no explicit model (Go GetProviderModel).
 *
 * @param providers - The provider table (assembly routes).
 * @param name - The provider name to look up.
 * @param fallback - Model used when the row has none.
 * @returns the resolved model name.
 */
export function getProviderModel(providers: readonly ProviderModelRow[], name: string, fallback: string): string {
  for (const p of providers) {
    if (p.name === name && p.model !== undefined && p.model !== '') return p.model
  }
  return fallback
}
