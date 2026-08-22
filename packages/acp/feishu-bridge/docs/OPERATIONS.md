# feishu-bridge 运维手册（部署 / 配置 / 运行 / 回退）

骨架：已确定的事实直接写死，TODO 标记留待后续填充。迁移背景、架构决策与验收标准见 [MIGRATION.md](MIGRATION.md)；本文只回答「怎么部署、怎么配、怎么跑、怎么退」。feature 迁移状态见 [FEATURE-PARITY.md](FEATURE-PARITY.md)。

本文示例一律使用占位符（`@REPO_DIR@`、`@DSH_BIN@`、`@LLM_API_KEY@` 等），不出现真实凭据。

## 1. 部署

### 1.1 依赖

- Node 与 pnpm（满足仓库 `package.json` engines 要求的版本）
- dsh CLI：`@DSH_BIN@`（全局发布版或 fork 仓库构建产物，路径写进 launchd/systemd 模板）
- 插件运行时依赖：`@larksuiteoapi/node-sdk`（WS 长连接）、`sharp`（Lucide 头像 SVG 栅格化）
- 可选：lark-cli（真机冒烟与运维操作，见 MIGRATION.md 附录 B）

TODO：最低版本清单与安装命令。

### 1.2 profile 安装

```sh
cd @REPO_DIR@/packages/acp/feishu-bridge
./install.sh
```

`install.sh` 把 `profile/` 下模板渲染到 `~/.dsh/profiles/feishu-bridge`（已存在的文件不动——profile 是自进化层），并在 profile 目录执行 `pnpm install`。要点：

- `cordis.patch.yml` 永远不会被 install 覆盖：它是运行期热改的配置层（Cordis HMR）。
- feishu bot / 引擎配置写在 `cordis.patch.yml` 的 `feishu-bridge` 插件行 `config:` 下（见 §2 映射表）；LLM 路由、沙箱、会话存储写在同文件其余行。
- TODO：`profile/` 模板与实例的路径统一（MIGRATION.md 附录 B 遗留 4：模板仍是 Linux 路径 + glm 路由）。

### 1.3 两步构建（TS 代码改动生效）

```sh
cd @REPO_DIR@
npx tsc -b packages/acp/feishu-bridge/tsconfig.json --force   # 第一步：tsc 产出 lib/types/*.js
npx tsdown --env.DSH_BUILD_FACE host                           # 第二步：tsdown 从 lib/types 打包 lib/index.js
```

坑：tsdown 入口是 `lib/types/{index,invariant,startup}.js`（tsc 产物），不直接读 `src/*.ts`——只跑第二步会用旧的 lib/types，改动不生效。

### 1.4 launchd 装载（macOS）

模板：[deploy/com.dsh.feishu-bridge.plist.template](../deploy/com.dsh.feishu-bridge.plist.template)。

```sh
cp @REPO_DIR@/packages/acp/feishu-bridge/deploy/com.dsh.feishu-bridge.plist.template \
   ~/Library/LaunchAgents/com.dsh.feishu-bridge.plist
# 编辑替换 @占位符@（见模板头注释与 deploy/README.md）
launchctl load ~/Library/LaunchAgents/com.dsh.feishu-bridge.plist
```

LLM 路由 API key 走 `EnvironmentVariables`（profile 里 `apiKeyEnv` 引用的变量名，如 `FB_MIFY_API_KEY`）。TODO：plist 权限收紧（0600）与多机分发流程。

Linux 部署面用 systemd user unit（§5）。

## 2. 配置映射表（旧 config.toml → 新 cordis.patch.yml）

旧：`~/.cc-connect/config.toml`（cc-connect Go）。新：`~/.dsh/profiles/feishu-bridge/cordis.patch.yml`。新配置分两处：dsh 通用行（LLM 路由、沙箱、会话存储）与 `feishu-bridge` 插件行的 `config:`（projects/providers/display）。

