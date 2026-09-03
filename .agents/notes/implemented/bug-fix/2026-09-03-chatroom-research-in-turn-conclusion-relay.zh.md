# Agent Note: research 中继不得丢弃同回合内的结论

Status: implemented

[English](2026-09-03-chatroom-research-in-turn-conclusion-relay.md) | 中文

## Problem

在同一回合内消化了助手结果的研究角色，其回合回复会被静默丢弃。`maybeAutoRelayRole` 只凭 `researchDispatched` 就走 defer，把「本轮派发过助手」与「结论仍未做出」混为一谈。2026-09-02 oc_e51a research 聊天室（小米股价，总时长 9h38m，`researchTimeoutSec: 7200`）现场观测：两个角色都把本轮任务 send 给助手后在同一回合内阻塞等待 subtask gather；gather 在回合内解决（助手回合结束于 00:07 / 02:09 / 02:12 / 03:53），角色得出结论，而回合结束（00:17 / 02:11 / 02:14 / 03:59）仍然走了 defer。六个研究回合里四个的结论以这种方式丢失；每次丢失都让 armed gather 一直挂到 7200s 研究超时，主持人再靠点名追问恢复。`buildGatherTimeoutWake` 读的同一个标志，于是超时报告声称「助手已派发未归」，而实际上助手早已归队、角色早已得出结论。defer 逻辑早于 research 去重批次（2026-09-02）；去重设计的角色-助手链路把它暴露出来。

## Decision

只在派发的助手确实仍欠报告时才 defer：defer 分支额外要求 `assistantReportPending`——预配助手的回合在途（`interactiveStates[key].activeTurns > 0`），或其当前派发周期尚未报告（`!getSubtaskReported()`；父会话的跟进消息会重新置位一次性报告）。助手已报告且空闲时，正在结束的回合就是结论，照常中继进 armed gather。无法解析的助手（无 `researchAssistantKey`、会话已不存在）按悬置处理，为替补 spawn 的助手保留保守 defer。`researchDispatched` 语义与 `buildGatherTimeoutWake` 不变：走了 defer 的角色在 defer 时刻必然有一个可验证悬置的助手。

## Alternatives considered

- **在阻塞 gather 回合内解决时清除 `researchDispatched`。** gather 在子会话任意回合结束时解决，包括中间状态报告（自己又派了 fetcher 的助手会以「等待子任务」结束回合——oc_e51a marks 第 1 轮的形状）；单凭 gather 解决无法区分最终贡献，会重新打开早熟中继路径。
- **保留无条件 defer，依赖助手报告唤醒结论回合。** 该路径只在角色先于助手报告结束回合时成立；回合内消化不会产生后续唤醒，这正是观测到的故障。

## Consequences

- `engine-chatroom.spec.ts` 的测试钉住三种形状：同回合结论中继进 armed gather；助手回合在途时仍 defer；派发周期未报告（静默或被重新置位）时仍 defer。
- 残留一个窄竞态：角色回合恰在助手回合结束与异步报告投递之间（`replyToParent` 经平台卡片发送后 fire-and-forget）结束时，可能中继一条先于报告的回复。对 gather 介导的回合不可达（阻塞的工具调用把回合持住直到结果落地），且未被观测到；相对丢弃所有同回合结论，接受此取舍。
- 下一个 research 聊天室复测：「deferring relay」日志只在助手确实在途时出现，研究 gather 零超时完成。相关笔记：`2026-09-02-chatroom-research-data-dedup`（本中继服务的角色-助手链路）、`2026-09-02-mid-epoch-report-redelivery`（报告投递机制）。
- 部署：chatroom 包重建 + 双机 `/reload`。
