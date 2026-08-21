# Agent Note: 工具进度卡片上的 Subagent 活动——被路由丢弃掩盖的血缘投影

Status: implemented

[English](2026-08-21-feishu-bridge-subagent-card-projection.md) | 中文

## Problem

cc-connect 时代的卡片只展示父会话的事件：被委派的 subagent 子级运行在自己的会话里（自己的持久化日志、自己的 `parentSession` header），`DshAgentAdapter` 按 session id 经 `liveSessions` 路由 `session/event`，子级 id 永远匹配不上，因此子级内部的工具调用在委派期间不可见——卡片上只有父级那次 `subagent` 工具调用及其结果。盯着卡片的用户既看不到正在运行的子级在做什么，也看不到会话用过几个子级。

事件本来就到达了 adapter：`session/event` 是进程级 firehose，其 scope 过滤对 untagged 监听器全放行（`packages/core/scope/src/index.ts` 的 `scopeTarget`），而 adapter 的监听器就是 untagged 的。子级事件被收到后，在 `liveSessions` 查找处被丢弃。

## Decision

`DshAgentAdapter` 的 `session/event` 处理器在 session id 不是活跃 bridge 会话时回退到血缘归因：沿 `session.header.parentSession` 链经 `ctx.agents` 逐级上溯（上限 8 跳），直至命中活跃 bridge 会话，再把事件投影进该会话的 channel。直接子级、孙级及更深的后代都归因到同一个 bridge 会话；链断裂（中间某级会话已不在线）则丢弃事件，维持子级不可见的旧行为。`/fork` 会话与 one-shot 查询会话没有误归因风险：fork 会话自身注册进 `liveSessions`（直接路由），one-shot 会话不设置 `parentSession` meta。

`DshAgentSession.projectSubagentEvent` 只投影 `tool/call`、`tool/result` 和每个子级的第一条 `turn/start`——子级的 assistant 文本和推理留在它自己的 transcript 上，否则一个话痨子级会淹没父级卡片。子级工具 id 命名空间化为 `${childSessionId}:${callId}`，使结果在父级调用交错时仍精确配对到自己的调用（否则卡片的位置回退匹配会用子级结果关闭某个父级条目）。累计的 `seenChildren` 集合对每个运行过 turn 的子级会话计一次数，计数增长时发出 `subagent_status` channel 事件——永不减少，因为集合只增：一个可继续子级跑多个 turn 只计一次，已完成卡片上的计数对仍在运行的后台子级也保持为真。

引擎把子级工具调用渲染为委派标签——标题行显示 `⚙️ subagent`（真实工具名经条目的 `fullName` 落在 code block 里，形如 `read -> /path`）——并把 `subagent_status` 消费到卡片的置顶统计区，显示为 `🤖 Sub Agent：N`（为零时隐藏；N 为运行过的子级累计数）。子级事件被排除在它可能污染的父级区块之外：子级的 `todo_write` 绝不替换父级的 Task List 区块，子级的 `Write` 绝不提升 plan 文件路径，子级的工具结果在 compact writer 拒收时绝不回退成独立聊天消息。

## Alternatives considered

**用未关闭的 `subagent` 工具调用数计数。** 否决：后台委派的工具结果立即返回（运行时通知稍后才到），按打开的调用计数天生少计；按子级计数对前台和后台子级都跟踪真实活动。

**连子级的 assistant 文本和 thinking 一起投影。** 否决：卡片是工具进度面板；子级的散文会与父级的实时播报区块交错，淹没环形缓冲区。

**给结构化卡片 payload（`ProgressCardPayload`）扩展 subagent 计数字段。** 暂缓：本部署渲染的是 streaming preview 卡片；结构化 `card` 样式需要自己的计数管线。结构化路径只拿到标签（entry `tool: 'subagent'`），是零 schema 变更的顺手支持。

**按 turn 边沿增删计数，另加 `session/disposed` 泄漏兜底。** 否决：累计计数根本不需要拆除——集合只增，子级即使中途死掉没有 `turn/end` 也不会泄漏或少计。

## Consequences

委派期间卡片现在能展示子级活动。孙级工具调用与子级调用显示完全相同——没有深度指示。计数按 bridge 会话隔离、在整个会话生命周期内累计，所以长命聊天的数字反映它累计用过多少 subagent，而非并发数；回合之间缓冲的子级事件在下个 turn 的 channel drain 时被丢弃，计数在下一次 `subagent_status` 发射时补齐。`subagent_status` 与 `fromSubagent` 是引擎内部事件词汇（`src/core/types.ts` 的 `EventKind`/`Event`），不是 wire 或持久化格式：没有任何东西跨进程边界。

## Testing

`tests/agent-dsh/adapter-subagent.spec.ts`（7 例）：直接子级投影与命名空间 id、累计计数发射（仅首条 turn 边沿；重复与后续 turn 不再增加）与非工具事件过滤、按子级去重计数加孙级链归因、无血缘/断链/深度超限会话的丢弃路径。`tests/engine/engine-subagent-card.spec.ts`（4 例）：`⚙️ subagent` 标签与正文里的真实工具名、按条目精确回填结果、子级重写 todo 时父级 Task List 区块的保全、子级结果的独立消息抑制（父级结果照常投递）。`tests/streaming.spec.ts` 新增条目标签渲染与计数行的显示/隐藏行为（计数未变时跳过 flush）。真机冒烟按 MIGRATION.md 的 reload 流程执行。
