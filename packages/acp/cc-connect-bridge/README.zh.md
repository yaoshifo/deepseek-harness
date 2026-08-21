# dsh-cc-connect-bridge

[English](README.md) | 中文

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
./install.sh    # writes ~/.dsh/profiles/cc-connect (templates only when missing; patch.yml is never overwritten) + pnpm install + symlinks ~/.dsh/AGENTS.md
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

**改 lib 源码的一键生效**：`./reload.sh`（本包）——构建 host 面 + SIGTERM 回收空闲 dsh 进程。各会话下一条消息由 engine 以同 session id respawn 并 resume（上下文保留），cc-connect 零重启。从 dsh 会话内（如 agent 自改 harness 后）跑会**自动跳过调用者自己的进程**（/proc 祖先探测），不会自杀当前 turn；其它 mid-turn 会话的当前 turn 会被打断（transcript 回退到最近完整 turn，重发即恢复）；有长任务在跑时用 `--no-recycle` 只构建。

## 踩坑

- **system prompt section 里的字面 `{{...}}` 会被 dsh 当变量引用解析**：名字不合 `/^[a-z][a-z0-9_]*$/` 或未注册 → 组装时抛错中止整轮。cc-connect 的渲染 prompt 带 `{{ICONS}}` 标记（#51），因此 dsh 侧渲染指令走用户消息（不插值）而非 system section。
- **请求 id 是字符串** `req_<uuid>`（`JsonRpcLineTransport` 生成），客户端应答必须原样回显。
- 桥 profile 的 pnpm-workspace.yaml 需 `allowBuilds` 白名单 + `minimumReleaseAge: 0`（pnpm 11 默认拦新发布的包）。

## 冲突清单

- `userQuestions` 是**单 provider**——本桥占用唯一 provider 位。不要往 profile 里加其它 UI 类插件（web 前端、交互式 TUI），会 `DUPLICATE_PROVIDER` 启动失败。
- approval 是 waterfall 多 answerer，与生态审批插件兼容。

## 开发

```bash
pnpm exec vitest run packages/acp/cc-connect-bridge   # fake-registry unit tests (HMR dispose-recovery cases included)
node /tmp/bridge-hmr-smoke.mjs                        # real-process HMR recovery smoke (isolated session root)
```

依赖版本随 harness workspace（`workspace:^` 解析到本仓 pinned 源，含 fork 补丁的 agent/llm-pi-ai 等）。

### 在本仓库开发速查（fork 侧，2026-08-16 迁移时趟平）

**改包 → 生效链路**：`pnpm run build:lib`（tsc -b 产 `lib/types`，tsdown 打 `lib/*.js`，workspace glob 自动含本包）→ profile `link:` 直读 `lib/` → **下一个 spawn 的会话**即用新代码，无需任何 reinstall。

**新增 workspace 包的接入清单**（下次照走）：
1. `package.json` 依赖用 `workspace:^`（peer + dev 模式见 `packages/acp/acp`）
2. 包 `tsconfig.json`：extends `tsconfig.base.json`，references 列依赖包（vendor 三件 + 所用 core 包）
3. **`tsconfig.host.json` references 登记**（漏了 typecheck 不看新包）
4. **`src/invariant.ts` 必须有**——`scripts/test-invariants` 按包名拓扑断言全覆盖，缺了报 220 vs 221（模板照抄 dsh-acp 的空 companion）
5. 测试文件放 `tests/`、命名 `*.spec.ts`（根 vitest glob 才会发现）；tsdown entry 只认 `{index,invariant,startup}.js`——package.json exports 别声明 tsdown 不产物的子路径

**严格编译/门禁坑**（迁移时全部撞过）：
- `noUncheckedIndexedAccess`：`mock.calls[0]![0]` 补 `!`
- `exactOptionalPropertyTypes`：可选字段赋 `undefined` 需类型显式 `| undefined`
- `noUnusedParameters`：waterfall 未用的 `next` 参数写 `_next`
- oxlint 禁 `Function` 类型（用具名函数签名）
- lefthook lint(staged) 自动 fix 后工作区与 staged 分叉 → commit 撤回 "conflict while merging unstaged changes" → 把 hook 改过的文件 `git add` 后重提即可
- third-party notices hook 按 `.pnpm/<pkg>@<ver>/` registry 布局找 manifest——`file:` override 安装的包留空壳会 ENOENT，把 `file+` 目录软链进 `@<ver>` 布局补齐

**pnpm install 网络坑（本机）**：pnpm fetcher 从 npmmirror 拉 85MB+ 平台 tarball 稳定 `error (23)`（curl 同 URL 可过）；`fetch-timeout`/串行/换 registry 均无效。分级解法：独立平台包名 → `pnpm-workspace.yaml` overrides `file:` 指预下载 tarball（根 `.npmrc` 未提交，指 npmmirror）；同包名平台版本变体（如 `@openai/codex@0.147.0-linux-x64`）override 拦不住、lockfile 加 `tarball:` 被 shape 校验拒 → 只能本地 scoped registry（node 脚本 serve packument+tarball，`.npmrc` 加 `@scope:registry=http://127.0.0.1:<port>`，装完删行）。遗留：`pnpm-workspace.yaml` 的 TEMP claude-sdk override，网络恢复后删去重装。

## Model Experience

### 请求上下文与条件

#### 模型可见内容

本插件不直接构造 LLM 请求——所有模型输入经 dsh agent 层（会话日志可完整重放）。桥的模型可见贡献是环境变量驱动的条件系统提示注入：`DSH_CC_APPEND_SYSTEM_PROMPT` 的值作为追加段进入系统提示；`DSH_CC_SYSTEM_PROMPT_COMPLETE` 整体替换系统提示。用户消息的 contentBlocks 由 cc-connect 原样透传；`session/command` 命中 dsh 命令注册表时走命令分发而非进入 prompt。

#### token 开销

条件注入：两个环境变量都未设置时零直接 token 开销；追加段每会话注入一次，长度等于变量值。

#### KV Cache 影响

系统提示段在会话内不变（prefix-stable）；运行中 `session/configure` 只切换 planMode/approvalPolicy，不改系统提示，不破坏前缀缓存。

## Known Limitations and Deferred Work

- **userQuestions 是单 provider 位**：本桥占用唯一 provider 槽，profile 再挂 UI 类插件（web 前端、交互式 TUI）会 `DUPLICATE_PROVIDER` 启动失败。
- **turn 进行中的 HMR 恢复不在 prompt 路径上**：由 cc-connect 侧 stall watchdog 兜底；transcript 回退到最近完整 turn 边界，被打断的 turn 重发即恢复。
- **profile 的 pnpm 11 兼容约束**：桥 profile 的 pnpm-workspace.yaml 需 `allowBuilds` 白名单 + `minimumReleaseAge: 0`，否则安装被拦。
