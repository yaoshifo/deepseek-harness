# Agent Note: Plain /fork 从持久化日志 seed——live-only 天花板解除

Status: implemented

[English](2026-08-21-feishu-bridge-fork-persisted-seed.md) | 中文

## Problem

普通 `/fork`（不带引用消息）只能从 **live** 父会话取 seed：`startSession` 的 `__fork__` 分支在 `ctx.agents` 注册表里查父会话，miss 时静默开一个全新会话、只在日志留 warn。daemon 重启或 idle 回收后——父会话只存在于持久化日志——`/fork` 建出来的群什么都不记得；同样的 live 限制还渗透进 subtask 守卫（`prepareForkSession` 拒绝仅持久化的源）。Go 从没有这个缺口：它的 fork 直接读磁盘 transcript。

## Decision

`__fork__` 分支分两步解析 seed：先查 live 注册表（内存日志比 write-behind 的持久化新），miss 则走 `persistedForkSeed`——`sessionPersistence.inspect(id)` 加同样的种子裁剪。裁剪逻辑当时在 `trimCompletedTurnPrefix`（现为 `seedablePrefix`，额外切割并收尾飞行中的 turn——见[飞行 turn fork 种子 note](../feature/2026-08-30-feishu-bridge-flying-turn-fork-seed.zh.md)）；两种日志视图的 seq 都等于数组下标，按平衡切点切出的前缀不变地满足 seed「从 seq 0 连续」的契约。lineage 元数据（`parentSession` + `seedLength`）现在两条路径都记录，不再只有 live 路径；源两边都找不到时行为不变（warn + 全新会话，无群消息）。

`prepareForkSession`（subtask 建群前守卫）随之跟进：可达 = 「live 或持久化 inspect 命中」，于是 `feishu_bridge_subtask` 的 `fork: true` 对死父会话也生效，而真正缺失的源仍会在建群前 fail-fast。engine 调用点不再传 workDir 参数——旧文案指责目录不匹配，但守卫从未比对过目录（持久化服务全局解析 id，没有 Claude Code 的 per-cwd projects-dir 局限），跨目录 fork 在 TS 本就可用，[subtask skill](../../../../packages/acp/feishu-bridge/skills/feishu-bridge-subtask/SKILL.md) 也不再禁止它。

## Alternatives considered

**让普通 /fork 也走 fork-at 的复制路径（persistence create + append + resume）。** 落选：复制路径的存在理由是回滚 fork 必须在命令时刻预物化截断日志——引用消息的定位数据无法随哨兵传输。普通 fork 的哨兵本来就带着全部所需信息（源 id），惰性展开加 seed 更简单、也不产生孤儿产物；这个不对称是有意为之，不是漂移。

**始终读持久化日志，不查 live 注册表。** 落选：持久化是 write-behind，live 父会话最新完成的 turns 可能还没落盘；live 优先让常见路径保持既有、已测试的行为，只增加兜底。

**源消失时回复降级消息（Go 守卫的文案）。** 落选：adapter 没有回复用的平台面，且一旦 consult 了持久化，「源缺失」就坍缩为 id 已损坏这种罕见情形；保留静默 warn 维持已文档化的行为，而不是为罕见失败长出引擎侧探测路径。

## Consequences

`/fork` 与 subtask `fork: true` 现在扛得住 daemon 重启和 idle 回收——这是与 Go fork 语义最后一个用户可见的分叉（回滚 fork 那一侧此前已闭合）。陈旧的持久化日志最多落后 live 父会话一个 write-behind 窗口；live 优先的顺序让这个窗口无关紧要。skill 文档里模型读到的跨目录禁令已删除，subtask 派发不再在 `dir` 不同时防御性地丢掉 `fork`。

## Testing

`tests/agent-dsh/adapter-fork.spec.ts` 覆盖仅持久化父会话的 seed（断言 seed 前缀与 lineage 元数据）、live 优先于陈旧持久化日志、服务在场但源缺失时仍降级，以及 `prepareForkSession` 对持久化源 resolve、对缺失源 reject；`tests/engine/engine-subtask.spec.ts` 钉住守卫是「存在性检查、不传 workDir」。
