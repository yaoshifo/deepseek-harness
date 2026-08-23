# Agent Note: feishu-bridge 去包袱第一批 — 原生信号与单一来源机制

Status: implemented

[English](2026-08-23-feishu-bridge-native-signal-projection.md) | 中文

## Problem

cc-connect 迁移在凡有 dsh 原生等价物处都保留 Go 形状，理由是保形才能机械翻译 700+ Go 测试。cutover 后该交易到期，四个机制在持续付息：

- adapter 的 `session/event` 投影静默丢弃 `tool/result` 失败身份、`todo/write` 快照与 compaction 生命周期。进度卡的 🔴 失败计数与 🗸 压缩计数因此没有生产者，置顶待办段只能靠 `JSON.parse` 解析 `todo_write` 工具入参重建。
- `listSessions` 只返回 live 会话，旁边挂着一条声称 dsh 无持久化会话枚举 API 的 `TODO(M7)`——`session-persistence` 长出 `list()` 后该断言已不成立。`/sessions` 与 `/switch` 对 daemon 重启前的所有会话失明。
- 回滚 fork（引用消息的 `/fork`）持久化一份截断日志副本（`persistence.create` + `append`）再 resume——这是 Go 时代 agent 作为外部 `--resume` 进程、只能被指向文件的形状。
- 渲染会话 prompt 内联一份 vendored 的渲染 skill——与 `skills/` 内容形成双份维护——且模型可见措辞仍自称「cc-connect 内部」session。

## Decision

每个机制改用原生来源直连；不再保留 Go 形状的边带通道。

- **投影携带原生信号。** `EventKind` 增加 `compaction` 与 `todo_update`；`Event` 增加 `toolSuccess?: boolean`（缺省即成功，无失败身份的发射方不受影响）。adapter 把 `tool/result.error` 投影为 `toolSuccess: false`、`todo/write` 投影为整表 `todo_update`、`compaction/start` 投影为 `compaction`。引擎以真实 success 值把静默模式条目标红，按 Go `EventCompaction` 语义递增 `state.compactionCount` 并以 i18n 摘要落 compact 进度条目（无活跃预览卡时降级为聊天消息），快照整体替换待办段。子代理子会话的 `todo_update` 不触父卡片——子列表留在子会话自己的 transcript。
- **`/sessions` 枚举会话存储。** `listSessions` 合并 live 会话与 `sessionPersistence.list()`，过滤为 `parentSession` 未设、`cwd` 是项目目录或其后代（worktree 在列；其他项目的会话与树外的 per-chat `/dir` 会话不在列，对齐 Go per-cwd 存储语义）。`enrichSessionSummaries` 在 `messageCount` 为零时以 SessionManager 的截断历史（上限 100 条）补齐——摘要本就从那里富化，持久化行因此带标题与条数渲染。
- **fork-at 是一次 seeded create。** `prepareForkAtSession` 仍经 `locateForkCut` 截断，但把前缀暂存 adapter 内 map 而非持久化副本；`__forkat__<newID>` 哨兵消费它执行 `agents.create({ sessionId, seed, meta: { cwd, parentSession, seedLength } })`。`seedLength` 按 [seed-boundary note](../testing/2026-06-22-fork-child-replay-seed-boundary.zh.md) 保持显式。prepare 与 start 之间 daemon 重启会丢暂存 seed；哨兵随即按无源 fork 同款降级为全新会话并 `console.warn`。
- **渲染 skill 单一来源。** `skills/feishu-bridge-render/SKILL.md`（frontmatter `disable-model-invocation: true`、`user-invocable: false`——注册但不广告）是唯一副本；渲染 prompt 以正文为参数，fork 时从 `ctx.skills.get('feishu-bridge-render')` 解析。正文为空或缺失时逐层 fail loud：纯 prompt 构造器带部署指引抛错、渲染入口 rejection、编排层 IIFE 预检后记日志并把渲染卡置 failed、跳过重试——markdown 卡仍是用户可见兜底，但不存在静默的空 prompt 渲染。预取正文进 prompt 的手法保留（省一次模型往返）；变的只是正文来源。
- **模型可见文本去 cc-connect 品牌。** 发送者注入前缀渲染为 `[feishu-bridge sender_id=…]`；渲染会话 prompt 与 skill 正文自称「feishu-bridge 渲染会话」。工具图标表在 Claude Code 名之外覆盖 dsh 工具命名空间（`read`/`write`/`lsp`/`subagent_fork`/`feishu_bridge_*`…），而派发标签 `subagent` 保持 Go 锚定的 ⚙️/蓝色渲染——移植测试钉死了它，且它是投影标签不是工具名。

## Alternatives considered

- **给 `MessageSourceMap` 扩 Feishu user source 承载发送者身份**，替代文本前缀。暂缓：这要改 `dsh-llm` 包和会话日志语义，而该信息本就需模型内联可见；改名后的前缀让「model-visible ⟺ logged」平凡成立。随更大的交互 seam 收敛再议。
- **只消费 todo 快照、放弃工具入参解析。** 否决：Claude 风格 `TodoWrite` 发射方与原生工具都在喂这一段；两条路径设同一列表，后写胜出。
- **fork-at 保留持久化副本。** 否决：写下的持久状态唯一读者就是紧随其后的 create；seed 选项正是此事的原生机制。
- **从 SessionManager 的 `sessions.json` 枚举会话。** 否决：「哪些会话存在」出现两个权威；持久化层是存在性权威，SessionManager 仍是摘要/条数权威。

## Consequences

- 🔴/🗜 统计与重启后的 `/sessions` 如实呈现 FEATURE-PARITY 表早已声称的行为；fork-at 与渲染管线不再维护原生路径可替代的工件。覆盖见 `tests/agent-dsh/adapter-projection|adapter-list|adapter-fork-at.spec.ts`、`tests/engine/engine-events.spec.ts` 的 native-signals 块、`tests/engine/plan-render*.spec.ts` 的 fail-loud 用例。
- 部署渲染 skill 变更需把 `customSkillDirs` 接到包内 `skills/` 目录——这也会首次把 `feishu-bridge-subtask` 与 `feishu-bridge-chatroom-moderator` 载入模型目录（D4 本意；生产 profile 从未指向那里）。接线落地前，升级后 daemon 的首次 plan/reply 渲染按设计 fail loud。
- fork-at 世系变了一个字段：子会话 `createdAt` 是 fork 时刻而非源会话创建时刻；`parentSession` 与 `seedLength` 承担 Go 副本靠复制 header 保住的世系信息。
