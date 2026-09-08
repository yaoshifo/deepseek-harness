# Agent Note：pick watchdog 要护住排序腿；被丢弃的 pick-roles 按丢弃如实回报

Status: implemented

[English](2026-09-08-chatroom-pick-watchdog-race.md) | 中文

## 问题

2026-09-08 oc_9b99fe794e82aeec4bceb077f9cc784e 事故（vault hub「知识驴 副本」，议题美股定投）：角色挑选 watchdog 在开场快答结算后 1 秒开火。daemon 日志与 moderator 会话日志中的时间线：

1. 23:08:16 讨论群创建；`beginChatroomPick` 上膛 5 分钟兜底 watchdog。
2. 23:09:31 moderator 发出开场快答（14 角色）；23:13:51 以 14/14 结算并唤醒 moderator 排序。
3. 23:13:52 watchdog 开火时快答已不在飞，唯一的推迟条件（`hasActiveChatroomPoll`）不成立：画出兜底卡——全部角色列出、无一推荐、无 blurb。
4. 用户在该卡上点选 5 个角色（`userTouched = true`）。
5. 23:16:03 moderator 的 `pick-roles` 到达（`reasoningEffort: max` 下 2 分 12 秒的排序生成——正常时延，不是卡死），被 `userTouched` 守卫按设计丢弃。
6. 工具仍返回写死的成功话术（"the role-selection card has been rendered"），moderator 据此告诉用户推荐席卡片已发出、9 位默认勾选——与事实相反。

用户手选的 5 个恰好都在被丢弃的 9 个推荐之内，讨论 23:23:51 正常启动；实际损失是推荐始终没上卡，以及 moderator 的汇报失实。

## 根因

设计内的挑选航程（开场快答约 4.5 分钟 + 排序约 2 分钟）超过从上膛起算的 5 分钟 watchdog 窗口，而推迟条件只保护快答腿。快答结算到 `pick-roles` 到达之间的排序腿没有任何保护：watchdog 到点落在这段空窗里就会放出无推荐卡，诱导用户开始自选，此后守卫只能丢弃真推荐。

## 决策

`packages/acp/feishu-bridge-chatroom` 两处改动：

1. **护住排序腿。** `wakeChatroomModerator` 记录每 hub 的唤醒时刻（`lastChatroomWakeAt`），pick watchdog 的推迟条件扩为「快答在飞 **或** 一次唤醒还在窗口内」：每次唤醒都为 wake→`pick-roles` 腿重新打开一个完整超时。兜底卡最早落在 moderator 最近一次唤醒的一个窗口之后。不引入 timer 注册表、不让 `chatroom.ts` 反向 import `chatroom-pick.ts`——惰性推迟在开火时读时间戳，保持既有的单向依赖。
2. **丢弃按丢弃回报。** `renderChatroomPickCardAndPush` 返回 `'rendered' | 'ignored-user-selecting'`，`pick-roles` 工具在 ignored 情形的结果声明推荐未上任何卡、禁止宣称卡片带推荐、建议改为用文字点名推荐。`renderChatroomTopicPickCardAndPush` 与 `pick-topic` 工具在同样的 `userTouched` 丢弃上遵循同一契约。

## 备选方案

- **结算时主动重挂 watchdog。** 需要 `chatroom.ts` 调入 `chatroom-pick.ts`（import 成环）外加每 hub timer 注册表；惰性推迟用一个时间戳达到同等窗口。
- **把迟到推荐角标合并进用户已点选的卡。** 暂缓：会在用户正在编辑的卡中途改变卡片含义；待有事故需求再做。
- **加大固定超时。** 仍然竞态——快答时长随角色库规模变化。

## 后果

- `tests/engine/engine-chatroom.spec.ts` 用假定时器钉住两个 watchdog 时序（无唤醒时上膛后一个窗口开火；唤醒后越过原始期限仍 `picking`、唤醒后一个窗口才开火）与返回值契约；`tests/tools/chatroom-tool.spec.ts` 钉住两个选择器的 ignored 情形如实话术。
- `tests/engine/chatroom-poll.spec.ts` 的结算后断言随行为更新：结算唤醒现在拥有完整窗口，兜底卡落在唤醒后一个窗口，而非下一个到期点。
- 部署：bridge 重建 + `/reload`。
