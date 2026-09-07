# Agent Note: mcp-workspace 经 subagent setup seam 贡献其 continuable 子级挂载

Status: implemented

[English](2026-09-06-mcp-workspace-continuable-setup-contribution.md) | 中文

## 问题

fork-local 的 `dsh-mcp-workspace` 包被两个上游包硬引用：`dsh-subagent` 的 `mountDirectoryMcp`（为 `ctx.get('mcpWorkspace')` 的服务类型增强而做的 type-only import，外加 `package.json`/tsconfig 依赖边）与 `dsh-subagent-in-process-driver`（传递性类型解析）。同一份目录挂载逻辑写在了三个组合点：继续执行管理器的 setup（continuable）、one-shot in-process driver 的 setup、以及 session controller 的 `wrap`。上游吸收因此在每次同步时都要把这条 fork-local 依赖重新嫁接回 `dsh-subagent`。

fork 此前已为这种形态加了通用 seam：`SubagentRuntime.registerContinuableSetup()` 让可选包贡献子级作用域能力，而无需继续执行管理器知道这些能力的名字。但该 seam 的贡献签名是同步的，而目录挂载必须在子级创建窗口内 await `agentCtx.plugin(mcp-client, …)`——发布不能先于工具注册，否则 prompt 组装会漏掉 `mcp__<server>__<tool>` 行。

## 决策

seam 现在接受可等待的安装：`ContinuableSetupContribution` 返回 `(() => void) | Promise<(() => void) | void>`，`apply()` 在下一条贡献开始前 await 挂起中的安装，仍停留在子级创建窗口内且先于批次 commit。安装挂起期间被移除的贡献会完成等待、被立即撤销、并使其供应批次失败——同步路径保持的不变量延伸到了 await 窗口。同步贡献的安装方式与之前完全一致（它们之间没有隐藏的 microtask）。

`McpWorkspaceService` 在构造器里经 `ctx.inject(['subagents'], …)` 注册自己的贡献，并把注册绑定到 inject fiber 的 effect 上，因此 continuable 子级（新建与冷恢复）在子级组合的工具遮罩之后按自身 cwd 挂载，卸载本插件即停止未来的挂载。继续执行管理器的 setup 不再调用 `mountDirectoryMcp`。

One-shot 子级保留其挂载：in-process driver 组装自己的 `AgentSetup`，没有任何 registry 覆盖它，所以 `mountDirectoryMcp` 为该路径留在 `dsh-subagent`——但改为面向本地最小接口（`DirectoryMcpService`）而非 fork-local 包。`dsh-subagent` 与 `dsh-subagent-in-process-driver` 不再携带任何形式的 `dsh-mcp-workspace` 依赖；`dsh-mcp-workspace` 的集成 spec 用真实服务驱动经 driver 的真实 one-shot 子级，`mount` 签名漂移会让该 spec 失败，而不是运行时查找静默损坏。

反向的边现在单向且已声明：`dsh-mcp-workspace` 以 peer/dev 依赖 `dsh-subagent` 并在 tsconfig 中引用它。原先的双向 tsconfig 引用对无法与这条边共存（project references 不允许成环），这正是迫使 one-shot 查找去掉 type import 的原因。

session controller 的 `wrap` 组合（第三份）按 fork 嫁接台账的登记，留待上游通用 agent-setup seam，不在本次范围。

## 考虑过的替代方案

- **在贡献里发起挂载但不等待**——否决：发布会先于工具注册，子级的第一轮 prompt 组装将缺失 `mcp__` 行。这个 await 是语义要求，不是实现细节。
- **保留 `mountDirectoryMcp` 的 type-only import、只迁移 continuable 路径**——否决：`dsh-mcp-workspace` 为注册贡献必须引用 `dsh-subagent`（类型解析需要 tsconfig reference），而 project references 不允许成环。上游→fork-local 的引用对无法与反向边共存。
- **为 one-shot 贡献增加第二个 registry 方法**——与 session-controller 那份一同推迟：它需要自己的协议决策（one-shot 子级该收到哪些贡献），且两者都属于嫁接台账已登记的上游通用 agent-setup seam。

## 结果

- one-shot 查找以本地声明的接口换取了 declaration merging 的类型安全。集成 spec 是漂移防线；把 `mount` 改名在 mcp-workspace 测试的上游编译都干净通过，并在那里失败。
- 未加载 `mcp-workspace` 的部署在 continuable 路径不再 warn（只有 one-shot 子级会到达 warn-once 分支）。该警告的受众——忘了加插件行的部署运维——仍会从第一个 one-shot 子级得到它；纯 continuable 部署保持静默，这是上游包不知道 fork-local 特性存在这一事实的固有代价。
- 上游吸收 `dsh-subagent` 时不再重新嫁接 fork-local 依赖：child-agent 源码不再携带任何 `dsh-mcp-workspace` 引用，鸭子类型查找是那里仅剩的一条 fork 感知代码行。
