# Agent Note: cron exec 任务改走 subprocess 服务，不再裸 spawn

Status: implemented

[English](2026-09-08-feishu-bridge-cron-exec-subprocess-containment.md) | 中文

## 问题

`Engine.executeCronShell` 用裸 `spawn('sh', ['-c', job.exec])` 跑 exec 任务：无进程组、无沙箱、abort 信号只杀直接 `sh`、输出无限累积。`长任务 & echo started` 这类任务直接 sh 立刻退出 0，后台化子孙继续无人监管地跑；输出汹涌的任务把全部输出攒进内存。这是 daemon 里唯一低于 bash 工具隔离水准的子进程面。

## 决策

引擎把前台执行委托给宿主接线的 `EngineSubprocess` runner（spec：argv、cwd、每流字节上限、abort 信号；结果：合并输出、退出事实、超时旗标）。`buildProjectAssembly` 接线 `createCronSubprocessRunner`，经组合的 `subprocess` 服务（`ctx.subprocess.spawn`）跑任务：托管 range 收编后台化子孙（macOS 进程组、Linux systemd scope / Windows Job Object），超时终结整棵树，range 静默而非直接子进程退出才结算本次运行。收集输出按流限 64 KiB。无 runner 时 cron exec fail loud。

## 考虑过的替代方案

- 保留裸 spawn，引擎内加 `detached: true` 与手写组杀：否——在 port 层重造 subprocess provider 终结阶梯（TERM→宽限→KILL、range 静默）的一小部分。
- 让 cron exec 走 bash 工具执行器：否——执行器带着轮次作用域的 shell 语义（stdin、spill 策略），cron 任务没有这些，且引擎要够到它得先有一个 agent 会话。

## 后果

- 超时现在杀整棵任务树；`echo` 背后的 `while true` 循环不再比本次运行活得更久（真 provider 测试用心跳文件停止增长钉住）。
- 引擎构造器多了可选 `EngineSubprocess` 参数；既有的全部无 runner 构造不受影响，只有 cron exec 路径 fail loud。
- 退出状态、超时、成功三类消息格式不变；每流 64 KiB 上限是内存不变量而非旋钮——聊天消息本就截到几千字符。
