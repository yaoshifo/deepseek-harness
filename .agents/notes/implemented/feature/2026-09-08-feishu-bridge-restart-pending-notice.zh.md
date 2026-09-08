# Agent Note: daemon 崩溃后排队输入通过重启通知保持可见

Status: implemented

[English](2026-09-08-feishu-bridge-restart-pending-notice.md) | 中文

## 问题

轮次进行中排入 inbox 的输入是持久的（`agent/inbox/spliced` 会话事件），但 daemon 崩溃杀死驱动时输入仍处 pending：没有任何东西告诉聊天，下一条消息会连带领取它看不见的消息。pending 数据本就可通过 session-query 冷观察与 inbox 投影读到——重启时无人消费。

## 决策

platforms-ready 时引擎上报恢复的 pending 输入：对每个活跃聊天会话（排除机器侧会话——`relay:` 管线、`#cron` 槽位），其持久化 agent 会话仍有 pending 消息的，聊天收到一张一次性橙色卡片，写明条数与「随下一条消息一并送达」。只做可见性——不自动唤醒。

## 机制

- 引擎把冷读委托给宿主接线的 `EngineInboxReader`（`pendingCount(sessionId)`），寻址用 agent 侧会话 id，而非引擎内部记录 id。
- `createPendingInboxReader` 在观察前把 `inboxProjectionDefinition` 注册到投影注册表：该单元否则只在某个 agent 拥有 inbox 后才存在，platforms-ready 时一个都没有——不注册则每次读取静默返回 0。该定义现从 `@deepseek-ai/dsh-agent-loop` 导出（一行上游 graft，已记台账）。
- 观察请求 `projectionMode: 'all'`；默认值不动投影状态、不返回值。
- 引擎的会话 id 取 `findActive(key)?.agentSessionID`（持久化键）。

## 考虑过的替代方案

- 用合成「继续」消息自动唤醒聊天：否——为用户没发过的内容花一次模型请求；若通知不够再作产品决策。
- 手工折叠 `agent/inbox/spliced` 事件而非注册投影单元：否——重造已发布格式的折叠逻辑，splice 语义变更时静默漂移；导出定义保持折叠唯一权威。

## 后果

- 通知在崩溃（kill、断电）后触发。优雅停机会先取消 pending 输入（轮次 unwind 期间写 `outcome: "canceled"` 的 splice），干净 reload 不产生通知——两条路径可区分且都是有意为之。
- `SessionManager.activeSessionKeys()` 是新的公开枚举访问器；`EngineInboxReader` 可选，无接线时上报静默。
- 真冷读测试钉住崩溃语义：排队的 steer 落盘、不 unwind、新组合在同根上数到它；从未持久化的 id 读 0。
