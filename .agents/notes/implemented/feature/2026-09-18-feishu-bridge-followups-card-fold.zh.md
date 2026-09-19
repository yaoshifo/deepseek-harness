# Agent Note: 收尾 followups 卡把事实细节收进一个折叠块

Status: implemented

[English](2026-09-18-feishu-bridge-followups-card-fold.md) | 中文

## Problem

[事实细节层](2026-09-18-feishu-bridge-followups-details-layer.zh.md)把每条发现的证据放在了实时收尾卡各自的 checker 下面。于是每个选项都是三行（加粗短标题、白话说明、灰色细节），几条发现就撑过一屏手机：扫读、勾选一个选项，要滚过用户当时并不在看的证据。同一张卡还要求说明一次讲三件事——这是什么问题、勾选后做什么、有什么代价——说明自己就占了两三行。

## Decision

实时卡每项两行，证据收进一个折叠块。

- `CardCheckOptions.detailsPanel`（`src/card.ts`）是可选的面板标题。设置后，飞书渲染器（`src/feishu/card.ts` 的 `case 'checkOptions'`）让 checker 文本只保留 `**label**` + description，并在表单内追加一个 `collapsible_panel`——位于各 checker 之后、文本输入框与提交按钮之前——其唯一的 markdown 子元素按「每个带细节的选项一行」拼出 `**label** · detail`。
- 不设标题时元素保持原来的行内灰色细节行：折叠是选择性开启的，忘记设标题的生产者不会把细节悄悄从卡面丢掉。
- `buildFollowupsCard`（`src/engine/ask.ts`）统计细节非空的选项数并传入 `i18n.tf(Msg.FollowupsDetailsPanel, n)`；全都没有细节时不传标题，卡上也不出现面板。新词条 `followups_details_panel` 补齐五种语言。
- `details` 仍留在卡模型的选项上，所以发卡时回读（`askCardMeta`）、派发的 `[后续处理]` 消息、以及无卡片平台的纯文本降级全都保持不变。
- 结算快照同样折叠、不再行内展示细节（`settledOptionMarks` 的面 `card-panel` 加 `src/engine/ask.ts` 的 `followupsDetailLines`）：选项行保持两行，面板承载同一批 `**label** · detail` 行——点选提交不会把刚折起的证据摊开（2026-09-20 用户反馈）。
- 同一改动里写作口径跟着改：工具契约（`src/tools/followups.ts`）与常驻约定段（`src/engine/agent-conventions.ts`）现在要求说明只写一句话、约 30 字以内——是什么问题 + 勾选后做什么，确有代价才补半句——并把 `details` 描述为收进折叠块。两处都只是引导，没有任何门会拒绝超长的说明。

## Feishu nesting rule

上线前按官方文档核实过：表单里同时放 checker 与折叠面板，对这张卡是新组合。表单容器的子节点「支持除表格和表单容器以外的所有组件」，表单本身必须留在卡片根节点且必须含提交按钮——三条都成立。折叠面板不得内嵌表单容器，那不是本方案的方向。容器嵌套上限五层，本卡用三层（body → form → panel → markdown）。

## Alternatives considered

- **把折叠块做成卡片底部的独立顶层元素。** 卡模型侧最简（不加新字段），也让面板不进表单。放弃原因：它会落在提交按钮下面、离它注释的选项很远，并且必须删掉 checker 的行内细节渲染——丢掉元素的默认渲染并重写其钉子测试。若表单内面板哪天渲染异常，它仍是回退方案。
- **每个选项各一个折叠块。** 放弃原因：checker 选项是单个文本节点，折叠块放不进去；而每项各挂一个面板会为每项多出一行表头，比它替换掉的行内渲染更高。
- **面板正文放在元素上而不是推导出来。** 放弃原因：同一个卡模型里会出现两份细节（选项里一份、面板内容一份），有漂移风险且没有收益；渲染器从发卡回读所读的同一个选项数组推导每一行。
- **细节留在行内，只压缩说明。** 被同一个抱怨否决：证据仍留在扫读路径上。
- **把行内细节截断。** 放弃原因：证据按契约是精确的（`path:line`），截断恰恰丢掉它存在的理由。
- **用 schema 或校验门强制约 30 字的说明。** 用户否决：被拒的一次调用要在收尾时多花一次模型往返；改为在真实卡片上观察。

## Consequences

- 每项两行加一个折叠表头，几条发现的收尾卡一屏放得下；证据退到一次点击之后，而不是一直占版面。
- 面板标题统计的是「带细节的选项数」（`🔎 事实细节（2 项）`），不是选项总数：标题写三项却只列两行会被读成 bug。
- 分隔符是自带空格的 ` · `：`padBoldDelimiters` 只给紧贴相邻文本的定界符补空格（飞书仅在定界符两侧有空白时才渲染加粗），用 `：` 会渲染成 `**label** ：detail`。
- 取代[事实细节层](2026-09-18-feishu-bridge-followups-details-layer.zh.md)的两条渲染决定——实时卡的行内细节与结算卡的灰色行；那张 note 现指向本文。
- 说明变短也会让执行 agent 读到的派发消息变短，上下文因此转移到 `details` 上——那个同样随派发消息走的字段。
- 测试：`tests/feishu/card.spec.ts`（折叠块位置、收起状态、逐项行、结算卡折进面板而非行内、无细节则无面板、不设标题时的行内默认），`tests/engine/followups.spec.ts`（标题项数、选项保留 details、结算面板与无细节时无面板、派发不变），`tests/feishu/card-action.spec.ts`（发卡回读仍能让两条出口都派发出细节），`tests/tools/followups-tool.spec.ts` 与 `tests/agent-dsh/adapter-persona.spec.ts`（两处散文面的钉子），`tests/i18n.spec.ts`（新键带 en/zh）。
