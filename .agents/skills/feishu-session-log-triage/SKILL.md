---
name: feishu-session-log-triage
description: "飞书群排查运维手册（Runbook）：由群 chat_id（oc_ 开头）定位 dsh 会话数据与 zstd 会话日志，按故障指纹判别真挂起、watchdog 强杀、卡片降级冻结、等用户输入等状态，并可从飞书群历史找回丢失的汇报内容。Use when 某个飞书群没响应、卡片不动、内容丢失，或需要查看某群 agent 的会话日志。触发例句：「排查 oc_xxx」「这个群的日志在哪」「群卡死了怎么回事」「找到 oc_xxx 对应的会话数据」「看下这个群的会话日志」"
argument-hint: "<oc_chat_id> [症状：无响应 | 卡片冻结 | 内容丢失 | 只要日志路径]"
---

# 飞书会话日志排查（feishu-session-log-triage）

由飞书群 chat_id 定位 dsh 会话数据与会话日志，按指纹判别故障状态并给出证据化结论；会话数据不可用时改从飞书群历史找回内容。

## 输入

- `$chat_id`（必需）：`oc_` 开头的群 chat_id。只有群名时先用 lark-im skill 搜群拿 chat_id。
- 症状（可选）：无响应 / 卡片冻结 / 内容丢失 / 只要日志路径。省略时默认走完整排查。

## 目标

成功产物：会话日志文件路径 + 故障结论（真挂起 / watchdog 强杀 / 卡片降级冻结 / 等用户输入 / 正常完成）+ 日志证据行。用户只问「日志在哪」时，产物就是路径本身，不做后续排查。

## 步骤

### 0. 无响应类症状：先确认 daemon 存活

群没反应时先分流「进程死了」还是「进程活着但会话/卡片出问题」：

```bash
launchctl list | grep feishu-bridge   # 无条目 = 服务未加载（dev 服务器对应 systemctl --user status）
```

沙箱内不可靠的判据：`ps` 被拒（Operation not permitted）、`XPC_SERVICE_NAME` 被改写成字面量 `0`——bot 会话里别用它们查进程；可靠判据是 `launchctl list` 与环境变量 `DSH_SESSION_JSONL` / `DSH_HOME`。确认 daemon 没跑属于恢复操作（launchctl load / kickstart），破坏性动作，先向用户确认。

**成功标准**：确认 daemon 进程在跑，才进入步骤 1 查会话数据。

### 1. 定位会话与日志文件

跑本 skill 目录（激活时给出的 base directory）下的定位脚本，覆盖本机所有 bot：

```bash
python3 <skill-dir>/scripts/locate-session.py "$chat_id"
```

**成功标准**：拿到 `agentSessionID`（cc- 开头目录名）与每个会话的 `log:` 行（session.jsonl.zstd 路径）。

0 命中时的兜底：按脚本身上的 fallback 提示手动 grep；仍无命中说明群不在本机 daemon 名下（检查另一台机器，路径同构）。

### 2. 读日志排查（zstdcat）

日志是 zstd 压缩 JSONL，每行一个事件（`type` / `seq` / `time` / `data`）。**必须 `zstdcat` 读取，禁止裸 grep 压缩文件。**

按症状分支：

- 群无响应 / 卡死 / 卡片不动 → MUST 先读 `references/triage-fingerprints.md`，按指纹表判别后再下结论。
- 审批卡没弹 / 反复要授权 → 同上，读指纹表的审批事件判别一节。
- 内容丢失 / 找不到汇报 → MUST 先读 `references/group-history-recovery.md`。
- 只要日志路径 → 第 1 步为止。

**成功标准**：结论有日志证据（事件 seq/time 或 daemon 日志行）支撑，不含「看起来大概」式猜测。

### 3. 汇报与后续

结论先行，附证据与时间点。若结论是真挂起且需要恢复操作（杀 turn、重启 daemon），这些是破坏性动作：先向用户确认，不擅自执行。

## Gotchas

- **症状**：拿 chat_id 直接 grep 日志内容来「验证」定位 → **做法**：定位只能走 sessions.json 映射链；日志事件结构里没有 chat id 字段，只有消息文本本身带群名时才碰巧命中，不可依赖。
- **症状**：grep session.jsonl.zstd 永远 0 命中，误判「日志丢失」 → **做法**：文件是 zstd 压缩，用 `zstdcat`。
- **症状**：把目录级 CLAUDE.md 注入当用户输入 → **做法**：它在日志里记作无正文的合成 `user/message`。
- **症状**：群里 /plan、/plan off「没生效」 → **做法**：飞书群内斜杠命令不作为命令分发（日志 0 个 command/run），文本直达 agent。
- **症状**：一个群名下多条会话分不清 → **做法**：activeSession 是当前活跃，userSessions 是全部历史，parentSessionKey 指回该群的是从这里 spawn 出去的子会话（脚本输出已标注关系）。
- **症状**：会话 name 显示为「飞书群 oc_…」 → **做法**：这是标题生成降级拿 chat id 兜底，不代表会话异常。
- **症状**：单聊 key 长得像 `feishu:oc_…:ou_…` → **做法**：单聊 key 带 `:ou_` 用户后缀，脚本反查已覆盖，手动拼 key 时别漏。
- **症状**：daemon 日志里搜新增埋点零命中，怀疑「日志被吞」 → **做法**：先核验 daemon 部署新旧（`tail ~/.dsh/feishu-bridge-reload.log` 的最后 reload 轮转戳，对比进程启动时间）——daemon 常比仓库代码旧得多。
- **症状**：bot 会话里用 `ps` / `XPC_SERVICE_NAME` 查 daemon 进程 → **做法**：沙箱拒绝 `ps`、把 `XPC_SERVICE_NAME` 改写成 `0`；用 `launchctl list` 与 `DSH_SESSION_JSONL` / `DSH_HOME`。
- **症状**：降级通知后的会话「上下文丢了」 → **做法**：降级是开新会话，被泄漏的原会话 jsonl 仍完整，按本 skill 定位后 zstdcat 找回。
- **症状**：群名被改成与该群任务无关的项目主题 → **做法**：daemon stdout.log grep `chat renamed` 定时刻，找紧邻的群名 fork 会话（one-shot，落桶 = 其真实 cwd），看首条消息的摘录段与注入；跑题根因通常是 fork cwd 回退项目基目录 + seed 含糊（指纹表 F）。
- **症状**：某项目桶里出现别的群的一次性 fork（渲染/群名）会话 → **做法**：不代表该群属于此项目；归属以 fork 首条消息里的会话 key / html_path 为准（指纹表 F）。

## 维护

排查中撞到新指纹或新坑：指纹回填 `references/triage-fingerprints.md`，坑按「症状 → 做法」格式回填本节。

已知未覆盖：chatroom 讨论群的 ledger 数据定位（feishu-bridge-sessions 下见 `…chatroom-ledgers-…` slug，机制未实测）。
