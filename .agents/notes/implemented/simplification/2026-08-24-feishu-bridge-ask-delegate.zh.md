# Agent Note: feishu-bridge 去包袱批次 2 —— 委托化问答与原生审批/答案结构

Status: implemented

[English](2026-08-24-feishu-bridge-ask-delegate.md) | 中文

## Problem

dsh 切换后，桥的审批/问答回路仍是 Go 桥协议的形状，而 B1（[审批 seam](../feature/2026-07-06-approval-seam.zh.md)）已补齐它本应使用的原生原语：

- adapter 的 `approval/request` answerer 把每个原生询问压成会话 EventChannel 上的合成 `permission_request` 事件；engine 的事件循环持有 `PendingPermission` 状态机；用户的裁决经 `AgentSession.respondPermission` 回流到 adapter 的双等待表（`pendingPermissions`、`pendingQuestionAnswers`）之一。
- 一次携带多题的 ask 按题渲染多张卡，推进 `currentQuestion` 游标；自由文本作为单一字符串塞进 `selected`，原生 `custom` 通道从未承载自由文本答案。
- `perm:allow_all` 设置 Go 时代的 `state.approveAll` 标志，而非原生 `allowed-always` 常驻授权；拒绝附言被包进 Claude-Code 形状的拒绝前导文案并另发一条 steer 用户消息，而原生 tools 执行器已把 `ApprovalAnswer.note` 折入拒绝文案。
- 权限卡用 `ApprovalRequest.reason` 冒充工具输入预览；`toolInput`（B1）闲置未用。
- `askq:{q}:{i1},{i2}` 按钮值协议由 engine 的答案解析器与飞书平台回调分支各自解析。

## Decision

一个类型化委托方法取代合成事件、状态机与双等待表；答案以原生结构回流。

- **`Engine.askUser(sessionKey, request, signal?)`** 是唯一的询问面。`AskRequest` 为封闭联合——`{ kind: 'permission', toolName, preview }`、`{ kind: 'plan-review', heading, plan }`、`{ kind: 'questions', questions }`——`AskDecision` 返回原生结局词表（`allowed-once`、`allowed-always`、`rejected`、`cancelled`，外加可选 note）或逐题答案（selected/custom 分离）。adapter 的审批 answerer 与 `userQuestions` provider 经 `AskDelegate` 接口委托，由 `index.ts` 在 engine 构造后注入，engine→agent 依赖保持单向。无 interactive state 的会话（relay、后台 shell）对权限询问自动放行、对问题询问返回空答案——Go relay 自动批准的语义，且 relay 循环完全无需感知询问。
- **事件循环不再看到询问。** `permission_request` `EventKind`、循环内 256 行的 case、`PendingPermission`、`approveAll`、`permissionPending`（只写不读）、`PermissionResult`、`AgentSession.respondPermission` 全部删除。该 case 触碰的回合面（文本累积、段落边界、预览、进度写入器、计时、plan 跟踪）移入 `InteractiveState`；循环在每次 select 解析时重读，委托的发卡前冲刷/脱挂与决议后的面重启落在旧循环内代码块完全相同的位置。询问停留期间 idle 计时器不武装——用户决策不是停滞。
- **一张卡承载全部问题。** `buildAskQuestionsCard`（engine/ask.ts）把每题渲染为列表行（`askq:{q}:{n}` 按钮）或 checker 表单（`askq_multi:{q}`）；已答题冻结为 ✅/◻️ 标记、其余保持可交互，飞书回调响应从发送时缓存的全题集重建卡片。`askqAnswered` 从「每卡一个布尔」收缩为已答题集，同一题的再次点击更新答案而非被吞掉。无卡平台把所有问题放进一条纯文本消息；首题未答问题的选项挂内联按钮；自由文本回答第一个未答问题。
- **`askq:` 解析收敛到一个纯函数。** `parseAskqSelection`（engine/ask.ts）是该 wire 格式的唯一解析器；平台回调分支与 engine 响应路由都经过它。两段式旧格式 `askq:{n}` 被拒绝——多题一卡后它无法指名问题。`resolveAskAnswer` 把选项选择放进 `selected`（标签）、自由文本放进 `custom`，两者不再混装。词表仅作为无卡回退保留：权限卡按结构化 `perm:` 载荷原样分发，`parsePermissionVerdict` 只在自由文本时查 `isAllowResponse`/`isDenyResponse`/`isApproveAllResponse`。
- **裁决映射原生结局。** `perm:allow` → `allowed-once`；`perm:allow_all` → `allowed-always`（B1 的 per-(agent, tool) 常驻授权让后续同类询问免分发）；`perm:deny` 加卡片输入文字 → `{ outcome: 'rejected', note }`，由 tools 执行器折入拒绝文案——桥侧前导文案构造器与普通工具拒绝 steer 已删，它们会重复附言。放行侧 note 随决议与 `approval/decided` 审计对落账。权限卡 body 显示 `ApprovalRequest.toolInput`，`reason` 为回退。
- **plan 审查保留 plan 卡。** plan-review 询问先渲染 plan markdown 卡（本轮写了 plan 文件则文件优先，否则 inline），await 完成后才发权限卡，从回复源剥离已流式输出的 plan 文本，并在批准时保留补充 steer——plan-mode 把任何 `custom` 视为继续规划反馈，note 不能随答案走。原生 plan mode 拥有模式迁移；engine 在批准时改 `effectiveMode` 的做法随其服务的 ExitPlanMode 权限事件一起退役。聊天室 pick 窗口仍自动批准主持人的 plan 审查，现在直接 resolve 委托 Promise。
- **research-manual 超时按整卡而非按题。** 一个计时器守护整张卡；触发时 `settlePendingAskDefaults` 对未答题应用首选项默认、保留已收集答案、一次结算。用户已决议时它无操作（engine 的 settle 先清走停留的 ask），迟到的触发不会二次结算。

