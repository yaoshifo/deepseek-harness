# Agent Note：per-provider context_window 接线（#12）

Status: implemented

[English](2026-08-20-feishu-bridge-provider-context-window.md) | 中文

## 问题

M7-b usage 域落地了 ctx% 消费方（状态页脚的 SDK token 累积）和引擎方法 `applyActiveProviderContextWindow`（Go `engine_provider.go` 的移植），但它重算的值恒为 project 级回退：插件 `ProviderRoute` schema 没有 `contextWindow` 字段，adapter 的 `getActiveProvider()` 只回 name-only 配置，`active?.contextWindow` 永远是 undefined。Go 在每次 provider 切换后都重算窗口（engine_provider.go 的 `switchProvider`/`switchProviderResume`/`cmdProviderShortcut` 与卡片切换路径）；TS 移植只在装配时调用一次。后果：`/provider` 切到窗口不同的模型后，页脚 ctx% 仍按旧窗口做分母。2026-08-20 的 FEATURE-PARITY.md 复核把这一点记为 #12 的天花板；本次改动移除它。

## 决策

把 Go `ProviderConfig.ContextWindow` 链路端到端接通。`ProviderRoute`（插件配置）新增 `contextWindow?: number`；`buildProjectAssembly` 转发到 adapter 路由；`DshAgentAdapter.getActiveProvider()` 在有值时带出（`exactOptionalPropertyTypes` 下用条件展开，JSDoc 的 "name-only" 措辞同步更新）。切换路径上的 `applyActiveProviderContextWindow()` 调用（此处为对齐 Go 而加）后由[按群生效的 provider 路由](2026-09-03-feishu-bridge-per-chat-provider-routes.zh.md)移除：按群切换不移动项目指针，没有需要重算的东西。未声明窗口的路由与清除选择回退 `projectContextWindow`（project `contextWindow`，默认 200k），行为不变。

## 备选方案

**切换时从 llm 服务路由的模型元数据推导窗口。** 否决：profile 的模型行本来就带 `contextWindow`（供 llm 服务用），但 bridge 有意把路由明细留在自己的配置里（adapter 只持有成员关系与 active 指针）；从 bridge 伸手进 llm-provider 内部会为了一个运维者一行配置就能写明的值耦合两个包。

## 后果

`Engine.contextWindow` 目前是只写不读的状态：2026-09-03 的穷尽检查没有找到任何读取方——ctx%/占用率的分母来自各会话自己的 context snapshot（`/context` 投影与 reply-footer 探测），不是引擎字段——因此该配置字段唯一存活的效果是 `getActiveProvider()` 把它带出。启动调用（`buildProjectAssembly`）与 `setContextWindow` 保留；接一个真实消费方（或移除死字段）是开放项。不带该字段的配置行为与之前完全一致（回退链未动）。

## 测试

`tests/agent-dsh/adapter.spec.ts`：`getActiveProvider` 只在有值时带出窗口。`tests/assembly-config.spec.ts`：active 路由窗口胜过 project 窗口并到达 adapter。切换路径的重算测试随按群改动一并移除（见取代 note）。包全量绿；包 typecheck 干净。
