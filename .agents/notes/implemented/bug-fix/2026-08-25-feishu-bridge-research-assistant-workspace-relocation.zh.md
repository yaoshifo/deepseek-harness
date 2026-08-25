# Agent Note: chatroom 研究助手保留 cwd 发现；工作区搬走了

Status: implemented

[English](2026-08-25-feishu-bridge-research-assistant-workspace-relocation.md) | 中文

## Problem

去 coding 场景剥离工作的审查发现两处残留。其一，d8107f21b0 给 research-assistant 子会话抑制了工作区指令注入，原因是其共享工作区（`<moderatorDir>/research`）把 moderator 人设——含「绝不 pip install」契约——放上了每个助手的 cwd 祖先发现链，与其以 pip install 为业的本职矛盾。抑制是对一个**放置 bug** 的钝刀修法：research 助手本质是 coding agent，cwd 指令发现（含用户全局 ~/.dsh/AGENTS.md 的纪律）对它们是恰当的，与 plain/attended 子任务完全一致。其二，每次 moderator 唤醒附带的 `chatroom_reminder` 指回 `~/.claude/CLAUDE.md 批判性自检`——正是 suppression 要挡在门外的全局 coding 指令文件——且 research 角色人设声称「没有 coding 工具」，而会话实际带着全套工具（只有 `skill` 被拒）。

## Decision

- **先搬家，再解除抑制。** `chatroomResearchWorkspace` 默认改为 `<项目数据目录>/chatroom-research`（从 sessions 存储路径推导；显式配置 `researchWorkspace` 仍然优先，无存储路径的引擎无默认值）。旧的 `<moderatorDir>/research` 默认直接废弃、不做迁移：现存部署在新位置一次性重配共享 venv。工作区离开所有人设祖先链后，adapter 里 research 助手的 `suppress()` 分支删除；助手与其他子任务一样保留 cwd 发现。工作区建目录失败的 fallback（助手落在角色人设目录）保持不变：注入的角色人设是低权威噪音，不是硬矛盾。
- **reminder 自包含。** `chatroom_reminder` 把 `~/.claude/CLAUDE.md` 引用换成内联提示（「先构造最强反例，再点名追问」）；批判性追问方法论本体写进两版 moderator priming（普通版「按需批判性追问」条目；research 版第 2 轮交叉迭代步骤），按聊天室付一次费而不是每次唤醒付一次。
- **prompt 说实话。** research 角色契约改为「执行交给你的预配助手；你负责思考、拆解、判断」，不再假称「没有 coding 工具」。工具面不变（bare persona 维持 `skill` 拒绝；角色与主持人保留工具——明确不做执行层收窄的决策）。

bare persona（主持人/角色/直聊）的抑制不动：那些会话是人设，不是 coding agent。

## Alternatives considered

**保留抑制、保留旧位置。** 弃用：为了躲一个放置 bug 而拒绝给 coding agent 提供 coding 纪律文件（它的实际价值），也挡掉了对助手有益的指令（输出纪律、依赖卫生）。

**用 `tools.restrict` 执行 research 角色的无工具化。** 用户决策弃用：角色保留工具；prompt 把执行指向助手，而不是对工具面说谎。

**reminder 的文件引用改为指向聊天室账本。** 弃用：reminder 每次唤醒都附带；方法论属于一次性 priming，唤醒时刻一句内联提示足够。

## Consequences

research 助手现在能看到用户全局 coding 指令与工作区树上的内容——与普通子任务相同的注入面。研究进行中重启守护进程，下次 chatroom 启动在新位置重配 venv（基础数据依赖一次性重装）。旧的 `<moderatorDir>/research` 目录原地废弃，不迁移。

## Testing

`chatroom-persona.spec.ts`：research 助手用例翻转为断言所有子任务保留 cwd 发现。`engine-chatroom-end.spec.ts`：工作区默认值测试钉住 `<项目数据目录>/chatroom-research`、配置覆盖与无存储路径的空值。`engine-chatroom-recovery.spec.ts`：gather 恢复唤醒断言 reminder 不携带 `~/.claude` 引用。五个受影响套件（persona、end、recovery、venv、assembly-chatroom，54 个测试）与 bridge typecheck 通过。