| 旧 config.toml | 新 cordis.patch.yml | 说明 |
|---|---|---|
| `data_dir` | `feishu-bridge` 行 `config.dataDir` | 默认 `~/.dsh/feishu-bridge`（per-project store 根） |
| `language` | 插件行 `config.language`（'zh'/'zh-TW'/'ja'/'es'/'en'，其余自动探测） | |
| `[platform_options.feishu]` `reaction_emoji` / `done_emoji` / `cancel_emoji` | `config.projects[].feishu.reactionEmoji` / `doneEmoji` / `cancelEmoji` | |
| `[platform_options.feishu]` `notify_on_complete` | `config.projects[].feishu.notifyOnComplete` | |
| `[platform_options.feishu]` `topnotice_first_message` | `config.projects[].feishu.topNoticeFirstMessage` | |
| `[platform_options.feishu]` `pin_user_messages` | `config.projects[].feishu.pinUserMessages` | |
| `[[providers]]` `name` / `api_key` / `base_url` / `model` / `context_window` | `llm-pi-ai` 行 `providers.<route>`（`apiKeyEnv` 引用 + `baseURL` + `models[].contextWindow`）；插件行 `config.providers.<name>.route` / `.model` | key 实际值放 launchd/systemd 的 Environment（不在 yml）；`rewrite_tui_fingerprint` 不迁移（FEATURE-PARITY #16） |
| `[[projects]]` `name` / `work_dir` | `config.projects[].name` / `.workdir` | |
| `[projects.agent.options]` `provider` | `config.projects[].agent.provider` | 指向 `config.providers` 的键名 |
| `[projects.agent.options]` `mode` | `config.projects[].agent.mode` | `'plan'` = 每会话默认计划模式（含审批 preset）；`/mode` 单次覆盖 |
| 项目级 `quiet` | `config.projects[].features.quiet` | |
| `[projects.platforms.options]` `allow_chat` | `config.projects[].features.allowChat` | |
| `inject_sender` | `config.projects[].features.injectSender` | |
| `[projects.platforms.options]` `app_id` / `app_secret` | `config.projects[].feishu.appId` / `.appSecret` | |
| `[projects.platforms.options]` `thread_isolation` | `config.projects[].feishu.threadIsolation` | 每条消息话题独立会话；默认关 |
| `[projects.platforms.options]` `allow_from` / `group_only` / `group_reply_all` / `share_session_in_channel` / `reply_to_trigger` / `respond_to_at_everyone_and_here` / `enable_feishu_card` / `progress_style` / `active_tag_name` | `config.projects[].feishu.allowFrom` / `.groupOnly` / — / `.shareSessionInChannel` / `.replyToTrigger` / `.respondToAtEveryoneAndHere` / `.enableFeishuCard` / `.progressStyle` / `.activeTagName` | 2026-08-21 补齐接线（此前机制在但配置不可达）；`group_reply_all` 由 `features.allowChat` 承担；`resolve_mentions` 随 mention resolution 未移植 |
| `dir_scan_paths` | `config.projects[].dirScanPaths` | /dir 子目录扫描建议列表 + 裸名解析（~ 展开；M7-d #3） |
| `hints` / `hints_with_param` / `hints_common`（顶层） | 插件行 `config.hints` / `.hints_with_param` / `.hints_common` | 完成卡快捷提示按钮 + `/hint` 卡；点击计数持久化 `<dataDir>/hint_usage.json` 并按频率排序（M8 前补充 4） |
| `[projects.feishu_workspace]` `wiki_space_id` / `folder_token` / `wiki_node_token` / `description` | `config.projects[].feishuWorkspace.wikiSpaceId` / `.folderToken` / `.wikiNodeToken` / `.description` | bot 默认飞书空间，经 setup 钩子注入（M7-d #18）；创建落位优先级 wikiNodeToken > wikiSpaceId > folderToken |
| `[display]` `tool_messages` / `tool_progress` / `plan_max_len` / `thinking_messages` / `thinking_max_len` | 插件行 `config.display.toolMessages` / `.toolProgress` / `.planMaxLen` / `.thinkingMessages` / `.thinkingMaxLen` | 键名 camelCase；`progress_spinner` 同理（`progressSpinner`） |
| `[display]` `stall_timeout_secs` / `stall_max_retries` / `absolute_turn_timeout_secs` | `config.display.stallTimeoutSecs` / `.stallMaxRetries` / `.absoluteTurnTimeoutSecs` | absolute 为每回合墙钟上限：未设 = 2× stall 窗口、0 关闭；硬上限 3×（防慢滴流回合挂死，2026-08-21 接线）。硬上限时钟按轮计量——排队消息接管为新轮时重置（2026-08-21，有意偏离 Go 的 per-run 计量）；stall-retry 重启不重置 |
| `[rate_limit]` `max_messages` / `window_secs` | 插件行 `config.rateLimit.maxMessages` / `.windowSecs` | 每 sessionKey 入站滑窗限流；默认 20 条/60s，`maxMessages: 0` 关闭（2026-08-21 接线） |
| `[stream_preview]` `partial` | — | 不迁移：Go 侧该键只驱动 claudecode CLI 的 `--include-partial-messages`；dsh 适配器事件流无此区分、无消费方 |
| （隐含）会话存储位置 | `session-persistence-jsonl` 行 `config.root` | cutover 时旧 root `~/.dsh/cc-connect-sessions` 已改名并沿用为 `~/.dsh/feishu-bridge-sessions`（历史日志随目录迁移，记账驴在途会话 resume 已验证）；7 个迁移 bot 按用户裁定全新会话开始，注册表未迁移 |
| `[chatroom]` / `[subtask]` / `[spawn]` / `[group_name]` / `[predict_next]` / `[turn_summary]` / `[plan_render]` / cron / relay / `[projects.monitor]` / `usage_providers` | 插件行 `config.chatroom` / `config.subtask` / `config.spawn` / `config.projects[].groupName` / `.predictNext` / `.turnSummary` / `.planRender` / `config.cron` / `config.relay` / `config.projects[].monitor` / `config.usageProviders` | 各域 M5–M7 已落地；键名 camelCase |
| —（Go 无对应，新增） | 插件行 `config.projects[].planDir` | ExitPlanMode 呈现时把完整计划落盘为 `.md`（对齐 Claude Code：默认 `~/.claude/plans/`，文件名 `<cwd-slug>-<标题slug>.md`，同名异文追加 `-YYYYMMDD-HHMMSS` 后缀、同文跳过；模型自写的 plan 文件优先不改写；写失败回退 inline 卡片）；卡片标题只显示标题部分——剥离与 workdir 匹配的 cwd-slug 前缀、保留时间戳后缀（2026-08-22，有意偏离 Go 的整 basename 标题）；`''` 关闭 |

