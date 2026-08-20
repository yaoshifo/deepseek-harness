# deploy 模板

[English](README.md) | 中文

feishu-bridge daemon 的进程监督模板，占位符统一用 `@NAME@` 记法，安装时替换：

| 占位符 | 含义 |
|---|---|
| `@DSH_BIN@` | dsh 可执行文件绝对路径 |
| `@LLM_API_KEY@` | profile 的 llm 路由 `apiKeyEnv`（`FB_MIFY_API_KEY`）所引用的 API key 实际值 |
| `@DEFAULT_WORKDIR@` | 任意一个 project 的 workdir（不影响各 project 路由） |
| `@LOG_DIR@` | daemon 日志目录（仅 launchd 模板用；systemd 走 journal） |
| `@PATH_VALUE@` | 需含 node/pnpm/git 的 PATH（仅 launchd 模板用） |

| 文件 | 平台 | 安装位置 |
|---|---|---|
| `com.dsh.feishu-bridge.plist.template` | macOS launchd | `~/Library/LaunchAgents/com.dsh.feishu-bridge.plist`，`launchctl load` |
| `feishu-bridge.service.template` | Linux systemd（user unit） | `~/.config/systemd/user/feishu-bridge.service`，`systemctl --user enable --now` |

两模板都含 API key，装好后权限收紧到 0600。装载步骤、reload 流程与回退时序见 [docs/OPERATIONS.md](../docs/OPERATIONS.md)。
