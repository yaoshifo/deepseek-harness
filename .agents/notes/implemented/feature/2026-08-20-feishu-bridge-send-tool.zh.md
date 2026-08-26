# Agent Note: feishu_bridge_send —— agent 发文件给用户的投递工具

Status: implemented

[English](2026-08-20-feishu-bridge-send-tool.md) | 中文

## Problem

在 cc-connect 里，agent 用 `cc-connect send --file/--image` CLI 投递生成产物，`AgentSystemPrompt()` 告知每个 agent 这条通路存在。保形 TS 移植后这条链恰好断在一个环节：`Engine.sendToSessionWithAttachments`（Go `SendToSessionWithAttachments` 的移植，含 attachmentSend 门控、能力先行检查、sideText 去重）M1 就已就位并有引擎测试覆盖，但没有任何 model 可见的入口调用它——等消费方的 dead code。普通会话不注入能力 prompt（D4 设计用自述工具替代了 Go 的注入式 prompt），chatroom persona 又刻意删掉了 Go `ChatroomRoleBaseSystemPrompt` 的产物投递段等 send 工具落地。于是「把那个文件发我」最多得到回复里的一句路径；用户在聊天窗口收不到任何东西。

## Decision

`src/tools/send.ts` 注册 `feishu_bridge_send`（计划 D4，与其余五个工具族并列，挂在 `index.ts` 共享的 caller-agent `route` 上）：参数为 `files: string[]` 加可选 `message`。工具读取每个本地路径（移植 Go `readAttachment` 的本地分支：读取前做存在性 + 50MB 上限检查，扩展名表 mime + magic-byte sniff 兜底），把 `image/*` 归入 `ImageAttachment`（图片消息）、其余归入 `FileAttachment`（文件消息），然后调 `engine.sendToSessionWithAttachments(sessionKey, message, images, files)`。相对路径按新增的 `Engine.sessionWorkDir(sessionKey)` 解析——per-chat `/dir` override，无则 agent 基础工作目录——即 Go CLI 按子进程 cwd 解析的进程内等价物。工具 description 是普通会话唯一的发现面，把契约写明：文本回复里的裸路径不会被投递；随文件发送的 `message` 不要在普通回复里重复。chatroom base persona 以工具形恢复了产物投递段，research 角色/研究助手的「仅在被要求可视化时」句也点名 `feishu_bridge_send`。

两处刻意裁剪。Go 的 http(s) URL 拉取分支未移植：agent 产物都在磁盘上，且 daemon 拉取 model 指名的任意 URL 是一个没有现网消费方的攻击面。单一 `files` 参数 + 按 mime 分类替代了 Go 分开的 `--image/--file` 旗标；天花板是用户想让图片以可下载文件而非图片消息投递时无法表达（修法是在现有参数上加 `asFile`）。

## Alternatives considered

**教 agent 经 lark 工具（im +send；注册名 `lark-cli`，见 [lark-cli 命名与 skills 路由 note](2026-08-25-feishu-lark-cli-naming-and-skills-routing.zh.md)）投递。** 否决：这会让 model 自己拼一个没有可靠来源的 chat_id，绕过 `attachmentSend` 配置门控与 sideText 去重路径，还丢失引擎路径保留的 reply-context 引用关系。

**给普通会话注入镜像 Go `AgentSystemPrompt()` 的能力 prompt 段。** 否决作为第一步：既有工具族（cron/relay/subtask/chatroom）全部只靠 description 被发现且真机可用；为一个可能不存在的问题给每个会话改模型可见输入不划算。若真机冒烟发现 model 用路径回答而非调工具，它是点名的 fallback。

**移植 Go 的 `setupMemoryFile`（`/bind setup`、`/cron setup` 把 CLI 指令写进 agent 记忆文件）并接线 `RelaySetupOK`/`CronSetupOK` i18n key。** 否决：该机制服务无系统提示注入能力的后端；dsh 下每个会话都有原生 section 机制，Go 的 `setupNative` 分支恒胜。两个 i18n key 保留为已移植未接线残留，记入 README Known Limitations。

## Consequences

agent 现在可以把任意本地产物作为真正的文件/图片消息投递到用户所在会话，受 `attachmentSend` 门控、由 caller agent 路由——最后一个没有进程内等价物的 Go CLI 面就此闭合（FEATURE-PARITY #62 行）。monitor `no_report` 子群与 chatroom 角色经共享的工具注册和恢复的 persona 段获得同一能力。调查顺带发现：普通 subtask 子会话（`CC_SUBTASK=1` 非 research）从未收到 `subtaskAgentSystemPrompt` 回报前导，`CC_SUBTASK_NO_REPORT` 从未收到 no-report 前导——`buildSessionSetup` 只消费 research-assistant 旗标，而 Go 的 `buildAppendSystemPrompt` 以 `CC_SUBTASK` 为键（research assistant 恒带两旗标）。同日已修：adapter 的 subtask 分支保形移植 Go 的 `CC_SUBTASK` 选择（回报前导；no-report 前导经新增的 `subtaskNoReportAgentSystemPrompt`；research 契约叠加其上），并补上 Go 经 env 注入的 workspace section。

## Testing

`tests/tools/send-tool.spec.ts` 经真实 Cordis Context + ToolRuntime 跑工具：caller 路由进 `sendToSessionWithAttachments`（session key、message、图片/文件拆分）、纯文件与相对路径（project-state workdir override）投递、缺文件与空列表报错、50MB 上限在读取前拒绝、attachmentSend 关闭报错上浮、外来 caller 拒绝、HMR 注销。`tests/engine/chatroom-persona.spec.ts` 钉住恢复的投递段。真机冒烟（测试群里收到文件消息 + 图片消息）按 MIGRATION.md 流程执行。
