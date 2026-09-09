# Agent Note: 白话直讲约定并入 agent 约定提示段

Status: implemented

[English](2026-09-09-feishu-bridge-plain-language-conventions.md) | 中文

## Problem

用户的白话直讲约定（把术语展开成大白话、用事实和数字支撑）此前放在机器本地的全局指令文件（`~/.claude/CLAUDE.md`）。对 2026-09-07 至 09-09 的 16 个出计划会话的审计发现：规则注入了每一个写计划的会话，计划输出依旧是实施细节密度——每份 8–66 个代码标识符、无一有白话层、全部三行内进入代码细节或未展开术语。失效根因是提示词层级不对等而非送达缺失：工作区指令以 user 角色 system-reminder 注入，前置声明明确「不覆盖 system/developer 指令」，且排在约 1.7 万字符的仓库级约定之前；而计划形态由系统级 `plan:policy` 段决定（decision-complete；「细到另一个工程师不做设计决策就能实施」）。同一审计也说明修复不能删细节：计划是批准者的主阅读面，也是设计决策的耐久载体——探索残留会随轮次被裁剪、子任务只拿父会话手写的 brief、架构上没有执行期设计重推导。

## Decision

「白话直讲」块随 `agentConventionsPrompt()`（`engine/agent-conventions.ts`）发布，并入 [agent 约定提示段](2026-08-24-feishu-bridge-agent-conventions-prompt.zh.md)（order 10；仅普通会话——subtask 子会话与 chatroom 人设维持排除）。约定覆盖一切给用户看的内容（回复、计划、汇报），并钉死计划的两层结构：白话层在前——问题、打算怎么改、预期效果、怎么验证、明确不做什么——决定要写死（范围、数字、验收标准；禁「适当优化」这类含糊动词），不出现实施标识符（文件路径、函数名、事件名；最多点到模块名）；实施细节层在后，保持工程密度。分层，不是删减：白话层服务批准，细节层服务执行。块尾带自检：把白话层单独截出来读，不看代码的人读不懂就重写。

机器本地的全局指令条目在本段确认送达后退役（全局文件热生效，系统段需构建 + 手动 /reload——先删会打开两头都没有规则的窗口）。bridge 部署是这条规则的唯一作用面（用户裁定）：Claude Code、dsh CLI/web、subtask 子会话不在其内。

## Alternatives considered

**改 `plan:policy` 段（`feishu-bridge/cordis.patch.yml`）。** 不作为第一步：会给上游 lockstep 管理的文本加第五处变换（`bundle-patch.spec.ts` 钉死变换集），且对非计划回复无效。保留为升级阶梯第二档（新会话复测不达标时启用），锚句与插入文本已备好。

**重写全局指令条目。** 放弃：这正是失效的那个层级——user 级提醒明确压不过系统级的计划引导，且该文件会触达用户已划出本决策范围的作用面。

**改 exit_plan_mode 工具描述。** 放弃：最贴近写作时刻的杠杆在上游共享插件代码里，分歧超出 bridge 局部范围。升级阶梯第三档。

**把白话概览渲染图升为主审批面。** 放弃：渲染 fork 是异步的（审批要等渲染）、渲染失败要兜底、全文计划卡仍会刷屏、回复术语问题不解决。

## Consequences

代价：每个普通会话的固定系统提示前缀增加约 450 个中文字符（至约 1550）；计划多一层白话；GLM-5.3 对两层结构的遵从度在度量前未知——验收门槛只采样新会话（≥5 份跨群计划；白话层出现率目标 ≥60%；实施细节层标识符密度不低于 8–66 基线），循 TDD 强制约束复测先例。bridge 之外的作用面在全局条目退役后不再有任何白话规则——用户裁定接受。换来：约定与它对抗的计划引导同处一个提示词层级、随 git pull + 构建在每台 bridge 机器生效、两层规则在给批准者可读层的同时保住执行者的技术细节。

## Testing

`tests/agent-dsh/adapter-persona.spec.ts` 逐字钉定约定段全文（含新块）；`tests/engine/followups.spec.ts` 继续对 `agentConventionsPrompt()` 钉定 followups 契约。
