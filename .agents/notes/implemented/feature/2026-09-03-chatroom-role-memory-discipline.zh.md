# Agent Note: chatroom 角色跨场记忆纪律

Status: implemented

[English](2026-09-03-chatroom-role-memory-discipline.md) | 中文

## 问题

chatroom 工具描述向主持人承诺角色有「跨场积累的记忆」：每个 persona workdir 派生一个按角色的项目记忆目录（dsh-memory，`~/.claude/projects/<slug>/memory/`），同一 persona 跨聊天室持续积累。通道可达但无人使用——chatroom persona 是 `complete: true` 整体提示词替换，会把 dsh-memory 的策略段从系统提示词里丢掉，且 chatroom 的提示词文本从不提记忆；角色只能靠工具 schema 自描述偶然发现 `memory_*`。生产复挖（2026-09-03，Mac 部署）：7 个角色项目目录，零个 `memory/` 子目录——没有任何角色写过记忆。

## 决策

`chatroom-persona.ts` 一处提示词层新增，无引擎/schema/会话事件/持久化改动：导出 `chatroomRoleMemoryPrompt()`，由 `buildChatroomSystemPrompt` 在 `isRole || isDirect` 时追加（research 角色经基础角色契约自动继承；主持人与助手不携带）。纪律内容：每场聊天室把同一 persona 解析到同一个记忆目录、开局注入其索引；持久判断一旦形成当场写——被验证有效的分析路径、用户确认过的偏好与约束、对反复出现议题的立场演化；先 `memory_write` 再 `memory_index`；只记可复用判断、不记单场流水、没有就跳过。选择「当场写」而非「收场写」：end 屏障只排空在途回复后拆会话、没有收场轮，角色感知不到收尾。

## 备选方案

**把 dsh-memory 策略段恢复进 complete persona**：把 `MEMORY_PROMPT` 引入 persona 装配会把冗长的记忆管理策略复制进每场聊天室的 N+1 份 persona；纪律段只点名聊天室角色需要的部分（何时写、留什么），一小段搞定。

**收场时写**：指示角色在聊天室结束时保存，假设了一个永不到来的收尾信号——没有收场轮，end 屏障只排空在途回复。

**主持人记忆纪律**：范围外——主持人的 workdir 是跨其所有聊天室共享的聊天室 home，属跨场编排域而非按 persona 的身份记忆域。

## 后果

- 每个角色与直聊会话增长一小段固定提示词文本；包 README 的模型体验、Token 与 Known Limitations 段一并说明。
- 遵从是提示词层约定，只能按已记录的零写入基线复挖会话日志度量；后续轮次的验收信号是真实聊天室之后角色项目目录下出现 `memory/`。
- 由新 spec 钉死：role、research、direct persona 携带纪律段；moderator persona 不携带；纪律文本钉住「当场写」与「不记流水」语义。
- chatroom 表面的 keyless 录制会话快照维持被阻塞（语料零 chatroom 案例——自 2026-08-31 scan3 轮延续）。

## 关联

- [Claude memory 全局 scope](2026-08-25-claude-memory-global-scope.zh.md) 拥有本纪律所依托的 memory 插件 scope 设计。
- [chatroom 用户背景注入与研究澄清](2026-09-03-chatroom-user-profile-and-research-clarify.zh.md) 与本改动共用 persona 装配注入面。
