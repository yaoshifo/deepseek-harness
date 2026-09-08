# Agent Note: 聊天室开场/收官持久化收尾——poll 出席自愈落盘，收官 hub 置 done

Status: implemented

[English](2026-09-08-chatroom-end-persistence-follow-ups.md) | 中文

## Problem

把 2026-09-07 oc_94b41a 会话从头到尾重读一遍后暴露的两个状态持久化缺口（与同日落地的 picker 自举修复同源）：

- **开场 poll 的出席行被整批丢弃。** 引导流程的开场闪电轮在 `start` 初始化账本之前结算，`persistPollStatements` 的 append 撞上 `ENOENT …/RECORD.md`——22:34:50 共 13 条 warn，出席行全丢，moderator 只好手工把整轮重新总结进综述。而出席记录的存在意义恰恰是「不依赖 moderator 写任何东西」。
- **moderator 工具 end 路径从不把 hub 自己的 spawn 群条目置 done。** 角色的 done 标记经 `cleanupOneChat` 落；`/done` 命令路径额外驱动通用 teardown 标 hub——但 moderator 的 `end` 工具调用走 `finalizeChatroomEnd`，背后没有 `/done`，于是已收官的 hub 在 spawn 状态文件里保持 `active=true / phase=discussing`、彩色讨论头像不灰（ended 日志行 05:41 之后 6 小时仍观察到）。

## Decision

- **`appendChatroomLedger` 自愈**（`chatroom-ledger.ts`）：append 路径在 RECORD.md 缺失时创建账本目录与 `## 讨论记录` 标题，pre-init 的 append 落盘而不是抛错。**`initChatroomLedger` 仅在 RECORD.md 不存在时写它**——SYNTHESIS/SUBPROBLEMS 保持覆盖语义（新聊天室是新讨论），而 pre-start 出席行在随后的 init 中存活。按次账本目录本就隔离不同聊天室，保留绝不是复用陈旧数据；同目录「先 append 后 init」的唯一路径就是这段 pre-start 序列与同场重试，保留正是想要的行为。**`persistPollStatements` pre-start 时把目录解析为下一 run**（`chatroom.ts` 的 `pollLedgerDirFor`）：引导开场轮在 moderator 标记未立时结算，直接 `max(run, 1)` 会把同 hub 的第二场解析进**上一场**的目录——第二场的出席行污染第一场账本；pre-start 用 `run + 1`（恰是 `start` 将消费的 run），post-start 保持现 run。
- **`finalizeChatroomEnd` 标 hub done**（`chatroom.ts`）：在 hub 标记清理旁边 `void e.markSpawnedChatDone(p, hubKey)`，覆盖每一条 end 路径（工具 end、`/done` 驱动的 interrupt、强制 interrupt）。`/done` 命令路径随后会再标一次 hub——幂等（`active=false` 重设），且 done/undone 头像轴本就把 done 标记当终态，直到下一条用户消息恢复 baseline。

## Alternatives considered

- **把 poll 持久化推迟到 start 之后（内存缓冲）。** 用户从未确认阵容时出席即丢；账本才是持久归宿，缓冲会造出第二事实源。
- **让 moderator 的 priming 把整轮复述进账本（prompt 层）。** 出席记录的设计初衷就是不依赖 moderator 写作；重新依赖它等于复刻丢行故障模式。
- **只靠 bridge 通用 teardown 监听器标 hub。** 那个监听器只随 `/done` 跑，不随工具 end；把标记放进 `finalizeChatroomEnd` 是所有 end 路径已共享的单点。

## Consequences

- 测试：init 前 append 自建目录+标题+行；init 保留 pre-start 行而重写 SYNTHESIS；无 start 的端到端开场 poll 落三条出席行、随后的 `startChatroom` 保留它们；同 hub 第一场已 end 的第二场 pre-start poll 把行落进**下一 run** 目录且上一场 RECORD.md 逐字节不变；`endChatroom` 对已开局房间标两个角色加 hub 的 done；`/done` 驱动的 interrupt 路径现在标 hub 两次（幂等——断言放宽为 ≥1，角色恰好一次的守卫保留）。
- pre-start 目录（`run + 1`）与 `startChatroom` 下一步消费的 run 构造上吻合（start 先递增再使用）；无活房间时残留的 moderator 标记（interrupt 清除它）不破坏映射——started/pre-start 的判据是标记本身，不是时钟状态。
- 部署：bridge-chatroom 插件重建 + `/reload`；无配置变更。
