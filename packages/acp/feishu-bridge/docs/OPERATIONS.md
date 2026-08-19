# feishu-bridge 运维手册（部署 / 配置 / 运行 / 回退）

骨架：已确定的事实直接写死，`TODO(M8)` 标记留待 cutover 期（M8）填充。迁移背景、架构决策与验收标准见 [MIGRATION.md](MIGRATION.md)；本文只回答「怎么部署、怎么配、怎么跑、怎么退」。feature 迁移状态见 [FEATURE-PARITY.md](FEATURE-PARITY.md)。

本文示例一律使用占位符（`@REPO_DIR@`、`@DSH_BIN@`、`@LLM_API_KEY@` 等），不出现真实凭据。

## 1. 部署

### 1.1 依赖

- Node 与 pnpm（满足仓库 `package.json` engines 要求的版本）
- dsh CLI：`@DSH_BIN@`（全局发布版或 fork 仓库构建产物，路径写进 launchd/systemd 模板）
- 插件运行时依赖：`@larksuiteoapi/node-sdk`（WS 长连接）、`sharp`（Lucide 头像 SVG 栅格化）
- 可选：lark-cli（真机冒烟与运维操作，见 MIGRATION.md 附录 B）

TODO(M8)：最低版本清单与安装命令。

### 1.2 profile 安装

```sh
cd @REPO_DIR@/packages/acp/feishu-bridge
./install.sh
```

`install.sh` 把 `profile/` 下模板渲染到 `~/.dsh/profiles/feishu-bridge`（已存在的文件不动——profile 是自进化层），并在 profile 目录执行 `pnpm install`。要点：

- `cordis.patch.yml` 永远不会被 install 覆盖：它是运行期热改的配置层（Cordis HMR）。
- feishu bot / 引擎配置写在 `cordis.patch.yml` 的 `feishu-bridge` 插件行 `config:` 下（见 §2 映射表）；LLM 路由、沙箱、会话存储写在同文件其余行。
- TODO(M8)：`profile/` 模板与实例的路径统一（MIGRATION.md 附录 B 遗留 4：模板仍是 Linux 路径 + glm 路由）。

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

LLM 路由 API key 走 `EnvironmentVariables`（profile 里 `apiKeyEnv` 引用的变量名，如 `FB_MIFY_API_KEY`）。TODO(M8)：plist 权限收紧（0600）与多机分发流程。

Linux 部署面用 systemd user unit（§5）。

## 2. 配置映射表（旧 config.toml → 新 cordis.patch.yml）

旧：`~/.cc-connect/config.toml`（cc-connect Go）。新：`~/.dsh/profiles/feishu-bridge/cordis.patch.yml`。新配置分两处：dsh 通用行（LLM 路由、沙箱、会话存储）与 `feishu-bridge` 插件行的 `config:`（projects/providers/display）。

