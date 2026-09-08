# Agent Note: cron exec 任务通过声明的 env_keys 获取 daemon 凭据

Status: implemented

[English](2026-09-09-feishu-bridge-cron-exec-env-keys.md) | 中文

## 问题

cron exec 任务改走 subprocess 服务（[收编](2026-09-08-feishu-bridge-cron-exec-subprocess-containment.zh.md)）后，子进程环境也经过 `scrubbedParentEnv()`，其 `SENSITIVE_ENV_PATTERN` 会擦掉所有凭据形态的变量名。systemd EnvironmentFile 供进 daemon 的云凭据（`VOLCENGINE_*`、`TENCENTCLOUD_*`）因此到不了 exec 任务——2026-09-09 运维备份任务全部失败。服务的 spawn 本就支持在擦洗后合并显式 `spec.env`；缺的只是 cron 这条链从未传过。

## 决策

`CronJob` 携带 `env_keys`——落盘 snake_case，只存变量*名*；无该字段的任务行为完全不变。`executeCronShell` 按声明键名从 daemon 的 `process.env` 取值填入 `EngineSubprocessSpec.env`（未声明则为 undefined），`createCronSubprocessRunner` 透传给 `ctx.subprocess.spawn`，在环境擦洗之后合并。声明的键名在 daemon 环境缺失时，本次任务在任何 spawn 之前以错误结束，错误消息含键名、绝不含值。值按次解析、永不落盘：jobs.json、工具调用、聊天消息只有键名。`env_keys` 与 exec 同一条信任线：`feishu_bridge_cron` 工具的 add（仅 exec 任务）与 edit（逗号分隔键名列表）接受它，编辑它与 `exec`/`prompt`/`work_dir` 一样需要管理员。

## 考虑过的替代方案

- **把 daemon 全部凭据隐式透传给每个 exec 任务：** 否——等于把 daemon 的整套凭据交给每个任务脚本，一个脚本被攻破即全部泄露；也会把收编改动刚获得的擦洗悄悄撤销。
- **每任务一个 env_file 由引擎读取：** 否——多出一个需要拥有、加固、审计的凭据来源；daemon 的 EnvironmentFile 本就供值 `process.env`，只声明键名即可拿到同样的值，无需新文件或文件读取通道。

## 后果

- 声明的键名即使命中凭据擦洗也能到达子进程；未声明的凭据键名保持被擦除（真 provider 测试用一条命令同时钉住两侧）。
- 键名拼错或被撤销时，任务在构造 spec 处即失败并在错误里点名——运维能直接看出该恢复哪个键，而不是去排查下游鉴权错误。
- 输出处理不变：流输出超过每流 64 KiB 上限的任务，仍保持收编改动所定的退出码行为。
- `/cron` 斜杠命令族不接受 `env_keys`；agent 工具是唯一入口，与它的管理员门限一致。
