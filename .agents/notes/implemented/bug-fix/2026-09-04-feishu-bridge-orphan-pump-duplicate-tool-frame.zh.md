# Agent Note: 未请求读出器的重复工具帧丢弃

Status: implemented

[English](2026-09-04-feishu-bridge-orphan-pump-duplicate-tool-frame.md) | 中文

## 问题

2026-09-04 oc_1fbe11 chatroom 运行：一个前台（消息路径）turn 于 02:03:32 完成，32 秒后 runtime 向事件通道重投射了一帧已消费的 `tool_use`——持久化会话日志在该 turn 结束与下一个引擎唤醒 turn 之间记录为零事件，这帧背后没有存活 turn。未请求读出器的 spillover 宽限（装配层默认 30 秒，对齐 Go wire.go）恰在 2 秒前过期，读出器把这帧重复升格为完整孤儿 turn 泵：幻影 preview 卡加 `beginTurn()` 会话锁，且因重复帧的 tool_result 永不到来（原泵已消费）而由 tool-in-flight 预算续命。该泵空坐 10 分钟，直到一个真实引擎唤醒 turn 的事件恰好经它排空。自愈无损失，但入口是通用的：任何落在宽限窗之外的迟到重投射都会开出幻影泵，2026-08-26 冻结时钟事故就是同一入口的更坏结局。

## 决策

- 未请求读出器遇到 `tool_use` 或 `tool_result` 且其 `toolID` 命中本 state 某个泵已消费过的调用时，直接丢弃而不升格：重复帧不含任何用户可见内容，不得开泵、发卡或持有会话锁。
- `InteractiveState.consumedToolIDs`（FIFO 上限 64，内存态）在两处消费点记录调用 id——共享 turn 泵的 `tool_use` case 与 spillover 中继。daemon 重启清空该集合；可接受，杂散帧只在 state 存活期内有意义。
- 无 `toolID` 的帧无法归类，保持既有升格；新 id 同样升格：调用 id 每请求唯一，真实引擎唤醒 turn 的首个工具帧永不命中。
- 部署侧，生产 profile 配置 `unsolicited.spilloverSec: 120`，窗口内的重复帧——包括 id 环无法分类的 result/text 重复帧——走纯文本 spillover 中继而非开泵。

## 备选方案

- **只靠更宽的 spillover 宽限。** 宽限窗只覆盖有界延迟；id 环可捕获任意迟到的重投射，且免去中继路径给工具帧留下的 `activeToolCalls` 悬挂计数。两者都上线：宽限吸收环无法分类的 text/result 重复，环吸收窗口可能漏掉的 tool 重复。
- **把重复工具帧按 spillover 文本中继。** 裸工具帧中继不出文本，要空等一整个空闲周期等一个不会来的结果，还让 `activeToolCalls` 抬升；直接丢弃严格更干净。
- **在源头修 runtime 的迟到重投射。** 自 2026-08-26 事故起即已知行为；读出器的存在就是为了吸收引擎侧唤醒，且投射层与已容忍重复帧的其他表面共享。

## 后果

- 测试钉住：泵退出后重投射的 `tool_use` 不开泵、消息路径对下一个用户 turn 保持空闲；重复 `tool_result` 同样丢弃且读出器仍为真实报告保持武装；无调用 id 的 `tool_use` 仍开泵（兜底）；既有的新 id 工具首帧唤醒测试仍开泵。
- 120 秒 spillover 窗口的代价：前台完成后 120 秒内到达的真实后台唤醒按纯文本中继（回复文本仍送达、`lastResult` 仍记录），而非完整带卡泵。
- 部署：桥包重建 + `/reload`；此后 journal 中每条 `orphan turn pump started` 都应跟着一个真实引擎唤醒 turn 的事件。
