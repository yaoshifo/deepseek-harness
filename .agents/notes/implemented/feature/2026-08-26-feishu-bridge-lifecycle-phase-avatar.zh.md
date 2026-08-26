# Agent Note: Lifecycle-phase avatar colors for spawned groups

Status: implemented

[English](2026-08-26-feishu-bridge-lifecycle-phase-avatar.md) | 中文

## Problem

spawn 出来的任务群头像背景原本只是装饰：`groupAvatarColor` 把群名哈希成随机色相，唯一的状态信号是 `/done`-`/undone` 切换的彩色/灰度对。而在飞书会话列表里，缩得很小的头像才是唯一能一眼扫到的表面——群名会截断、卡片要进群才能看——于是「哪些群在等我」这个问题唯一的承载渠道，除了完成/未完成之外不携带任何信息。

## Decision

spawn 群的头像背景现在是固定的五色生命周期信号（图标不变，仍由 LLM 按语义选择）；这是对 Go 上游随机色相设计的有意分歧：

| 颜色 | Phase | 含义 |
|---|---|---|
| 黄 | `discussing` | 尚无已批准的计划——讨论、直接干活、永不做计划的会话（无人值守 cron）同算 |
| 蓝 | `plan-review` | ExitPlanMode 审批卡挂起等待批准 |
| 绿 | `approved` | 计划已批准；健康基线 |
| 红 | `attention` | 需要用户介入：挂起的提问/权限卡、出错的回合、stall 超时 |
| 灰 | `done` | `/done`，与原灰化设计一致 |

phase 模型分两层：持久化的 `basePhase`（`discussing`/`approved`）是覆盖物（`plan-review`/`attention`/`done`）清除后群回到的状态。engine 在以下位置驱动转移：`askUser` 入口（plan-review → 蓝，questions/权限 → 红）、`askUser` 结算（计划批准 → 绿且基线上移；拒绝/撤回 → 黄且基线重置；其余 ask 回到基线）、回合终局（出错 → 红，成功 → 基线）、stall 超时击杀、`/done`（灰）、`/undone` 及下一条消息的复活（基线）。自动批准的 ask（无人值守应答、chatroom 角色挑选、全准记忆）从不挂起，因此从不上色——红色严格表示需要人。两个基线 phase 同时也是基线的写入规则：涂 `discussing` 或 `approved` 即移动基线，覆盖物不动它。

`/done` 的标记（`doneAt`）未撤销期间冻结整条头像轴：`applyChatPhase` 丢弃一切引擎侧回绘——停止结算的 ask、回合终局回基线、stall——因为 `/done` 发出的 stop 恰好会释放这些结算，而未被拦住的结算会把基线色重涂到灰色终局之上（生产已观察到：一次被打断的 `/done` 让群停在黄色、done 标记被覆盖抹掉）。因此 `cleanupOneChat` 先落 done 标记、画灰，再发出 stop。`/undone` 解除冻结（`markActive` 删除 `doneAt`）；下一条消息的复活经平台直涂基线、绕过 `applyChatPhase`，但覆盖色在 `/undone` 之前保持冻结。

布尔轴 `ChatAvatarStateSwitcher`（Go `setChatAvatarActive`）被 `ChatPhasePainter`（`setChatPhase` + `chatBasePhase`）替换；布尔轴的 `/done` 灰化职责就是 `done` phase。平台侧每次转移的 key 解析顺序：缓存的 per-phase key → 用存下的 `iconName` 懒渲染 → legacy `colorAvatarKey`/`grayAvatarKey` 对 → bot 头像对；全都解析不到 → warn 后跳过。`setGroupIconAvatar` 只急切上传初始对（黄 + 灰，与之前同样是两次上传），并在 spawned-chat meta 上记录 `iconName`、`phase`、`basePhase`、`lastAvatarKey` 和 `avatarKeys`；蓝/绿/红在首次进入该状态时才渲染上传，到不了这些状态的群分文不付。转移先走 chat-update 应用头像、成功后才持久化 phase；两者之间崩溃由下一次转移自愈。同 key 的转移（经 `lastAvatarKey` 去重）完全跳过 API 调用——每条飞书「更新了群头像」系统消息都标记一次真实状态变化，完整 happy-path 生命周期至多 3–4 条。

