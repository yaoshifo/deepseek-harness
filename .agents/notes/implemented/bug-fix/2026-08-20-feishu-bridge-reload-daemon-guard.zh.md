# Agent Note: feishu-bridge reload.sh refuses daemon-hosted shells and self-restores

Status: implemented

[English](2026-08-20-feishu-bridge-reload-daemon-guard.md) | 中文

## Problem

reload.sh 通过 `launchctl unload` + `launchctl load` 重启 launchd daemon。2026-08-20，daemon 自己托管的 agent 会话在任务收尾时运行了该脚本：unload 向 daemon 发出 SIGTERM，daemon 的 teardown 把脚本自身的进程树一并杀死在 unload 与 load 之间，LaunchAgent 从此处于未注册状态——bot 离线，直到有人手动重新加载。脚本既有的守卫——沿 ppid 链上溯、发现祖先匹配 `bin.js --profile feishu-bridge` 即拒绝——从未触发。两个环境事实解释了漏判，均在真实 daemon 上验证过：bash 工具沙箱拒绝执行 `/bin/ps`，ppid 走链在第一跳就断；沙箱还会把每个 bash 工具子进程导出的 `XPC_SERVICE_NAME` 改写成字面量 `0`（bash 的 shell 变量保留真实标签，导出副本被覆盖），因此基于标签的环境变量守卫到达不了脚本。

## Decision

守卫的主信号是 `DSH_SESSION_JSONL`：dsh 向每次 bash 工具执行导出该变量，其路径指名托管 daemon 的会话存储——取值位于 `${DSH_HOME}/feishu-bridge-sessions/` 之下即表明 shell 运行在 feishu-bridge daemon 内，脚本在触碰 launchctl 之前以 exit 1 拒绝。cc-connect 托管的会话（存储为 `cc-connect-sessions`）仍被允许——从那里重启 feishu-bridge daemon 不会杀死调用者。ppid 走链保留为兜底，覆盖不在任何 dsh 会话中手工启动的 daemon。其次，unload→load 窗口由 EXIT/TERM/INT 上的 `restore` trap 兜底：带重试地重新加载 plist（最多 10 次、间隔 0.5 秒）——`launchctl unload` 之后立刻 `load` 可能因 launchd 尚未完成注销而报 Input/output error，且濒死 daemon 的 teardown 可能在重启中途 TERM 脚本。

## Alternatives considered

**XPC_SERVICE_NAME 守卫。** 经真机验证后否决：沙箱会把每个 bash 工具子进程的导出值改写为 `0`，无论是否在 daemon 内，标签永远到不了脚本的环境。

**拒绝一切 dsh 会话（任意 `DSH_SESSION_ID`）。** 否决：这会连带封锁安全且有用的 cc-connect 托管重启路径；`DSH_SESSION_JSONL` 能精确区分。

**用 `launchctl kickstart -k` 取代 unload/load。** 否决：它不会注销服务（没有离线窗口），但也从不重读 plist，`EnvironmentVariables` 的修改会静默不生效。

## Consequences

从 daemon 托管会话运行 reload.sh 会快速失败，错误消息指名会话存储；daemon 不受影响。脚本若仍在 unload 与 load 之间死亡（abort 路径或 TERM 杀死），trap 会重新加载服务，最坏情形是一次短暂重启而非 bot 离线。残余风险：窗口内的 SIGKILL 无法捕获，服务将保持未加载；3 秒的 teardown 宽限期使其不太可能发生。会话存储若迁移（配置改离 `feishu-bridge-sessions`）会静默使主守卫失效——OPERATIONS.md §3.3 记录了该信号。

## Testing

`tests/reload-script.spec.ts` 用桩掉的 launchctl/pgrep/ps 运行真实脚本（仅 macOS，`describe.skipIf`）：daemon 存储环境拒绝且 launchctl 零调用；cc-connect 存储环境正常走完 unload→load；ppid 走链仍拒绝 daemon 形状的祖先；旧 daemon 未退出的 abort 路径会重新加载；重启中途的 SIGTERM 会重新加载；普通终端的 happy path 正常完成。2026-08-20 真机验证：daemon 托管会话运行 `reload.sh --skip-build`，收到拒绝（exit 1），daemon 保持存活。
