# deploy templates

English | [中文](README.zh.md)

Process-supervision templates for the feishu-bridge daemon. Placeholders use the uniform `@NAME@` notation and are substituted at install time:

| Placeholder | Meaning |
|---|---|
| `@DSH_BIN@` | absolute path of the dsh executable |
| `@LLM_API_KEY@` | the actual API key referenced by the profile's llm route `apiKeyEnv` (`FB_MIFY_API_KEY`) |
| `@DEFAULT_WORKDIR@` | any one project's workdir (does not affect per-project routing) |
| `@LOG_DIR@` | daemon log directory (launchd template only; systemd uses the journal) |
| `@PATH_VALUE@` | a PATH containing node/pnpm/git (launchd template only) |

| File | Platform | Install location |
|---|---|---|
| `com.dsh.feishu-bridge.plist.template` | macOS launchd | `~/Library/LaunchAgents/com.dsh.feishu-bridge.plist`, `launchctl load` |
| `feishu-bridge.service.template` | Linux systemd (user unit) | `~/.config/systemd/user/feishu-bridge.service`, `systemctl --user enable --now` |

Both templates embed the API key; tighten permissions to 0600 after installation. Loading steps, the reload flow, and the rollback sequence live in [docs/OPERATIONS.md](../docs/OPERATIONS.md).