脱敏示例（新配置形状，占位符）：

```yaml
- id: llm-pi-ai
  config:
    providers:
      <route-name>:
        apiKeyEnv: FB_MIFY_API_KEY        # 实际值在 launchd/systemd Environment
        api: anthropic-messages
        baseURL: <llm-base-url>
        models:
          - id: <model-id>
            contextWindow: 1000000

- id: feishu-bridge
  config:
    display:
      toolProgress: true
    projects:
      - name: <project-name>
        workdir: <project-workdir>
        feishu:
          appId: <feishu-app-id>
          appSecret: <feishu-app-secret>
          notifyOnComplete: true
          reactionEmoji: Get
          doneEmoji: Done
          cancelEmoji: CrossMark
          topNoticeFirstMessage: true
          pinUserMessages: true
        agent:
          provider: <provider-key>
        features:
          allowChat: true
          quiet: true
    providers:
      <provider-key>:
        route: <route-name>
        model: <model-id>
```

## 3. 运行

### 3.1 日志

launchd 模板把标准输出/错误写到 `@LOG_DIR@/feishu-bridge-stdout.log` 与 `feishu-bridge-stderr.log`（本机现值 `~/.dsh/`）。systemd 部署走默认 journal（`journalctl --user -u feishu-bridge`，轮转交给 journald）。TODO：常用排障 grep 组合、watchdog 探活参数。

### 3.2 WS 独占

同一飞书 app 的 WS 事件同一时刻只归一个进程消费：新 daemon 与旧 cc-connect 不能同时持有同一个 bot。任何切换（切流或回退）都必须遵守 §4 的顺序。完整背景见 MIGRATION.md 附录 B「WS 独占」段。

### 3.3 reload 流程

