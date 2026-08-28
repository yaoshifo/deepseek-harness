# Agent Note: feishu-bridge provider 卡（#9 卡片面）

Status: implemented

[English](2026-08-28-feishu-bridge-provider-card.md) | 中文

## Problem

`/provider` 命令族（M7-c）此前所有界面都是纯文本：裸命令打印带 ▶ 标记的路由列表，然后要求用户重新手打 `/provider switch <name>` —— 而 Go 的 provider 卡早已把这段交互变成每路由一次点选。MIGRATION.md 把卡片推迟到渲染域；与此同时引擎的通用卡片动作注册表（`Engine.registerCardAction`）虽为特性卡选择器而生，却一直没有生产消费者——推迟也让这条路径在单测之外从未被验证过。

## Decision

卡片平台（`supportsCards`）上裸 `/provider` 渲染 provider 卡（移植 Go `renderProviderCard`，engine_provider.go）：indigo 标题卡，含当前路由行、每路由一行 `listItemBtn`（`▶`/`◻` + 名称 + 可选 model 反引号标注），行按钮携带 `act:/provider <name>`，一行提示与返回按钮。按下的行经 `registerProviderCommands` 注册的 `registerCardAction(['/provider'])` 分发：非空参数即切换，走与文本命令相同的 `applyProviderSwitch` 核心（setActiveProvider → context window 重算 → usage 探测器同步 → agent session id 处理 → 持久化），引擎将返回的卡原地 PATCH；查找失败（路由表变化后的陈旧卡）不切换，以 not-found 通知重渲染。帮助卡的 provider 行原地打开本卡（`nav:/provider`，无参 → 仅渲染）。两个前缀共用一个 handler，前提是本卡自持其发出的全部动作值：任何 `nav:/provider <name>` 生产者都必须被刻意添加，而现状不存在。（同日晚些时候，模式行把热切换搬上了卡——[provider 卡热切换模式](2026-08-28-feishu-bridge-provider-card-hot-mode.zh.md)——取代下方备选方案里的"仅文本"立场。）

## Alternatives considered

**在 `Engine.handleCardAction` 里加内联 `/provider` 分支，与 `/dir`、`/switch` 并列。** 否决：注册表本就是为特性卡选择器准备的，能让 engine.ts 零改动（M7 的 engine 热点纪律），并让注册表路径获得首个生产消费者；内联分支携带的 act:/nav: 前缀区分在这里并不需要（见 Decision）。

**卡上加热切换（`--resume`）按钮。** 否决：为低频变体让每行翻倍；提示行指明文本命令即可，Go 卡也只提供普通切换。同日部分被取代：模式行变体（[provider 卡热切换模式](2026-08-28-feishu-bridge-provider-card-hot-mode.zh.md)）在不翻倍行数的前提下加入了热切换。

**Go 的 NeedNew 提示文案。** 不沿用：TS 切换本就清空 agent session id，下一条消息即在新路由上开新会话、无需 `/new`；卡片提示陈述真实语义（点击 = 新会话）。

## Consequences

飞书上切换是一次点选，被按的卡原地变成结果视图（切换通知 + ▶ 标记移动），而非一条新文本消息；纯文本平台与 list/current/clear 子命令不变。点击已激活的路由会重跑切换（再次清空 agent session id）——与 `/provider <当前名>` 及 /dir 卡重复选择刻意保持同语义。普通切换副作用从此有两个入口共享一个核心，未来切换语义变更只需落在 `applyProviderSwitch` 一处。注册表路径获得生产验证；`registerProviderCommands` dispose 后到达的卡动作如未知动作一样静默落空（HMR 安全）。卡切换的持久化沿用既有 providerSaveFunc → project state 链，不变。

## Testing

`tests/engine/provider-commands.spec.ts`：裸命令渲染卡（行、▶ 标记、act: 值、model 反引号）且不发文本；按下行的用例完成切换、清空 session id、持久化并以移动后的标记与切换通知原地 PATCH；未知路由保持状态并显示 not-found 通知；`nav:/provider` 仅渲染不切换；dispose 移除动作。`tests/assembly-misc.spec.ts`：装配引擎上的卡动作翻转 adapter 活跃路由（注册 → 注册表 → adapter 全链，独立临时 root，持久化的切换不会泄漏进共享默认 root 的装配）。包全量套件 2548 绿。
