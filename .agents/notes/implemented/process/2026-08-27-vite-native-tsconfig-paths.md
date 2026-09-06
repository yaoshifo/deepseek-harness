# Agent Note: Vite-native tsconfig paths for test resolution

Status: implemented

English | [中文](2026-08-27-vite-native-tsconfig-paths.zh.md)

## Problem

Every vitest run printed Vite's migration warning: the `vite-tsconfig-paths` plugin duplicates a capability Vite 8 ships natively as `resolve.tsconfigPaths`. The repository carried that duplicate — a root devDependency, the plugin mounted once per vitest config and once more per vitest *project* — solely to keep one contract alive: bare workspace imports resolve to `src` through the shared `tsconfig.base.json` paths map, never through package `exports` into built `lib/`, where stale artifacts would load a second copy of module singletons ([test resolution](../../../../docs/testing.md)).

## Decision

**Reversed.** The 2026-08-27 switch to native resolution was walked back in two steps: `vitest.config.ts` returned to the `vite-tsconfig-paths` plugin on 2026-08-29 during the 1079-commit upstream absorption, and the four remaining lanes (`vitest.snapshot.config.ts`, `vitest.e2e.config.ts`, `vitest.web.config.ts`, `vitest.web-stress.config.ts`) followed on 2026-09-06, ending the deviation.

Why native resolution was abandoned: it discovers tsconfig chains per importer (walk-up plus `extends`) instead of one pointed match-all facade. Upstream's new face-split packages keep a solution-only root `tsconfig.json` without `paths`, so that walk-up resolved their `src` files through package `exports` into built `lib/` and loaded a second module-singleton copy — 33 `instanceof` test failures in `api/session-controller`. The plugin's `projects: ['./tsconfig.base.json']` facade restores the source-plane contract on every lane: the base file has no `include`, so its `paths` map applies to every test file, and paths win over package exports.

Every vitest config mounts `tsconfigPaths({ projects: ['./tsconfig.base.json'] })`; `vitest.config.ts` repeats it per vitest project through its `pathsPlugin()` factory. The [fork secondary-development principles](2026-08-29-fork-secondary-development-principles.md) own the standing no-toolchain-forks rule this deviation produced.

## Testing

- The full unit suite passed on the 2026-08-29 main-lane rollback; the 33 false `instanceof` failures in `api/session-controller` cleared.
- The 2026-09-06 lane closure ran the full keyless snapshot replay lane plus one scoped suite from each remaining lane (e2e, web, web-stress) through the plugin facade.

## Alternatives considered

- **Keep the plugin until forced off.** Rejected at the time: it preserved a second resolution implementation and its failure modes out of inertia while the warning spammed every local and CI test invocation. The face-split singleton failures reversed this judgment.
- **Add `extends` to the three solution-style aggregate configs** so their nearest-config chain visibly reaches base. Rejected as unnecessary: walk-up already resolves there, and touching aggregate tsc entry points widens the blast radius past a runtime-resolution change.
- **Generate a Vite `alias` table from `tsconfig.base.json`.** Rejected: a second mapping pipeline with its own drift risk — exactly what removing the plugin deletes.

## Consequences

- `vite-tsconfig-paths` is a root devDependency with its `THIRD_PARTY_NOTICES.md` entry.
- New lane directories holding tests need no tsconfig chain of their own: the plugin facade points every lane at `tsconfig.base.json` directly.
- Renaming `tsconfig.base.json` or moving its `paths` map updates every vitest config and the [development layout table](../../../../docs/development.md) in the same change.
