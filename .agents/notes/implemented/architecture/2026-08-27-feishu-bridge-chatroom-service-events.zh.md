# Agent Note: feishu-bridge 以 feishuBridge/* 事件暴露扩展缝

Status: implemented

[English](2026-08-27-feishu-bridge-chatroom-service-events.md) | 中文

## Problem

chatroom 功能（角色群、主持编排、`/chatroom` 命令族）内联在 feishu-bridge 引擎里：`engine.ts` 有 186 处 chatroom 引用、`session.ts` 242 处、dsh adapter 32 处，外加直接改写 `commandHandlers`，以及 `Message`/`QueuedMessage` 协议类型上的 chatroom 字段。抽取计划要把这一切搬进兄弟插件包，前提是 bridge 把每个耦合点都暴露成兄弟插件可消费的缝——同时引擎与 adapter 不持有 Cordis context。手搓 hook 或策略投票接口不符合仓库的事件规则（拦截与策略属于 typed events），而把 chatroom 半边留在引擎里，搬移后又会迫使 bridge 反向 import chatroom 包。

## Decision

抽取的 C1 落地缝本身，行为零变化：

- `FeishuBridgeService`（`super(ctx, 'feishuBridge')`）持有 live 项目注册表与调用方路由（`route`/`nativeRoute`，plan D4），并且*就是*分发面：它实现 `BridgeDispatch`——收窄到 `feishuBridge/*` 键的 Cordis 事件总线。`apply()` 在构建任何引擎之前挂载它（apply 改为 async），并传给每个引擎构造器与 adapter。
- 九个 typed events 承载耦合点：`permission-policy`、`mode-policy`、`rename-exemption`、`auto-render-policy`（会话启动决策的 waterfall），`turn-start`（serial；消费队列 metadata），`turn-end`（waterfall；角色回复 relay），`ask-approval`（返回决策或 `undefined` 落回默认流程的 waterfall），`platforms-ready`（emit；barrier 恢复），`session-start-options`（改共享 options 对象的 waterfall）。waterfall 分发方把内建基线作为最内层 `next` 传入——无监听时分发结果与既有引擎行为一致。
- chatroom 监听半边放在 `engine/chatroom-policy.ts`，由 `apply()` 进程级注册一次——独立成模块是因为 `chatroom-pick.ts` 已经从 `chatroom.ts` import 运行时符号，注册函数放回 chatroom.ts 会闭合 import 环。
- 在 Cordis 树之外构造的引擎与 adapter（单元测试）默认拿到 `bareBridgeDispatch()`：无监听、内建基线照跑、emit 丢弃。验证 chatroom 行为的测试用 `ctxBridgeDispatch(new Context())` 加注册的 policy 监听器（生产组合形态）接线。
- `Message`/`QueuedMessage` 的 chatroom 协议字段合并为一个不透明 `metadata` 袋，由写入键的功能自持。
- 通用缝去 chatroom 化：`GroupFamilyAvatarSetter`（原 `ChatroomFamilyAvatarSetter`）、`renameHubToTopic` 接受可注入的 topic 命名器、工具标签颜色改为注册时声明（`declareToolFamily`）而非硬编码工具名、`Engine.registerCommand` 以可逆 effect 统一持有命令注册（handler + resolver 匹配器 + help 分组）。
- 受支持的兄弟插件导入面是 `./exports` 子路径（独立 bundle；由一个 spec 解析并钉住）。

随批落地：`packages/acp/feishu-bridge-chatroom` 骨架（按现行 constraints 门禁的 release-member manifest）、从 `chatroom-persona.ts` 拆出的通用 subtask prompt、i18n `lookupMessage` 助手。

## Alternatives considered

- **在 Engine 上手搓策略接口（投票/拦截方法）。** 否决：cordis-primer 规则要求拦截与策略走 typed events；引擎侧 hook 对象在搬移后还会重建反向依赖。
- **服务只暴露路由、事件分发各自为政。** 否决：分发面与注册表只有一个 owner——拆开后每个调用点要自行决定如何触达总线，而分发面正是 bare 默认值的自然注入点。
- **C1 把 chatroom 半边留在原地，C2 一起搬。** 否决：只有每个分支都先经缝分发，搬移才是「纯文件搬移」；C1 刻意做成保行为的半场，C2 就不再携带内联分支手术。
- **引擎默认惰性取得 context 绑定的分发面。** 否决：引擎内部悄悄获取 context 会藏起接线；bare 默认让无监听场景显式且测试可见。

## Consequences

- `apply()` 是 async；调用方（与测试）必须 await——fire-and-forget 的 apply 与 fiber dispose 竞态会以服务挂载失败浮出，现在 fail loud。
- 生产路径上未经服务面构造的引擎或 adapter 会静默地没有 `feishuBridge/*` 监听（每个事件走内建基线）。`BridgeDispatch` 的 JSDoc 写明了这一点；装配层是唯一受认可的构造路径。
- 测试中的 chatroom 策略行为现在取决于监听器注册而非引擎本身：裸引擎测试此前靠构造即得 chatroom 策略，现在断言 subtask/普通基线；chatroom spec 接 policy 监听面（`tests/stubs/bridge-policy.ts`）。
- C2 从这里继续：把 chatroom 模块经 `./exports` 面搬进新包，并把 sessions.json 快照迁移到 v3 不透明 `featureState` 分节——其 survive-reset 声明集必须包含 `researchAssistantKey`/`researchAssistant`/`researchVenv`，`carryChatScopedState` 今天就在携带它们（session.ts），计划文档决策 3 的表述写反了。
