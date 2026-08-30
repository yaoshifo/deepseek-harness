# Agent Note: feishu-bridge cron 槽位 ask 卡应答裸键点击、abort 结算停泊 ask

Status: implemented

[English](2026-08-31-feishu-bridge-cron-ask-slot-click-routing.md) | 中文

## Problem

2026-08-31 的 cron-fbe6d268 盘前检查（会话模式 `new_per_run`）把回合停在 `ask_user_question` 上，发出多选跟进卡，用户点选了选项 1、3、4——之后运行静默挂死。会话日志终止在 ask 的 `tool/call`（无 `tool/result`），随后是携带原始点击载荷 `askq:0:1,3,4`、`target=next-turn` 的 `agent/inbox/spliced`：点击落进了普通消息路径，排队在它本应结算的那个回合后面。循环等待——回合等 ask 答案、inbox 投递等回合结束——点击文本还经裸键槽位（其 `agentSessionID` 已被本次运行的 resume 绑到 cron agent 会话上）排进了活着的 agent 会话。自 [8/26 槽位修复](2026-08-26-feishu-bridge-cron-ask-slot-routing.zh.md)以来的每个工作日运行都以同样方式停泊（8/27、8/28 尾部一致：有 `turn/start` 无 `turn/end`），只是这次点击才让它可见。

根因 A：卡片把 reply context 的会话键——裸键——盖进 `value.session_key`（`renderElement` 用 `rc.sessionKey`；cron 消息的 reply context 携带裸键），而 ask 停泊在 `#cron:` 槽位下。`routeAskResponse` 按精确键解析 state、落空，点击载荷变成普通消息。8/26 笔记"盖章会把点击原路路由回槽位"的断言不成立——已在原笔记就地修正。

根因 B：无人应答同样挂死。调度器 30 分钟超时中止运行（daemon 日志 `cron: job failed (id fbe6d268): job timed out after 1800000ms`），`onAbort` 只调了 `cancelTurn`——但运行时侧的 turn-cancel 到不了引擎侧的 ask 等待，停泊的回合（连同 agent 会话）泄漏 live 直到 daemon 重启。`/stop` 够不到槽位 state（精确键停止），重启是唯一恢复手段。

判别特征：cron 会话日志终止在无 result 的 ask `tool/call`，其后可能跟 inserted 文本为原始 `askq:N:M` 载荷的 `agent/inbox/spliced`；`turn/start` 计数大于 `turn/end` 计数。

## Decision

- `routeAskResponse` 精确键落空时回退到最新的、带 `pendingAsk` 的 `#cron:` 槽位 state，仅限卡片动作（`isAskqCardAction || isPermissionAction`）——自由文本留在精确键上，普通聊天消息不得应答停泊的 cron ask。这是 8/26 修复的应答侧：那里否决的提问侧前缀扫描继续否决（提问方不知道后缀），但点击对聊天裸键的指称无歧义，只有并发的多个停泊 ask——最新的胜出——才可能碰撞。
- `onAbort` 在 `cancelTurn()` 之后触发 `st.markStopped()`：state 的 stop 信号正是停泊 ask 等待已经在竞速的对象，ask 经自身清理路径以 cancelled 结算（清 park、不重启 surface），运行在其执行超时处收尾而不是泄漏。

## Alternatives considered

- **把槽位键盖进 ask 卡的回调值。** 否决：需要把路由键穿透每个卡片构建器，并要求 `permBodyCache`/`askqMetaCache` 在发送与回调两侧一致换键，而飞书 `form_submit` 回调可能整个省略 `action.value`——引擎侧应答桥接只是 miss 点上的一次受控查找。
- **在 `onAbort` 里直调 `pending.resolve` 结算 `pendingAsk`。** 否决：resolve 决议 decision promise，使停泊等待走 decided 分支、在垂死 state 上重启 ask surface；stop 信号驱动的是既有 stopped 分支及其清理语义。

## Consequences

- cron 运行的 ask/权限卡点击现在无论回调重构出哪个键都能应答运行自己的停泊 ask；卡片的冻结答案重建在发送与回调两侧仍以裸键为键（不变）。
- 无人应答的 cron 运行在作业执行超时（默认 30 分钟）处以 cancelled 结束回合，不再永久挂死——8/26 笔记留作未建的整 ask 超时，对 cron 运行由调度器超时覆盖；普通聊天会话保留 idle reaper 对停泊 ask 的跳过。
- 对 cron 槽位 ask 的自由文本应答仍不路由（飞书 ask 一律走卡片；只有纯文本平台回退可能命中该缝隙），旧卡上落在范围内的陈旧点击会应答最新的停泊 ask——与同键陈旧点击同类。
- 覆盖于 `tests/engine/engine-m3-askq.spec.ts`（裸键 askq 点击路由、自由文本负例、裸键权限卡点击路由）与 `tests/engine/cron-execute.spec.ts`（abort 结算槽位停泊 ask 并收尾运行）。
