# Agent Note: chatroom 在途 gather 互锁与 askq 过期提示拆分

Status: implemented

[English](2026-09-02-feishu-bridge-chatroom-followup-guards.md) | 中文

## Problem

2026-09-02 中途参与调研带出的三个隐患，经授权作为跟进项处理：

- **重复 gather 覆盖在途屏障**：`gatherRoles` 只守卫了收尾屏障与挂起的 ask-human；`pendingGather` 在途时再次 gather 会替换屏障对象——旧一轮的定时器、期望集与已收回复全部丢弃，而角色仍对着一个无人持有的屏障继续生成。
- **gather 在途时主持人的 `ask` 两种情况都丢答案**：busy 角色的回复不再 relay（gather 问题已消费一次性 relay gate）、idle 角色的回复被吞作该角色的 gather 回复。
- **无停放 ask 时 askq 过期提示误导**：同一份文案（`AskqStaleQuestion`「问题列表已变化——请用文字回答当前问题」）同时服务「在途 ask 的题目列表变了」和「卡片对应的 ask 整个没了（已答完/被取代/重启丢失）」——后者根本没有当前问题可答。

## Decision

- `gatherRoles` 对在途 `pendingGather` fail loud（`Msg.ChatroomGatherInFlight`）：在途屏障与 seq 原样保留。
- `askRole` 对在途 `pendingGather` fail loud（`Msg.ChatroomAskGatherBlocked`），文案点名两条出路——等本轮收齐唤醒后再问，或把追问并入下一轮 gather 任务。对 ask-human 回答回路安全：挂起的 ask-human 与在途 gather 由既有双向守卫互斥，且 `routePendingHumanReply` 在 gather 在途时直通回落。
- 过期文案按站点拆分：`AskqStaleCard`（无停放 ask——提示指向普通聊天消息）给 `staleAskqCardAction`，`AskqStaleQuestion`（在途 ask、题目列表变化）留在 `routeQuestionResponse`。
- 依赖旧「屏障覆盖」行为串轮次的研究轮上限 spec 改为轮间清屏障（对齐引擎收齐流程）；它们钉住的上限语义不变。
- 双机 live profile 的 chatroom `defaults` 设 `researchTimeoutSec: 7200`（Mac + dev 服务器）：60 分钟默认值在 2026-08-30 北京房价场反爬限流下轮轮超时，实际每轮 73–80 分钟。

## Alternatives considered

**让 gather 在途的 ask 正常工作而非拒绝**——把 ask 排到屏障之后、单独 relay 其答案。这需要每个角色第二条在途 ask 生命周期加一套新 relay 语义；拒绝并指路的文案经轮次边界达到同样的用户效果，机制量级天差地别。

## Consequences

- 主持人 gather 在途的转向尝试现在得到明确报错而非静默丢失；基于超时的催收流程不受影响——`fireGatherTimeout` 先清 `pendingGather` 再唤醒主持人。
- 两个新守卫均为 spec 钉住的模型可见错误文案；不改引擎状态、工具 schema、事件。
