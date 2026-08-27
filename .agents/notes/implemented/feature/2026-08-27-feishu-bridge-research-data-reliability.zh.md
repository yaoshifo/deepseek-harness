# Agent Note: chatroom 研究助手携带数据可靠性硬约束

Status: implemented

[English](2026-08-27-feishu-bridge-research-data-reliability.md) | 中文

## Problem

research 模式聊天室里，预配的助手子会话是唯一真正下网取数的参与者，但它的组装提示（report 前导加 `subtaskResearchAssistantPrompt`）只带工作目录、不出图、来源标注三类纪律，对来源质量只字未提：什么源能支撑结论、一个数字需要几个源印证、分歧或缺数据怎么办。既有的唯一一条权威数据约束（safety floor 的「涉及时效事实只用多源交叉验证或权威机构发布的数据」）随 bare-persona 路径（角色 / 主持人 / 直聊会话）注入，助手子会话看不到；两处派发面（gather 研究前缀、主持人第 1 轮任务模板）也没有转达。真正联网的 agent 恰是唯一不受来源可靠性约束的参与者。

对 production 农产品调研项目（`~/workspace/production`，skill `commodity-supply-research`）的考察表明，那里的可靠性是六层机制——权威源注册表+一手优先级、量化交叉验证、审计留痕、缺数诚实处置、脚本化校验门槛、独立复算。可迁移到只有 prompt、没有基础设施的助手的，是操作纪律这一层。

## Decision

- `subtaskResearchAssistantPrompt` 新增一条硬约束（「只用权威一手数据」）：结论性数字（数值/占比/排名）只取权威一手源——官方统计、国际组织、监管机构、原始论文；二手转引（媒体/百科/聚合站）只能用于定位一手源，不得进结论。关键数字要么有两个相互独立的源对上（上游汇总数据与下游官方同链、不算独立），要么加总闭合回母数据。跨源分歧先归因（口径差、时点错位、发布滞后），归因不了就显式降级——绝不悄悄二选一。查不到就如实回报缺失；不用低质量源补洞、不编造。
- report 条目的标注要求从「来源 + 抓取日期」扩为每个数字附置信度（高/中/低）并单独列出未验证/缺口清单。
- 两处派发面各带一句数据可靠性要求，让角色向助手传达：gather 研究前缀（`chatroom.ts` `gatherRoles`）与主持人第 1 轮任务模板（`chatroom-priming.ts` `buildChatroomResearchModeratorPriming`）。
- 角色侧提示不动：safety floor 已约束角色、主持人与直聊会话。

## Alternatives considered

**只加一句「请用权威来源」。** 否决：production 考察表明可执行的内容是四条操作规则——只用一手源、独立性或加总闭合、分歧归因、缺数诚实。一句话给不了模型处理冲突和缺数据的决策程序，而那正是虚假或低质数字混入的入口。

**把 safety floor 注入所有子任务子会话。** 否决：safety floor 面向的不是 coding agent 的会话；助手需要的是助手特有规则（独立性、闭合、report 分级）而非 floor 的措辞，其前导本就是承载契约的接缝。

**移植 production 基础设施（源注册表、校验脚本、复算）。** 本次否决：chatroom 研究助手是领域通用的；注册表和脚本是领域资产。若某聊天室固定在一个领域，按领域做 skill 自带注册表是升级路径。

## Consequences

每个研究会话多约 120 字提示。助手对主要失败模式——看似可信实则错误的网络数据——从只有事后可追溯升级为持有决策程序；report 带置信度与缺口清单，供主持人综合时掂量。约束停留在 prompt 层：没有门槛机制性拒绝非一手源，与其他 persona 契约的执行姿态一致。

## Testing

`chatroom-persona.spec.ts` 断言注册的研究助手段落含约束标记；`engine-chatroom-gather.spec.ts` 断言 gather 研究前缀带转达句、第 1 轮 priming 模板带数据可靠性句。两套件（50 tests）通过。

## Related

[研究助手保留 cwd 发现；工作区已迁移](../bug-fix/2026-08-25-feishu-bridge-research-assistant-workspace-relocation.zh.md) 持有本 note 所依托的助手提示组装接缝。
