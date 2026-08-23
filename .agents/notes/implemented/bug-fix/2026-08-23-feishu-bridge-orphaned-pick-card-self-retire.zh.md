# Agent Note: 孤儿 chatroom 选择卡在下一次点击时自行退役

Status: implemented

[English](2026-08-23-feishu-bridge-orphaned-pick-card-self-retire.md) | 中文

## Problem

Chatroom picker 状态（`#43` 角色挑选、`#59` 选题）存放在 engine 键控的内存 map 里，daemon 重启即丢，但已推送的选择卡带着活按钮留在群里（2026-08-23 fb-envfix 重启排查时暴露）：点击孤儿卡上的 `confirm` 回复紫色「正在启动聊天室」卡却什么都没启动——状态机在 state 缺失处提前返回，starting 卡却无条件渲染——`toggle` 则被静默吞掉（替换卡为 undefined）。跟着卡片自己的文案走的用户得到的是无声死胡同或假成功，两者都比冻结卡更误导。

## Decision

`executeChatroomCardAction` 在会话无已武装 picker state 时对 `/chatroom-pick` 与 `/chatroom-topic-pick` 双双短路：任何动作（confirm、toggle、cancel）返回同一张灰色失效卡（`chatroom_pick_expired`：本次选择已失效（服务重启或超时），请重新发送 /chatroom）。既有的原地换卡路径（`handleCardAction` → 平台 `refreshCard`）把被点的卡替换为它，一次点击即让孤儿卡退役。无 state 无法区分重启与 pick 看门狗超时，文案同时点名两者。

## Alternatives considered

**跨重启持久化 picker 状态以保住卡片功能。** 只有 `select` 阶段可恢复——`picking` 阶段挂着的 moderator turn 已随进程死亡——且持久化引入停机时写盘，`SIGKILL` 与崩溃照样跳过。该状态本就受 5 分钟看门狗约束；让它跨重启存活只买到一次罕见的 confirm，代价是一条持久状态缝。

**停机时把孤儿卡 PATCH 成失效态。** 依赖优雅停机路径（`kill -9` 仍是孤儿）；点击时退役以零持久化覆盖所有丢失方式。

## Consequences

Picker 状态保持内存态（与 Go 一致）；孤儿选择卡不再假装可用——任何点击把它变成提示重新 `/chatroom` 的失效卡。被重启打断的 chatroom 讨论本身仍不恢复；修复的只是误导性卡面。

## Testing

`tests/engine/engine-chatroom.spec.ts`（"orphaned picker cards"）在无武装状态下对两个 picker 的全部三种动作驱动 `executeChatroomCardAction`，断言灰色失效卡与零 spawn。feishu-bridge 套件：2104 通过。
