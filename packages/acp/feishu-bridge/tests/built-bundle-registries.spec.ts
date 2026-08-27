/**
 * The cross-bundle singleton contract for the bridge's process-global
 * registries: the package ships as two self-contained bundles (the plugin
 * entry, lib/index.js, and the ./exports sibling-plugin face,
 * lib/exports.js), each carrying its own copy of the registry modules. A
 * sibling plugin registers codecs, message subtables, and tool families
 * through the exports face while the engine consumes them through its own
 * bundle copy — so the registry state must live on globalThis, or the two
 * copies silently split (the 2026-08-27 raw-i18n-key live incident).
 *
 * Self-skips on a clean tree without built artifacts; CI runs it after
 * build.
 *
 * @module dsh-feishu-bridge/tests-built-bundle-registries
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const pkgRoot = fileURLToPath(new URL('..', import.meta.url))
const pluginBundle = `${pkgRoot}lib/index.js`
const exportsBundle = `${pkgRoot}lib/exports.js`

const probe = String.raw`
const g = globalThis
const exp = await import(${JSON.stringify(exportsBundle)})
const disposeMessages = exp.registerMessages({ zh: { probe_key: '探针' }, en: { probe_key: 'probe' } })
const disposeCodec = exp.registerFeatureStateCodec({ key: 'probe', encode: () => undefined, carry: () => {} })
const disposeFamily = exp.declareToolFamily('probe_tool', 'agent')
const report = {
  messagesRegistered: g.__DSH_FEISHU_I18N_SUBTABLES__?.length === 1,
  codecRegistered: g.__DSH_FEISHU_CODECS__?.length === 1,
  familyRegistered: g.__DSH_FEISHU_TOOL_FAMILIES__?.get('probe_tool') === 'agent',
  lookupResolves: exp.lookupMessage('zh', 'probe_key') === '探针',
}
disposeMessages(); disposeCodec(); disposeFamily()
report.disposed = g.__DSH_FEISHU_I18N_SUBTABLES__?.length === 0
  && g.__DSH_FEISHU_CODECS__?.length === 0
  && !g.__DSH_FEISHU_TOOL_FAMILIES__?.has('probe_tool')
console.log(JSON.stringify(report))
`

describe.skipIf(!existsSync(exportsBundle) || !existsSync(pluginBundle))('built-bundle registries', () => {
  it('registrations through the exports face land on the shared process globals', async () => {
    const { stdout } = await execFileAsync('node', ['--input-type=module', '-e', probe])
    expect(JSON.parse(stdout)).toEqual({
      messagesRegistered: true,
      codecRegistered: true,
      familyRegistered: true,
      lookupResolves: true,
      disposed: true,
    })
  })

  it('both bundles read the same global slots (no module-level registry split)', () => {
    // The plugin bundle exports no registry query; its copies must at least
    // reference the global slots their registry code reads. A copy that
    // regressed to a module-level array would lose the reference.
    for (const key of ['__DSH_FEISHU_I18N_SUBTABLES__', '__DSH_FEISHU_CODECS__', '__DSH_FEISHU_TOOL_FAMILIES__']) {
      expect(readFileSync(pluginBundle, 'utf8'), `plugin bundle references ${key}`).toContain(key)
      expect(readFileSync(exportsBundle, 'utf8'), `exports bundle references ${key}`).toContain(key)
    }
  })
})