- TS 代码改动（一键，双平台）：`packages/acp/feishu-bridge/reload.sh`——§1.3 两步构建 → 重启 daemon（macOS：`launchctl unload`/`load` + stdout/stderr 日志轮换；Linux：单条 `systemctl --user restart`，原子操作无空窗）→ WS 就绪探活（macOS 查轮换后的 stdout 日志，Linux 查 journal）；`--skip-build` 跳过构建（构建已在别处完成时）。在 daemon 内的会话里执行会被拒绝（重启会中断自身 turn；由 bash 环境里的 `DSH_SESSION_JSONL` 判定——agent 沙箱会把 `XPC_SERVICE_NAME` 改写成字面量 `0`、并拒绝 `ps`，两者都不可用），须从普通终端跑；进行中 turn 会回滚到最后完整 turn。macOS 上 unload 与 load 之间脚本若因任何原因退出，会自动重试 `launchctl load` 恢复服务。
- 同一效果的聊天入口：admin 用户发 `/reload [--skip-build]`（TS 原生命令，无 Go 对应）。daemon 以 detached 子进程运行上述脚本并带 `FB_RELOAD_FROM_DAEMON=1`——该变量只豁免脚本的 ppid 守卫（detached 子进程正是该守卫想近似的安全场景），`DSH_SESSION_JSONL` 守卫不豁免。macOS 直接 setsid spawn（launchd teardown 打不到 setsid 子进程）；Linux 经 `systemd-run --user --scope` 生成兄弟 scope 单元——setsid 出不了 `feishu-bridge.service` 的 cgroup，`systemctl --user restart`（KillMode=control-group）会连带杀掉脚本造成重启成功但误报失败（2026-08-22 dev 事故）。输出追加到 `$LOG_DIR`（默认 `~/.dsh`）的 `feishu-bridge-reload.log`；进行中仅允许一个 reload；脚本在重启之前失败（构建失败、plist/systemd unit 缺失）时 daemon 未重启、用户会收到失败回复。
- 完成通知：spawn 前 handler 写 `$LOG_DIR/feishu-bridge-reload-pending.json`（pid、platform、replyCtx、at）；新 daemon 所有平台就绪后读取标记，经记录的平台把「✅ Reload 完成」回复到原 `/reload` 消息上并删除标记——通知由新进程发出，能发出即证明重启落地。同 pid（HMR 插件重载在 reload 飞行中重跑 `apply()`）跳过且保留标记；超过 15 分钟视为陈旧静默丢弃；平台已不在配置、标记损坏、发送失败均 warn 后丢弃。残留边界：reload 构建期间 daemon 独立崩溃由 systemd 拉起，也会收到通知（daemon 确实重启了，文案不声称构建结果，详情以日志为准）。daemon 已重启后才暴露的失败（如 WS 探活超时）仍只有日志留痕，无失败回复。
- profile yml / 插件 config 改动：Cordis HMR 事务热载，无需重启。

## 4. 回退（回旧 cc-connect）

前置：旧 cc-connect 仍被 systemd/launchd 监督且对应 project 段在 `~/.cc-connect/config.toml` 中被注释（切流时留的备份）。回退一个 project：

1. 取消注释 `~/.cc-connect/config.toml` 中该 project 段。
2. `launchctl kickstart -k gui/$(id -u)/com.cc-connect.service`（旧进程重启并拿回 WS）。
3. `launchctl unload ~/Library/LaunchAgents/com.dsh.feishu-bridge.plist`（停新 daemon；若只回退部分 project，改从新 daemon 的 `cordis.patch.yml` 移除该 project 段——HMR 生效，不必停进程）。

顺序不可换：先让旧进程拿回 WS，再停新进程。切流窗口内（旧进程释放到新进程接管之间）用户消息不补投，挑空闲时段执行。

## 5. systemd 自启（Linux 部署面）

模板：[deploy/feishu-bridge.service.template](../deploy/feishu-bridge.service.template)（systemd user unit）。

```sh
cp @REPO_DIR@/packages/acp/feishu-bridge/deploy/feishu-bridge.service.template \
   ~/.config/systemd/user/feishu-bridge.service
# 编辑替换 @占位符@
systemctl --user daemon-reload
systemctl --user enable --now feishu-bridge
```

设计要点（MIGRATION.md D9，与旧 cc-connect 重启语义对齐）：

- `Restart=on-failure`：进程内断线由 SDK 指数退避重连 + 探活 watchdog 兜底，进程退出交给 systemd 拉起。
- 死因留痕：`journalctl --user -u feishu-bridge`。
- LLM 路由 key 走 `Environment=`（`apiKeyEnv` 引用），unit 文件含密钥须收紧到 0600。
- 开机自启：user unit 需要 `loginctl enable-linger <user>`（Dev 部署已启用 linger）。
- 重启后状态恢复：会话由 jsonl 日志在下一条消息时自动 resume；路由/cron/账本从磁盘 store 恢复；进行中 turn 回滚到最后完整 turn。
