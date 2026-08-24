# Agent Note: feishu-bridge 去包袱批次 7 —— 会话账本换原生日志

Status: implemented

[English](2026-08-24-feishu-bridge-b7-session-ledger-native.md) | 中文

## Problem

桥的会话账本仍带着三份 Go 时代的、原生 dsh 会话日志已经拥有的状态副本：

- `sessions.json` 沿用 Go 的 snake_case 字段名（每会话约 40 个字段），外加 `past_id_tracking` / `legacy_data` 机制——后者的唯一消费者是 owned-session 过滤。
- 每个桥侧 `Session` 持有一份 100 条的内存 history 副本（engine 里 5 处 `addHistory`、8 处 reset 场景的 `clearHistory`，并持久化进 `sessions.json`），消费点是 token 估算、predict/turn-summary 上下文、`/rename`、`/list` 与 `/status` 的计数、子任务回报兜底、以及 spawned-group 首条消息判定。
- `knownAgentSessionIDs` + `applySessionFilter` + `filterOwnedSessions` + `filterExternalSessions` 配置开关把 `agent.listSessions()` 过滤到桥自己跟踪的会话。独占持久化下存储里的每个会话都是桥自己的——该过滤器删掉的是桥自己的历史会话，这是它唯一可观察的效果。

两个相邻缺口：`SessionHeader` 没有 `updatedAt`，`/list` 只能按 `createdAt` 给持久化会话排序（用了一周的会话按出生日期排）；未迁移的 `/show` 命令的 `show_*` i18n 键死在键表里。

## Decision

- **`sessions.json` version 2** 是桥自有的 camelCase schema（`agentSessionID`、`subtaskDepth`、`worktreePath`……；默认值字段省略；无 `history`、无 `past_id_tracking`、无 `legacy_data`）。读到 version 1 文件（Go 字段名，含无版本号的 Go 时代文件）时在内存中一次性迁移；首次 save 落盘为 v2。`legacyData` 机制随它服务的过滤一并退役——迁移后的文件不存在 legacy 判定需求。
- **owned-session 过滤删除**（`knownAgentSessionIDs`、`applySessionFilter`、`filterOwnedSessions`、engine 标志、配置键与 profile 模板行）。`cmdList`/`cmdSwitch` 直接消费 `agent.listSessions()`。`/list` 的子会话排除不变——那走 adapter 的 `parentSession` 判断，不是这个过滤。
- **history 副本替换为原生日志的 recent-turn 投影。** `DshAgentAdapter.recentTurns(agentSessionID, limit)` 是唯一读面（`Agent` 上的 `RecentTurnsReader` 能力，经 `asRecentTurnsReader` 解析）：live 会话读 `DshAgentSession` 上增量维护的窗口——在 `startSession` 时从 resumed/forked 日志播种，由已接线的 `session/event` 事件流增长（每条人类 `user/message` 一条 user 条目，合成 plugin 注入排除；每 turn 一条 assistant 条目，拼接该 turn 的 assistant 文本）——冷会话把 `sessionPersistence.inspect()` 折叠一次进进程内缓存（上限 512 条；id 变 live 时丢弃对应缓存条目）。`foldRecentTurns` 是播种与冷读共享的折叠函数；窗口保留退役副本的 100 条读取上限。`Engine.recentTurnsOf`/`lastResultOrReply` 包装给 engine 与命令侧消费方，原生 id 解析 live 优先（桥侧映射在 turn 中途可能滞后）。
- **持久化会话的新近度改用 JSONL 日志文件 mtime**：`DshPersistenceLike` 增加可选 `locate`（jsonl 后端的路径解析器），`listSessions` stat 日志文件，后端无法定位或文件尚未落盘时回退 `createdAt`。live 会话仍用 `lastActivityAt`。
- **spawned-group 首条消息判定**改为「该聊天会话还没有会话窗口」（`recentTurnsOf(..., 1)` 为空）——首条消息时 interactive state 尚不存在，而上一轮 turn 的事件早已进窗口。
- **删除 `/show` 的 i18n 死键**（`keys.ts` 与 `messages.ts` 中的 `Show`……`ShowReadFailed`）。`/show` 本身仍在不迁移命令清单上；路线图把它列为 history 消费点是笔误——该命令从未有 TS handler。

### 作用域监听 spike（负结论）

