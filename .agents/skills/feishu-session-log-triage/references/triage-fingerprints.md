# 故障指纹表（会话日志排查）

先抽一两行样本确认结构，再按指纹对号。字段名均实测自 session.jsonl.zstd（2026-09-03）。

## 事件结构速查

- 每行一个 JSON 事件：`type` / `seq` / `time`（ms epoch）/ `data`。
- 首行 `type: session`，带 `id`（agentSessionID）、`cwd`、`createdAt`。
- 用户消息：`type: user/message`，正文在 `data.content[].text`（数组，text 项的 `text` 字段）。
- 工具调用：`type: tool/call` 与 `type: tool/result`。
- 回合边界：`type: turn/start` / `type: turn/end`，结束原因在 `data.reason.kind`。

## 指纹

### A 真挂起（挂在工具上）

- **日志形状**：`turn/start` 后长期无新事件，且没有对应 `turn/end`。
- **判别**：看最后一条 `tool/call`——交互类工具（如 ask_user_question）是在等用户，不是故障；其他工具长期无 `tool/result` = 挂在工具执行上。
- **验证命令**：`zstdcat <log> | grep 'tool/call' | tail -3`、`zstdcat <log> | grep -c 'turn/end'`。

### B watchdog 强杀

- **日志形状**：`turn/end` 的 `data.reason.kind` 为 aborted / disposed 类值（相对 interrupted「用户打断」）。
- **佐证**：daemon stdout.log 里的 watchdog 日志，与强杀时间点对得上。

### C 卡片降级冻结（假卡死，最易误诊）

- **日志形状**：turn 活跃（tool/call、叙述文本连续出现）但群里卡片停在某一时刻。
- **验证**：daemon `stdout.log` 搜 `230020`（卡片 PATCH 被飞书单消息 5 QPS 限流）；`stderr.log` 搜 `too many consecutive async update failures, degrading`。降级后该 turn 其余时间的卡片更新被跳过。
- **预期行为**：修复后的限流应表现为 rewind + 重发（卡片短暂滞后），不再冻结；若仍冻结，按本指纹上报缺陷。
- ⚠️ 会话日志活跃 ≠ 群里可见。先排除本指纹，再诊断「agent 卡死」。

### D 回合结束原因速判

`zstdcat <log> | grep 'turn/end' | tail -20` 看 `reason.kind`：completed 正常；interrupted 被打断；aborted / disposed 走指纹 B 与 E。

### E stall 盲杀与降级（daemon 活着但 turn 被反复杀）

- **用户侧**：「💀 Agent 长时间无响应（200 无输出，已重试 3 次均失败）」「⚠️ 会话恢复失败：已降级为全新会话」。
- **stdout**：连续 `stall retry: restarting with re-injected env resume=...`，且重试间隔精确等于 stallTimeoutSecs（盲杀节拍指纹）。
- **stderr**：`session resume failed ... while it is live`（live-guard 泄漏，resume 被拒）。
- **会话日志**：`turn/end` reason 为 aborted / disposed，且包括模型仍在正常出流的 turn。
- **后果与补救**：降级 = 开全新会话丢上下文；被泄漏的原会话 jsonl 仍完整，按定位链找到后 zstdcat 可找回。恢复操作（kickstart 重启等）先向用户确认。

### F 群名跑题 / 一次性 fork 落错桶（2026-09-03 实测）

- **症状**：群名被 LLM 改成与该群任务无关的项目主题（如 deepseek-harness 的群被改成「mem0 记忆服务开发」+ database 图标）；或别的群的渲染/群名 fork 会话出现在某项目桶里。
- **定位**：daemon stdout.log 搜 `chat renamed` 拿改名精确时刻（紧随的 `group icon avatar set` 同源）；改名前 1–3 秒会有一个 one-shot fork 会话落在**其真实 cwd 的桶**——读它的首条 user/message：开头是「你是一个群聊名 + 图标生成器」即群名 fork；摘录段只有含糊词（如「继续」）而注入上下文来自别的项目 = 实锤。
- **根因（修复前指纹）**：one-shot fork（群名/渲染/标题/预测）的 cwd 回退项目基目录，不认聊天 `/dir` override；群名 seed 含糊时 LLM 按注入上下文起名。
- **归属判别**：会话属于哪个群看 fork 首条消息里的群名/会话 key/html_path，不看所在桶。

## 审批事件判别（卡片没弹 / 反复要授权）

- 会话日志事件 `approval/asked` → `approval/decided` 的**时间差**：秒级/分钟级 = 真弹卡等用户点击；0–1ms = 被常设授权短路放行。两种情况日志事件形态相同，只有时间差能区分。
- 「全准后同工具不再弹、换工具又弹」= 上游设计：常设授权按 (agent, toolName) 记忆，不是授权丢失，不必重查。

## daemon 日志位置与时段切分

- 本机（macOS）：`~/.dsh/feishu-bridge-stdout.log` 与 `~/.dsh/feishu-bridge-stderr.log`（历史轮转为 `.old-<时间戳>` 后缀）。
- dev 服务器：journalctl（systemd 托管）。
- **多数日志行不带时间戳**：用 `~/.dsh/feishu-bridge-reload.log` 的最后 reload 轮转戳 + `.old-` 轮转文件名切定时段，再与会话日志事件的 `time` 字段对齐。
- **零命中先查部署新旧**：`tail ~/.dsh/feishu-bridge-reload.log` + 进程启动时间对比——daemon 常比仓库代码旧得多，新埋点零命中多半是没部署，不是日志被吞。
- **区分 in-process 全量重载与真重启**：日志里连续 `ws client closed manually (force)` 且无 systemd `Stopped` = in-process 重载（常由 profile 文件被热编辑触发，用 profile mtime 对齐时刻）；出现 `Stopping` / `Started` = 真重启。

## 常用统计管道

- 事件按类型计数：
  `zstdcat <log> | python3 -c "import sys, collections, json; c = collections.Counter(json.loads(l)['type'] for l in sys.stdin); [print(f'{n:6}  {t}') for t, n in c.most_common()]"`
- 最近 N 个事件的类型与时刻：
  `zstdcat <log> | tail -50 | python3 -c "import sys, json; [print(json.loads(l).get('time'), json.loads(l)['type']) for l in sys.stdin]"`
