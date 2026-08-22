# Agent Note: reload.sh 的 Linux 分支——systemctl restart + journal WS 探活

Status: implemented

[English](2026-08-22-feishu-bridge-reload-linux.md) | 中文

## 问题

reload.sh 只支持 macOS launchd。在 Linux dev 服务器上（systemd user unit，见 OPERATIONS.md §5）脚本在 Darwin 检查处直接退出 1、什么都没做，于是聊天侧 `/reload`——其 handler 就是 spawn 这个脚本——在那里失败，只回一句没头没尾的「退出码 1」（2026-08-22 真机报告，群 `oc_7e49044246b67ce4b5a64d0567a87d6a`）；真正的「launchd is macOS-only」报错只落在 `feishu-bridge-reload.log` 里。运维只能离开聊天、手动跑 §1.3 构建加 `systemctl --user restart`——恰恰是 `/reload` 要消除的摩擦。

## 决策

reload.sh 以 `uname` 分支，公共前缀（参数解析、两个拒绝守卫、host 构建）共享。Linux 路径先用 `systemctl --user cat "$UNIT"` 预检——在构建烧掉几分钟之前 fail loud，与 plist 检查对称；`UNIT=${UNIT:-feishu-bridge}` 与 `PLIST` 覆盖对称——随后单条 `systemctl --user restart "$UNIT"` 重启，再从 journal 探活 WS：时间戳取在 restart 返回**之后**（旧 daemon 届时已停止，它临终止前发的 WS 重连行满足不了探活），之后以 0.5 秒间隔轮询 `journalctl --user -u "$UNIT" --since "$stamp" | grep 'ws client ready'`，至多 60 次。没有 restore trap、没有日志轮换：systemctl restart 是单一原子操作，不存在 unload/load 空窗（trap 正是为那个空窗存在的），journal 自己保留跨重启的历史。

守卫不变且与平台无关：`DSH_SESSION_JSONL`（daemon 承载的 agent 会话）与 ppid 回溯（手动启动的 daemon），`FB_RELOAD_FROM_DAEMON=1` 仍然只豁免后者。平台预检放在守卫**之后**，保证拒绝路径零系统交互——darwin 套件对 launchctl 已断言过这一性质。TS 侧（`reload-commands.ts`）零改动：平台逻辑留在脚本内，终端路径与 `/reload` 保持同一条代码路径。

## 否决方案

**在命令 handler（TS）里重新实现 Linux 流程。** 否决，理由同 `/reload` note：build-restart-probe 序列出现第二个 owner 必然漂移；脚本自定位，同时服务两个入口。

**`systemctl --user restart` 不做 WS 探活。** 否决：macOS 流程以「WS ready」为完成信号，缺了它，编译通过但启动即崩的构建会被当成成功。

**journal cursor 而非墙钟 `--since` 时间戳。** 否决：restart 返回后的时间戳已足够（旧 daemon 写不过它的停止时刻），且简单得多；时钟回拨要恰逢重启才有影响。

## 后果

`/reload` 在 Linux 部署上可用，回复契约不变：restart 之前的失败（构建错误、unit 缺失）聊天内回复，之后的失败（探活超时）只有日志——已文档化的天花板。探活超时会把 journal 最后五行 tail 进 `feishu-bridge-reload.log` 供诊断。`journalctl --user` 需要用户总线（`XDG_RUNTIME_DIR`）；systemd unit 已设置，普通终端天然具备。

## 测试

`tests/reload-script.spec.ts` 新增 `reload.sh on Linux/systemd` 套件（6 例），在 darwin 与 linux 上都运行：PATH 上遮蔽 `uname`/`systemctl`/`journalctl`/`ps`（no-op 的 `sleep` 桩让 60 轮探活超时在毫秒级耗尽）。用例：happy path（恰为 `cat` + `restart`）、`DSH_SESSION_JSONL` 拒绝且 systemctl 零调用、unit 缺失 fail loud、探活超时、`FB_RELOAD_FROM_DAEMON=1` 绕过 ppid 回溯、该绕过在 daemon 承载会话下仍被拒绝。真机冒烟按 MIGRATION.md（dev 服务器终端直跑 + 聊天侧 `/reload --skip-build`）。