| 旧 config.toml | 新 cordis.patch.yml | 说明 |
|---|---|---|
| `data_dir` | `feishu-bridge` 行 `config.dataDir` | 默认 `~/.dsh/feishu-bridge`（per-project store 根） |
| `language` | — | TODO(M8)：i18n 语言接线方式核实 |
| `[platform_options.feishu]` `reaction_emoji` / `done_emoji` / `cancel_emoji` | `config.projects[].feishu.reactionEmoji` / `doneEmoji` / `cancelEmoji` | |
| `[platform_options.feishu]` `notify_on_complete` | `config.projects[].feishu.notifyOnComplete` | |
| `[platform_options.feishu]` `topnotice_first_message` | `config.projects[].feishu.topNoticeFirstMessage` | |
| `[platform_options.feishu]` `pin_user_messages` | `config.projects[].feishu.pinUserMessages` | |
| `[[providers]]` `name` / `api_key` / `base_url` / `model` / `context_window` | `llm-pi-ai` 行 `providers.<route>`（`apiKeyEnv` 引用 + `baseURL` + `models[].contextWindow`）；插件行 `config.providers.<name>.route` / `.model` | key 实际值放 launchd/systemd 的 Environment（不在 yml）；`rewrite_tui_fingerprint` 不迁移（FEATURE-PARITY #16） |
| `[[projects]]` `name` / `work_dir` | `config.projects[].name` / `.workdir` | |
| `[projects.agent.options]` `provider` | `config.projects[].agent.provider` | 指向 `config.providers` 的键名 |
| `[projects.agent.options]` `mode` | — | TODO(M8)：mode 与审批 preset 的映射关系核实 |
| 项目级 `quiet` | `config.projects[].features.quiet` | |
| `[projects.platforms.options]` `allow_chat` | `config.projects[].features.allowChat` | |
| `inject_sender` | `config.projects[].features.injectSender` | |
| `[projects.platforms.options]` `app_id` / `app_secret` | `config.projects[].feishu.appId` / `.appSecret` | |
| `[projects.platforms.options]` `thread_isolation` | — | TODO(M8)：thread 隔离的配置键核实 |
| `dir_scan_paths` | `config.projects[].dirScanPaths` | /dir 子目录扫描建议列表 + 裸名解析（~ 展开；M7-d #3） |
| `[projects.feishu_workspace]` `wiki_space_id` / `folder_token` / `wiki_node_token` / `description` | `config.projects[].feishuWorkspace.wikiSpaceId` / `.folderToken` / `.wikiNodeToken` / `.description` | bot 默认飞书空间，经 setup 钩子注入（M7-d #18）；创建落位优先级 wikiNodeToken > wikiSpaceId > folderToken |
| `[display]` `tool_messages` / `tool_progress` / `plan_max_len` / `thinking_messages` / `thinking_max_len` | 插件行 `config.display.toolMessages` / `.toolProgress` / `.planMaxLen` / `.thinkingMessages` / `.thinkingMaxLen` | 键名 camelCase；`progress_spinner` 同理（`progressSpinner`） |
| （隐含）会话存储位置 | `session-persistence-jsonl` 行 `config.root` | 旧 dsh 后端为 `~/.dsh/cc-connect-sessions`，新 daemon 用 `~/.dsh/feishu-bridge-sessions`，root 可对齐实现 resume 兼容（TODO(M8)：cutover 会话兼容验证） |
| `[chatroom]` / `[subtask]` / `[group_name]` / `[predict_next]` / `[turn_summary]` / `[plan_render]` / `[projects.monitor]` / cron / relay | — | TODO(M5/M6/M7)：各域落地后补映射行 |

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

launchd 模板把标准输出/错误写到 `@LOG_DIR@/feishu-bridge-stdout.log` 与 `feishu-bridge-stderr.log`（本机现值 `~/.dsh/`）。TODO(M8)：常用排障 grep 组合、日志轮转策略、watchdog 探活参数。

### 3.2 WS 独占

同一飞书 app 的 WS 事件同一时刻只归一个进程消费：新 daemon 与旧 cc-connect 不能同时持有同一个 bot。任何切换（切流或回退）都必须遵守 §4 的顺序。完整背景见 MIGRATION.md 附录 B「WS 独占」段。

### 3.3 reload 流程

- TS 代码改动：§1.3 两步构建 → 重启进程（macOS `launchctl unload` + `load`；Linux `systemctl --user restart feishu-bridge`）。
- profile yml / 插件 config 改动：Cordis HMR 事务热载，无需重启。
- TODO(M8)：reload 脚本封装与 idle 会话回收（对齐旧 cc-connect-bridge 的 reload.sh 语义）。

## 4. 回退（回旧 cc-connect）

前置：旧 cc-connect 仍被 systemd/launchd 监督且对应 project 段在 `~/.cc-connect/config.toml` 中被注释（切流时留的备份）。回退一个 project：

1. 取消注释 `~/.cc-connect/config.toml` 中该 project 段。
2. `launchctl kickstart -k gui/$(id -u)/com.cc-connect.service`（旧进程重启并拿回 WS）。
3. `launchctl unload ~/Library/LaunchAgents/com.dsh.feishu-bridge.plist`（停新 daemon；若只回退部分 project，改从新 daemon 的 `cordis.patch.yml` 移除该 project 段——HMR 生效，不必停进程）。

顺序不可换：先让旧进程拿回 WS，再停新进程。TODO(M8)：双活窗口内的消息补投语义与会话兼容（同 root resume）验证。

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
- 开机自启：user unit 需要 `loginctl enable-linger <user>`（TODO(M8) 写入部署清单）。
- 重启后状态恢复：会话由 jsonl 日志在下一条消息时自动 resume；路由/cron/账本从磁盘 store 恢复；进行中 turn 回滚到最后完整 turn。
