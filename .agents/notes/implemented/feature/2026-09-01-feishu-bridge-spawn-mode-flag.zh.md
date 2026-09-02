# Agent Note: /spawn --plan/--default 按群 pin 权限模式

Status: implemented

[English](2026-09-01-feishu-bridge-spawn-mode-flag.md) | 中文

## Problem

项目配置 `agent.mode`（通常配 `plan`）是选择会话权限模式的唯一入口，且对项目内每个聊天统一生效。派发出去的任务群无法例外：配了 plan-first 的项目里每个 spawn 群都进 plan 模式——哪怕只是跑腿小活；配了直接执行的项目想为一个子群要 plan 模式就得改 bot 配置。Go 的 `/mode` 单次覆盖命令被裁定不迁移（2026-08-21），聊天侧完全没有旋钮。

## Decision

`/spawn` 与 `/fork` 接受布尔 `--plan` / `--default` 参数（互斥；同现回复 `spawn_mode_conflict`，在建群之前中止）。指定的模式 pin 在子群的 chat 上，而非某一次会话启动，经既有管道流转：

- pin 落在 bridge `Session` 的 `inheritedMode` 字段——chat 级记录，`carryChatScopedState` 本就把它带过 `/new` 重置，所以 chat 内换会话 pin 不丢。它保持内存态（不序列化）：daemon 重启丢 pin、chat 回落项目默认，与 `pendingMonitorClarification` 同款取舍。该字段此前按 Go 保形写入的 `parentEffectiveMode()`（意为继承父会话当前模式）存的是常量 `''`——`InteractiveState.effectiveMode` 没有非 `''` 写点——这条死路径已在同一改动中移除，字段现在只由显式 flag 写入。
- `buildSessionStartOptions` 把非空 pin 提升进新增的 `SessionStartOptions.spawnMode` 字段（与 `persona.forceMode` 同型）。
- dsh adapter 的模式链变为：无人值守子任务 `bypassPermissions` > 一次性 `modeOverride`（cron job 模式）> `spawnMode` pin > 项目 `defaultMode`，之后照旧过 `feishuBridge/mode-policy` waterfall（聊天室 persona 降级）。pin 在该 chat 的每次 `startSession` 重新应用——会话被 idle 回收重启、`/new` 换会话都保持——不同于 adapter 只消费一次的一次性 override。

`plan` 项目里的 `--default` 是主打场景：pin 压过 `defaultMode`，子群直接执行。反向（`default` 项目里 `--plan`）则武装 plan 模式，走完整 ExitPlanMode 卡片管线。只接受这两个值——原生 plan-mode 控制器只有开/关，其余模式名（`bypassPermissions` 等）由无人值守子任务的 bypass 表达，而 bypass 本就压过一切。

## Alternatives considered

**消息级 `Message.modeOverride`** —— engine 已在消费它（`handleMessage` → `startAgentLocked` → `setSessionMode`），改动只有一行。输在：它是一次性武装、第一次 `startSession` 即被消费，子会话重启与 `/new` 后模式丢失；裸 `/spawn --plan`（无任务文本、无首条消息）更是立刻丢——会话在用户后续第一条消息时才启动。chat 级 pin 三种情况全覆盖。

**`persona.forceMode`** —— persona 是整套系统提示替换、自带权限 bypass；spawn pin 两者都不是，耦合它们等于给普通 spawn 群强塞一个假 persona 块。

**把 `inheritedMode` 序列化进 `SerializedSession`** —— 能让 pin 扛过重启，但代价是扩大持久化格式，而这个字段丢了也只是回落项目默认（良性）。留到真有需求再做。

**通用 `--mode <名字>` 参数** —— cron 侧有六个模式名，但交互群唯一有意义的区分是 plan/非 plan；两个布尔 flag 让帮助文案与解析器都保持最小。

## Consequences

买到：不改 bot 配置就能按群控制模式——一条 spawn 命令决定这个子群先计划还是直接干，pin 活过 `/new` 与 idle 回收。代价：pin 是内存态，daemon 重启后该群静默回到项目默认（在 `plan` 项目上 pin 了 `--default` 的用户，重启后 plan 模式会回来）；且 `--plan`/`--default` 只此两值——想要 `bypassPermissions` 风格行为的群没有入口（该模式按设计属于无人值守子任务）。

## Verification

`tests/engine/commands.spec.ts`（flag 提取、pin 值、不漏进任务文本、互斥拒绝）、`tests/engine/commands-fork-at.spec.ts`（fork 对称）、`tests/engine/engine-subtask.spec.ts`（`buildSessionStartOptions` 提升）、`tests/agent-dsh/adapter.spec.ts`（链上排序：pin > default、一次性 > pin、bypass 压一切、pin 跨启动持续）。全包套件绿（2973 测试）。真机冒烟待部署后补：`/spawn --plan <任务>` 应在新群停一张 ExitPlanMode 卡；`plan` 项目下 `/spawn --default` 应直接执行。
