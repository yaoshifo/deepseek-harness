# Agent Note: chatroom bare persona 抑制工作区指令注入

Status: implemented

[English](2026-08-25-feishu-bridge-chatroom-bare-suppresses-agent-instructions.md) | 中文

## Problem

Go 的 chatroom 会话以 `--bare` 运行 claude 后端，`--bare` 禁用 CLAUDE.md 自动发现；人设本身由 `agent/claudecode/persona_load.go` 读取。TS 移植用 `complete: true` 系统提示段替代了 `--bare`——但它只替换 prompt **sections**。`agent-instructions` 插件把 AGENTS.md/CLAUDE.md 以 `<system-reminder>` 块挂在 user 消息上注入，这是整体替换够不到的通道。真机 `/chatroom --research`（2026-08-25，会话 `cc-20260825-071502-8a2df5d28119` 及其角色/助手子会话）显示每个 chatroom 会话都带着工作区指令：某角色拿到祖先仓库 CLAUDE.md 全文（约 3 万字符），自己的人设 CLAUDE.md 又在系统提示已展平人设之上重复一份；研究助手拿到的是主持人契约（`chatroom/CLAUDE.md`：「绝不 pip install、不跑数据分析脚本」），与其研究助手前导直接矛盾。用户全局 `~/.dsh/AGENTS.md` coding 指令只是被 64k 预算挤掉——剥离靠预算巧合，不是机制。

## Decision

`dsh-agent-instructions` 改为挂载 `AgentInstructions` 服务的函数插件（`ui-input-trigger` 模式：命名空间 `apply` 保留，监听器落在服务上）。服务暴露 `suppress()`——仿 `systemPrompt.suppressRuntimeContext()` 的 scoped `ScopedLayers` effect：经调用方上下文注册（agent 的 setup 作用域经 traceable receiver 绑到该 agent），使 `compose()` 对全局层或其 scope 链上任一标记覆盖的 agent 返回 `undefined`，同时把 inbox 中待处理的工作区上下文移除。bridge 的 `buildSessionSetup` chatroom 分支（role / direct-role / moderator）在注册 persona 段的同时调 `agentCtx.get('agentInstructions')?.suppress()`——指令通道上的 Go `--bare` 保形。同一分支再以 scoped `tools.restrict({ deny: ['skill'] })` 拒掉全局 `skill` 工具——tool-skill 文档明说的杠杆，同时移除 `<available_skills>` 目录与加载器——因为非 coding agent 的人设不该看到 `tdd` 这类目录条目（今天没有任何 thinker 角色自带 skill；未来角色自带 skill 时需重新审视）。research assistant 子会话也抑制工作区指令：共享工作区嵌在 moderator home 下，cwd 发现会把主持人契约（「绝不 pip install」）塞给助手、与其前导矛盾——而抑制也是唯一能把用户全局 `~/.dsh/AGENTS.md` 挡在外面的办法，挪工作区做不到。plain 与 attended 子会话的 cwd 发现原样保留（派发编码任务时仓库约定是关键上下文），任何 subtask 子会话都不会失去 skill 工具（主持人的 HTML 总结 brief 明写用 `html` skill）。

## Alternatives considered

**读 systemPrompt 组装态的 complete 段来推断抑制。** 否决：没有「该作用域是否有 complete 段」的公开查询，且把指令通道耦合到 prompt 组装会让未来任何 complete persona 都触发抑制——决策权落在另一个 owner 手里。

**把人设目录从指令候选文件里滤掉。** 否决：泄漏源是整条祖先链加用户全局文件，不是一个目录；候选列表是插件级全局配置，在文件发现里塞 persona 条件例外是无主特例。

**把包转成类插件。** 否决：两个 example bundle 都经命名空间导入挂载（`ctx.plugin(workspaceContext, config)`），Cordis registry 按 `{ apply }` 解析；函数体内挂服务让所有消费方零改动。

## Consequences

chatroom 角色/直聊/主持人会话不再收到任何工作区指令 reminder，也不再收到技能目录：没有祖先仓库指令、没有重复的人设 CLAUDE.md、无论预算如何都没有用户全局 coding 指令，也没有 `<available_skills>` 块与 `skill` 工具（工具数 44→43）。persona 生效前记录的首轮历史（选题/挑角阶段仍按 Go 旗标时序以普通会话运行）保留普通会话当时注入的内容——抑制随 chatroom persona 一起开始。未来部署若以 complete 段组装其他 persona，只有显式调 `suppress()` 才获得同样的静默；缝隙是显式的，不靠推断。研究助手起初也在此抑制，但该半场当天即被反转：助手本质是 coding agent，共享工作区搬离人设祖先链替代了抑制，助手保留 cwd 指令发现（见[工作区搬迁 note](2026-08-25-feishu-bridge-research-assistant-workspace-relocation.zh.md)）。

## Testing

`packages/context/agent-instructions/tests/suppression.spec.ts`：scoped 抑制器挡住基线；dispose 恢复；抑制期文件系统 touch 零注入、dispose 后 touch 组合出基线加嵌套 scope；无作用域注册抑制所有 agent。`packages/acp/feishu-bridge/tests/engine/chatroom-persona.spec.ts`：moderator 与 role 的 setup 各恰好调一次 `suppress()` 并拒一次 skill 工具；subtask 子会话（自工作区搬迁起含 research assistant）从不抑制、也从不失去 skill 工具。`dsh-agent-instructions` 全量套件（162 测试）、feishu-bridge adapter/persona/markdown/settlement spec、两个 example bundle、仓库 typecheck、仓库 lint（0 错误）全绿。真机验证待 reload 后下一次 `/chatroom --research`：角色与主持人会话日志中不应再出现 `Instructions from:` reminder 与 `<available_skills>` 块。
