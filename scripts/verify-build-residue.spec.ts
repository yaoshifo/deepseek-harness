import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectBuildResidue, pruneBuildResidue } from './verify-build-residue.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('build residue gate', () => {
  it('flags tsc outputs whose source file is gone', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-build-residue-'))
    roots.push(root)
    const pkg = join(root, 'packages/core/agent')
    mkdirSync(join(pkg, 'src'), { recursive: true })
    mkdirSync(join(pkg, 'lib/types'), { recursive: true })
    writeFileSync(join(pkg, 'src/live.ts'), 'export {}\n')
    writeFileSync(join(pkg, 'lib/types/live.js'), '')
    writeFileSync(join(pkg, 'lib/types/gone.js'), '')
    writeFileSync(join(pkg, 'lib/types/gone.d.ts'), '')

    expect(collectBuildResidue(root)).toEqual([
      'packages/core/agent/lib/types/gone.d.ts',
      'packages/core/agent/lib/types/gone.js',
    ])
  })

  it('maps nested outputs onto .tsx sources and flags orphaned maps in the vendor layout', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-build-residue-'))
    roots.push(root)
    const pkg = join(root, 'vendor/logger-console')
    mkdirSync(join(pkg, 'src/ui'), { recursive: true })
    mkdirSync(join(pkg, 'lib/types/ui'), { recursive: true })
    writeFileSync(join(pkg, 'src/ui/panel.tsx'), 'export {}\n')
    writeFileSync(join(pkg, 'lib/types/ui/panel.js'), '')
    writeFileSync(join(pkg, 'lib/types/ui/panel.js.map'), '')
    writeFileSync(join(pkg, 'lib/types/ui/panel.d.ts'), '')
    writeFileSync(join(pkg, 'lib/types/ui/panel.d.ts.map'), '')
    writeFileSync(join(pkg, 'lib/types/ui/legacy.js'), '')
    writeFileSync(join(pkg, 'lib/types/ui/legacy.js.map'), '')
    writeFileSync(join(pkg, 'lib/types/ui/legacy.d.ts'), '')
    writeFileSync(join(pkg, 'lib/types/ui/legacy.d.ts.map'), '')

    expect(collectBuildResidue(root)).toEqual([
      'vendor/logger-console/lib/types/ui/legacy.d.ts',
      'vendor/logger-console/lib/types/ui/legacy.d.ts.map',
      'vendor/logger-console/lib/types/ui/legacy.js',
      'vendor/logger-console/lib/types/ui/legacy.js.map',
    ])
  })

  it('flags every output of a package whose src tree is gone entirely', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-build-residue-'))
    roots.push(root)
    const pkg = join(root, 'packages/util/brand')
    mkdirSync(join(pkg, 'lib/types'), { recursive: true })
    writeFileSync(join(pkg, 'lib/types/index.js'), '')
    writeFileSync(join(pkg, 'lib/types/index.d.ts'), '')

    expect(collectBuildResidue(root)).toEqual([
      'packages/util/brand/lib/types/index.d.ts',
      'packages/util/brand/lib/types/index.js',
    ])
  })

  it('refuses a root with no workspace trees instead of passing vacuously', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-build-residue-'))
    roots.push(root)
    writeFileSync(join(root, 'package.json'), '{}\n')

    expect(() => collectBuildResidue(root)).toThrow(/no packages\/ or vendor\/ tree/)
  })

  it('prune deletes only the orphaned outputs and reports what it removed', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-build-residue-'))
    roots.push(root)
    const pkg = join(root, 'packages/core/agent')
    mkdirSync(join(pkg, 'src'), { recursive: true })
    mkdirSync(join(pkg, 'lib/types'), { recursive: true })
    writeFileSync(join(pkg, 'src/live.ts'), 'export {}\n')
    writeFileSync(join(pkg, 'lib/types/live.js'), '')
    writeFileSync(join(pkg, 'lib/types/gone.js'), '')
    writeFileSync(join(pkg, 'lib/types/gone.d.ts'), '')

    expect(pruneBuildResidue(root)).toEqual([
      'packages/core/agent/lib/types/gone.d.ts',
      'packages/core/agent/lib/types/gone.js',
    ])
    expect(collectBuildResidue(root)).toEqual([])
    expect(existsSync(join(pkg, 'lib/types/live.js'))).toBe(true)
    expect(existsSync(join(pkg, 'lib/types/gone.js'))).toBe(false)
  })
})
