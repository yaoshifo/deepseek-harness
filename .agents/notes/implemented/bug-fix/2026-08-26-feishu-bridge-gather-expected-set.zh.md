# Agent Note: feishu-bridge subtask gather 等待集成员资格

Status: implemented

[English](2026-08-26-feishu-bridge-gather-expected-set.md) | 中文

## Problem

2026-08-26 晚间，聊天室 hub oc_b46da516（bot 教学驴）在 `feishu_bridge_subtask {"action":"gather"}` 里挂了 17 分钟：journal 显示 `gather armed on parent (expected=5 timeoutS=1200)`，而当时的在途工作只有两个聊天室角色（hamming、polya），它们的回复早已中继回 hub。等待集来自 `gatherSubtasks` 的第一个循环——所有 `parentSessionKey` = hub 且 `subtaskReported` 为假的会话——恰好计入五个聊天室角色群：三场已结束的残留（popper、marks、lakatos；chatroom 收场清理会剥掉角色字段，记录只剩 parent = hub）加两个活角色。聊天室角色群从创建起就没有 subtask depth（chatroom 派发路径不经过设 depth 的群派发），而每条 subtask 回报路径都要求 depth > 0，角色回复永远无法 bank 进屏障——屏障唯一的结算点是 `deliverParentReply → SubtaskGather.accumulate`。gather 于是在等五个结构上不可能回报的会话直到 20 分钟超时，期间持着父回合的锁；用户在第 17 分钟手动终止。当晚早些时候的重启不是诱因：污染源（挂在 hub 下的角色会话）在正常运行中就存在，popper 的会话比重启还早。

agent 侧的触发点是 moderator 为角色回复调错了 gather（聊天室工具自带的 ask/gather 才是那个 seam）；引擎的失误是把一个错误但貌似合理的调用变成 20 分钟挂起，而不是立刻报错。

## Decision

- `gatherSubtasks` 第一个循环在 parent 与未回报之外追加要求 `subtaskDepth > 0`：等待集只允许持有能结算屏障的会话，因为所有回报路径（自动汇报、显式回报、重新武装、超时结算）都以同一 depth 为门槛。聊天室角色群——活的或残留——一概不进；原生子任务仍经第二个循环加入，不变。
- 没有可收集子任务的父会话现在以既有的 `SubtaskGatherNoPending` 错误快速失败，错调的 gather 以工具错误返回，agent 可据此自纠（等角色用 chatroom gather）。

## Alternatives considered

- **把聊天室角色回复 bank 进 subtask gather 屏障。** 否决：角色是一场讨论里应答多次的长期人设，「已回报」对它们没有语义，桥接两个扇入屏障让一条消息走双唤醒路径。
- **按 `chatroomHubKey`/`chatroomRoleName` 标记排除角色群。** 否决：chatroom 收场清理会剥掉已结束角色会话的这些字段，残留与任何普通父挂会话无法区分——depth 判据用一个所有回报路径都已检查的持久字段同时覆盖活角色与残留。
- **按会话存活过滤。** 否决：已结束角色的会话对象在注册表里仍然存活（它是历史，不是尸体），存活状态区分不了角色与子任务。

## Consequences

- 群路径 subtask 子会话（`/spawn`、attended `feishu_bridge_subtask` 群）不受影响：群派发路径在创建时赋 depth = parent + 1，照常进屏障。
- moderator 侧的 prompt/skill 指引未改；快速报错即纠正路径（已观察到 moderator 遇工具错误会改调正确工具）。
- 覆盖：`tests/engine/engine-subtask.spec.ts` 的成员资格用例（活/残留角色排除、depth 子会话保留、已回报排除）与纯角色快速失败用例；既有原生子任务 gather 用例不变且全绿。
