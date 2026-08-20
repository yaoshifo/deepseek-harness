# Agent Note：/shell 与 "!" 快捷前缀——feature 对照表看不见的引擎命令

Status: implemented

[English](2026-08-22-feishu-bridge-shell-command.md) | 中文

## Problem

cc-connect → feishu-bridge 迁移以 `docs/FEATURE-PARITY.md` 为验收对照——该表源自 cc-connect 的 `docs/features.md`，是一份 feature 清单而非引擎命令清单（`core/engine.go` 的 `builtinCommands` 共 52 条，TS 引擎只注册了约 18 条）。`/shell` 正是从这个缺口漏掉的：它的 i18n 文案（`shell_usage`、`BuiltinCmdShell`、`message_help`）被整体随迁，看起来已迁移，但处理器并不存在——`/shell …` 作为普通消息落给 agent，`!` 前缀快捷方式则以字面文本到达 agent。

## Decision

`src/engine/shell-commands.ts` 按既有的按域注册模式移植 Go `cmdShell`（`core/engine_cmd_workspace.go`）：`registerShellCommands` 合并进引擎现有命令表（别名 `shell`/`sh`/`exec`/`run` 加 ≥2 字符前缀解析）并返回 disposer。命令在 `commandWorkDir(msg)` 里以 `sh -c <command>` 执行，spawn + AbortController 形状与 `executeCronShell` 相同：合并 stdout/stderr、默认 60 秒超时、开头 `--timeout <seconds>` 解析（失败则旗标留在命令里）、输出 trim 后超过 4000 rune 截为 3997 + `...`、成功但空输出回 `(no output)`、非零退出仅在无输出时报 `exit status N`、回复带围栏的 `$ <command>`。命令文本取自 `msg.content` 而非分发器的空白切分 args——args 会压扁引号内空格（`echo "a  b"`）。`!` 前缀在 `handleMessage` 的 `handlePendingPermission` 之后分派（Go 顺序：`!yes` 应答 pending permission，绝不进 shell），经 `runBangShell` 先过 `gatePrivilegedCommand`。`shell` 加入 `commands.ts` 的 `privilegedCommands`（Go 8 条 admin 门命令的 TS 子集：dir/monitor/shell）。

刻意不迁（维持 M4-E C 类裁定）：`disabled_commands` 与 user-role `DisabledCmds`（机制未移植）、multi-workspace shared binding 工作目录（多工作空间本身未移植）、`audit: command_executed` 日志（TS 引擎无审计面）。

## Alternatives considered

**走 dsh shell 能力（`packages/shell`）而非 `sh -c`。** 否决：该 Service seam 面向带 request/spec 解析与 provider 路由的 agent 工具；聊天命令需要的是与 Go `exec.CommandContext` 及引擎既有 `executeCronShell` 相同的 daemon 进程直接子进程。

**现在移植整个缺失命令族。** 否决为本轮范围扩张：缺失的 ~34 条命令各需独立的迁移/裁剪裁定（upgrade/restart/web/doctor 属 D 类；/help、/whoami、/history 无裁定记录），改为下方记录为已具名缺口。

## Consequences

`/shell` 与 `!` 在聊天里恢复可用，由 `admin_from` 管理。本 note 提到的两个后续项已于同日在 `feature/2026-08-22-feishu-bridge-seven-commands.md` 落地：`/help` 已注册且列表从注册表动态生成，误导性的 `message_help` 大段（连同六个 `help_*_section` 条目）已删除。命令清单本身仍是具名缺口——剩余未裁定命令见该 note 与 README Known Limitations。超时消息保留 Go 冻结的 "(60s)" 措辞，即使 `--timeout` 设了别的值。

## Testing

`tests/engine/shell-commands.spec.ts`（15 例）：空命令 usage、工作目录解析、别名/前缀分发、非零退出有/无输出、`(no output)`、4000 rune 截断、`--timeout` 击杀、`/shell` 与 `!` 的 admin 门、`!yes` 权限应答优先、空 `!` 穿透、注册合并/dispose。Go 的两个 multi-workspace `TestCmdShell_*` 用例随其机制一并未移植。真机冒烟（`/shell pwd`、`!ls`、超时、非 admin 拒绝）按 MIGRATION.md 的 reload 流程执行。
