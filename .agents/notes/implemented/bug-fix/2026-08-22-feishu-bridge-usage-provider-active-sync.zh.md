# Agent Note: feishu-bridge 的 usage provider 从未收到活跃 provider 名

Status: implemented

[English](2026-08-22-feishu-bridge-usage-provider-active-sync.md) | 中文

## Problem

cc-connect 的移植把 usage-provider 域完整带了过来——`engine/usage.ts` 的 GLM 与 MiniMax 两个 provider，以及渲染为完成卡片折叠面板标题的 ⌛ 配额行——但部署 profile 里配置 `usageProviders` 却看不到任何变化。两个已交付 provider 的摘要都受可选的活跃检测能力门控（GLM：路由名 `startsWith('glm')`；MiniMax：精确匹配），而移植后的 engine 从未对任何 provider 调用过 `setActiveProvider`。名字永远为空时 `isActive()` 恒为 false，`buildCompletionUsage` 跳过所有 provider，⌛ 行永不渲染。

Go cc-connect 在四处同步该名字，TS 移植一处都没带上：装配后的 `SetUsageProviders`（`core/engine.go`），以及 switch-new、flip、switch-resume 三条路径（`core/engine_provider.go`）。

## Decision

单一 engine 方法 `syncUsageProvidersActive()` 读取 adapter switcher 当前的活跃路由名，推送给每个暴露 `setActiveProvider` 的 usage provider（结构化检查，与 `status-footer.ts` 的 `MaybeActiveDetector` 同形）。`setUsageProviders()` 在赋值后调用它完成初始播种；`provider-commands.ts` 的四个活跃路由变化点——switch、switch `--resume`、shortcut、clear——在 `applyActiveProviderContextWindow()` 之后立即调用它，与既有的重解析钩子对称。clear 传播 `''`，正确地禁用所有 detector。

部署侧：线上 profile 增加一行 `usageProviders`（type `glm`、region `cn`、`api_key` 经 `!!js process.env.FB_GLM_API_KEY` 从 systemd unit 环境解析），并把 bridge 路由键 `turbo` 重命名为 `glm-turbo`——GLM 的门控按路由名前缀匹配，指向同一 GLM 网关的 `turbo` 路由否则会隐藏配额行。

## Alternatives considered

**复刻 Go 的逐点循环（四处对 provider 列表的内联遍历）。** 行为相同；一个具名方法让每个调用点保持一行，并让初始播种与切换路径共享实现。

**去掉活跃检测门控（始终展示所有已配置 provider）。** 会在 minimax 路由活跃时仍显示 GLM 配额行——恰是门控要避免的跨 provider 混淆。

## Consequences

⌛ 行可达，切换路由后下一个完成通知展示新 provider 的摘要。需要 usage-provider 门控的路由名从此携带厂商前缀（`glm`、`glm-turbo`）；这是部署命名约定，不是代码。

## Testing

`tests/engine/provider-commands.spec.ts`（"usage provider active sync"）：一个记录 `setActiveProvider` 调用的 detector 桩。红测显示从未发生任何调用——初始播种与全部切换路径皆无；绿测断言 `setUsageProviders` 的播种、⌛ `providerMsg` 的门控（`glm` 活跃时展示、`minimax` 活跃时隐藏），以及 switch、`--resume`、shortcut、clear 的再同步。feishu-bridge 全套件：2036 通过。
