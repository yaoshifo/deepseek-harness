# dsh-feishu-bridge-chatroom（中文）

[English](README.md) | 中文

飞书桥的 chatroom 插件：多角色聊天室编排——角色组、主持人、`/chatroom` 命令族、`feishu_bridge_chatroom` 工具与内置 chatroom-moderator skill——作为独立的 dsh 包，挂载在 `@deepseek-ai/dsh-feishu-bridge` 旁（依赖方向：本包引用桥的导出面；桥绝不引用本包）。引擎接缝的两半走桥服务的 `feishuBridge/*` 事件；各引擎的配置与命令注册在插件启动扫描中应用，时机是桥报告就绪之后。

## 模型体验

### 模型看到什么

- `feishu_bridge_chatroom` 工具（family 标签 `feishu_bridge_chatroom`）：主持人通过其 actions（`start` / `ask` / `gather` / `pick-roles` / `pick-topic` / `ask-human` / `end` / `list` / `note`）编排聊天室；角色 persona 通过整体提示词替换引用它。
- Chatroom persona：role、direct-role、moderator 与 research-assistant 会话以完整系统提示词替换运行，提示词由 persona 目录的扁平化 CLAUDE.md 加参与/研究契约组装（由 session-start-options 监听器预计算；adapter 将其注册为 `complete: true` section）。
- Moderator priming 与唤醒消息（gather 扇入摘要、end-barrier 收束、重启恢复 note），以及随 subtask 启动选项携带的 research-assistant 前言。
- 内置 `feishu-bridge-chatroom-moderator` skill，作为隔离的 skill provider 挂载。

#### Token 影响

工具描述与 schema 会在注册了该工具的项目里到达每个 dsh agent（工具是进程级、按调用方路由的）。Persona 提示词整体替换各 chatroom 会话的系统提示词而非追加；moderator 唤醒与 relay 卡是用户可见消息，不进模型请求。

#### KV Cache 影响

Chatroom 会话使用整体替换的 persona 提示词，因此每个 role/moderator 会话拥有各自稳定的前缀；工具 schema 会对桥自有 agent 的模型请求做扩展，叠加（而非使其失效）其可复用前缀。

## 已知限制与延后工作

- **就绪前窗口**：桥的引擎启动到本插件 `whenReady()` 扫描之间平台投递的消息，会按默认值的 chatroom 配置处理（无 roles 目录覆盖、ledger 关闭）——这是桥内接线所没有的窗口。它结构性源于兄弟插件的挂载顺序；恢复及之后所有轮次看到的都是扫描后的配置。
- **卸载插件丢失内存态聊天室状态**：已武装的 barrier 实例、进行中标记与 gather 轮次戳都是进程内的；dispose 插件 fiber 即丢弃。持久化的 `featureState.chatroom` 段保留——各会话访问器就地写入，无 codec 的保存会原样持久化——重启后的 barrier 恢复走持久化快照而非实例。
- **Picker 状态在内存**：daemon 重启会丢弃已武装的 picker；孤儿 pick 卡的下次点击会原位换成灰色过期卡并提示重新 `/chatroom`（Go 版对孤儿按钮是静默或假确认）。
- **部署迁移是手动的**：生产 profile 在其自演化的 `cordis.patch.yml` 里把 chatroom 段放在 `feishu-bridge` 行下；桥现在会对这类残留 fail loud，需要把段迁移到本插件自己的配置（`defaults` + 按 `projects`、以桥项目名为键）。迁移片段与 profile 模板更新随 C3 部署批次落地。
- **REAL 组合面的覆盖**：apply/HMR spec 把插件挂在真实 Cordis 服务上（事件总线、工具注册表、skill 注册表、桥服务），但未经过 Loader 与 `cordis.yml`；走 Loader 的组合测试与生产 `/reload` 冒烟清单随 C3 落地。
