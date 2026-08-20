# Agent Note: Delegation-surface selection wording (headless subagent vs attended subtask)

Status: implemented

[English](2026-08-20-delegation-surface-selection-wording.md) | 中文

## Problem

同一个 feishu-bridge 会话里并存两套委派面：原生 `subagent`/`subagent_fork` 工具（headless、可续接、子 agent 由父会话种子生成）和从 cc-connect 迁移来的 `feishu_bridge_subtask` 工具（attended 飞书群聊、按次 `dir`、git worktree 隔离）。二者在 spawn/report/send/fork 语义上重叠，却在两条模型看不见的轴上分叉：

- 原生工具没有按次指定工作目录的入口——子会话的 cwd 硬编码继承父会话（`dsh-subagent` 的 `childSessionMeta`），因此它的 workspace-write 沙箱边界和 AGENTS.md/CLAUDE.md 指令链都留在父项目里。把跨项目工作派给 headless subagent 的模型会得到一个跑在错误目录里、无法写到父工作区之外的子 agent。
- 两边工具描述都没写明分工，两套面之间的选型全靠名字相似度猜。

## Decision

每个工具的 `description` 只陈述自己的委派事实；两边都不按名字引用对方工具（原生 `toolName` 是加载期配置，别的部署也未必挂载任何可跨目录的替代工具）。这遵循[工具指引归属规则](2026-07-05-prompt-variables-and-tool-guidance-ownership.md)：按工具的语义与选型指引放在工具描述里，不放 prompt section 或 persona。

- `dsh-tool-subagent` 的 spawn 与 fork 两个措辞版本都陈述：子 agent 共享本会话的工作目录及其指令文件，一次委派不能把它重定向到另一个目录。这句话描述的是能力（没有按次目录），不是 cwd 的取值，因此对部署级 config 固定了另一个目录的 out-of-process provider 也成立。
- `feishu_bridge_subtask` 的 description 与 `dir` 参数陈述：另一个目录里的工作经由本工具委派——子任务在那里运行并加载那个项目的指令文件。

这套措辞编码的实际选型契约：同目录的后台工作用 headless subagent；跨目录工作、同 repo 并行写（auto worktree）、以及用户需要旁观或加入的任何工作用 subtask 工具。

## Alternatives considered

- **对 bridge 会话隐藏原生 subagent 工具**（scoped `tools.restrict()` 或禁用 `tool-subagent` 行）——消除歧义，但也砍掉了 headless 同目录委派，而分工设计有意保留它；bridge 子群是重型 attended 会话，不适合安静的后台调研。
- **给 subagent seam 扩展 `SubagentStartRequest` 的按次 `cwd` 字段**——让原生工具也能跨目录，但要为所有 provider 改能力契约，需要能力位门控加 out-of-process 后端的线上表面，而 attended 工具已覆盖的场景它买不到任何新东西。推迟到真正出现 headless 跨目录需求；升级路径是届时把 `feishu_bridge_subtask` 的 `dir` 解析对齐到同一字段。
- **用一个 prompt section 解释两套面**——把每个工具都能就地陈述的事实复制一份，后续编辑时会与描述漂移；被唯一归属规则否决。
- **把两套面统一到 `ctx.subagents` seam 上配一个 attended provider**——continuation manager 与 bridge engine 会各拥有同一子 agent 生命周期的一部分（轮次排序 vs 飞书群路由），违反 one-lifecycle-controller 规则。

## Consequences

跨包的措辞改动由既有 keyless snapshot 钉住：acp-agent 的 `system-prompt.expected.md`/`tool-schemas.expected.json` fixture 带上新句子，`docs/tool-catalog.md` 重新生成，`subtask-tool.spec.ts` 断言 bridge 的 description 与 `dir` 参数携带跨目录契约。代价是以后任何一侧描述的重新措辞都要再碰这些 fixture。分工买到的是：当前全部特性零架构改动，模型凭每个工具自己的契约选对面。有意保留的已知缺口：安静（headless）的跨目录委派不存在；它需要上面推迟的 seam 扩展。
