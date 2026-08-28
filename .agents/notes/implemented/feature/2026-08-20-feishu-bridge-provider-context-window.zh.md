# Agent Note：per-provider context_window 接线（#12）

Status: implemented

[English](2026-08-20-feishu-bridge-provider-context-window.md) | 中文

## 问题

M7-b usage 域落地了 ctx% 消费方（状态页脚的 SDK token 累积）和引擎方法 `applyActiveProviderContextWindow`（Go `engine_provider.go` 的移植），但它重算的值恒为 project 级回退：插件 `ProviderRoute` schema 没有 `contextWindow` 字段，adapter 的 `getActiveProvider()` 只回 name-only 配置，`active?.contextWindow` 永远是 undefined。Go 在每次 provider 切换后都重算窗口（engine_provider.go 的 `switchProvider`/`switchProviderResume`/`cmdProviderShortcut` 与卡片切换路径）；TS 移植只在装配时调用一次。后果：`/provider` 切到窗口不同的模型后，页脚 ctx% 仍按旧窗口做分母。2026-08-20 的 FEATURE-PARITY.md 复核把这一点记为 #12 的天花板；本次改动移除它。

## 决策

把 Go `ProviderConfig.ContextWindow` 链路端到端接通。`ProviderRoute`（插件配置）新增 `contextWindow?: number`；`buildProjectAssembly` 转发到 adapter 路由；`DshAgentAdapter.getActiveProvider()` 在有值时带出（`exactOptionalPropertyTypes` 下用条件展开，JSDoc 的 "name-only" 措辞同步更新）。`provider-commands.ts` 的全部切换点——`switchProvider` 与 provider 卡动作（两者经共享核心 `applyProviderSwitch`）、`switchProviderResume`、`clear` 子命令、`cmdProviderShortcut`——在 `setActiveProvider` 成功后立即调用 `e.applyActiveProviderContextWindow()`，先于 interactive-session 清理，对齐 Go 顺序。未声明窗口的路由与清除选择回退 `projectContextWindow`（project `contextWindow`，默认 200k），行为不变。

## 备选方案

**切换时从 llm 服务路由的模型元数据推导窗口。** 否决：profile 的模型行本来就带 `contextWindow`（供 llm 服务用），但 bridge 有意把路由明细留在自己的配置里（adapter 只持有成员关系与 active 指针）；从 bridge 伸手进 llm-provider 内部会为了一个运维者一行配置就能写明的值耦合两个包。

## 后果

声明了 `contextWindow` 的路由从装配起、以及每次切换后，都由它驱动 ctx% 分母——多窗口舰队（如 1M 窗口的 GLM 与 128k 路由并存）能报出诚实的百分比。不带该字段的配置行为与之前完全一致（回退链未动）。live daemon 在运维者给某路由加字段之前无需任何变更；既有的「/provider 双路由切换」日常验证项顺带覆盖真机检查（切换到窗口不同的路由后观察 ctx% 变化）。

## 测试

`tests/engine/provider-commands.spec.ts`（stub switcher 扩展了 per-route 窗口）：切到有窗口的路由、切回（project 回退恢复）、clear（回退）、shortcut 与 `--resume` 都重算。`tests/agent-dsh/adapter.spec.ts`：`getActiveProvider` 只在有值时带出窗口。`tests/assembly-config.spec.ts`：active 路由窗口胜过 project 窗口并到达 adapter。包全量 1843 绿；包 typecheck 与新增文件 lint 干净。