B7 路线图条目「评估把 adapter 的手工 `session/event` 路由（`liveSessions` map + lineage walk）换成 dsh-scope 作用域监听」已调查并**否决**；手工路由保留：

1. 宿主 agent 作用域没有祖先链。`AgentLoop` 用 `createScope(loopCtx, this)` 铸造自己的作用域且不绑父（`packages/core/agent-loop/src/agent.ts`），subagent 运行时里也没有谁把子 agent 的作用域绑到父——`bindScopeParent` 在 `agent-presets` 之外没有生产调用方。「祖先作用域收到后代事件」的语义对 agent 会话事件而言没有生产者；只有 client runtime 组合值键作用域。桥没有可订阅的祖先作用域。
2. 投递替代不了归因。即便有祖先链，祖先作用域的 listener 收到的仍是所有后代混在一起的 `(session, event)`，仍要解析发射子会话属于哪个桥通道——正是手工路由在做的 `parentSession` lineage walk。
3. 桥的路由策略无法用作用域过滤表达：断链丢弃（lineage 中段会话不再 live）、深度上限 8、排除外来/一次性会话，都是桥的决策，不是作用域拓扑。
4. adapter 的结构化 `DshContextLike`（`on`/`get`）让单测不必启动 Cordis；`createScope` 会为一个零行为收益把它耦合到真实 `Context`。

## Alternatives considered

- **每次读取时折叠 live agent 的完整事件日志**替代增量窗口。否决：每次读取变成 O(全部事件)，`/list` enrich 每条命令要重新折叠每个列出会话的整份日志；播种式增量窗口只在每次 `startSession` 花一次折叠。
- **在 `AgentSession.send()` 里记录 user 条目**以获得无竞态的首条消息判定。否决：`send` 收到的是构建后的 prompt（发送者前缀、附件引用），不是旧 history 存的原始消息；原生 `user/message` 事件已携带模型可见文本——一个记录点好过两个逐渐分叉的记录点。
- **过滤删了但保留 `knownAgentSessionIDs` 作为 Go 对齐面。** 否决：它唯一的生产消费者就是过滤；`findByAgentSessionID`（`/switch` 回切与 enrich 仍在用）直接读 `pastAgentSessionIDs`。
- **用 `listSnapshots` 的 revision 做持久化新近度。** 否决：revision 是区分存储的不透明变更令牌，不是时间戳；mtime 才是 Go 存储文件列表暴露的物理新近度。

## Consequences

- 迁移测试覆盖 v1 → load → 字段齐全 → save → 落盘 v2（含无版本号的 Go 时代文件）；`tests/agent-dsh/adapter-list.spec.ts` 用 `locate` 断言真实 mtime 排序与 `createdAt` 回退；`tests/agent-dsh/adapter-recent-turns.spec.ts` 覆盖折叠（注入跳过、按 turn 拼接、上限）与 live/冷/缓存读取路径；`/list` `/switch` `/fork` `/new` `/dir` `/provider` 族、reset-on-idle、auto-compress、predict、子任务回报兜底均已按投影改写。本沙箱内余下 9 个测试失败，全部为环境性且不在本 diff 触及范围：`reload-script.spec.ts`（脚本的 pnpm/launchctl 编排在沙箱化的 daemon 会话内跑不了）与 `commands-fork-at.spec.ts` 一个用例（其 `git worktree add` 要向主仓库 `.git` 写 ref，被沙箱拒绝）。
- 已知可接受漂移：user 窗口条目持有模型可见的 prompt 文本（含发送者前缀），不再是旧 history 存的原始平台消息——`/list` 摘要与 predict 上下文可能带上前缀。agent id 被失效的会话（agent 类型切换）在新 agent 会话启动前读到空窗口，`reset_on_idle` 不再轮转无 backend 的会话（它们的下一条消息无论如何都会起新 agent）。首轮 turn 在任何 turn 事件前死掉的 spawned group 改为在第二条消息改名，而不是永不改名。
- 真机重启恢复仍由用户验证：daemon 重启后 `/list` 应按真实新近度排序、摘要与计数来自原生日志；B7 之前的 `sessions.json` 应能重载并在首次 save 时改写为 v2。
- 既有且范围外：`pnpm run lint` 在 `packages/core/tools` 上有三个错误（`src/index.ts:1889` 多余 optional chain ×2、`tests/tools.spec.ts:773` 多余断言），由 commit e704d3b8bb（B1）引入；本批未触碰这些文件。
