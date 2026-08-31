# Agent Note: envFile — deployment-secret injection on the bash executor

Status: implemented

English | [中文](2026-08-31-bash-envfile-deployment-secrets.zh.md)

## Problem

The cc-connect-era secret architecture (see `~/.config/secrets-management-guide.md`): `~/.zshenv` sourced `~/.config/secrets.env`, so the whole process tree — including every fresh shell the agent started — carried all secrets, with Go-side deny rules blocking file reads and `printenv`. That mechanism broke at the dsh migration: `ctx.subprocess` always passes through `scrubbedParentEnv()`, which drops credential-shaped variable names (`/KEY|PASSWORD|SECRET|TOKEN/i`, `packages/subprocess/subprocess/src/index.ts:44`), so agent bash commands cannot see `*_API_KEY`-style variables, while names avoiding those four words (`*_SIG`, `*_WEBHOOK`, `*_ACCOUNT`, `*_URL`) still pass through. LLM routes (the credentials seam's `apiKeyEnv`) and cron exec jobs (the engine's raw `spawn('sh', ['-c'])`, which bypasses the scrub) each have their own injection path; the three paths disagree.

## Decision

An optional `envFile` Config field on `LocalBashExecutor` points at an operator-maintained `KEY=VALUE` document (mode 600), whose entries merge into every command's explicit env under their original names. This is the deployment-level expression of the scrub's own semantics — "an explicit entry is a deliberate caller opt-in, so it survives" (stated verbatim in the `ShellExecSpec.env` seam comment) — and matches the repo rule that deployment-varying choices are validated Config fields. `SandboxBashExecutor` inherits the whole Config via `export type Config = LocalConfig` (`packages/shell/bash-sandbox/src/index.ts:35`), so one change covers both the confined and unconfined execution paths.

### Hot-reload granularity = every command

The file is read in `spawnSpec()` (each `run()`/`start()` call walks it once): an edited value, an appended key, or a removed line applies to the very next command, within the same turn, with no `/reload`. A background process already running keeps the env fixed at its spawn (process semantics). Changing the `envFile` path itself in cordis.patch.yml still needs `/reload`. For contrast, the systemd `EnvironmentFile` (used by LLM routes and cron exec) still needs a daemon restart.

### Layering and fail-loud

Merge order `{ ...ENV_OVERRIDES, ...envFile, ...spec.env, ...spec.dshEnv }`: terminal overrides < file < explicit caller < trusted `DSH_*`. The constructor reads and validates once (missing file, malformed line, or empty value fails plugin load naming the line; empty values are rejected to prevent publishing a blank secret); a file that disappears mid-run fails that one command loudly. Parse semantics align with `~/.zshenv`'s `IFS='=' read` but stricter: split at the first `=` (values may contain `=`), skip blank lines and `#` comments, throw on malformed lines.

### Exposure profile

Entries are visible to the command and therefore to the model — the same level as cc-connect (`printenv`/`echo $X` was never blockable; the deny rules only stopped file reads). Deployments therefore treat the file as a reviewed whitelist: the feishu-bridge deployment points at a dedicated `~/.config/agent-secrets.env` (the file is the whitelist) rather than the full `secrets.env`. The choice rule for a new credential consumer is who initiates the credentialed call: a harness-initiated call takes a config reference (`apiKeyEnv`, MCP headers); a dedicated tool the harness spawns for the model takes per-child injection at its own spawn boundary (the lark-cli tool); only free-form agent commands fall through to envFile. Tool-style safety comes from surface narrowness — a narrow tool offers no verb that echoes credentials — which is why no generic "run arbitrary commands with secrets" wrapper exists: it would be envFile in disguise with zero added safety. True hiding from the model is only possible with harness-side consumption (`apiKeyEnv`, MCP headers) — new integrations prefer their owning seam over stuffing bash env.

## Alternatives considered

- **shellEnv contributor plugin**: rides the trusted `DSH_*` registry, but key names are forcibly rewritten with the prefix (every existing `os.getenv("VOLCENGINE_ACCESS_KEY")` script would need renaming), the key set is fixed at registration (a new key needs `/reload`), and it drags in full new-package ceremony. Its UX loses across the board.
- **BASH_ENV escape hatch**: `bash -c` sources `$BASH_ENV`, zero code with original names, but it bypasses the scrub implicitly, has no load-time validation, and is all-or-nothing with no whitelist.

## Consequences

Agent bash commands regain cc-connect's "the operator manages values, the agent manages names" workflow with original variable names, and hot reload is finer than cc-connect's ever was (per command, including appended keys, versus a daemon restart for systemd layers). The cost: entries are model-visible by construction, so the whitelist discipline lives in the deployment's file curation; the fork now carries a small additive change on the upstream-hot `bash-local` package until envFile is proposed upstream; and the three injection paths remain mechanically distinct (this note's Problem paragraph is still the map).

## Deferred

- Upstream proposal: once envFile is stable, propose it upstream per the fork secondary-development principles (a natural Config field).
- The semi-credential ambient leak (`*_SIG`/`*_WEBHOOK`/`*_ACCOUNT` reaching agent commands) and "the agent can read the secrets file directly (the sandbox governs writes only)" remain independent open issues; see the deployment-side record.
