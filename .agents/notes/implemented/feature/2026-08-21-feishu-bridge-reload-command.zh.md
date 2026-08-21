# Agent Note: /reload——daemon 用 detached 子进程完成自我重启

Status: implemented

[English](2026-08-21-feishu-bridge-reload-command.md) | 中文

## 问题

让 harness 的 TS 改动在 feishu-bridge daemon 上生效，需要从普通终端执行 `reload.sh`（host 面构建、`launchctl unload`/`load`、日志轮换、WS 就绪探活）。脚本内的守卫会拒绝任何祖先是 daemon 的执行——重启会杀死脚本自身进程树、令 `launchctl load` 永远到不了，即 2026-08-20 事故。该守卫对 daemon 承载的 agent 会话是对的，但它同样挡住了唯一一种「树被杀」担忧并不成立的场景：daemon 自己发起的、有意的重启。此前没有任何聊天侧入口：每次改代码都得离开聊天、开终端、记住两步构建-重启序列。

## 决策

`src/engine/reload-commands.ts` 新增 TS 原生 `/reload [--skip-build]` 命令（非 Go D 类裁剪 `/restart` 的移植）。handler 先回复「已启动」——`--skip-build` 数秒内就会重启 daemon，spawn 之后再发回复永远到不了——随后以 `spawn('sh', [reload.sh, ...], { detached: true, stdio: ['ignore', logFd, logFd] })` + `unref()` 运行脚本本体。setsid 脱离是承重设计：脚本亲手造成 daemon 之死、又必须活过这次死亡，所以它在动手之前先离开 daemon 的进程组。

脚本路径经 `resolveReloadScript(import.meta.url)` 自定位，按序探测两种真实构建布局：`../../reload.sh` 对应源码/tsc 布局（`src/engine/<file>`），`../reload.sh` 对应 tsdown 单文件 bundle——daemon 走的 `main: lib/index.js` 把所有 engine 模块内联进一个文件，`import.meta.url` 是 bundle 文件本身，写死单一相对层级会解析成 `packages/acp/reload.sh`。手动重启后的首次真机 `/reload` 正是报了该路径的脚本缺失错误；源码平面的单测看不到这一层，因为测试布局恰好匹配写死的层级。live profile 把包符号链接进 repo，两种布局下 daemon 解析到的都是 repo checkout 里的脚本。

`reload.sh` 接受 `FB_RELOAD_FROM_DAEMON=1`，但只豁免 ppid 守卫。对该 detached 子进程而言，walk 必然看到活着的 daemon 祖先、在它想近似的安全场景上误报；`DSH_SESSION_JSONL` 守卫不豁免，agent 会话里手动设这个变量仍被拒绝。这个切分如实反映了守卫的性质：它从来不是安全边界（沙箱本就拒绝 `ps`，bash 子进程也可以 unset 环境变量），只是防呆护栏。

`reload` 进入 `privilegedCommands`（admin 门，与 dir/monitor/shell 并列）。resolver 只整词匹配 `reload`：家族惯例的 ≥2 字符前缀解析会让 `/re`、`/rel` 在链式 resolver 里抢占 `/rename` 和 `/relay`。模块级 in-flight 标志拒绝运行中的第二次 `/reload`（两次交错的 unload/load 序列是 2026-08-20 事故等级的风险）；脚本 exit 或 spawn error 清除标志。输出追加到 `$LOG_DIR/feishu-bridge-reload.log`（默认 `~/.dsh`），每次运行一行时间戳头。脚本在 daemon 仍存活时非零退出——构建失败、plist 缺失、spawn 出错——exit 监听器回复失败与日志路径。

## 考虑过的替代方案

**在命令 handler 里原生重写 reload 逻辑。** 否决：那会让构建/重启/探活序列出现第二个所有者并与终端路径漂移；「效果等同 reload.sh」的最好保证就是运行 reload.sh 本体。

**用 `launchctl kickstart -k` 替代 unload/load。** 否决：它只重启服务，不承担周边契约——两步构建、日志轮换、unload→load 恢复 trap、WS 就绪探活都在脚本里。若真机冒烟证明 launchd 会杀掉 setsid 子进程，它作为回退方案重提（见后果）。

**省掉「先回复再 spawn」的顺序约束。** 否决：`--skip-build` 下 unload 在 spawn 后数秒内发生，确认消息会随旧进程一起丢失。

## 后果

admin 在聊天里即可触发完整的重建-重启；进行中会话仍会回滚到最后完整回合，与终端流程完全一致——已启动回复里写明了这一点。已知天花板：daemon 已重启之后才暴露的失败（如 WS 探活超时）无法产生聊天回复，监听器已随旧进程消亡，`feishu-bridge-reload.log` 是唯一记录，OPERATIONS.md §3.3 如实标注。脱离生存假设——launchd 的终止信号作用于任务的进程组而非 setsid 子进程——由真机冒烟验证；若不成立，bot 会离线直到手动 `launchctl load`，kickstart -k 是记录在案的回退方案。Linux 上脚本自身拒绝（launchd 检查），失败回复会转达该信息；systemd 流程保持手动。

## 测试

`tests/engine/reload-commands.spec.ts`（14 例）：注册合并/dispose、整词 resolver（`/re`/`/rel` 不抢占）、admin 门、未知参数 usage、脚本缺失报错、spawn 契约（argv、`detached`、守卫豁免 env、回复先于 spawn 的顺序）、`--skip-build` 透传、in-flight 拒绝与失败后恢复、spawn error 清标志、干净退出静默，以及 `resolveReloadScript` 的双布局解析（tsdown bundle 形状的 URL 即真机失败的红灯用例）与 miss 回退。`tests/reload-script.spec.ts` 新增两例：`FB_RELOAD_FROM_DAEMON=1` 在 daemon 形状祖先的桩下走完 unload/load；同一变量在 `DSH_SESSION_JSONL` 指向 daemon 会话存储时仍被拒绝。真实重启按 MIGRATION.md 真机冒烟（快路径、完整构建、双发拒绝、非 admin 拒绝、构建失败回复）。
