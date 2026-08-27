# Agent Note: Vite-native tsconfig paths for test resolution

Status: implemented

English | [中文](2026-08-27-vite-native-tsconfig-paths.zh.md)

## Problem

Every vitest run printed Vite's migration warning: the `vite-tsconfig-paths` plugin duplicates a capability Vite 8 ships natively as `resolve.tsconfigPaths`. The repository carried that duplicate — a root devDependency, the plugin mounted once per vitest config and once more per vitest *project* — solely to keep one contract alive: bare workspace imports resolve to `src` through the shared `tsconfig.base.json` paths map, never through package `exports` into built `lib/`, where stale artifacts would load a second copy of module singletons ([test resolution](../../../docs/testing.md#test-resolution-source-plane-only)).

## Decision

All five vitest configs enable `resolve: { tsconfigPaths: true }`; the plugin import, its npm dependency, and its notices entry are removed. The resolution contract is unchanged. Two semantic differences between the plugin and the native option are load-bearing:

- **Discovery is per-importer, not a pointed match-all facade.** The plugin resolved every file through one explicitly listed config; Vite's native support walks up from each importing file and follows `extends`. Every lane directory reaches `tsconfig.base.json` that way in this repo: packages, `apps/*`, root-level `scripts/`, and the three solution-style aggregates whose nearest `tsconfig.json` carries no compilerOptions of its own (`packages/api/gateway`, `packages/api/remotes`, `packages/client/connection`).
- **Paths win over package exports**, preserving the source-plane rule above despite workspace packages publishing `exports` entries pointing at `lib/`.

A retired comment in `vitest.snapshot.config.ts` had rejected the native option because "the root tsconfig is a solution file with no paths"; it predated Vite's support for the option and no longer describes the mechanism.

Vitest project configurations do not inherit top-level `resolve`: each named project in `vitest.config.ts` repeats `resolve: { tsconfigPaths: true }` in place of the old per-project plugin mounting. Without the repetition, setup-file transforms fail to resolve workspace names at module-fetch time.

## Testing

- Canary suites from each suspected discovery gap ran under a temporary config carrying only the native option: solution-style aggregates (`gateway.host.spec.ts`, `node-half.host.spec.ts`), the root-level script lane, and an ordinary package lane.
- A sentinel export appended to a built `lib/index.js` stayed invisible through namespace imports of both the bare name and its `/invariant` subpath, proving src-side resolution rather than an exports fallback; the sentinel artifacts were removed afterward.
- The full unit suite passes after migration (1034 spec files).

## Alternatives considered

- **Keep the plugin until forced off.** Rejected: it preserved a second resolution implementation and its failure modes out of inertia while the warning spammed every local and CI test invocation.
- **Add `extends` to the three solution-style aggregate configs** so their nearest-config chain visibly reaches base. Rejected as unnecessary: walk-up already resolves there, and touching aggregate tsc entry points widens the blast radius past a runtime-resolution change.
- **Generate a Vite `alias` table from `tsconfig.base.json`.** Rejected: a second mapping pipeline with its own drift risk — exactly what removing the plugin deletes.

## Consequences

- Third-party surface shrinks by one package; `THIRD_PARTY_NOTICES.md` regenerated accordingly.
- New lane directories holding tests need a tsconfig chain reaching `tsconfig.base.json`; tsx already imposed this on scripts and examples, and violations fail loudly at transform time.
- Renaming `tsconfig.base.json` or moving its `paths` map now updates five vitest configs and the [development layout table](../../../docs/development.md) in the same change.
