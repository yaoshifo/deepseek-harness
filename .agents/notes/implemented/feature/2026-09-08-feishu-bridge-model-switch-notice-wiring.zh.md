# Agent Note: 飞书桥把上游模型切换告知接进会话 setup

Status: implemented

[English](2026-09-08-feishu-bridge-model-switch-notice-wiring.md) | 中文

## 问题

热切换（`/provider switch --resume`，卡片默认模式）保留会话 id、在新路由上续跑 transcript，但新模型对旧模型写下的助手轮次零归因。桥的用户侧反馈（切换回执、🤖 页脚行）已覆盖用户；上游的 `installModelSelection`（PR #3507）补上了模型侧，而桥的组合从未安装它，通知在 daemon 里一次不触发。上游的动机案例直接适用：vision 模型读到文本模型的省图占位符时，会把限制归因到自己。

## 决策

`DshAgentAdapter.startSession` 在会话 setup 链外层加 `withModelSelection` 包装，以会话生效路由（`routeAgentOptions(key)`，每次 start 捕获）作为实时选型安装 `installModelSelection`。新模型的第一个请求携带一条模型可见的 `[model changed: ...]` user 角色告知；其 `source.kind: 'plugin'`，聊天渲染与 recent-turns 窗口本就排除，飞书群零噪音。

## 机制

- provider/model 直通选型；`reasoningEffort` 经 `ReasoningEffortId` 品牌构造转换。未解析出路由的会话保持 `current` 未设，请求配置交回 loop 自行解析。
- 桥的 effort 是项目级、均匀烙进每条路由（2026-08-30 effort 标签修复），监听对请求 effort 的剥除重盖在任何可表达的配置下都是行为中性的：两套路由要么都带同一 effort 要么都不带。
- plain 切换丢会话，无 resume 即无通知；同路由 resume 与持久化请求头一致，保持沉默。

## 考虑过的替代方案

- 把通知钉进引擎消息管线（切换时合成可见的桥消息）：否——缺口在模型侧，且桥有意把 plugin 来源通知排除在聊天渲染外。
- 配置面加 per-route effort 并消费监听的「路由为准」语义：否——桥配置面不存在 per-route effort，加它是独立的产品决策而非接线。

## 后果

- 热切换后新模型知道 transcript 的模型出处；每次真实路由变更约 30 个 retained token，落在历史尾部，前缀缓存不受影响。
- 手搓 adapter 测试上下文补上了 `DshContextLike` 切片本就要求的 `on` 成员（`adapter-mcp-mask`、`adapter-persona`）；真组合覆盖在 `tests/agent-dsh/model-switch-notice.spec.ts`（切换后通知、同路由沉默、项目 effort 保持）。mock LLM 必须声明 reasoning efforts，否则 runtime 会在请求到达 adapter 前拒绝带 effort 的请求。
- 若将来给配置面加 per-route effort，监听的清空行为（无 effort 的路由清空继承值）即告生效，需要独立的产品决策。
