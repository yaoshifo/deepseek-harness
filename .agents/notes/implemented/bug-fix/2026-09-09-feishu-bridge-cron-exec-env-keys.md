# Agent Note: Cron exec jobs declare env_keys to receive daemon credentials

Status: implemented

English | [中文](2026-09-09-feishu-bridge-cron-exec-env-keys.zh.md)

## Problem

Running cron exec jobs through the subprocess service ([containment](2026-09-08-feishu-bridge-cron-exec-subprocess-containment.md)) also routed their environment through `scrubbedParentEnv()`, whose `SENSITIVE_ENV_PATTERN` drops every credential-shaped name. Cloud credentials supplied to the daemon by its systemd EnvironmentFile (`VOLCENGINE_*`, `TENCENTCLOUD_*`) therefore no longer reached exec jobs — the ops backup jobs failed across 2026-09-09. The service's spawn already merged an explicit `spec.env` after the scrub; the cron chain simply never passed one.

## Decision

`CronJob` carries `env_keys` — snake_case on disk, variable *names* only; jobs without the field behave exactly as before. `executeCronShell` resolves each declared name from the daemon's `process.env` into `EngineSubprocessSpec.env` (undefined when nothing is declared), and `createCronSubprocessRunner` forwards it to `ctx.subprocess.spawn`, where explicit entries merge after the ambient scrub. A declared name missing from the daemon environment fails the run loud with the key names — never values — in the error, before anything spawns. Values are resolved per run and never persist: jobs.json, tool calls, and chat messages carry names only. `env_keys` rides the exec trust line: the `feishu_bridge_cron` tool accepts it on add (exec jobs only) and on edit (comma-separated name list), and editing it requires an administrator like `exec`/`prompt`/`work_dir`.

## Alternatives considered

- **Implicit pass-through of all daemon credentials to every exec job:** rejected — hands every job script the daemon's full credential set, so one compromised script leaks everything; it would also silently undo the scrub the containment change gained.
- **A per-job env_file the engine reads:** rejected — a second credential source to own, secure, and audit; the daemon's EnvironmentFile already feeds `process.env`, so a names-only declaration reaches the same values without new files or a file-read channel.

## Consequences

- Declared names reach the child even when they match the credential scrub; undeclared credential names stay scrubbed (a REAL-provider test pins both sides in one command).
- A typo'd or revoked name fails the run at spec construction with the name in the error — ops sees exactly which key to restore instead of debugging a downstream auth error.
- Output handling is unchanged: a job whose streams exceed the 64 KiB per-stream cap keeps the exit-status behavior the containment change shipped.
- The `/cron` slash-command family does not accept `env_keys`; the agent tool is the only entrance, matching its administrator-gated surface.
