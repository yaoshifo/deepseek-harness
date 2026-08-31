# Agent Note: 斜杠手势加载的技能在工具过程卡上的呈现

Status: implemented

[English](2026-08-31-feishu-bridge-skill-invocation-card.md) | 中文

## Problem

技能进入会话有两条路径，卡片可见性却不同。模型自主调用 `skill` 工具时，进度卡显示 `📚 <名>` 条目（标签加每轮「📚 技能：」汇总行），因为 `parseSkillToolUse` 会重标这个工具调用。用户输入 `/<名>` 手势时，tool-skill 的 pre-step 监听器把技能正文注入为合成 user message（durable source `{kind: 'skill-invocation', name}`），不产生任何工具调用——而 dsh adapter 对该 source 的投影为空，这次加载在飞书工具过程卡上完全不可见。用户把缺失的图标误读为加载失败（2026-08-31 派生群里的 `/explain` 实测）。dsh web 客户端早已对 `skill-invocation` 消息投影技能名标签；飞书卡是唯一把它藏起来的呈现面。

## Decision

用诚实的 channel 事件投影这次注入，不伪造工具活动。`EventKind` 新增 `skill_invocation`（content = 技能名，对应 durable source 的 `name` 字段）；adapter 的 `projectSessionEvent` `user/message` 分支在 `source.kind === 'skill-invocation'` 且 name 为非空字符串时推送该事件。交互主循环把它渲染为带 `skillName`、预置 `hasResult`/`success` 与 locale-owned `SkillLoaded` 结果行的 `ProgressEntry`，流经既有的 `appendProgress` 管线——seq 分配、`addSkillName` 汇总累积、`📚` 标签渲染全部白拿，`streaming.ts` 零改动。spillover 与 relay 两处 switch 把该 kind 当作与 `subagent_status` 同类的卡片专属帧。

## Alternatives considered

- **adapter 伪造一对 `skill` 的 tool_use/tool_result**（走既有重标得到完全相同的视觉）。否决：引擎的工具记账——`toolCount`、活跃调用平衡、generation span——会把一次上下文注入记成真实工具活动；typed union 多一个诚实成员，比事件流学会说谎便宜。
- **只出汇总行、不出条目行。** 否决：用户注意到的缺失物是 `📚` 条目行；只有页脚行与模型自主路径的对称性更弱。
- **什么都不做。** 否决：无论哪种呈现，加载本身花费的 token 相同（注入无论如何都存在）；唯一悬念是可见性，而 web 客户端早已确立投影先例。

## Consequences

构造上即 token 中性：卡体内容永不回流模型上下文，模型可见输入（目录 reminder、注入的技能正文）与之前逐字节一致。每个斜杠技能 turn 至多多一次飞书卡片 PATCH，搭既有 flush 周期的便车。子代理子会话不受影响（`projectSubagentEvent` 忽略 `user/message`）；resume/重放不会产生重复条目，因为 `session/event` 只对活跃追加触发——与 recent-turns 窗口依赖的前提相同。未来的卡片专属事件 kind 应沿用此模式：`EventKind` 里的 typed kind、adapter 里的投影、交互循环里的渲染 case、纯文本 switch 里的 no-op case。
