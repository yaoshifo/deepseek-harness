/**
 * ProjectStateStore's durable-file parse boundary: a hand-corrupted state
 * file holding legal-but-wrong JSON (null, an array, a bare primitive) must
 * fall back to empty state instead of poisoning every accessor with a
 * TypeError at plugin load.
 *
 * @module dsh-feishu-bridge/tests-project-state-shape
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProjectStateStore } from '../../src/engine/project-state.ts'

describe('ProjectStateStore corrupt-shape fallback', () => {
  it.each(['null', '[]', '"text"', '123'])('a %s file loads as empty state', (raw) => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-pstate-shape-'))
    const path = join(dir, 'test.state.json')
    writeFileSync(path, raw, 'utf8')
    const s = new ProjectStateStore(path)
    expect(s.workspaceDirOverride('k')).toBe('')
  })
})

describe('ProjectStateStore provider overrides', () => {
  function newStore(): { s: ProjectStateStore; path: string } {
    const dir = mkdtempSync(join(tmpdir(), 'fb-pstate-prov-'))
    const path = join(dir, 'test.state.json')
    return { s: new ProjectStateStore(path), path }
  }

  it('round-trips per-chat overrides through save and reload', () => {
    const { s, path } = newStore()
    s.setProviderOverride('feishu:oc_a', 'turbo')
    s.setProviderOverride('feishu:oc_b', 'glm')
    s.save()

    const reloaded = new ProjectStateStore(path)
    expect(reloaded.providerOverrides()).toEqual({ 'feishu:oc_a': 'turbo', 'feishu:oc_b': 'glm' })
  })

  it('clearing an override removes the entry; the map drops once empty', () => {
    const { s, path } = newStore()
    s.setProviderOverride('feishu:oc_a', 'turbo')
    s.setProviderOverride('feishu:oc_a', '')
    s.save()

    const reloaded = new ProjectStateStore(path)
    expect(reloaded.providerOverrides()).toEqual({})
  })
})

describe('ProjectStateStore cleared-native-children tombstones', () => {
  function newStore(): { s: ProjectStateStore; path: string } {
    const dir = mkdtempSync(join(tmpdir(), 'fb-pstate-tomb-'))
    const path = join(dir, 'test.state.json')
    return { s: new ProjectStateStore(path), path }
  }

  it('round-trips cleared child ids through save and reload', () => {
    const { s, path } = newStore()
    s.markNativeChildCleared('child-1')
    s.markNativeChildCleared('child-2')
    s.save()

    const reloaded = new ProjectStateStore(path)
    expect(reloaded.nativeChildCleared('child-1')).toBe(true)
    expect(reloaded.nativeChildCleared('child-2')).toBe(true)
    expect(reloaded.nativeChildCleared('child-3')).toBe(false)
  })

  it('caps the tombstone set at 512 ids, evicting the oldest first', () => {
    const { s } = newStore()
    for (let i = 0; i < 600; i++) s.markNativeChildCleared(`c-${i}`)
    expect(s.nativeChildCleared('c-0')).toBe(false)
    expect(s.nativeChildCleared('c-87')).toBe(false)
    expect(s.nativeChildCleared('c-88')).toBe(true)
    expect(s.nativeChildCleared('c-599')).toBe(true)
  })
})
