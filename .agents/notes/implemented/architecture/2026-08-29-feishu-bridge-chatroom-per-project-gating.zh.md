# Agent Note: per-project chatroom gating through a service-registered tool mask

Status: implemented

[English](2026-08-29-feishu-bridge-chatroom-per-project-gating.md) | 中文

## Problem

一个 feishu-bridge daemon 把所有机器人作为单一 bridge 插件行下的 project 托管，而 chatroom 插件是进程级挂载：启动扫描给每个引擎注册 `/chatroom`，`feishu_bridge_chatroom` 工具对整个进程注册一次、按 caller agent 路由。只想让部分机器人拥有 chatroom 的部署因此全员拥有它，代价还不止命令面板：工具描述加 schema（约 600 token）与内置主持 skill 的目录条目（约 200 token）进入每个机器人每一次模型请求，无论用不用；看得见工具的模型还可能被说动在不该有聊天室的机器人上开一个。

## Decision

项目用 chatroom 插件自己配置上的一个旋钮退出——`defaults` 或该项目的 `projects` 条目里 `enabled: false`（默认 true）。一个旋钮驱动两半，无需配对：

- **功能面**：扫描对禁用引擎跳过 `registerChatroomCommands`；工具 `execute` 对路由到禁用引擎的调用以明确报错拒绝（兜底掩码登记前启动窗口里创建的会话，见下）。
- **模型面**：插件把工具名登记到桥服务的按引擎 deny 注册表（`FeishuBridgeService.denyTools(engine, names)`，可逆注册）。装配给每个 adapter 接线 `setDeniedTools(() => service.deniedToolsOf(engine))`；adapter 创建期掩码——`withProjectToolMask`，MCP 允许列表包装的推广——在每次会话创建时把这些名字 restrict 到 agent scope，并以同样方式转发进 continuable 子会话的 `toolFilter`，与[按项目 MCP 可见性](../feature/2026-08-25-feishu-bridge-per-project-mcp-visibility.zh.md)机制完全同型，只是来源从配置字段换成服务登记。定义由此完全不进禁用项目的模型请求。
- **Barrier 恢复对禁用引擎无条件保留**：它清的是项目被禁用前已武装的聊天室（收束恢复的 gather、通知主持人），不是新入口。

`denyTools` 是服务方法而非 bridge 配置，因为当前唯一消费者是兄弟包：配置字段会成为用户必须与 `enabled` 配对的第二个旋钮（配错会得到一个没有自己工具的主持人），服务缝保持单一用户设置且构造上就不会配错。bridge 保持通用——它持有掩码存储与 adapter 读取，chatroom 持有"隐藏什么"的决策。

## Alternatives considered

- **仅 execute 期拒绝**（工具内一个 `enabled` 检查）。否决，不够：定义仍进每次请求——部署为了省 token 而禁用，钱照付；模型仍看得见（且可能被说动调用）该工具。
- **bridge 配置按项目加 `denyTools` 字段，与 chatroom 的 `enabled` 并列。** 否决：两个独立可设的旋钮守一个决策；只设 bridge 字段不禁用 chatroom，会让主持人在没有自己工具的 schema 视图下生成，讨论中途卡死。
- **把不挂 chatroom 的机器人拆进第二个 daemon/profile（bundles 不含 chatroom 包）。** 对此需求否决：多一个进程（自己的 LSP/MCP 客户端）、多一个 launchd/reload 单元、会话存储分家，而配置字段已给出该粒度；按进程隔离只在故障或资源隔离时才是答案。
- **经 agent presets 按会话挂载 chatroom**（Web 组合机制，`packages/preset/agent-presets`）。暂否决：feishu-bridge adapter 未接 preset 组合，chatroom 的进程级半边（codec、policy 监听、命令扫描）会按 preset 代次重复注册，`/chatroom` 命令又是引擎级的——按会话组装是独立项目，与按机器人门控正交。
- **什么都不做**（chatroom 调用前完全惰性）。在所有机器人都可能用的情况下成立；本次变更存在的前提是部署的机器人多数永远不用。

## Consequences

- 禁用项目的请求仍带内置主持 skill 的目录条目（skill provider 是进程级的；skill-filesystem 自定义目录无按项目作用域）——约 200 个惰性 token，包 README 已记录。
- 掩码有启动窗口：桥就绪到 chatroom 扫描之间创建的会话看得到定义，改在 execute 被拒。
- deny 掩码机制的启动窗口与复活天花板原样适用（deny 掩码放行后到的未具名全局；不在活注册表里的名字静默掉落——登记方可能已卸载）。
- `defaults.enabled: false` 且无项目覆盖即禁用所有机器人，等效插件行 `disabled: true`；按项目门控与 presets 仍可组合（将来若把 chatroom 模型面拆进 preset，会叠加在 execute 检查之上）。
- 生产 profile 在 `feishu-bridge-chatroom` 行下加 `projects.<bot>: { enabled: false }` 并 `/reload` 即关停某机器人；bridge 配置零改动。

## Related

- [chatroom 功能抽取为独立包](2026-08-29-feishu-bridge-chatroom-extraction.zh.md)——本门控乘坐的兄弟插件挂载；其扫描现对禁用引擎跳过命令注册。
- [按项目 MCP 工具可见性](../feature/2026-08-25-feishu-bridge-per-project-mcp-visibility.zh.md)——服务注册表复用的创建期掩码机制。
