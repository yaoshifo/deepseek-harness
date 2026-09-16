# Agent Note: ACP config-option 通知只在净变化时发出

Status: implemented

[English](2026-09-16-acp-config-option-net-change-suppression.md) | 中文

## 问题

`AcpSession` 在 armed 之后对每一条 `llm/adapters-updated` 都发布一条 `config_option_update`。布防发生在创建会话的 `session/new`/`session/resume` 响应解析时，但插件装配与这个时点之间没有顺序保证：`registerConfigurableProviders` 的 commit 由 provider 插件的异步 start 调度，多数运行落在布防之前，约六分之一的运行落在之后（探针实证：各次运行的事件时间线一致，失败运行里目录 commit 跨过了布防线）。漂进窗口的那条会发布一个与创建响应完全相同的 config state，且它在会话 stdout 里的位置取决于竞速结果，使 `ask-question-multi-select-variant` ACP 快照间歇性失败（本机约 17%）。

## 决策

- `armTopologyNotifications(initial)` 记录创建响应携带的 config state 作为 `lastNotified`。
- `topologyChanged()` 重算 options，与 `lastNotified` 做 `JSON.stringify` 相等比较（`state()` 以固定键序构造 options，签名稳定），无净变化则吸收，有通知则记录。
- 契约变化：通知跟随 config state 的净变化，而非 adapters-updated 事件。创建窗口静默（option discovery 期间的注册）、窗口后发布、provider 消失时发布可恢复选项这三个契约测试的行为保持不变；新增被抑制的只有无净变化的回显。

## 考虑过的替代方案

### 为什么不在首个 prompt 进入时布防？

那样能吸收所有装配期漂移，但也会吸收客户端在会话创建与首个 prompt 之间应当看到的真实 topology 变化，与既有的「窗口后注册必须通知」契约测试矛盾。

### 为什么不过滤 dispose 来源的事件？

失败运行里的漂移者是注册类 commit 而非 dispose；且「provider 消失（dispose 来源）必须通知可恢复选项」的契约测试要求 dispose 事件也通知。按来源过滤既错过竞态又两头破坏契约。

### 为什么不录第二份 stdout 快照变体？

快照套件支持多变体期望，把竞速形态录成第二变体能让测试通过——但那等于把产品的时序泄漏固化成两份黄金样本，掩盖转写正在展示的缺陷；这是 flake-masking，不是修复。

## 后果

- 重算结果与上次通知相同的事件不再通知——包括落在相同内容上的合法刷新。ACP 客户端消费的是状态而非事件，相同内容的刷新不携带信息；这是为消除时序泄漏付出的、被接受的代价。
- 与布防时点竞速的装配期注册无论怎样调度都不再出现在会话转写里。

## 测试

- 回归用例 `suppresses topology notifications that leave the config state unchanged` 在修复前失败（2 条 update）、修复后通过（1 条，仅状态真正变化的注册）。
- acp 的 bridge/updates/model-control/multi-session/dispose 套件通过（78/78）；此前后飘的快照场景修复后 20/20 通过（修复前失败率 17%）。