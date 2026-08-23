# Agent Note: /reload 完成通知——重启后的 daemon 自己回报

Status: implemented

[English](2026-08-22-feishu-bridge-reload-completion-notify.md) | 中文

## 问题

`/reload` 成功路径在聊天里完全静默。回复监听器活在旧 daemon 进程里、随它一起消亡，结果只有 `feishu-bridge-reload.log` 留痕（文档已注明的天花板，OPERATIONS.md §3.3）。发起 `/reload` 的运维要离开聊天、上服务器 tail 日志，才能知道那场持续数分钟的构建-重启真的完成了。首次真机运行（2026-08-22 23:20，dev 服务器）又暴露了初版的一个身份缺陷：只用 `Platform.name()` 匹配发送平台，而 dev 部署的 9 个项目都没配 `tag`（所有平台默认名 `'feishu'`），第一个命中的 bot 不在群里——飞书以 230002「Bot/User can NOT be out of the chat」拒绝发送，通知静默死在 journal 的 warn 里。

## 决策

完成通知由重启后的 daemon 自己发：它能发出这条消息，本身就是重启落地的证明。`cmdReload`（`packages/acp/feishu-bridge/src/engine/reload-commands.ts`）在 spawn 前写 `$LOG_DIR/feishu-bridge-reload-pending.json`——`{ pid, engine, platform, replyCtx, at }`，其中 `replyCtx` 原样 round-trip 触发消息的上下文，让通知落在原 `/reload` 消息的回复上。`index.ts` 收集各项目的 `engine.start()` promise，全部完成后调用一次新的 `completePendingReload(engines)`——每次 daemon 启动恰一次：

- 无标记——普通启动，no-op。
- `marker.pid === process.pid`——HMR 插件重载在 reload 还在飞行中重跑了 `apply()`（2026-08-22 exit-notice 事故的同款触发形状）：跳过且保留标记，真正的重启还在前面。
- 异 pid 且未过期（15 分钟 TTL，覆盖构建+重启窗口）——先按名字找到记录的引擎、再在该引擎的 platforms 里按名字找平台，经它发送 `reload_completed` 通知，删标记。handler 运行时 `p ∈ engine.platforms` 且该 bot 在群里，两级查找精确复现「已启动」回复的发送者；`Platform.name()` 单独不构成身份——未配 tag 的部署里所有平台都叫 `'feishu'`（230002 的教训）。
- 陈旧、引擎或平台不在配置（reload 期间项目被改名/移除）、JSON 损坏、发送失败（如 /reload 消息被撤回）——warn 后删除；每个被消费的路径都删除，单次 daemon 启动至多一条通知。

旧 daemon 的 `finish()` 在脚本非零退出（重启前的失败，失败回复本就会发出）时清掉标记，防止之后无关的启动误发。文案只声称永远为真的部分——daemon 已重启、消息由新进程发出、详情见日志——绝不声称「新构建」或「WS ready」。

## 否决方案

**由活下来的 reload.sh 自己发通知。** 脚本没有飞书凭证与发消息通道；为它新开一条通路远比复用新 daemon 的平台重。

**脚本写状态文件（ok / probe-failed）供 daemon 轮询。** daemon 在脚本探活结束前就已起，需要轮询循环加一套 shell↔TS 状态协议——只为区分一个文案可以直接不声称的结果。

**按引擎逐个调用通知检查。** 引擎并发启动，多个项目可能共用默认平台名 `feishu`，逐引擎检查可能双发。`Promise.all` 之后单次调用，天然无竞态。

**逐个尝试所有同名平台直到成功。** 230002 事故后否决：每次 reload 打 8 次必失败的 API、日志噪音大，且靠错误码猜身份——marker 直接记录引擎名即可，项目名在配置里唯一。

## 后果

`/reload` 在聊天里闭环：先有「已启动」回复，重启后补发完成回复。已知缺口：reload 构建期间 daemon 无关崩溃（systemd 拉起、脚本死于 cgroup kill）也会收到通知——daemon 确实重启了，文案不声称更多；详情在日志。重启后才暴露的失败（WS 探活超时）仍只有日志——那个窗口里没有任何进程能回复失败。`index.ts` 启动时序改动（收集 starts、循环后统一 await）行为中性：循环体无 await，引擎启动并发不变，逐项目启动错误日志不变。

## 测试

`tests/engine/reload-commands.spec.ts`（共 27 例，红灯先行）：cmdReload 在 spawn 前写入标记（pid/engine/platform/replyCtx/at），非零退出在失败回复的同时清标记；`completePendingReload` 经匹配引擎的平台发送并清除、平台名跨引擎撞名时经**记录的**引擎的平台发送（230002 事故形状：两个引擎、平台都叫 'feishu'、错误引擎排在前面）、pid 相同（HMR）时保留、TTL 边界丢弃陈旧、引擎或平台失配丢弃、无标记 no-op、损坏 JSON 丢弃、发送失败后仍清除。全包 2087 例绿；`tsc` 干净；无 snapshot——聊天通知进不了 record-replay 管线（与 /reload 命令本身同一已文档化缺口）。dev 服务器真机冒烟：聊天 `/reload` 收到落在原命令消息上的完成通知；标记文件出现后消失。
