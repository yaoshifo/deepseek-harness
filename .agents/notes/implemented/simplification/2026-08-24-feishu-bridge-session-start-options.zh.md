# Agent Note: feishu-bridge 去包袱批次 6 —— typed session-start options 取代 CC_* env 纸条

Status: implemented

[English](2026-08-24-feishu-bridge-session-start-options.md) | 中文

## Problem

engine→adapter 的每会话人设/路由元数据通道仍是 Go 子进程时代的 env 纸条数组，尽管 dsh 切换早已把它变成进程内交接：

- `Engine.buildSessionEnv` 每次会话启动写 17 条 `CC_*` KEY=VALUE 字符串。其中四个（`CC_PROJECT`、`CC_SESSION`、`CC_SUBTASK_DEPTH`、`CC_RESEARCH_ASSISTANT_KEY`）根本没有读者——Go 子进程消费者的遗留。
- adapter 用 `envHasFlag`/`envValue` 逐行扫描把数组解析回来，服务三个消费者（`sessionBypassesPermissions`、`buildSessionSetup`、moderator plan 降级），外加一个偷渡点：`startSession` 从数组里读 `CC_SESSION_KEY` 当 engine 会话 key——用环境变量语义藏了一个类型化参数。
- 投递走一次性可变槽位（`setSessionEnv` + `this.env`）：由「下一个 startSession」消费，无论那是不是同一次会话。空 env 刻意不动槽位，于是 placeholder 态的 stall 重试可能继承上一个会话的人设标志——槽位设计自身无法摆脱的潜在跨会话泄漏。
- `renderQuery` 带着一个 `void sessionEnv` 形参（Go 平价残留：dsh one-shot 在进程内 spawn），并让 `[...state.sessionEnv]` 副本贯穿整个 plan-render fork 链。
- lark 工具的 `sanitizedChildEnv` 防御性地从子进程 env 丢弃 daemon 从不设置的 `CC_PROJECT`——一旦没有任何代码路径再产出这个名字，该防御就是死代码。

## Decision

一个类型化参数取代字符串协议：`Agent.startSession(sessionID, options?: SessionStartOptions)`。

- **`SessionStartOptions`（core/types.ts）** 按 adapter 各消费者的实际读取面分组：`sessionKey`（非空时覆盖 startSession 实参作 engine key；cron new-per-run 保留双标识拆分——带 `#cron:` 后缀的 interactive 槽位 key 与无后缀的 session key）、可选 `subtask {attended, noReport, researchAssistant}`、可选 `chatroom {role, directRole, moderator, ledgerDir, research, researchAssistantChild}`、可选 `feishuWorkspace`、可选 `venv {virtualEnv, pathBin}`。无读者变量直接删除，不进 options。
- **`researchAssistant` 按读者拆分，不按来源分组。** 研究助手标志（子任务子会话关注点，report-preamble 分支读取）放在 `subtask.researchAssistant`；预派发助手的 session key（聊天室角色关注点，人设 prompt 构造器读取）放在 `chatroom.researchAssistantChild`。生产中两者从不共存：角色会话带 key 不带标志，助手子会话带标志不带 key。单一 `researchAssistant {childKey}` 组会让每个会话都背着自家读者永不查询的半个字段。
- **`Engine.buildSessionStartOptions`** 取代 `buildSessionEnv`（并把 `feishuWorkspaceEnv` 折叠进来）；`startAgentLocked` 把 options 作为参数直传，并发安全是结构性的——不存在可串扰的槽位。stall 重试重新注入 `state.sessionStartOptions`；placeholder 态（从未启动过会话）现在传 `undefined`——普通会话——而不是继承槽位上一次的残留。
- **`RenderQuerier.renderQuery` 删掉 `sessionEnv` 形参**，plan-render fork 链（`renderContentToHTML` / `renderPlanToHTML` / `renderReplyToHTML` / `launchPlanRender` / `renderAndDeliverReply`）随之去掉贯穿的副本。渲染隔离就是进程内 one-shot 的全新会话本身。
- **lark 子进程 env 的 `CC_PROJECT` 丢弃连同测试 fixture 一起删除**：该名字的生产者已不存在。
- **模型可见文本不动。** workspace 路由 section 仍输出 `CC_FEISHU_*` 行（lark/feishu-search skills 的 prompt 契约），聊天室 priming prompt 仍引用 `$CC_RESEARCH_ASSISTANT_CHILD`——角色实际经 `chatroom.researchAssistantChild` 构造的人设 prompt 文本拿到 key，而非经任何 env。

## Alternatives considered

- **保留 env 数组作为 wire 格式、只类型化生产端。** 拒绝：数组的唯一读者就是 adapter 自己（CLI env 契约随 dsh 切换退役），字符串往返没有任何收益，却付出 `CC_SESSION_KEY` 偷渡与陈旧槽位两种代价。
- **options 上单一 `researchAssistant {childKey}` 组。** 拒绝：标志与 key 的写者（助手子会话 vs 研究角色）与读者（子任务 preamble vs 聊天室人设）互不相交；一个组强迫每个会话携带死的那一半。
- **干脆删掉 venv 字段（无 adapter 读者）。** 保留为数据：Go 研究路径的 `VIRTUAL_ENV`/PATH 改写从未到达进程内的 dsh 世界，但人设 prompt 仍告诉模型用 `$VIRTUAL_ENV/bin/python`——这些字段保留了该数据未来被接通时的唯一类型化出口（见 Consequences）。

## Consequences

- `CC_SUBTASK_DEPTH`/`CC_RESEARCH_ASSISTANT_KEY` 的 Go 平价按设计消失（无读者）；防清洗的 `CC_SESSION` 别名及其存在理由（dsh 清洗 `*KEY*` 形状的 env 名）随数组一起消亡——已经没有任何东西读 env。
- placeholder-stall-retry 修正是一个角落行为变化：从未启动过会话的 state 上的 stall 重试现在启动普通会话，而非穿着上一个会话人设的会话。没有生产路径触达它（stall 重试需要活跃会话），旧行为本身就是 bug。
- `venv {virtualEnv, pathBin}` 是被携带、未被消费：今天没有 adapter 代码读它。它记录的既有缺口——研究人设 prompt 引用的 `$VIRTUAL_ENV` 并不会被进程内 dsh agent 的 Bash 子进程继承——早于本次改动，不在 B6 范围内。
- 覆盖：env 注入测试族（`engine-events` startAgentLocked、`engine-workspace-env`、`engine-chatroom-venv`、`engine-subtask` options 构造、`cron-execute` session-key 拆分）断言类型化表面；`adapter.spec.ts` / `chatroom-persona.spec.ts` 经 options 驱动人设；删除行为的用例（nil-env 不动槽位、render env 透传、lark `CC_PROJECT` 清洗）随行为一起移除。
