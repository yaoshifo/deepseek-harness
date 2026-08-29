# Agent Note: 基于会话投影的飞书 /context 上下文洞察卡

Status: implemented

[English](2026-08-28-feishu-bridge-context-command.md) | 中文

## Problem

一个飞书会话的上下文状态——窗口占用多满、prompt 由什么构成、压缩与注入各改动了什么、哪些工具 schema 最重——此前只有 dsh-context 的 web 客户端可见。聊天面没有任何视图：问 bot 要花一个模型轮次，且答案产自被问的那份上下文本身；`/status` 汇报的是引擎状态而非上下文状态。飞书 schema 2.0 卡片格式新增了原生 `chart` 元素（VChart 驱动），但桥接层尚无使用它的表面；dsh-context 的投影（`contextTimeline`、`contextHeaders`）与 token-meter 的投影（`contextPressure`、`contextBreakdown`、`tokenUsage`）已经在 daemon 自己的进程里折好了这些数据。

## Decision

三层，分三步落地。

**图表元素**（`src/card.ts`、`src/feishu/card.ts`）：卡片模型携带 `{ kind: 'chart', spec }`，`spec` 是桥接层从不解释的 VChart JSON 对象；渲染器原样输出 `{ tag: 'chart', chart_spec: spec }`。飞书在发送时服务端校验 spec（错误码 230099），因此 spec 的正确性归调用方——实测验证的约束是 `color` 必须是完整的 ordinal 比例尺（`{ type, domain, range }`），`src/context/chartspec.ts` 固化了真实投递验证过的两种线格式（横向构成条形图与逐轮堆叠柱状图）。不含纹理、锥形渐变、词云网格、extensionMark 图片平铺、svg mark 背景——这些在移动端均不受支持；平台会追加自己的响应式 media query，因此 spec 永不声明 `media`。

**context 模块**（`src/context/`）：dsh-context 的纯函数与线格式类型移植进桥接层——`headlineOf`（锚定链：官方 `contextPressure` 投影优先，末次请求 prompt 估算次之，启发式构成总量兜底）、`aggregateByTurn`、`topToolSchemas`、`recentEvents`、两个图表 spec 构造器，以及窄化类型（`ContextTimelineValue`、`ContextHeadersValue`、`ContextPressureValue`，加 token-meter 的 `ContextBreakdownValue`/`TokenUsageValue` 与聚合出的 `ContextSnapshotValues`）。不 import dsh-context——当前 dsh-context 宿主的投影值原样喂给这些类型，字段可选性与上游一致，重新对齐是手工 diff 而非重写。已对齐 dsh-context 0.38.1：自 0.36.0 移植以来，上游线格式仅新增可选的 `timing` 汇总字段，卡片不读取。

**/context 命令**（`src/engine/context-commands.ts` + `src/context/render.ts`）：命令解析会话的活跃 agent 会话（`Engine.activeAgentSessionID`，live interactive 优先），经 adapter 新增的 `ContextSnapshotReader` 能力（`DshAgentAdapter.contextSnapshot(agentSessionID)`——`ctx.agents.get` → `agent.session` → 注册表的 `snapshot`，返回五个键，会话无活跃 agent 时为 undefined）读取一致的 `sessionProjections.snapshot` 切面，再用纯函数从聚合出的 args 渲染卡片。卡片：头部（📊 标记、截断的会话标题、模型名）、概览行（占用对窗口、余量，ratio 超过 1 时红色模板加超窗标注）、构成条形图、逐轮趋势（最近 20 轮）、最近 8 条上下文事件、轮次/步数/事件类别统计（含末次请求的原始 prompt/cacheRead/output 数字）、折叠的 Top-5 工具 schema 面板，以及刷新按钮。按钮携带 `act:/context ctx:<sessionKey>`，经 `Engine.registerCardAction` 注册：被按卡片自己的渲染时会话键优先于按压用户的聊天键，处理器重读快照并原地 PATCH 被按卡片。列表上限（20 轮、8 条事件、5 个工具）与逐字段 rune 截断使卡片天然有界；最终的预算守卫度量渲染后的 JSON（20KB 内控，对飞书 30KB 硬限）与元素数（< 200），超预算时先丢弃趋势图与事件段，再退到仅概览行的兜底卡。

降级阶梯：无 `contextTimeline`（未挂载 dsh-context）时渲染 token-meter 概览、启发式三段构成、累计原始用量与一行挂载提示；无活跃 agent 会话时渲染友好空卡。非卡片平台获得文本降级（数字与事件保留，图表丢弃）。

插件 `inject` 数组声明 `sessionProjections`——dsh-base 恒挂载该注册表，声明让桥接层的激活排在它之后（最小化测试组合也挂载该行）。

## Alternatives considered

**在引擎内渲染**（`/status` 的形态）：否决——卡片是投影值加两个展示字符串的纯函数；`src/context/render.ts` 使其无需 Engine 即可表驱动测试，引擎模块只解析输入。

**把 `ContextSnapshotReader` 放在 Engine 而非 adapter 上**：否决——Engine 不持有 `ctx`；adapter 拥有 cordis 上下文，且已有同类能力读取（`childCwd` 走 `ctx.agents.get`），结构化转换（`asContextSnapshotReader(e.agent)`）沿用其他能力共用的缝。

**用 `timeline.cost` 的成本数字**：暂缓——卡片只展示原始 provider token 数；计费 token 家族总量存在于 timeline 值里，但货币换算属于用量/账单表面，不属于上下文洞察卡。

**按字节预算裁剪事件段而非卡片级守卫**：否决——逐字段 rune 截断让普通卡片保持完整，一个卡片级守卫加确定性降级阶梯一次性覆盖所有段，胜过再调一个专属预算。

## Consequences

`/help` 自动把 `/context` 列入 agent 组。i18n 新增两键（`context`、`context_usage`）。刷新按钮的回调路径无法自动化测试（飞书卡片动作的既有局限）——由 act 值的纯函数表测加卡片动作分发测试覆盖，另有真机冒烟。inject 声明使投影注册表成为桥接层的硬激活依赖：未挂载 `dsh-session-projection` 的组合根本不会加载桥接层（所有真实 profile 都构建于挂载它的 dsh-base 之上）；若日后更倾向降级而非阻断，删掉该条目即可换来一张空 `/context` 卡。不支持读取冷（非活跃）会话的投影——注册表的单元素以活跃 `Session` 对象为键——因此 daemon 重启后、聊天下一轮恢复其 agent 之前，`/context` 渲染空卡。生产 profile 以 registry 依赖挂载 dsh-context，经 `dsh.profile.bundles` 层激活——仅 host 半区，浏览器 client 打包在 daemon 中永不加载。

## Testing

`tests/context-render.spec.ts`（14 例）：完整卡结构（头部、概览数字、两个图表、统计、带前缀的刷新按钮）、红色模板超窗、列表上限（40 轮 → 20、20 事件 → 8、20 工具 → 5）、事件行形状与排序、pressure 兜底、token-meter 降级卡、空卡，以及预算守卫（病态 CJK 载荷在 20KB 内控下降级；字节/元素度量器）。`tests/agent-dash/adapter-context-snapshot.spec.ts`（4 例）：五键拾取、缺键省略、全缺快照、三条 undefined 路径。`tests/engine/context-commands.spec.ts`（7 例）：表合并与前缀解析、卡片与文本分发、空卡路径、原地刷新卡片动作（args 携带键与回退）、dispose。两个真实组合套件（`tests/mcp-health.spec.ts`、feishu-bridge-chatroom 的 `tests/loader-composition.spec.ts`）挂载 inject 声明要求的 `session-projection` 行。
