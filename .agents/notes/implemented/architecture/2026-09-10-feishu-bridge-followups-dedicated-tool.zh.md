# Agent Note: 收尾追问卡迁移到专用 feishu_bridge_followups 工具

Status: implemented

[English](2026-09-10-feishu-bridge-followups-dedicated-tool.md) | 中文

## Problem

[收尾卡转换](2026-09-02-feishu-bridge-closing-card-followups-conversion.zh.md)让模型继续用 `ask_user_question` 手写收尾卡——提示词规定签名的五个字段里四个是引擎常量（问题文本、问题 id、保留字 header、多选标记），真正变化的只有选项清单。这次手抄在全桥范围以每天约 3 次的频率栽在参数校验上：2026-08-27..09-10 共 44 次拒绝，横跨 8 个项目工作区，38 次带收尾卡 header，每次失败丢的恰好是样板字段——`question`（33 次）或 `id`（8 次，多为 glm-5.3-flash）——选项清单从未出错。每次拒绝都在下一次调用自愈（报错文本点名缺失属性），代价是群聊里一条裸校验错误加一次额外往返。规范清单点名了可选字段却漏了必填字段，而 GLM 逐字照散文模板组装。

## Decision

专用工具 `feishu_bridge_followups`（`src/tools/followups.ts`）把模型的契约收窄到唯一变化的输入：`options: [{label, description, recommended?}]`，至少一项。工具把四个常量合成到 questions ask 上——header 取自 import 的 `FOLLOWUPS_ASK_HEADER`（单一来源）、固定问句「以上发现后续如何处理？」、稳定 id `followups`、`multiSelect: true`——并委托给 `Engine.askUser`，其 `isFollowupsAsk` 转换分支仍是唯一的注册实现，不存在第二条引擎路径。agent-conventions 段落改为点名工具、删去字段清单。手写签名路径保留为兼容层：跑旧提示词的会话照旧经 `isFollowupsAsk` 转换——它同时也是工具失手的兜底，因此本决定以修正形式部分接替 2026-09-02 note 对工具方案的否决：一次失手如今退到那个转换，而不是当年促成否决的驻留回合。

## Alternatives considered

**修提示词清单（补必填字段句加完整示例）。** 否决作为修复：历次失败发生时必填字段本就写在通用工具 schema 里；散文示例只能降概率、删不掉这一类。保留为工具调用率不达标时的后备层级。

**把卡片要求打包成 skill。** 否决：模型从不主动加载 skill（tdd-default 提示词的存在正是这一有档可查的原因），每次收尾加载一轮 skill 的固定成本高于全桥每天约 3 次的偶发失败，且 skill 按项目部署而规范段一处覆盖全部桥项目。

**引擎侧补默认值（保留字 header 命中时补 `question`/`id` 而非拒绝）。** 否决：在工具参数边界静默修复模型输出（违背 fail-loud），且通用 ask 工具的校验属核心 harness，桥得在执行器之前拦截。

## Consequences

跑新提示词的会话上，缺字段拒绝类从结构上消失——schema 里没有样板字段可漏。规范文本更短（无字段清单、无保留字解释）。代价：工具目录多一个工具（每个普通会话约 150 token）；会话轮转完成前双路径并存——ask-header 转换服务旧提示词与工具失手，轮转完成后才可退役（本次不动，经 followups 注册日志行监控）。非收尾卡类失败（44 次中 6 次；glm-5.3-flash 在普通 ask 上漏 `id`）不在覆盖内——仍由通用工具 schema 负责。钉死于 `tests/tools/followups-tool.spec.ts`（注册/HMR 注销、合成请求与递延句透传、非桥调用方、空选项、走真实 `askUser` 分支的集成）、`tests/engine/followups.spec.ts` 改写后的提示词契约（点名工具、禁止通用工具提法）、`tests/agent-dsh/adapter-persona.spec.ts` 的逐字钉死。
