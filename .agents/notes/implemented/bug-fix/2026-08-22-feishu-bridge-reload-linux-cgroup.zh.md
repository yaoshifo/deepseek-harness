# Agent Note: /reload 在 Linux 上死于 unit 的 cgroup kill 并误报失败

Status: implemented

[English](2026-08-22-feishu-bridge-reload-linux-cgroup.md) | 中文

## 问题

真机事故 2026-08-22 22:29（dev 服务器，聊天侧 `/reload`）：聊天收到「❌ Reload 失败（退出码 -1），daemon 未重启」，而 daemon 实际重启成功——22:29:19 起 `active (running)`，journal 里 22:29:22 起 `ws client ready`，运行的就是刚构建的产物。`feishu-bridge-reload.log` 停在 `==> restarting daemon feishu-bridge (systemd)`，之后一行探活输出都没有。

根因：Node 的 `spawn(detached: true)` 在 Linux 上只做 setsid——子进程仍是 `feishu-bridge.service` cgroup 的成员。`systemctl --user restart` 默认 `KillMode=control-group`，stop 阶段杀掉整个 cgroup，包括 detached 的 reload.sh 和它 fork 的 systemctl 客户端。脚本死于 SIGTERM（exit code null，映射为 -1），没来得及做 WS 探活；旧 daemon 在自身被拆除的间隙处理了子进程的 `exit` 事件，赶在死前发出了失败回复。systemd 本身照常完成 stop→start，所以重启从未失败——失败的只是报告。

## 决策

`packages/acp/feishu-bridge/src/engine/reload-commands.ts` 的 `reloadSpawnArgv(platform, scriptPath, scriptArgs)` 承担唯一一个必须由 spawner 做的平台决定：Linux 上 `/reload` 改为 spawn `systemd-run --user --scope --collect sh <reload.sh> [args]`，而非 `sh <reload.sh>`。瞬态 scope 单元是 daemon 单元的兄弟单元、在其 cgroup 之外，control-group kill 打不到脚本；`systemd-run` 同步等待命令结束，退出码语义不变。`--collect` 让 scope 退出即回收；不固定 `--unit` 名，残留 scope 不会与后续 reload 撞名。macOS 仍直接 spawn `sh`——launchd teardown 打不到 setsid 子进程。构建-重启-探活序列仍唯一地留在 reload.sh 里，终端路径不受影响。

## 否决方案

**daemon unit 改 `KillMode=process`。** 否决：每次重启都会留下所有 unit 子进程的孤儿——包括 mcp-server 进程——用一个真实的泄漏去换一个误报的消除。

**在 reload.sh 里自救。** 否决：脚本在 kill 降临的那一刻已经死了，只有 spawn 有机会提前离开 cgroup。

**改写失败消息措辞（「daemon 状态未知」）。** 否决：治标——脚本照样死在探活之前，日志照样没有成功记录，且 -1 的信号死亡路径仍与 spawn 出错无法区分。

## 后果

Linux `/reload` 的误报路径消除：脚本活过它亲手触发的重启，执行 journal WS 探活，并向 `feishu-bridge-reload.log` 追加完整成功序列。回复契约不变——非零退出仍只发生在重启之前的失败（构建错误、unit 缺失、`systemd-run` spawn 失败），此时「daemon 未重启」是准确的。没有 systemd-run 的 Linux 部署会 ENOENT 报 spawn 失败；这类部署本来就会在脚本的 `systemctl --user cat` 预检处 fail loud，无需 fallback。dev 服务器真机冒烟确认 scope 活过重启。

## 测试

`tests/engine/reload-commands.spec.ts`：新增 `reloadSpawnArgv` 套件断言两种平台形态（linux → systemd-run scope 前缀；darwin → 直接 `sh`），两个 spawn 契约用例改为经映射断言、保持平台无关。红灯先行：映射函数尚不存在。reload-commands 18 例、reload-script 30 例全绿；`tsc` 干净。
