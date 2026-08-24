# Agent Note: feishu-bridge 把 subagent 运行时交给 dsh-base，经 bundle patch 覆盖结算投递

Status: implemented

[English](2026-08-24-feishu-bridge-subagent-mount-duplicate-provider.md) | 中文

## 问题

`f1ce74f8a4` 在 bridge 的 `apply()` 里自挂 `SubagentRuntime`（`settlementNotice: 'external'`）与 in-process spawn/fork providers，依据的假设是「同时加载 `dsh-subagent` 的 profile 才会冲突」。但 feishu-bridge profile 的第一个 bundle 就是 `dsh-base`，其 patch 自 `b650ab0fab`（2026-08-16）起就声明了 `subagent` / `subagent-spawn-in-process` / `subagent-fork-in-process` entry。base 先注册 `spawn`/`fork` provider，bridge 的第二次 `registerProvider` 抛 `DUPLICATE_PROVIDER`，整棵插件树加载失败、daemon 退出——launchd KeepAlive 随之 crash-loop，用户侧表现为「发消息没反应」。缺陷一直潜伏，直到 2026-08-24 16:24 `reload.sh` 重建 host lib（此前运行中的 daemon 还是没编译进自挂代码的旧 lib）。`reload.sh` 的 `--dump-config` preflight 只 compose entry 列表、不 apply 插件，拦不住 apply 阶段的冲突——compose 层面每个 entry 恰好只出现一次。

## 决策

bridge 不再自挂 subagent 栈；运行时与两个 provider 归 `dsh-base`。bridge 的 `cordis.patch.yml` 以 `- id: subagent` + `settlementNotice: external` 覆盖 base entry——引擎自己驱动 parent turn，runtime 的 inbox 自唤醒会花掉一个引擎从未调度的模型请求。type-only 的 `SubagentRunEndInfo` import 恢复了随值 import 一并带入的 `'subagent/end'` 事件表声明合并，并替掉手搓的结构化监听类型。`requireSubagents` 的报错文案改为指明挂载方是 `dsh-base`。

## 备选方案

**给自挂加守卫**（`ctx.get('subagents')` 缺失才挂）。否决：条件化组装掩盖了 profile 契约，各 profile 拓扑不一致；缺失引用该响亮失败，而不是静默自愈。

**保留自挂、从 `dsh-base` 摘掉 subagent entry。** 否决：base 服务所有 profile，entry 归 base 所有；bridge 是带唯一一个 config 覆盖的消费方。

**捕获 `DUPLICATE_PROVIDER` 后跳过。** 否决：吞掉注册冲突会掩盖别处的真实双重挂载。

## 后果

不含 `dsh-base`（或等价 subagent entry）的 profile 没有 `subagents` 服务；`requireSubagents` 以 `mounted by dsh-base` 文案响亮失败。REAL 组装测试不变——它自己挂运行时，与 base 的行为同构。`dsh-subagent-fork-in-process` 从 bridge manifest 移除（移除自挂后不再使用）；`dsh-subagent` 与 `dsh-subagent-spawn-in-process` 因测试引用保留。`--dump-config` preflight 的盲区仍在：它校验的是组装而非插件应用——未来的 apply 阶段冲突仍只会在 daemon 启动时暴露。

## 测试

包测试套件：2249 通过（`reload-script.spec.ts` 的 8 个失败为存量问题，在未改动的树上同样失败）。真机验证：`reload.sh` 构建 → WS ready、单进程稳定、零 `DUPLICATE_PROVIDER`，测试群 `/new` 冒烟消息收到会话卡回复。
