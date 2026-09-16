# Agent Note：/context map 上下文树图 —— 复用投影快照的分段可视化

状态：已实现

[English](2026-09-16-feishu-bridge-context-treemap.md) | 中文

## 问题

`/context` 卡片把运行时上下文压成六桶聚合数字（系统/工具/用户/注入/回复/结果各多少 token），回答不了「每一块是什么内容、按什么顺序装配、哪块在吃预算」。dsh-context 的 `contextTimeline`/`contextHeaders` 投影值早就逐条携带这些数据——每个消息节点有自己的 token 数、开头文本、seq；每个工具 schema 有 token 数与描述；系统提示词有全文——但桥的窄类型（`src/context/types.ts`，设计上只放行卡片消费的字段）把 `nodes`/`droppedNodes` 与 header 的 `system`/`description` 裁掉了，飞书卡片也画不了树图。

## 决定

`/context map`（现有命令的参数形态）：同一 `ContextSnapshotReader` 取数，纯渲染层产出自包含零 JS 的 HTML 文档，经平台的 FileSender 能力以 `.html` 附件发出（`deliverReplyHTML` 同款链路）。三层设计：

- **窄类型放行而非新建数据面**：`ContextTimelineValue` 增补 `nodes`/`droppedNodes`（上游 0.11+ 必填，忠实对齐），`HeaderRecordValue.system`、`HeaderToolValue.description` 按上游可选放行。适配器逐字段拷贝 wire 对象，类型放行即通、零运行时改动；同步补齐四个既有 fixture 的必填字段。
- **squarify 手写**（`squarify`，约 80 行，Bruls 算法）：保序（列左→右、栈上→下，阅读顺序≈装配顺序）、面积严格∝token、贪心行装填压扁长宽比。不引 d3/echarts：产物要求离线自包含，且算法体量小于依赖接线。
- **覆盖诚实**：`current` 的四桶合计覆盖全部存活消息而 `nodes` 只服务最新尾部——差额（连同 `droppedNodes` 条数）画成开头一块灰色「更早的 N 条消息」占位矩形，树图永不假装完整。

分段顺序：系统提示词（`current.system` 计价、epoch 全文做悬停预览）→ 最新 epoch 的工具 schema（声明顺序）→ 灰色占位 → 已服务消息按 seq；0-token 节点跳过（空 assistant 消息计 0、无矩形）。HTML 文案仅中文，与 chartspec 图表标签同一先例；聊天侧降级文案走桥 i18n（复用 `ContextEmpty`/`ContextPluginHint`，新增 `ContextMapNoFileSender`）。所有插值经 `escapeHtml`（消息预览是任意内容→HTML 注入边界，截断先于转义防止切断实体）。文件名由命令层用 `slugifyTitle` 组装——纯渲染模块不反向依赖 engine 层。

## 备选方案

**改 dsh-context 插件客户端（dsh web 的 Context 标签页加树图）。** 否决为本轮范围：第三方插件 fork 漂移 + 用户的 web profile 未挂 dsh-context（要先改 profile 再验挂载会话的投影可用性）；留作后续选项。

**按 seq 回看历史请求装配**（dsh-context `client/assemble.ts` 的存活判定 `seq < R.seq && (gone undefined || gone > R.seq)`）。搁置为 `/context map <seq>` 扩展：archive 数据已在 wire 上，但本轮先交付「下一次请求」的当前视图。

**PNG 内联图片 / 卡片按钮触发。** 搁置：文本密集的树图需要缩放与悬停，图片形态差；卡片动作处理器契约返回 Card，文件发送要走副作用，先不破形。

## 后果

- 桥新增 `src/context/treemap.ts`（分段整形 + squarify + HTML 模板，纯函数、`time` 入参保持确定性）与命令分支；`render.ts` 的 `capRunes`/`formatTokens` 转公开（它们的既有家，避免第二份拷贝）。
- 快照是生成时刻的静态视图，上下文变化后重发命令即重生成（与卡片刷新按钮同级的便利性）。
- 树图文件携带会话内容开头文本——受众即发命令的聊天本身，与 /context 卡片同界，但暴露内容多于卡片（系统提示词开头、消息预览）。
- 既有四个 timeline fixture 因必填 `nodes`/`droppedNodes` 补了空值——上游 dsh-context 的窄类型从此更接近 1:1，后续重对齐少一层裁剪账。
