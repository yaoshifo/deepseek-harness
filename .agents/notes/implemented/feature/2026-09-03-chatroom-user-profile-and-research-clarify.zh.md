# Agent Note: chatroom 用户背景注入与 research 澄清阶段

Status: implemented

[English](2026-09-03-chatroom-user-profile-and-research-clarify.md) | 中文

## Problem

chatroom 会话没有携带用户背景的通道。角色、主持人与 direct-role 会话以 bare persona 运行——`complete: true` 的 section 整体替换装配出的系统提示词，且 adapter 抑制 cwd 指令注入——项目的 CLAUDE.md/AGENTS.md 内容与任何 memory-index section 都到不了它们，角色 persona 又是静态的按角色身份文件。research 模式此外没有澄清阶段：普通聊天室 priming 跑 3 轮用户澄清循环，research priming 却直接进数据需求清单，每轮运行的用户上下文只能从议题文本与中途插话进入（[中途参与](2026-09-02-feishu-bridge-chatroom-midrun-participation.zh.md) 修的是可发现性，不是背景）。

## Decision

两个已落地机制；都是内容层——不改引擎、工具 schema、session 事件与持久化。

- **`userProfile` 配置字段**（chatroom 插件 `defaults` + 按项目 `projects`，`~` 展开，`''` 退出共享默认）：一个纯文本文件，在 persona 装配期读取、以 `## 用户背景（服务对象）` 段追加在角色人设之后——角色、主持人与 direct-role 1:1 一视同仁，research 与非 research 完全同一（单一注入点，`decorateSessionStartOptions` → `buildChatroomSystemPrompt`）。研究助手与数据管家不注入；角色把相关背景写进派给助手的任务文本。未配置 → 提示词与之前逐字节一致。空文件 → 跳段。运行中删除 → 下次 persona 装配带警告跳过（已启动聊天室保留已装配的提示词）。
- **启动引用门禁**：`/chatroom`（所有路径——题目挑选、角色挑选、direct、多角色）与工具 `start` 动作先经 `chatroomUserProfileError` 检查配置的文件；读不到就 fail loud（i18n `chatroom_user_profile_unreadable`，内联路径），而不是让背景从每个 persona 里无声消失。
- **research 澄清阶段**（仅 priming 文本）：数据需求阶段之前的有界前置——一次普通 gather 问各角色需要澄清哪些用户背景/约束/目标（2-4 个多选题建议，或「无需追问」）；主持人合并成一张 `ask_user_question` 卡；回答以「用户背景与约束」note 进账本综述段，下一轮每个角色都能读到。最多 2 轮，之后剩余问题记为假设。已注入的背景为底——只问与议题相关的缺口。议题清晰且背景足够时可整段跳过。普通聊天室的 3 轮澄清循环不动。

## Alternatives considered

**用 `dsh-agent-presets` 做每会话组合（按聊天室配能力/背景）**：在桥 profile 里挂 agent-presets 会把全部桥会话的组合重键到 preset 体系（default preset 变成必填），且 bare persona 本就整体替换装配提示词，提示词层注入仍需自己的通路。需求是内容不是组合——折进既有 persona 装配的一个文件是最小机制。

**把背景 `@import` 进每个角色的 CLAUDE.md**：零代码，但每个角色文件都要加 import 行，主持人与 direct-role persona 还要各加一处，一次改动要碰 N 个文件。一个命名单文件的配置字段是部署自有的等价物，且只有一个家。

**在 research 里复用普通聊天室的澄清循环形状（3 轮、无底稿、不可跳过）**：research 在 30-60 分钟的管家预取之前已经要花分钟级轮次；2 轮上限加「足够即跳过」让管线保持推进，持久背景文件兜住常见情况。

## Consequences

- 背景文本复制进每个角色与主持人 persona（每场聊天室 N+1 份）；部署保持文件精炼。澄清阶段把管家预取推迟至多两个分钟级 gather 加用户应答时长——接受，因为背景决定需要什么数据。
- auto 模式下澄清卡无超时兜底、等用户回答（与普通聊天室澄清循环、收尾卡同暴露）；manual 模式下 research-manual 的 10 分钟 whole-ask auto-default 按默认选项代答。两条都记入包 README 的已知限制。
- 行为由新 spec 钉住：配置解析（`~` 展开、project 覆盖 defaults、`''` 退出）、persona 注入（位于角色人设之后；未配置/空白/缺失即跳段）、policy 接线（角色与主持人 persona 携带文本；研究助手的 subtask 选项不携带）、两处启动门禁（命令回复 i18n 消息且不 spawn；工具 `start` 抛错）、priming 文本（澄清阶段先于数据需求阶段；普通循环保持 3 轮上限）。chatroom 面的无 key 快照仍被阻塞——语料里零 chatroom 用例（自 2026-08-31 scan3 轮沿袭）。

## Related

- [研究数据可靠性](2026-08-27-feishu-bridge-research-data-reliability.zh.md) 与 [research 数据去重](2026-09-02-chatroom-research-data-dedup.zh.md) 拥有同一 priming 的信源与抓取台账纪律。
- [中途参与](2026-09-02-feishu-bridge-chatroom-midrun-participation.zh.md) 拥有澄清阶段所互补的插话通道。
