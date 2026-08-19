/**
 * Ported from cc-connect core/provider_test.go's GetProviderModel cases,
 * reshaped to the by-name lookup this plugin consumes: route detail (model)
 * lives on the assembly's provider table, not on the engine-facing
 * ProviderConfig, so wirePredictNext resolves the label by provider name.
 * GetProviderModels/SetProviderModel are not ported — their only consumer is
 * the /model command family, whose model-per-route detail stays in the
 * profile llm config in this plugin.
 *
 * @module dsh-feishu-bridge/tests-provider
 */

import { describe, expect, it } from 'vitest'
import { getProviderModel } from '../../src/engine/provider.js'

describe('getProviderModel', () => {
  const providers = [
    { name: 'openai', model: '' },
    { name: 'turbo', model: 'glm-5.3' },
  ]

  it('falls back for an unknown provider name', () => {
    expect(getProviderModel(providers, 'missing', 'default-model')).toBe('default-model')
  })

  it('falls back when the provider has no explicit model', () => {
    expect(getProviderModel(providers, 'openai', 'default-model')).toBe('default-model')
  })

  it('returns the provider model when set', () => {
    expect(getProviderModel(providers, 'turbo', 'default-model')).toBe('glm-5.3')
  })

  it('falls back on an empty provider table', () => {
    expect(getProviderModel([], 'openai', 'default-model')).toBe('default-model')
  })
})
