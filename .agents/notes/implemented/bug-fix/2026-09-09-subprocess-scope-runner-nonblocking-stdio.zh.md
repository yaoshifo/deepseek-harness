# Agent Note：scope runner 的 exec 边界恢复阻塞式 stdio

Status: implemented

[English](2026-09-09-subprocess-scope-runner-nonblocking-stdio.md) | 中文

## 问题

输出超过 64 KiB 收集上限的 cron exec 任务以退出码 1 失败——`tr: write error: Resource temporarily unavailable` 与 `head: ... Broken pipe`——引擎把本已成功的命令记为失败（`bounds the collected job output at 64 KiB per stream` REAL-provider 测试确定性变红）。最初「收集器在 maxBytes 停止排水」的解读是错的：收集器持续排水并保留尾部。真正的机制在 exec 边界：Linux scope runner 是 `systemd-run` 与目标之间的一个 Node 进程，而 Node 运行时把它的管道型 stdout 置为非阻塞；`execve` 保留打开文件描述的状态标志，且与 libuv 派生的子进程（libuv 会把其 stdio 恢复为阻塞）不同，裸 libc `execve` 路径从未清除该标志。被 exec 的目标因此继承了非阻塞的管道写端，一旦突发写满 64 KiB 管道缓冲，`write()` 返回 `EAGAIN` 而非阻塞——coreutils 将其视为致命写错误。任何经 scope 的高吞吐写者都暴露在此风险下；超限运行只是让写满管道的窗口近乎必然。

## 决策

`loadLinuxExecve()` 的 exec 包装——即已对 fd 0 至 fd 2 清除 `FD_CLOEXEC` 的同一处规范化——现在在 `execve` 前也通过 `F_GETFL`/`F_SETFL` 清除这些描述符上的 `O_NONBLOCK`。目标获得与任何常规派生子进程相同的阻塞式 stdio；想要非阻塞 stdio 的目标可以自行设置。修复位于 subprocess 服务层，所有消费者（cron exec、bash 执行器）都受益；macOS 进程组回退路径没有中间 runner、本就正确，Windows Job 路径经 `CreateProcessW` 派生、机制不同、无需改动。

## 备选方案

- **加大管道或让写者降速：** 否决——非阻塞写端会把每次瞬时的管道写满都变成 `EAGAIN`；只有恢复派生约定才能消除这一失败类别。
- **读端更努力地排水：** 否决——读端本就持续排水；竞态发生在写者突发与事件循环之间，任何读端改动都关不上这个窗口。

## 后果

- `bounds the collected job output at 64 KiB per stream` 转绿：2 MiB 快速写者配合 8 KiB 收集上限经 scope 退出码 0，尾部字节精确（`native-containment.spec.ts` 新增 REAL-provider 测试）。
- `fcntl` 规范化序列由单元测试钉住，包括读取与清除状态标志的失败路径。
- runner 的描述符卫生现在按描述符覆盖两族标志：`FD_CLOEXEC`（每描述符）与 `O_NONBLOCK`（每打开文件描述）。
