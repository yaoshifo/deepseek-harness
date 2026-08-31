# Agent Note: feishu-bridge cron 信任边界——chat 归属与 exec 的 admin 门

Status: implemented

[English](2026-08-31-feishu-bridge-cron-trust-boundary.md) | 中文

## Problem

cron store 是项目级全局的，但它的三个入口——`/cron` 文本命令、cron 卡片按钮、`feishu_bridge_cron` agent 工具——全部凭裸 8-hex job id 操作，没有任何归属校验。任意 chat 都能删除、停用、编辑其它 chat 的 job（工具的 edit 分支还能改写 `exec`/`prompt`/`session_key`），`/cron list` 把项目里每个 job——含 prompt 与 exec 全文——渲染给任何群成员。更糟的是，agent 工具绕过了文本面唯一的门：`/cron addexec` 要求 `isAdmin`，而工具的 `add` 分支直接接受 `exec`——任何群成员都能让 agent 建一个无人值守的 shell 定时任务。这是一条持久化提权通道：cron 在之后无人盯守的时刻触发，恰恰活在逐轮审批的射程之外。

## Decision

job 归属于创建它的 chat（`job.sessionKey`）；`admin_from` 白名单在所有入口凌驾于归属之上。共享 helper `cronJobActionAllowed`（engine/cron-commands.ts）是唯一实现，工具、文本、卡片三路复用：

- **add**——`exec` job 要求操作用户是 admin，与 `/cron addexec` 同一条信任线：无人值守 shell 执行。prompt-only job 不设门，因为它在 agent 会话内运行、走正常的逐轮审批。
- **edit**——敏感字段（`exec`、`prompt`、`project`、`session_key`、`work_dir`、`mode`）仅 admin 可改，本 chat 的 owner 也不行；`mode` 列入是因为它能把无人值守 run 切到 `bypassPermissions`，同属绕过逐轮审批的信任线。非敏感字段（`cron_expr`、`description`、`enabled`、`mute`、`silent`、`timeout_mins`、`session_mode`）为 owner-or-admin。
- **del / enable / disable / mute / info**——三入口统一 owner-or-admin，把全局 id 的读泄露与写泄露一起关掉。
- **list**——非 admin 只看到调用 chat 自己的 job，prompt/exec 回退文本截断 60 rune；admin 仍是全项目视图。

操作用户取会话的 spawn user（`session.getSpawnUserID()`）；无活跃会话的 chat 解析为 `''`，admin 判定按非 admin 处理——fail closed。卡片按钮路径只拿到 session key（engine.ts 的 `handleCardAction` 没把 `msg.userID` 传进来），所以它的门退化为纯归属判定：伪造的跨 chat 卡片动作连 admin 也拒——更严，且有意保持。

## Alternatives considered

**彻底禁止 agent 工具建 exec job。** 否决：admin 确实需要让 agent 排定时命令；只留文本路径只会逼人肉中转。

**用会话的 permission mode 门禁 exec add。** 否决：cron 建立后无人值守地运行，建立时的逐轮权限状态对之后的运行毫无约束力——admin 线是唯一能活到执行时刻的检查。

## Consequences

信任线现在统一：一切执行 shell 或改变 job 执行内容的行为需要 admin；一切管理既有 job 的行为需要归属或 admin。未来任何新 cron 入口必须走 `cronJobActionAllowed`，不许直连 `scheduler.store()`。已知上限：卡片路无 admin 豁免意味着 admin 无法通过伪造卡片回调操作其它 chat 的 job——要恢复需把 `msg.userID` 接进 `executeCardAction`（engine.ts 一行）；更严的行为是有意选择。

## Testing

`tests/tools/cron-tool.spec.ts`：非 admin 操作用户的 exec add 被拒、prompt add 不设门、admin 的 exec add 通过；跨 chat 的 del/edit/info 被拒；敏感字段 edit 连本 chat owner 也需要 admin；list 对非 admin 只显示本 chat job 且回退文本截断。`tests/engine/cron-commands.spec.ts`：文本路 del/enable/disable/mute 跨 chat 对非 admin 拒绝；owner 与 admin 自由操作。`tests/engine/cron.spec.ts`：伪造的跨 chat 卡片动作被拒。`tests/tools/lark-tool.spec.ts` 钉住同批落地的 lark 透传输出上限。
