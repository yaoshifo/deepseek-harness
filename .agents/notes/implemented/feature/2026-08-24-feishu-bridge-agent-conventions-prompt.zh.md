# Agent Note: 普通会话携带固定的 agent 约定提示段

Status: implemented

[English](2026-08-24-feishu-bridge-agent-conventions-prompt.md) | 中文

## Problem

用户的好奇心上报约定（范围外发现先验证、收尾单列「发现的问题 / 可优化点」一节）此前放在机器本地的全局指令文件（`~/.claude/CLAUDE.md`，由 `~/.dsh/AGENTS.md` 符号链接）。后续交互只有文字：用户要处理其中一部分发现，得把内容再说一遍。给收尾追加 ask_user_question 多选卡片，两个候选归宿都被否了：共享指令文件会把运行时专属交互耦合进运行时无关的约定；每台机器 profile 的 `persona` 字段（`cordis.patch.yml`）在每次新部署时都会被忘记——这套工作流现在部署在多台机器上（本机 launchd、dev 服务器 systemd）。

## Decision

约定随包发布：`agentConventionsPrompt()`（`engine/agent-conventions.ts`）返回三个部分——异步自主工作方式（可逆动作直接做、探索性问题只交评估、工具调用不可见所以简要播报并把本轮交付物完整落在最后一条消息、回合结束不留悬空承诺；逐字迁自退役的全局指令节并并入两条聊天渲染规则）、好奇心上报约定（逐字沿用退役的全局指令条目）、收尾卡片约定（发现一节非空 → 调一次 `ask_user_question`，`multi_select: true`，每个发现一个选项外加「暂不处理」）。收尾文本的发现一节每条只留短标题与一句验证依据；`path:line` 与建议动作只放在卡片选项描述里，正文与卡片互不重复。选项按推荐程度排序，推荐要处理的选项标 `recommended: true`，提交的勾选即授权立即处理；与选项无关的自由文本按新任务执行，覆盖 `handlePendingPermission` 把挂起问题期间自由文本消费为答案的行为。`buildSessionSetup`（`agent-dsh/adapter.ts`）仅对普通会话把它注册为 `feishu-bridge-agent-conventions`（order 10，persona 之后、tool guidance 之前）；原先无 persona 无 workspace 的早退取消。subtask 子会话与 chatroom 人设不含此段——它们的发现分别经父会话与各自人设呈现。迁出的各节已从 `~/.claude/CLAUDE.md` 删除（该文件只留运行时无关的工作风格）；部署级行为随 `git pull` + 构建走，不依赖机器本地配置。

`recommended` 标记走一条仅影响呈现的 seam 变更：`AskUserQuestionOption.recommended`（`interaction/user-questions`）→ `ask_user_question` 工具 schema（`interaction/tool-ask-user`）→ `UserQuestionOption.recommended`（`core/types.ts`）→ `CardCheckOption.checked`（`card.ts`）→ 飞书 `checker` 元素的初始 `checked` 态（`feishu/card.ts`），推荐的多选项默认勾选、一次「提交选择」即确认推荐集合。回答编码不变——表单两种情况下都提交勾选的 `askq_opt_N` 键。

## Alternatives considered

**live profile 的 `system-prompt` 插件 `persona`。** 放弃原因：机器本地配置要手工迁移到每台新机器，正是本次要消除的失效模式。

**保留在共享全局指令文件并指示 agent 调 ask_user_question。** 放弃原因：把运行时专属交互耦合进用户想保持通用的指令文件。

**引擎侧解析收尾回复的发现一节并渲染卡片。** 放弃原因：在自由格式的模型输出上新建解析与回调机制，而现成的 ask_user_question 管线已经闭环。

## Consequences

代价：每个普通会话多付约 1100 个中文字符的固定系统提示前缀；收尾卡片被忽略的会话会挂到 turn 超时（下一条用户消息仍会作为答案流入，由自由文本条款兜底）。subtask 子会话不再经用户全局指令继承好奇心文本——刻意的作用域收窄，其发现经父会话聚合上报。换来：一份钉在仓库里的自包含行为约定，所有部署 bridge 的机器行为一致，机器本地零配置。

## Testing

`tests/agent-dsh/adapter-persona.spec.ts`：普通会话用例断言约定段（名称、order 10、非 complete）且全文逐字内联钉住；第二个用例断言配置 CC_FEISHU_* 时 conventions 在 workspace 之前；subtask 与 chatroom 路径断言不含此段。`recommended` 链路逐跳覆盖：`interaction/tool-ask-user` 断言结构化标记透传到 provider，`tests/engine/engine-m3-askq.spec.ts` 断言多选 checker 只预勾推荐选项，`tests/feishu/card.spec.ts` 断言 checker 元素携带初始 `checked` 态。包内先例：提示段随单测发布，钉注册行为与文本（chatroom persona、subtask preamble），不配 keyless 应用 transcript。
