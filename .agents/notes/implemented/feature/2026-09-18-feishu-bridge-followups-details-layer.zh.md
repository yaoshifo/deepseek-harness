# Agent Note: followups 选项携带事实细节层，同时进卡面与派发消息

Status: implemented

[English](2026-09-18-feishu-bridge-followups-details-layer.md) | 中文

## Problem

同一张收尾 followups 选项上叠着两个缺陷。

[locator 拆分](2026-09-17-feishu-bridge-followups-locator-split.zh.md)把执行定位移出卡面，前提是派发的 `[后续处理]` 消息会带着它——那是执行 agent 唯一的定位来源。但从来没有。发卡时从已发送的卡上回推问题的那段逻辑（`askCardMeta`，`src/feishu/platform.ts`）只把 checker 选项映射成 `{label, description}`；`locator` 根本不在卡模型上，所以 `cacheAskqMeta` 写内存缓存与持久化 sidecar 时它早就丢了，`followupsSelectionMessage` 永远拼不出 `📍` 行。现场证据（会话 `oc_2680b22abca4f04388504321e59f2984`，2026-09-18）：注册带着 `locator: apps/desktop/src-tauri/gen/schemas/acl-manifests.json:1`，派发消息没有 `📍` 行，整份会话日志 grep 命中 0 次。发送出口还有第二道门——`sendCard` 会把线程回复交给 `replyCard`，后者会再记录一次发送时缓存——所以任何「把问题当调用参数传」的修法都必须同时穿过两道门。

另一件事：用户要求在卡面上也看到每条发现的**事实侧**。计划卡的两层呈现（白话层展开、实施细节折叠）在 followups 卡上没有对应物，卡面此前只读得到白话。

## Decision

一个字段取代两个：选项携带事实字符串 `details`，独立的 `locator` 字段删除。

- `UserQuestionOption.details`（接替 `locator`）承载事实侧——涉及文件、机制、依据；是否写出精确位置（`path:line`）由调用方判断。
- 两个卡面都把它渲染成白话说明下方独立的一行灰色文字（`<font color='grey'>🔎 …</font>`，在飞书卡片 markdown 白名单内）：活卡拼进 checker 文本（`src/feishu/card.ts`），冻结卡拼进冻结 marks（`settledOptionMarks`，`src/engine/ask.ts`，面 `card`）。
- 派发的选择消息携带同一份细节的纯文本（面 `dispatch`）：模型输入不得收到渲染标签。
- 发卡回读从卡元素上映射 `details`（`askCardMeta`），两条出口都会记录它、sidecar 也跨重启保留——保住派发完整的是这段映射，而不是额外的缓存参数。

## Alternatives considered

- **给 `sendCard` 加一个「源问题」参数。** 否决：线程回复那道出口会在 `replyCard` 内再次记录缓存，参数必须同时穿过 `CardSender.sendCard` 与 `CardSender.replyCard`，且今后每新增一条出口都要记得传。把数据留在卡上让保证变成结构性的。
- **`locator` 与 `details` 并存。** 被用户「合并」的决定取代：两个字段意味着两套提示契约、两条 schema 条目，以及一条在卡面已展示事实之后失去理由的「永不上卡面」规则。合并后的字段也消除了回读唯一的盲区。
- **每个选项一个可折叠细节面板。** 做不到：飞书 checker 选项是单个文本节点，选项内折叠无法构建；卡级 `collapsible_panel` 又会把细节挪离它所属的选项。

## Consequences

- 新卡的卡面会显示灰色事实细节；卡面不再只是白话——这是用户要求下的既定代价（计划卡保留它自己的折叠细节形态）。
- 本次改动之前登记的卡派发时没有细节行——退化为旧行为，不是故障。
- `details` 在工具 schema 里是选填；reload 后首批卡的填写质量会被观察，升级路径是改为必填（与计划卡 details 的推进方式一致）。
- 活卡的灰色包裹在渲染层、冻结卡在 marks 层；两者都有钉子（`tests/feishu/card.spec.ts` 渲染 checker 文本，`tests/engine/followups.spec.ts` 断言冻结 marks 与派发文本）。
- 测试：`tests/feishu/card-action.spec.ts`（`sendCard` 与 `replyCard` 两条出口的发送时回读都派发细节）、`tests/feishu/card.spec.ts`（活卡与冻结卡面的灰色细节行）、`tests/engine/followups.spec.ts`（`followups details` describe）、`tests/tools/followups-tool.spec.ts`（schema 暴露 `details`、不含 `locator`；转换保留它）、`tests/agent-dsh/adapter-persona.spec.ts`（约定文本更新）。
