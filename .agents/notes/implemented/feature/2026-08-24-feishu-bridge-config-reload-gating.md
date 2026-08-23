# Agent Note: gating the feishu-bridge daemon's config changes behind /reload

Status: implemented

English | [中文](2026-08-24-feishu-bridge-config-reload-gating.zh.md)

## Problem

Every edit to `cordis.patch.yml` hot-applied through Cordis config HMR: the refresh disposes and rebuilds all engines and platforms inside the running daemon. That reload path caused repeated production incidents — the WS zombie that silently dropped new-group messages (2026-08-21), the multi-project user-questions provider conflict (2026-08-22), and the same-pid `apply()` re-run that once misfired the reload exit notice — and an editor's intermediate saves each triggered a full re-apply. The daemon already has one deliberate, guarded apply point (`/reload`), so config should ride it instead of applying itself.

## Decision

Three coordinated changes; each is load-bearing for the others.

1. **`DSH_CONFIG_HMR_DISABLED`** (any non-empty value, the `DSH_TELEMETRY_DISABLED` semantics) in `runProfile` (`apps/cli/src/profile-boot.ts`): the launcher then mounts no fallback watch-only HMR service and registers no `watchUserPatches` watcher (profile layer or home layer), logging one info line so a dead watcher is never indistinguishable from a failed one. Patch-layer edits apply only at the next boot.
2. **The feishu-bridge bundle disables dsh-base's `hmr` row** (`packages/acp/feishu-bridge/cordis.patch.yml`, the headless precedent). That module watcher only ever saw the profile directory, but the reload preflight below rewrites the profile's `cordis.yml` root — with a live module watcher, `include.refresh()` would treat the rewrite as a config change and hot-reload the old daemon mid-reload (the exit-notice trigger shape). Deployments that do not set the env switch keep config HMR through the launcher fallback, so the documented hot-reload contract survives elsewhere.
3. **`reload.sh` validates before restarting**: after the build, before any stop, it runs `dsh --profile <name> --dump-config` (composes the patch layers without booting, so no second process ever connects to Feishu). A broken `cordis.patch.yml` aborts while the old daemon still runs — it keeps its last-good tree, the group receives the pre-existing `/reload` failure reply, and no systemd crash loop starts.

`/reload` itself is unchanged: the restart re-reads config from disk, and the failure-reply chain (`finish()` on non-zero script exit) already existed. Known limit of the preflight: dump mode evaluates no `!!js`, checks no plugin schema, and resolves no plugin names — those errors still surface only in the post-restart boot (fail-loud exit, systemd retries; fixing the file recovers automatically).

## Alternatives considered

**Make launcher watching opt-in globally.** Breaks the documented live-edit contract for every other long-lived surface (web); the switch is the deployment's choice, not the product default.

**Preflight by booting the composition.** A second daemon would open a second Feishu WS connection per app — the event-splitting hazard the zombie incident documented. `--dump-config` parses without booting precisely to avoid this.

**Validate between stop and start.** The on-disk config is already broken at that point, so "start" would crash-loop; validating while the old daemon lives is the only placement where failure leaves the bot up.

**Keep HMR and rely on operator discipline.** No enforcement; the incident history is the counterexample.

## Consequences

Config edits (profile yml, home yml) are inert until `/reload`, exactly as requested; mid-turn sessions still lose the current turn on restart. The same-pid HMR branch of the reload marker (`reload-commands.ts`) becomes unreachable in this deployment and stays as defensive logic. The Loader's runtime tree write-back into `cordis.yml` no longer hot-reloads anything (nothing watches it). `reload-commands.ts`, i18n, and snapshots are untouched.

## Testing

`apps/cli/tests/config-hmr-switch.spec.ts`: REAL `runProfile` boots of an empty-bundle temp profile — the control observes a live patch apply with the switch unset (also proving the edit is self-contained: each refresh re-applies every layer onto the re-read empty root, so an id-targeted override alone would warn and change nothing); with the switch set, no fallback HMR service mounts and edits stay inert; with the switch set and the composition mounting its own `hmr` row, the service exists and edits still stay inert. Red-verified: reverting only the `profile-boot.ts` change fails the two inertness cases. `reload.sh` preflight verified manually — `--dump-config` exits 1 on a broken patch yml against a temp `DSH_HOME`. Docs: OPERATIONS.md §1.2/§3.3/§4/§5, the systemd unit template, the profile template header, MIGRATION.md D9, and both app-boot READMEs.
