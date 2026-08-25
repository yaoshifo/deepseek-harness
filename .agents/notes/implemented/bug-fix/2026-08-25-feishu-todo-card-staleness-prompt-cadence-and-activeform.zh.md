# Agent Note: 飞书待办卡片滞后根因是模型批量更新；提示词节奏规则加 activeForm 接受

Status: implemented

[English](2026-08-25-feishu-todo-card-staleness-prompt-cadence-and-activeform.md) | 中文

## Problem

飞书实时进度卡上的待办项在工作完成后很久仍显示未完成。渲染链路不是延迟来源：引擎在 `tool_use` 时刻（早于工具校验）就解析 `todo_write` 调用，原生 `todo/write` 会话事件更新同一个置顶区块，`updateTodoSection` 经 300ms 节流加延迟补刷和瞬时 PATCH 重试刷新——会话事件产生后约一秒内卡片就呈现最新快照。

原因在会话日志里。全部 67 个带待办清单的 daemon 会话（228 次成功 `todo_write`）中，模型都是开头写一次清单、结尾一次性全标完成；两次写入之间最多隔着 378 次工具调用和 53 分钟（`cc-20260824-130227-aa3b8e71d0ec`）。卡片如实渲染最后一次快照，于是回合中途状态持续滞后。Claude Code 的及时性来自模型遵循 TodoWrite 纪律，且被系统提示与工具描述双重强化；dsh 的工具描述里有逐字相同的句子（"Mark a todo `completed` the moment it is done (do not batch completions)"），但 agent-conventions 提示段落里没有任何对应内容。

次要摩擦：在 Claude Code TodoWrite 上训练的模型会携带 `activeForm`（观测到的 233 次调用中有 4 次）或幻觉出额外字段（1 次）；`additionalProperties: false` 将整次调用拒绝，其中一次失败后清单约 30 分钟无人维护。

## Decision

- **agent-conventions 提示段落加入节奏规则**（`agentConventionsPrompt`，由 dsh adapter 为直聊会话注册）：每完成一项立即更新清单——标 `completed`、把下一项标 `in_progress`——绝不攒到收尾批量更新，因为飞书卡片实时渲染这份清单。这是补上 Claude Code 系统提示提供的那第二次强化。
- **`todo_write` 接受可选 `activeForm`**：接受时 trim、为空则丢弃、随快照落日志（落日志的快照保持与模型自认为写入的内容一致）、在工具输出中回显、由 `todos` 投影 wire schema 和 feishu-bridge adapter 的 `todo_update` 映射携带。置顶卡片区块本就为 `in_progress` 项渲染它。`content`/`status`/`activeForm` 之外的条目键仍然报错；持久层 invariant 对出现的 `activeForm` 校验（字符串、非空、已 trim），缺失时保持沉默，历史日志回放不受影响。`todos` 投影维持 `stateVersion: 2`：fold 逻辑未变，旧行仍然有效。

## Alternatives considered

**loop 层的滞后待办提醒。** 暂缓：清单滞后时注入回合中提醒需要改 agent-loop，违反 plugins-not-loop-changes 规则。先做提示层修复并观测模型是否遵循。

**卡片侧完成推断。** 弃用：卡片必须渲染持久快照，不能从工具流量猜测状态。

## Consequences

模型对新条目的遵循度是未决风险——提示规则只能靠观测检验。若部署后批量更新依旧，升级路径是在文档化的扩展点上做提醒机制。ACP 快照钉（工具 schema 与系统提示类型投影）现在携带 `activeForm`；它们经 keyless refresh 模式刷新，不是重录。

## Testing

`tool-todo.spec.ts`：schema 形状钉包含 `activeForm`；接受/trim/丢弃往返断言落日志快照与工具输出。`invariant.spec.ts`：接受已 trim 的 `activeForm`，拒绝非字符串、空、未 trim。`chatroom-persona.spec.ts`：含新条目的 conventions 文本逐字钉。`adapter-projection.spec.ts`：`activeForm` 经 `todo_update` 透传，空值丢弃。全套：feishu-bridge 2303、session + token-meter 336、tools + client 3929；仓库 typecheck 与 keyless 快照回放通过——本机残留的 5 个快照失败（Node 24 SQLite stderr 警告、agent 沙箱下 `mkdtemp` EPERM、landlock Napi 崩溃）在干净 dev checkout 上同样复现，早于本次变更。