## Alternatives considered

- **保留事件循环作为询问渲染者（内部通道信号）。** 拒绝：一切「循环渲染」的变体都是合成事件通路的别名；循环停在 `receive()` 上无法渲染，而解除停靠会重新引入委托所移除的顺序耦合。
- **按 request id 的共享决议表。** 拒绝：委托返回 Promise 后，停留的询问只需要响应路由读取的内容（请求与已收集答案）；第二张键控表会恢复 B2 删除的等待表形状。
- **第一题作答即冻结整张卡。** 拒绝：多题一卡下，首次回调即冻结会杀掉其余题的按钮；冻结/可交互混合重建在保留可复查选择的同时保持卡片可用。
- **普通工具拒绝 note 与原生折入并存 steer。** 拒绝：note 已随折入的拒绝文案到达模型，再 steer 会二次送达。

## Consequences

- 询问延迟与卡数有可观察变化：无论题数，一次 ask 一张卡；`allowed-all` 后同 (agent, tool) 对在该 agent 生命周期内不再询问（B1 内存 memo；恢复的会话会再问）。覆盖：`tests/engine/ask.spec.ts`（协议收敛）、`tests/engine/engine-ask.spec.ts`（委托生命周期）、重写的 `engine-m3-permission|askq|plan` 套件、`tests/agent-dsh/adapter.spec.ts`（answerer/provider 委托）、飞书 `card-action` 套件。
- 聊天室 pick 批准不再对 pick 回合余下部分整体放行（`approveAll`）：该回合后续的工具询问会出卡。pick 窗口读角色文件（预期无需审批）；待真机确认。
- 询问停留期间，通道上仍有的事件（仍在运行的委托子会话的工具活动）由活循环处理而非排队等旧的循环内停留；它们落在脱挂卡的替换面上。聊天室 research 轮次加并发子会话的真机冒烟是剩余验证点。
- 子会话询问仍失败关闭（`unavailable`）——世系归因仅用于投影，未变。
