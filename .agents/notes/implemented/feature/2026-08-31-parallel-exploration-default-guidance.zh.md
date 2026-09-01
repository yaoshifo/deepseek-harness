# Agent Note: 调研并行默认化引导

Status: implemented

[English](2026-08-31-parallel-exploration-default-guidance.md) | 中文

## Problem

feishu-bridge 会话日志（344 个会话，2026-08-19 至 08-31）显示并行委派只在显式指令下发生：用户写了「并行」或「充分利用并行」的 14 个会话 14/14 全部 fan-out 子任务；而无指令的调研只要需要模型自己拆分就保持串行——三方向调研请求零 spawn 直接出计划（会话 `cc-20260821-122708`）、多角度验证审计 58 个工具调用全串行、历史日志分析 324 分钟 594 个调用且零后台任务。无指令的 fan-out 只出现在请求本身已预分区时（每 child 一本书、一个消息里多个编号查询点、两台服务器对比）。

三个原因，均在日志中核实：

1. plan-mode 段落（仅注入 plan 模式会话——该部署这些会话的默认模式；工具目录为 request-cache 稳定性跨模式一致）把委派写成条件句："Exploration also parallelizes: when the investigation spans independent areas, …"。抽象请求（「全面扫描」「多角度验证」）是否*具有*独立区域，留给模型现场裁量，而裁量会摇摆。
2. skill 文本与它矛盾："同一个项目内的只读调研 / 勘察不开子任务"（2026-08-21 措辞）禁止同项目只读委派，而 plan-mode 文本授权的恰是这件事。失败案例在调研中途加载了 skill 便停止委派；同日的孪生案例（相同引导、相同任务形状）spawn 了三个并行子任务。
3. 实施阶段并行完全没有引导。2026-08-21 的决策把它推迟到判据「计划已按子系统分组、模型仍串行执行分组」之后——后续会话满足了判据（计划带有独立的 W1–W3 / A1–A5 组），而每次实施 fan-out 仍需用户说「充分利用并行」。

## Decision

- plan-mode 调研句从条件句改为带明确例外的默认句，落在全部四份 preset/bundle 副本及 live-profile patch 覆盖：全仓库扫描、横切审计、点名了几个方向的请求，预先拆成 2–5 个独立角度并在一个 assistant message 里一起派发（brief 要求只读回报）；仅单一焦点、一两次 read 即可回答的问题保持串行。仓库副本保持工具中性（"background subagent delegations"）；live-profile 覆盖点名 `feishu_bridge_subtask`，维持部署层的路由分工。
- "group implementation changes by subsystem" 追加 "and mark which groups are independent enough to implement in parallel versus serially dependent"——推迟的实施阶段闸门在判据满足后落地。标记写在用户 review 的计划里，审批闸门仍在用户手中。
- skill 的排除边界收窄到它的成本理由：轻量单焦点问题（一两次 read/grep）保持串行；多方向调研默认并行无群 spawn。2026-08-21 的边界定价的是 attended 群面；2026-08-24 起无值守 spawn 走原生 continuable seam、不再建群，该成本前提已消失。

## Alternatives considered

- **保留条件句措辞。** 保留被观测到的不稳定：相同引导与任务形状，行为分化。
- **只在 skill 或只在 prompt 引导。** 两者的矛盾本身就是抑制因素——失败案例加载 skill 后停止委派。两个表面必须陈述同一边界。
- **在 AGENTS.md 全局指令加并行倾向。** plan-mode 段落已覆盖该部署的默认（plan）模式——全部失败案例都发生在该模式下；非 plan 直接执行会话是剩余未覆盖面，量小、接受此缺口。
- **无条件并行。** 每个 spawn 是完整 agent 会话；token 成本与每角度浅读是真实的。单焦点例外与 2–5 路上限防止默认过度触发。

## Consequences

- 部署：live profile 的 plan-mode 覆盖整行替换该 section，携带两句新文本，`/reload` 在任何 bundle promote 之前即可生效；待 dsh-base release 带上文本后该覆盖仍可删除（与 2026-08-21 相同的回收条件）。
- 工具名路由维持在[委派面措辞 note](../architecture/2026-08-20-delegation-surface-selection-wording.zh.md)划定的位置：仓库副本工具中性，仅部署层覆盖点名工具。[并行调度](2026-08-09-parallel-subagent-delegations.zh.md)与[无值守原生 seam](2026-08-24-feishu-bridge-native-unattended-subtasks.zh.md)机制未动。
- 验收：不带「并行」字样复放三种失败形状（三方向调研、多角度验证、跨会话日志分析）——三例中至少两例应在单个 assistant message 内 fan-out；显式指令回归测试仍应 fan-out。关注 spawn 数量：单任务常态超出 2–5 路说明默认过度触发，需收紧上限。
- 已知残余：不稳定性的一部分是采样层面的（相同输入、计划分化），单次复放成功不构成证据；上述多任务标准才是闸门。
