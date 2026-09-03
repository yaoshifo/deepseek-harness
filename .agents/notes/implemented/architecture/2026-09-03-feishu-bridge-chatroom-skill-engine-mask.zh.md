# Agent Note: 禁用项目上按引擎掩蔽 chatroom 主持 skill

Status: implemented

[English](2026-09-03-feishu-bridge-chatroom-skill-engine-mask.md) | 中文

## 问题

2026-09-03 的 oc_0ace 探针：一个 chatroom 禁用项目的 spawn 群带着指向其他项目 workdir 的 workspace override，`/chatroom` 以自由文本落到 agent，模型从会话目录加载了 `feishu-bridge-chatroom-moderator` 并开始照做。三道门的作用域不一致——命令族与工具是按引擎的（`denyTools`），但内置 skill 的可见性是 provider 的 `cwdPrefixes`，看不见引擎身份。任何 workdir 落在启用项目 workdir 之下的会话（spawn workspace override、按群 `/dir`）都会命中前缀、看到条目。工具的 execute 门兜住了实际损害（聊天室起不来），代价是一次误导性回复加烧掉一轮。

## 决策

把 skills 能力接缝补齐到与 tools 注册表对称。

- **`SkillRegistry.restrict({ allow?, deny? })`**（dsh-skill）：作用域层限制对查看链上所有层的继承名称求交，该作用域自身的注册在过滤之外——逐点镜像 tools 注册表的 `restrict`，包括无作用域调用与空过滤的抛错。名称只按 skill 名语法校验：可用性随 cwd 变化，在某个工作目录下不匹配任何 skill 的被拒名称在该处是惰性的（tools 注册表对照其静态全局视图校验；skills 做不到）。
- **桥服务在 `denyTools` 旁新增 `denySkills`/`deniedSkillsOf`**；装配接线 `adapter.setDeniedSkills(() => service.deniedSkillsOf(engine))`，adapter 的建会话 setup 在工具掩码包裹的同样两个点（普通/resume 会话、one-shot）把活名单落为作用域化的 `skills.restrict({ deny })`。`/skills` 列示按引擎过滤被拒名称——该命令按 cwd 无作用域地列示，与 provider 一样看不见引擎，因此读同一个服务注册表。
- **chatroom 的禁用分支**在工具名旁登记 `feishu-bridge-chatroom-moderator`；provider 的 `cwdPrefixes` 作用域保留为启用侧的局域性门。

让作用域解析成立的是 cordis 的 traceable proxy：经带作用域的 context 读到的服务，其 `ctx` 绑定到该 context，因此 setup 回调里的 `agentCtx.get('skills')?.restrict(...)` 落进该 agent 的层——同一回调里 `tools.restrict()` 早已依赖的机制。

## 备选方案

- **adapter 本地遮蔽注册**：在 setup 回调里向 agent 的层注册一个同名不可调用的 runtime skill——近层胜出加目录的 `isModelInvocable` 过滤即可隐藏条目，零核心包改动。否决：它把注册路径借用为掩码，假条目搭运行时重名警告的机制，且每个未来消费方都要重新发明；tools 注册表把 `restrict` 作为一等接缝正是补齐接缝的先例。
- **在 tool-skill（目录消费方）内过滤**：从会话选项的每会话被拒名单过滤——把通用消费方耦合到 bridge 专属接线，且 `skill` 工具的执行路径需要重复同一份名单；注册表查找是两条路径共享的唯一一点。

## 后果

- oc_0ace 形状端到端关闭：真实 Loader 组合装载工厂对（dsh-llm + dsh-agent-loop），经禁用项目的 adapter 在启用项目 workdir 下建会话，断言 agent 作用域视图没有主持 skill、同 cwd 的无作用域视图保留它。变异验证：仅摘掉 chatroom 登记即使测试变红。
- 保留的天花板：禁用项目会话的 subtask 子会话仍可能列出该 skill（continuable-subagent 请求不带 skills 挂点；其继承的 `toolFilter` 仍拒绝 `feishu_bridge_chatroom`，照做会在工具调用处 fail loud）；启动窗口不变（两道掩码同在一次扫描中登记，扫描前的会话由 execute 门兜底）；启用侧仍是 cwd 代理（启用项目的会话切到别处会失去条目但保留命令与工具）。

## 关联

- [按项目 chatroom 门控](2026-08-29-feishu-bridge-chatroom-per-project-gating.zh.md)——其决策与 `denyTools` 推理依然成立；本次改动取代了其对禁用项目的 cwd 代理天花板后果。
- [chatroom 抽包为独立包](2026-08-29-feishu-bridge-chatroom-extraction.zh.md)——其禁用分支现在同时登记两道掩码的兄弟插件挂载。