非 phase 群保留哈希色、不参与状态色语言：chatroom 家族（`setChatroomFamilyAvatar` 盖章时不记 `iconName`，故所有非 done phase 都解析到既有彩色 key——家族品牌保留，end-chatroom 灰化经灰 key 保留）和 brand 的监控枢纽群（没有 spawned meta，`setChatPhase` 直接 no-op）。这同时让家族群与状态色任务群在视觉上可区分。非 spawn 群里的 `/done` 不再动它的头像（旧轴会给它灰化 bot 头像对）——可接受：`/done` 本就只对 spawn 群有意义。

## Alternatives considered

- **红色表示「计划待批」（用户最初的提案）。** 否决：红色是通讯工具里的告警色，计划审批是流程里正常、预期的关卡而非故障。红色保留给收拢后的「需要你」状态——挂起的提问/权限卡、出错回合、stall——用户的动作就是解锁步骤；把提问等待与权限等待分成两色也被否决，因为两者对用户的动作相同（进群、回卡片）。
- **保留随机色相、另加状态指示。** 否决：会话列表里头像是唯一可渲染状态的表面；群名后缀会截断，卡片要进群。
- **超过五个 phase（运行中 vs 空闲、等子任务、上下文压力）。** 否决：小头像色块大约只能稳定分辨五种（黄/橙、蓝/紫在列表尺寸下混淆），绿/红对已经考验红绿色盲（用更深的红缓解），而运行中/空闲这类高频状态每回合翻转，会把「更新了群头像」系统消息变成噪音。颜色预算已花完；更细粒度该走图标或群名后缀。
- **设头像时急切上传全部五个变体。** 否决：多数群到不了蓝/绿/红，用存下的图标名懒渲染只在首次进入时花一次渲染 + 上传。
- **加 `phaseLocked` 标志把 chatroom 家族挡在轴外。** 否决：legacy 条目本来就解析到自己的彩色/灰度对，key 去重让同 key 转移零成本——legacy 回退路径本身就是家族锁，不需要新字段。
- **在 engine 侧（会话元数据）跟踪 `basePhase`。** 否决：平台已把它与解析用的 key 一起持久化在 spawned-chat meta 里；由涂色 phase 推导（基线 phase 移动基线）不需要 engine 记账，且重启后依然成立。
- **消息复活时完全解冻头像轴。** 否决：复活将不得不清除 `doneAt`，而它同时喂养 7 天 retention 清扫；且 Go 的 active 轴有意让复活的群保持 `/done` 的 inactive 直到 `/undone`——半冻结头像（有基线色、无覆盖色）与该语义一致。

## Consequences

- 会话列表一眼回答「哪些 spawn 群在等我」：扫红色；蓝色标记计划关卡；灰色是归档。
- legacy 群（phase 之前的条目、无 `iconName`）保持旧的两态行为——活跃时哈希色、`/done` 灰——升级后首次转移会有一次性的重涂系统消息；不写迁移。
- 每次 phase 变化发一条飞书系统消息（「更新了群头像」）；接受它本身作为信号，去重保证上限。
- 挂起卡片期间 daemon 重启会丢那一次变色，下次转移恢复；phase 只在头像应用成功后才发布，持久化的 phase 与已应用头像保持一致。
- 消息复活的 `/done` 群显示基线色，但在 `/undone` 之前不再显示覆盖色。
- phase 色板是固定常量（`src/feishu/avatar.ts` 的 `phaseAvatarBG`）；`groupAvatarColor` 只为非 phase 群（家族、brand 枢纽）保留。
- 上游漂移：Go 的 `ChatAvatarStateSwitcher` 不再一一对应；将来 `dsh-sync-upstream` 触到它时以本 note 为分歧记录。

Pinned by `tests/feishu/avatar-state.spec.ts`（解析顺序、去重、懒渲染 + 缓存、legacy/bot 回退、先应用后持久化、基线规则）、`tests/feishu/avatar-icon.spec.ts`（设头像时的初始对 + phase 簿记）、`tests/engine/avatar-phase.spec.ts`（askUser 入口/结算矩阵、回合终局错误/成功、best-effort 语义、`/done` 冻结）、`tests/feishu/spawn-evict.spec.ts`（phase 字段持久化 round-trip）、`tests/engine/spawn-family-commands.spec.ts`（`/undone` 恢复基线）。
