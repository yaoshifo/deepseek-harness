# dsh-feishu-bridge

[English](README.md) | 中文

cc-connect 的编排能力（engine + 飞书平台）迁入 dsh 的单插件形态：一个长驻 dsh 进程按配置为每个 project 组装一个 Engine + 一个飞书 WS 平台（官方 node-sdk 长连接，D5），agent 会话经 `ctx.agents` 原生创建，不再有桥协议。迁移计划、里程碑与决策记录见 [docs/MIGRATION.md](docs/MIGRATION.md)；61 项 feature 对照见 [docs/FEATURE-PARITY.md](docs/FEATURE-PARITY.md)；部署与配置映射见 [docs/OPERATIONS.md](docs/OPERATIONS.md)。

插件结构：

| 目录 | 内容 |
|---|---|
| `src/engine/` | Go `core/` 保形移植：事件状态机、会话、命令、cron、relay、chatroom、monitor、i18n、附件暂存 |
| `src/feishu/` | Go `platform/feishu/` 移植：WS、API client、卡片、进度卡、群管理、标签、头像、媒体、引用消息抓取 |
| `src/agent-dsh/` | Agent 接口 → `ctx.agents` 适配器（D1/D3：setup 钩子、provider 路由、审批/问题/plan 接线） |
| `src/tools/` | `feishu_bridge_subtask / cron / relay / chatroom / lark` 工具族（D4：caller agent 路由，免 env） |
| `skills/` | 修订版技能（`feishu-bridge-` 前缀），经 profile `customSkillDirs` 加载 |

模型可见面：入站消息（含引用链前缀、暂存附件路径注记）进 prompt；出站经卡片系统（进度卡/完成卡/审批卡）；CC_FEISHU_* 工作空间路由经 D3 setup 钩子注入系统提示段。

## Model Experience

### 请求上下文与条件

#### 模型可见内容

本插件不直接构造 LLM 请求——所有模型输入经 dsh agent 层（会话日志可完整重放），插件贡献的模型可见文本均为条件注入且按 Go 原文保形：入站 prompt 携带用户文本、引用链前缀（`[Quoted message from X]:` 单条格式或 `--- Reply chain (n messages) ---` 编号链）、暂存附件路径 bullets 与 `(Images saved locally, please read them: <paths>)` / `(Files saved locally, ...)` 注记；配置了 feishuWorkspace 的项目经 setup 钩子随会话注入「默认飞书工作空间」系统提示段（CC_FEISHU_* 值 + 创建优先级；chatroom bare persona 整体替换系统提示、不含此段）；`feishu_bridge_subtask / cron / relay / chatroom / lark` 工具族注册进 dsh 工具目录，lark 工具结果为 lark-cli 子进程 stdout/stderr 原文。

#### token 开销

条件注入：无附件/无引用/无 workspace 配置时均为零直接 token 开销；引用链上限 5 条消息；附件注记只含路径不含字节。

#### KV Cache 影响

引用前缀与附件注记附加在每条用户消息内（append-only 对话前缀，缓存友好）；workspace 系统提示段是每会话固定前缀段，会话内 prefix-stable；lark 工具结果作为工具消息一次性进入上下文，不回改历史。

## Known Limitations and Deferred Work

- **lark 工具仅支持 Feishu 域（open.feishu.cn）**：插件平台侧整体未移植 Go `larkCreds.Brand`（lark.com 双域名）；需要 lark 域时在 `src/tools/lark.ts` 与平台 client 引入 brand 维度。
- **引用消息的发送者名不解析**：平台从不经通讯录 API 解析联系人名（M1 起的既定裁剪），引用链里发送者渲染为 `User`/`Bot`；需要真名时随平台补 `resolveUserName` 缓存。
- **`reply_footer`（#11）未接线**：Codex 式状态页脚依赖 model/effort 能力 getter 与 ctx%/usage 计算（#1 usage 域），归 M7 usage 里程碑；当前 `features.replyFooter` 键声明但不转发，默认关。
- **卡片按钮回调无法自动化测试**：`card.action.trigger` 只能真机点击验证（飞书平台无回调模拟 API）；按钮路径靠纯函数表测 + 真机冒烟覆盖。
- **多工作空间（multi-workspace）未迁移**：channel→workspace 绑定（Go workspace_binding.go）与 per-workspace agent 池未接线；单工作空间 + `/dir` per-chat override 承担现网需求，E 群清查记为 C 类。
- **/fork 只能从 live 父会话 seed**：Go 读持久化日志复制已完成 turns，TS 侧父会话不在内存时退化为全新会话（adapter startSession 的已注释天花板）。
- **chatroom picker 状态为内存态**：daemon 重启后旧选择卡成孤儿（Go 保形）；plan-render/usage/predict-next 等 M7 剩余域按 MIGRATION.md 队列推进。
- **`nav:/help` 按钮无效**：cron 卡片的返回按钮指向 Go 的 help 卡体系（`renderHelpGroupCard` + `nav:` 帮助导航），该体系未移植；点击会进 engine 打 "no handler" 日志而非静默消失。根治是移植 help 卡族；`/dir` 选择卡同样因此不带返回按钮。
- **`/list`、`/status`、`/switch` 仍是纯文本**：Go 侧渲染 `renderListCardSafe`/`renderStatusCard` 卡片并带 `act:/list switch|delete N` 动作；TS 命令保持文本输出，待该渲染域移植。
