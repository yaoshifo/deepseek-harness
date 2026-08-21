# Agent Note: Fork-at 回滚——引用消息在某个 turn 处 fork，经持久化服务完成

Status: implemented

[English](2026-08-21-feishu-bridge-fork-at-rollback.md) | 中文

## Problem

cc-connect 的回滚 fork——回复一条历史消息（含计划卡片）再执行 `/fork`——会创建一个新群，其会话回滚到产出被引用消息的那个 turn。TS 迁移把它裁剪为「claudecode-only」（FEATURE-PARITY #55、MIGRATION §0）：可见的 Go 实现截断 Claude Code 的 transcript 文件后用 `--resume <id> --fork-session` 恢复。但 Go `agent/dsh/fork.go` 本就带 dsh 后端实现（对 session log 跑 `locateForkCut` 加 `writeForkedLog`），所以该能力可移植，并非 claudecode 专属。TS bridge 交付时 `cmdFork` 留着 TODO、i18n 文案、`__forkat__` 哨兵常量、平台侧引用采集（`quotedText`/`quotedSenderType`/`quotedUpdateTimeMs`）——地基全部预埋，无一被消费。

## Decision

`cmdFork` 把「回复了消息（`parentMessageID` 非空、`quotedUpdateTimeMs > 0`）且未带 `--worktree`」识别为回滚 fork：向 agent 的 `ForkAtPreparer` 能力请求一份截断副本，把返回的 id 藏进 `__forkat__` 哨兵，`startSession` 直接 resume 该 id。能力缺失或定位失败都先回复再中止，不建群。`--worktree` 跳过回滚——worktree 路径要到 `spawnGroupCommon` 内部才可知，截断副本无法提前落位（Go 保形）。

`DshAgentAdapter.prepareForkAtSession` 经 `sessionPersistence` 服务完成复制，而非读写原始日志文件：`inspect(origID)` 返回源会话事件（live 父会话得快照、否则读持久化日志——父会话无需 live），`locateForkCut`（移植为 `src/agent-dsh/fork-at.ts`，作用于 `SessionEvent[]` 的纯逻辑）选出截断点，`create` + `append` 把前缀持久化到新 id 下，其 header 改写 `id` 与 `cwd`，并盖 `seedLength: keep`。该标记遵循 [fork-child-replay-seed-boundary 规则](../testing/2026-06-22-fork-child-replay-seed-boundary.zh.md)：整段复制日志都是继承历史，边界让回放能把它与子会话自己的 turns 区分开——Go 的 `writeForkedLog` 没有这个字段可写。

定位器移植 Go 语义：引用时间戳开启 10 分钟窗口并按发送方过滤（`app` 匹配 `assistant/message`，否则 `user/message`）；窗口内归一化 40 字符文本前缀命中即直接胜出（飞书引用会截断加装饰），否则取窗口内最近的消息；无时间戳时取最后一个文本命中。截断保留到收口该 turn 的 `turn/end`（开放 turn 截到下一个 `turn/start` 前）。

与 Go 的偏差，均为有意：不移植 `ForkAtTranscriptReachable` 能力——jsonl 后端全局解析 id，「副本不可达」坍缩为「resume 失败」，engine 既有的 fresh 回退已覆盖（该分支对 `__forkat__` 哨兵改用 fork 降级文案）；不返回 cleanup 函数——`create` 惰性落盘，`append` 失败不留盘上孤儿；`planBasisName`/`spawnFromQuotedPlan`（引用计划卡配 `/spawn`）未移植，仍是 `cmdSpawn` 的 TODO。

## Alternatives considered

**移植 Go 的原始日志文件复制（`writeForkedLog`）。** 落选：它要在持久化层背后重新实现 `encodeSegment`、zstd 帧结构、project-dir 布局。服务本身持有这些字节并校验 append 契约（从 0 连续的 seq、header 校验），复制不会偏离后端自己会写出的内容。

**像普通 `__fork__` 路径那样在 `startSession` 时 seed。** 落选：定位数据（引用文本与时间）只在 `cmdFork` 时刻可知，而哨兵是一个 session-id 字符串——把定位数据塞进哨兵或暂存 engine 内存，都会破坏命令到子群首条消息之间的重启安全。把截断日志预先物化到新 id 下，哨兵保持纯 id，副本持久。

**把 `prepareForkAtSession` 并入 `ForkSessionPreparer`（Go 的单一接口）。** 落选：bridge 的结构化能力检查按方法探测，合并会迫使 subtask 跨目录守卫的桩实现它们从不使用的回滚成员。独立的 `ForkAtPreparer` 沿用同文件里 `ForkQuerierWithProvider` 的先例。

**在会话启动前预检可达性（Go 的守卫）。** 落选：id 全局解析下，预检与 resume 尝试本身证明的是同一件事；只保留了面向用户的文案。

## Consequences

回滚对仅持久化的父会话也生效，并在命令到子群首条消息之间扛得住 daemon 重启。交付时这一点严格优于普通 `/fork` 的 seed 路径（当时后者仍要求父会话 live）；该天花板后来对普通 `/fork` 也已解除（见 [fork-persisted-seed](../bug-fix/2026-08-21-feishu-bridge-fork-persisted-seed.zh.md)）。

引用时间戳取卡片的 PATCH 时间：被反复刷新的卡片可能漂出 10 分钟窗口，fork 于是响亮地失败（`fork_at_truncate_failed`，不建群），而不是静默 fork 整段会话——与 Go 接受的取舍相同。文本匹配按 rune 切前缀而 Go 按字节切；意图（被截断、被装饰的引用仍能命中原文）一致。

## Testing

四个 spec 文件钉住行为：`tests/agent-dsh/fork-at.spec.ts`（定位器：时间窗、文本优先、最近时间兜底、发送方过滤、开放 turn 与 pre-turn 截断、归一化）、`tests/agent-dsh/adapter-fork-at.spec.ts`（复制契约含 `seedLength` 盖章、冷父会话、各拒绝路径、`__forkat__` resume 不 create 不 seed）、`tests/engine/commands-fork-at.spec.ts`（哨兵植入，无引用 / 带 `--worktree` / 无时间戳时退化为普通 fork，失败与能力缺失时中止）、`tests/engine/engine-fork-at-degrade.spec.ts`（resume 失败以 fork 文案降级为 fresh 并替换哨兵）。
