# Agent Note: Followups 选项把卡面白话文本与执行定位拆成两个字段

Status: implemented

[English](2026-09-17-feishu-bridge-followups-locator-split.md) | 中文

## Problem

收尾 followups 选项的 `description` 同时伺候两个读者：在建议卡上读选项、决定勾什么的用户，以及读派发的 `[后续处理]` 消息去找代码的执行 agent。所有提示层（工具描述、逐参数 schema 文本、agent 约定节）都规定工程格式——`path:line` 加一句话动作——于是用户看到的卡满是文件路径和机制词汇，不打开代码读不懂，这张卡赖以存在的勾选决定根本做不了。

## Decision

两个受众各得一个字段。`UserQuestionOption` 携带可选 `locator`，`feishu_bridge_followups` 的 schema 要三个单一用途的输入：`label`（白话短标题）、`description`（纯白话——问题、动作、代价，写给不看代码的人）、`locator`（给执行 agent 的 `path:line`）。

分发是结构性的，不靠约定：

- 活卡（`buildFollowupsCard`）与定格卡（`buildFollowupsCardSettled`）通过显式挑选 `label`/`description`/`checked` 映射选项——`locator` 永不进入任何卡面。
- 派发的选择消息（`followupsSelectionMessage`）是 locator 的唯一出口：`settledOptionMarks(..., includeLocator = true)` 给每个**已勾选**选项追加一行 `📍 path:line`（未勾选项不带——派发消息是给已授权条目的指令）。
- 工具的 `execute` 整组透传 `args.options`，没有第二条构造路径需要保持同步。

## Alternatives considered

- **提示词层的两段式格式**（description = 白话主体、尾部括号带 `path:line`）。否决：它把格式可靠性押在模型于自由文本内维持复合格式上。本工具自己的历史就是反例——收窄 schema 之所以存在，是因为模型每天约 3 次弄丢需要复述的 `question`/`id` 字段，而选项内容从未坏过。简单字段可靠；自由文本内的复合格式不可靠。且卡面仍会显示定位。
- **渲染端从 description 里正则剥离 `path:line` 模式。** 否决：用户抱怨的是读不懂（函数名、机制词汇），不只是定位可见；剥掉定位不解决术语问题，且从散文里模式匹配定位本身脆弱。
- **纯白话、彻底无定位**（执行 agent 从发现文本自行重新定位）。否决：执行质量将依赖重新搜索，浪费收尾 agent 已知的定位，且为无所得而删除派发消息的一项既有能力。

## Consequences

- 两个卡面结构性无定位——这是渲染端显式挑字段的保证，不是提示词纪律。把选项映射改成展开透传会破坏它；`tests/engine/followups.spec.ts` 的 `followups locator separation` describe 钉住它。
- 此变更前持久化的注册（followups meta JSON 无 `locator`）派发时不带 `📍` 行、照常工作——退化为旧行为，不是故障。
- `UserQuestionOption` 镜像 Go `UserQuestionOption`；TS↔Go 对应面现在多一个可选字段。followups 的 question 在 bridge 内构造，从不跨 Go wire。
- 模型仍可能出于习惯把路径写进 `description`；工具描述明文禁止，且 `locator` 字段会吸走定位内容。残余偏差靠活体观察（验收：reload 后首批卡中 ≥2/3 不看代码能读懂、卡面无路径无标识符）。
- 测试：`tests/engine/followups.spec.ts`（`followups locator separation` describe——派发只带勾选项的 `📍` 行、存量注册派发不带、两个卡面永不渲染定位）、`tests/tools/followups-tool.spec.ts`（locator 经转换存活进注册的 question）、`tests/agent-dsh/adapter-persona.spec.ts`（约定文本同步）。
