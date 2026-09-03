# Agent Note: feishu-bridge one-shot forks run in the chat's directory

Status: implemented

[English](2026-09-03-feishu-bridge-oneshot-fork-workdir.md) | 中文

## Problem

2026-09-03，feishu-bridge 群 oc_9e68（deepseek-harness 的聊天室调研群）在用户执行 /provider 切换后发送「继续」的几秒内，群名被改为「mem0 记忆服务开发」。daemon 日志 `chat renamed … → mem0 记忆服务开发`（09:50:13）把触发点钉在群名 fork 上，而该 fork 会话（cc-20260903-095010-7a9f255d74fe）落在 `--Users-hm-workspace-mem0--` 桶里，聊天自己的主会话却运行在 deepseek-harness。三个缺陷同根：一次性 side query 把会话 cwd 解析到适配器基目录，而不是调用聊天的生效目录。此前一天 profile 已把该 bot 的基目录改到 `/Users/hm/workspace/mem0`，于是：

1. 群名 fork 收到 mem0 仓库的工作区指令，而提示词摘录只有含糊的「继续」——模型凭环境上下文编出 mem0 开发主题的群名和 `database` 图标，引擎随即改群名并同步会话标签。
2. plan-render / reply-html 渲染 fork 落错桶，后续日志排查被引向错误项目。
3. `/list` 持久视图按基目录过滤、live 视图完全不过滤，聊天里的会话选择卡混入另一项目的会话——同一窗口内，私聊的 glob 修复会话被挂进了本群。

## Decision

- `ForkQuerierWithProvider.lightweightQuery` 与 `RenderQuerier.renderQuery` 增加可选尾参 `workDir`；适配器把它透传进 `oneShotQuery`——后者本就按它钉 `meta.cwd`，缺省或空串回退基目录。
- 引擎在每个 side query 站点传 `sessionWorkDir(sessionKey)`（聊天 `/dir` override 优先，回退基目录）：群名查询（`generateGroupName`，经 `renameGroupWithLLM` 与 `/rename` 重新生成两条路）、plan-render / reply-html 共享的 `renderContentToHTML` 核心、predict-next 与 turn-summary——后两者的调用方把 worktree-or-override 的解析上提，两种预测模式共用一个值。
- `Agent.listSessions` 增加可选 `workDir`，把两个视图都限定到该目录树；`DshAgentSession.cwd()` 暴露 live 会话记录的 header cwd，没有记录的 live 项保留可见（未知不等于外项目）。cmdList、会话选择卡与 /switch 全部传聊天的 `sessionWorkDir`。
- 首条消息自动改名跳过含糊 seed：`isNameableGroupNameSeed` 拒绝不足 4 字符或命中固定敷衍词集合（继续/接着/continue/go on/好的/收到/ok/next/嗯/嗯嗯）的 seed，裸「继续」不再触发一场以环境上下文为输入的改名。`/rename` 重新生成与 spawn 建群命名不受影响——二者或为显式操作、或 seed 充实。

## Alternatives considered

- **给群名 fork 喂聊天的跨会话历史而不是跳过。** 引擎按会话保存历史，切换后的新会话没有历史；持久的按聊天历史环是更大的工程面，而裸「继续」本来命名不出任何东西——跳过才是诚实行为。
- **含糊 seed 只用词表、不加长度下限。** 长度下限整类覆盖 1–3 字符的敷衍消息，无需枚举；词表只补更长的习惯用语。
- **修 /list 改成跨桶全量列出。** 这正是用户投诉的来源：选择卡必须读作「本目录的会话」（Go per-cwd store 语义）；先 `/dir` 再认领，跨目录认领仍然可用。
- **只修群命名，渲染继续落在基目录。** 渲染 fork 落错桶对日志排查的破坏与改名同源，而这个 seam 的代价只是每处一个参数。

## Consequences

- 测试：adapter-oneshot.spec 钉两条查询的 workDir；adapter-list.spec 钉持久与 live 的目录限定、以及不传参时行为不变；engine-groupname.spec 钉改名查询的 workDir 与含糊跳过；predict.spec 钉两处透传；plan-render-fork.spec 钉渲染 fork 的 workDir。受影响的 spec 集合 524 全绿。
- 部署：宿主构建加手动 `/reload`；活体验证信号是被 override 群里下一次「/provider 后发继续」——不再改名，`/list` 限定到聊天目录。
- 已知同族未动项：monitor 分诊的 `lightweightQuery`（分类器，cwd 只影响它看到哪些注入）与 harness 会话标题 fork（packages/session 域）仍解析到基目录；后续可沿用同一 seam。
- 聊天的恢复路径保留：deepseek-harness 的群在 `/list` 里仍能看到同目录的私聊会话，把调研会话重新挂回仍是点一次选择卡的事。
