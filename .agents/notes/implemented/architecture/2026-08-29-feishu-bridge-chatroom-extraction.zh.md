# Agent Note: chatroom 功能抽取为 feishu-bridge-chatroom 包

Status: implemented

[English](2026-08-29-feishu-bridge-chatroom-extraction.md) | 中文

## Problem

chatroom 功能（角色群、主持编排、`/chatroom` 命令族、`feishu_bridge_chatroom` 工具、其 i18n key、其 skill、以及 `ChatroomConfig`）原本住在 `packages/acp/feishu-bridge` 里：每次 chatroom 改动都要动 bridge 内部，bridge 也背着一个没有扩展契约的产品功能。抽取把这一切搬进 `@deepseek-ai/dsh-feishu-bridge-chatroom`，与 bridge 并排挂载，依赖方向 chatroom → bridge，行为零变化。[C1](2026-08-27-feishu-bridge-chatroom-service-events.zh.md) 已把每个耦合点改经 `feishuBridge/*` 分发缝；C2 是完整切换点——代码与配置一批到位，不存在功能无配置或 bridge 反向够到插件的中间态。

## Decision

chatroom 产品面住进兄弟插件；bridge 只持有它们所乘坐的通用缝。

- **搬走**：八个引擎模块（`chatroom.ts`、`chatroom-pick.ts`、`chatroom-cmd.ts`、`chatroom-persona.ts`、`chatroom-priming.ts`、`chatroom-ledger.ts`、`chatroom-roles.ts`、`chatroom-policy.ts`）、`feishu_bridge_chatroom` 工具、主持 skill 目录、i18n 子表，以及十二个 chatroom 专项 spec。插件侧新增文件持有引擎原来代管的部分：`chatroom-state.ts`（每会话活态）、`chatroom-config.ts`（引擎配置存储）、`i18n.ts`（子表）与 `apply` 入口。
- **bridge 保留**：十五个 `feishuBridge/*` 事件声明及其经 `FeishuBridgeService` 的分发（插件的 `chatroom-policy.ts` 为每一个都注册了监听器）；`Engine.registerCommand` / `Engine.registerCardAction` 两个可逆注册缝；不透明的 `Session.featureState` 分节与 codec 注册表；以及 `./exports` 子路径——受支持的窄导入面（服务与分发类型、路由类型、共享引擎符号、平台能力 cast、注册助手），绝不导出整只 `Engine` 类。
- **插件 `apply`** 先注册进程级半边（feature-state codec 与 i18n 子表必须先于首次保存或查找就位），再注册 policy 监听器、工具与内置 skills；`service.whenReady()` resolve 后，先按 bridge 的 live 项目清单校验自己的项目名，再逐引擎扫过——配置、命令，以及对平台先于插件就绪的引擎做 barrier 恢复（其余经 `feishuBridge/platforms-ready` 恢复）。

### 快照 v3 与 featureState codec

`sessions.json` 升到版本 3：插件 feature state 以一个不透明 `featureState` 对象持久化在每个会话条目上，chatroom 的十七个耐久字段按 version-2 扁平名原样嵌到 `featureState.chatroom` 下一级。加载是链式内存迁移：version-1 文件（Go snake_case）先映射到 version-2 camelCase 形态，其扁平 chatroom 字段由加载器原样抬进分节；首次保存把文件重写为 v3。重写是单向的，所以重写前把 pre-v3 文件一次性备份到 `<storePath>.v2.bak`（已存在的备份保留最早的原始文件——回滚读它），且快照版本高于当前构建支持的版本时加载即 fail loud，而不是当作垃圾静默解析。

`FeatureStateCodec` 持有一个分节键：`encode` 在保存时投影分节（undefined 表示该键省略），`carry` 在 `carryChatScopedState` 内把 reset 存活子集搬到后继记录上。没有注册 codec 的分节双向原样透传——bridge 视之为不透明。

### 配置迁移

`ChatroomConfig`（bridge 级 `[chatroom]` 分节、引擎 setter、`wireChatroom`）变成插件自己的 `Config`：`defaults` 加按 bridge 项目名键控的 `projects` 映射。两份项目清单是平行事实源，双向守卫：chatroom 项目名在 bridge 无对应项目时插件加载即失败；bridge 自身 config（顶层或 per-project）残留 `chatroom` 键时——生产 `cordis.patch.yml` 迁移片段未合并的典型症状——bridge 加载即失败。残留键以 `Schema.any` 留在 bridge schema 里，正是因为 schemastery 会静默剥掉未知键：没有它们，残留会凭空消失而不是 fail loud。

## Alternatives considered

- **chatroom 字段留在 `Session` 上，配 typed getter 与内联 barrier 句柄。** 否决：barrier 句柄类型在插件里，`session.ts` 将被迫 import chatroom 包——正是整个抽取要消除的反向依赖。
- **codec 声明 survive-reset key 集而非 `carry` 钩子**（抽取计划决策 3 的原始表述）。否决：armed barrier 是插件内按会话持有的活 `ChatroomGather`/`ChatroomEndBarrier` 实例，插件活态挂在模块级 WeakMap 上——key 集只能点名耐久分节键，搬不动进程本地实例。钩子也让 bridge 无需解释分节内部：搬运是功能代码，分节保持不透明。
- **bridge 保留 `ChatroomConfig` 并转发给插件。** 否决：转发重建反向依赖，且把配置搬移与代码搬移拆开会留下一批界窗口，期间 chatroom 以无配置状态运行。

## Consequences

- **pre-readiness 窗口**：平台在 bridge 引擎启动与插件 `whenReady()` 扫过之间投递的消息，按默认值 chatroom 配置处理——这是内联时代不存在的窗口，属兄弟插件挂载顺序的结构性代价（包 README 已记录）；恢复与之后所有 turn 都见到扫过的配置。
- **卸载插件丢失内存态 chatroom 状态**（armed barrier 实例、in-flight 标志、gather-round 计数）；耐久分节存活，因为插件的访问器就地写 `session.featureState.chatroom`——无 codec 的保存会把它原样持久化。重启 barrier 恢复走持久化快照，而非实例。
- bridge 的 `src/` 里保留的 chatroom 提及恰是缝所需：十七个 version-2 legacy 字段名（原样抬升、绝不解释）、配置残留守卫、version-1 legacy 拼写，以及缝契约需要示例处点名兄弟插件的注释；其余一律中性化为 feature 层措辞。
- 生产部署的自演化 profile `cordis.patch.yml` 仍把 `[chatroom]` 分节挂在 feishu-bridge 行下；在 C3 批次交付迁移片段与 profile 模板更新之前，迁移靠手工完成（bridge 对残留 fail loud，不会漏掉）。
