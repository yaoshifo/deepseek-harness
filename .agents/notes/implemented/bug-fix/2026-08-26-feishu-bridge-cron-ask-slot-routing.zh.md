# Agent Note: feishu-bridge cron new-per-run 会话的 ask 路由到交互槽位键

Status: implemented

[English](2026-08-26-feishu-bridge-cron-ask-slot-routing.md) | 中文

## Problem

2026-08-26 的 cron-fbe6d268 盘前检查运行（session mode `new_per_run`）以 `ask_user_question` 在 8 毫秒内返回 `{"answers":[{"id":"followup","selected":[]}]}` 收场——卡片从未发出，agent 把空选择读成「用户不要后续处理」，并把这条错误结论写进了自己的记忆。根因：`executeCronJob` 把 new-per-run 运行的 interactive state 停放在槽位键 `<runSessionKey>#cron:<sideSessionId>` 下，而 adapter 的权限应答器与 userQuestions provider 传给 `Engine.askUser` 的是裸 `DshAgentSession.sessionKey()`，后者按精确键查 state。运行期间裸键下没有 state（聊天自身的 state 已被空闲回收，或属于另一个 turn），ask 于是落进 `unattendedAskDecision`：questions 类回答空选择、permission 类自动放行。同一键错配还让所有 cron new-per-run 运行中的权限请求被静默 auto-allow，或在聊天恰好有活跃 state 时错挂到那个无关 state 上。

留给后续排查的判别特征：question ask 在个位数毫秒内返回、每题恰一条 `{id, selected: []}`（adapter 自己的空兜底返回的是零元素数组），且 daemon 日志里没有任何发卡调用。

## Decision

- `SessionStartOptions.interactiveSlotKey`（[session start options](../simplification/2026-08-24-feishu-bridge-session-start-options.zh.md)）在交互槽位键与 `sessionKey` 不同时（cron new-per-run 的 `#cron:` 槽位）携带前者。`getOrCreateInteractiveStateWith` 负责填入；`DshAgentSession.askSlotKey()` 暴露它，缺省回落到会话键。权限应答器、questions 处理器与 plan-review 应答器统一把 `askSlotKey()` 传给 [ask delegate](../simplification/2026-08-24-feishu-bridge-ask-delegate.zh.md)，卡片因此渲染在运行自己的 state 上，飞书回调的 `value.session_key` 盖章又把点击原路路由回同一槽位。
- 无人值守兜底现在会打日志。`Engine.askUser` 在按无人值守作答前（无 state 与无 platform 两个分支）打 warn，adapter 在活会话未命中或缺 delegate 而捏造空答案时打 warn。静默空答案正是这次事故在生产日志里不可见的根源。

## Alternatives considered

- **在 `askUser` 里按 `${sessionKey}#cron:` 前缀扫描 `interactiveStates`。** 否决：后缀携带调用方不知道的 side-session id，同一聊天上的并发运行会让扫描有歧义，前缀匹配也削弱了 engine 对该 map 的精确键所有权。
- **按活跃 agent 会话而不是键匹配 interactive state。** 否决：每次 ask 都要 O(n) 扫描，且要重开 ask-delegate seam 已冻结的 `AskDelegate` 签名；显式传递槽位键让路由保持确定性、map 查找保持原样。
- **把 cron new-per-run 运行当作无人值守、让 ask 大声失败。** 否决：运行刻意拥有自己的 interactive state、流出报告，其绑定聊天也能回答卡片——应答器的设计注释写明无人值守会话上的 questions 仍以卡片呈现。缺陷在路由键，不在能力。

## Consequences

- cron new-per-run 运行现在会在任务绑定的聊天里真实呈现 ask 卡（questions 与 permission 两类）并阻塞等待。用户永不作答则 turn 无限期停放——空闲 reaper 跳过停等的 `pendingAsk`，与普通聊天会话一致；cron 运行专用的整卡超时（research-manual 模式已有的形态）尚未构建。
- `DshAgentSession.sessionKey()` 仍返回裸键；`sessionsByEngineKey` 的身份校验依赖它。只有 ask 路由读取槽位键。
- 覆盖于 `tests/engine/cron-execute.spec.ts`（启动选项携带槽位键）、`tests/engine/engine-m3-askq.spec.ts`（槽位键下的停放/结算往返；裸键未命中按无人值守作答）、`tests/agent-dsh/adapter.spec.ts`（questions 与权限在槽位键下委托）。
