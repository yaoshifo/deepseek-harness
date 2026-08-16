# dsh-cc-connect-bridge

cc-connect 的 DeepSeek Harness（dsh）桥插件：一个 Cordis 插件 + 专用 profile，把 dsh 的能力缝（agents registry / approval / user-questions / plan-mode / system-prompt）翻译成 stdio JSON-RPC 协议，供 cc-connect 的 `agent/dsh` Go 后端消费。

2026-08-16 从独立仓库 `~/workspace/dsh-cc-connect-bridge` 迁入 harness（`file:` 拷贝部署 → `link:` 软链直读）。

在 dsh 官方 SDK 协议（initialize / session/prompt / shutdown + session.event 等通知）之上扩展：

| 方向 | 方法 | 说明 |
|---|---|---|
| client→server | `initialize` | `{cwd, provider, model, maxTokens?}` |
| client→server | `session/create` | `{sessionId, resumeSessionId?, cwd?, planMode?, approvalPolicy?}`（官方 SDK 无 resume） |
| client→server | `session/prompt` | `{sessionId, contentBlocks}` → `{messageId}` |
| client→server | `session/cancel` | `{sessionId, keepInbox?}` → `agent.cancel`（官方 SDK 无 cancel） |
| client→server | `session/configure` | `{sessionId, planMode?, approvalPolicy?}` 运行中切换 |
| client→server | `session/command` | `{sessionId, line}` 经 dsh 命令注册表分发（如 `/compact`）；`{dispatched, text?}`，未注册命令 `dispatched:false` 供回落普通 prompt |
| client→server | `shutdown` | dispose 全部会话并退程 |
| server→client | `approval/ask`（请求） | dsh `approval/request` waterfall → 飞书审批卡；响应 `{outcome}` |
| server→client | `question/ask`（请求） | dsh user-questions 单一 provider → 承载 `ask_user_question` 与 **exit_plan_mode 的 plan review**（intent.kind==='plan-review'） |
| server→client | `session.event` / `session.status`（通知） | 原样转发 |

system prompt 注入：`DSH_CC_APPEND_SYSTEM_PROMPT`（追加段，`--append-system-prompt` 等价）/ `DSH_CC_SYSTEM_PROMPT_COMPLETE`（整体替换，chatroom bare 等价）。

## 安装

```bash
./install.sh    # 写 ~/.dsh/profiles/cc-connect（模板仅缺失时；patch.yml 永不覆盖）+ pnpm install + 软链 ~/.dsh/AGENTS.md
```

要求：node ≥22.19、pnpm ≥11、harness workspace 已 `pnpm install && pnpm run build:lib`（bridge 随 workspace 一起构建）。

## 自进化（hot reload）姿势

dsh 与 cc-connect 是两个进程层——agent 在 dsh 层自我修改，**cc-connect 全程无需重启**：

| 改什么 | 生效时机 | 机制 |
|---|---|---|
| profile `cordis.patch.yml`（插件配置） | 当前会话：重载即时，agent 被事务重载 dispose 后由桥**自动 resume 恢复**（下次 prompt 时透明重建，重放 planMode/approval 覆盖） | Cordis HMR 事务重载（`watchUserPatches`）+ 桥 `ensureLive` |
| CLAUDE.md / AGENTS.md | 立即 | agent-instructions 文件监听 |
| `~/.claude/skills/**`（含新增） | 立即 | skill-filesystem chokidar watch |
| 新装插件（profile `package.json` + `pnpm install`） | 下一会话（新进程） | per-session spawn + resume |
| `~/.dsh/AGENTS.md`（全局指令） | 立即 | 同 CLAUDE.md 监听 |
| 本包源码（`src/`） | 下一会话（新进程）：`link:` 软链直读，`pnpm run build:lib` 后即生效，无需 reinstall | per-session spawn |

已知天花板：HMR 发生在 turn 进行中时，恢复不在 prompt 路径上——由 cc-connect 侧 stall watchdog 兜底；transcript 恢复到最近完整 turn 边界。

默认 sandbox 为 workspace-write：写 `~/.dsh/**`、`~/.claude/skills/**` 等 workspace 外路径会被拦并触发升级审批（cc-connect 飞书审批卡放行单次写入，审计事件落 session log）。想零摩擦可在 profile patch 里把 `sandbox-policy.mode` 改为 `danger-full-access`。

## 踩坑

- **system prompt section 里的字面 `{{...}}` 会被 dsh 当变量引用解析**：名字不合 `/^[a-z][a-z0-9_]*$/` 或未注册 → 组装时抛错中止整轮。cc-connect 的渲染 prompt 带 `{{ICONS}}` 标记（#51），因此 dsh 侧渲染指令走用户消息（不插值）而非 system section。
- **请求 id 是字符串** `req_<uuid>`（`JsonRpcLineTransport` 生成），客户端应答必须原样回显。
- 桥 profile 的 pnpm-workspace.yaml 需 `allowBuilds` 白名单 + `minimumReleaseAge: 0`（pnpm 11 默认拦新发布的包）。

## 冲突清单

- `userQuestions` 是**单 provider**——本桥占用唯一 provider 位。不要往 profile 里加其它 UI 类插件（web 前端、交互式 TUI），会 `DUPLICATE_PROVIDER` 启动失败。
- approval 是 waterfall 多 answerer，与生态审批插件兼容。

## 开发

```bash
pnpm exec vitest run packages/acp/cc-connect-bridge   # fake registry 单测（含 HMR dispose 恢复用例）
node /tmp/bridge-hmr-smoke.mjs                        # 真实进程 HMR 恢复 smoke（隔离 session root）
```

依赖版本随 harness workspace（`workspace:^` 解析到本仓 pinned 源，含 fork 补丁的 agent/llm-pi-ai 等）。
