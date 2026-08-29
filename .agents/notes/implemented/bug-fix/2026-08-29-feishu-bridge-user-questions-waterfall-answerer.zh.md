# Agent Note: feishu-bridge 追问 answerer 迁移到作用域 waterfall

Status: implemented

[English](2026-08-29-feishu-bridge-user-questions-waterfall-answerer.md) | 中文

## Problem

fork 本地的 feishu-bridge adapter 通过 `userQuestions.registerProvider(...)` 注册追问 answerer。上游 049170c6d0（2026-08-23，当日合入 dev）删除了该注册制，改为 agent 作用域的 `user-questions/request` waterfall，bridge adapter 一直未迁移。旧构建产物掩护到 2026-08-29 重建并重启：首个 agent 创建抛出 `TypeError: uq.registerProvider is not a function`，又因 `questionRouting.registered` 在注册调用之前置位，后续所有会话静默跳过注册。没有任何 answerer 组合进来，于是每一次 `ask_user_question` 调用——以及每一次计划审批 ask，包括 exit-plan-mode 卡片——都返回 `no user-questions answerer accepted the request`，卡片不再渲染（oc_cd00410d 追问事故）。adapter 单测用手工假件伪造了被删除的服务 API，CI 从未看见这次断裂。

## Decision

- `ensureUserQuestionsAnswerer`（原 `ensureUserQuestionsProvider`）改为通过 `ctx.on` 注册一个 `user-questions/request` waterfall 监听器。adapter 的插件 ctx 无作用域 tag，scope carrier 对其全局准入——adapter 既有的 `agent/disposed` 监听依赖的正是同一准入规则。
- 监听器返回持有该会话的 adapter 的 `handleUserQuestion` 结果即认领请求，否则以 `next()` 委托；共享 question routing 仍按每次插件应用恰好注册一个监听器，并把 ask 派发给持有活跃会话的 adapter。
- 注册标志（`questionRouting.registered`、`uqRegistered`）只在监听器注册成功之后置位，注册失败会在下一个会话重试，而不是被永久静默跳过。
- 无人认领的 ask 显式抛出服务的 NO_PROVIDER 错误，取代旧的「告警加空答案」兜底：模型可把显式失败用文字转述给用户，优于静默空选择——后者正是 2026-08-26 cron-fbe6d268 事故的遮蔽签名。

## Alternatives considered

- **在 user-questions 服务上恢复 `registerProvider`。** 拒绝：服务契约归上游所有；作用域 waterfall 是已落地的 UI answerer 扩展点，在 fork 本地重加注册制会在下一次同步时再次断裂。
- **对未匹配会话保留空答案兜底。** 拒绝：它把用户从未见过的 ask 报告为成功，并窃取 waterfall 下游任何其他已组合 answerer 的请求。

## Consequences

- 到达 bridge 不持有会话的问题现在以 NO_PROVIDER 拒绝而非空答案作答；在无头 daemon 中 bridge 是唯一组合的 answerer，模型看到的是可以在文字里转述的诚实错误。
- 共享路由的监听器存活于首个 adapter 的 ctx 上：若该 adapter 的项目在其他项目仍在运行时被 dispose，监听器随之消失而 `questionRouting.registered` 保持 true。这一形态先于本次修复存在，此处未改变。
- 真组合回归测试钉住了作用域派发假设（无 tag 的插件 ctx 监听器能收到 agent 作用域的 ask）；若上游作用域准入规则变化，该测试会先于生产失败。

## Testing

`tests/agent-dsh/adapter.spec.ts`：新增真组合测试，在真实 Cordis context 上组合真实的 `UserQuestionService` 与 `AgentRegistry`，把 `userQuestions.ask` 经 adapter 驱动到引擎 ask delegate（同时复现注册 TypeError 与 NO_PROVIDER 两种失败）；手写服务假件替换为一个驱动已注册 waterfall 监听器的驱动器，并带上服务的 no-answerer 兜底；共享路由用例断言两个 adapter 恰好注册一个监听器且跨 adapter 派发。套件：feishu-bridge 158 个文件 / 2702 个测试通过；仓库 typecheck 干净；所改文件 oxlint 干净。
