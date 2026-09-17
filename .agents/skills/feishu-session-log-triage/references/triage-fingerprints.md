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

### G 子任务后台任务随 epoch 收尾团灭（2026-09-06 实测，已修 dev@c48b659543 + chatroom 监督网）

- **症状**：chatroom/子任务的研究数据管线整体停摆——子任务数据文件与日志的 mtime 精确停在其 turn/end 时刻；research 目录零活进程；会话日志无任何挂起（最后事件是 `turn/end completed`）；无限流痕迹（无 -32001/429）；journal 在停摆时刻仅有 `subtask: native child reported to parent`。
- **根因（修复前指纹）**：native 子任务回合结束 → 静默判定 `settled` → dispose AgentHandle → jobs seam 的 owner-disposal 语义取消其全部存活后台任务；而子任务的计划恰恰依赖该任务的完成通知续命。上游再叠「数据管家一次性自动回报被进度消息消耗 + moderator 被动散文等待」→ 整条唤醒链断、房间冻结在 discussing。
- **修复后判别**：子任务拥有 live（running/stopping）任务时不 settle（`continuation.ts` stateOf）；chatroom hub↔管家关系静默超过 `assistantStallSec`（默认 1800s）会被监督网唤醒 moderator，journal 出现 `chatroom: supervisor woke stalled moderator`，三次无进展熔断为群内可见通知。部署后遗留冻结房间在首个扫描周期自动被捞起。

### H 追问卡登记后随 stop 丢失（2026-09-08 实测，已修）

- **症状**：turn 收尾的问题卡片（closing-card ask 转非阻塞追问卡登记）没发出来；此前用户在执行中发过消息（收到 📬 排队回执、队列接管），随后任意走 `stopInteractiveSession` 的路径打断接管 turn——/stop、/new、/switch、Provider 卡片热切换等都算。
- **日志形状**：journal 有 `engine: closing-card ask converted to followups`，但始终没有 `engine: followups card sent`；turn/end 序列 = 完成 turn（队列非空，按设计跳过投递、登记保留）→ 接管 turn `aborted/user` + `stopping interactive session`。触发动作若是卡片按钮（如 Provider 热切换）在群消息历史里不可见，别只找文本命令。
- **修复后判别**：`stopInteractiveSession` 拆除前会抢救投递存活登记；修后若仍丢，查 `followups card send failed` 告警（发送失败不重试）。

### I 群名长期停在占位名「<bot> 副本 / 分支」（2026-09-11 实测，已修 dev@c173afa7ec）

- **症状**：spawn 出来的群（`/spawn`、`/fk`、subtask）群名始终是「<bot> 副本」或「<bot> 分支」，从未变成任务主题；群内一切正常，只是名字不动。
- **定位**：stdout.log 搜该群 chat id——应有 `spawned group chat (chat_id …, group_name <bot> 副本, mode group)`，紧随（数秒内）一条 `group-name: skip auto rename, ambiguous first message (<sessionKey>)`，此后该群**再无** `chat renamed` 行。会话日志首条 `user/message` 是含糊开场（`hi`、`在吗` 等 <4 runes，或 继续/ok/好的 类 nudge）。
- **根因（修复前指纹）**：idle spawn 以占位名建群、靠「首条消息」自动改名；含糊种子 guard（`isNameableGroupNameSeed`：<4 runes 或 nudge 词表）跳过首条时**同时作废了唯一的命名机会**（触发条件为「会话窗口还没有轮次」）。guard 判定本身正确（防跑题），缺陷在「跳过 = 永久放弃」。
- **修复后判别**：命名机会改为「会话标签仍是占位名」期间持续有效，含糊消息只跳过自己；卡片回执（审批/追问/followup）不参与命名；同群命名查询互斥。修后仍不改名按序查：①该群会话标签是否被 `/new` 重置（重置后不再是占位名，判据随之失效）；②bot 名是否变更（老占位名失配 → 保守拒绝）；③stdout.log 是否仍打 skip 行（说明首条之外的消息也未达门槛）。详见 Agent Note `.agents/notes/implemented/bug-fix/2026-09-11-feishu-bridge-groupname-opportunity.md`。
- **自愈**：在群里发一条有内容的消息（≥4 字、非「继续/ok」类）即触发改名；想立刻改就 `/rename <名字>`。

### J 子任务回合死于限流预算耗尽（429 风暴，2026-09-14 实测）

- **症状**：父 agent 的 `feishu_bridge_subtask` gather 回报里出现「⚠️ 子任务失败（error），未完成」。两种形态：mycontext 型——完全无收尾输出（死得早，没攒下东西）；mico-im 型——留有部分轨迹（死前最后的文本/工具结果出现在失败摘要里）。
- **日志形状**：子任务自己的会话日志 `turn/end` 的 `data.reason` 为 `{kind: 'error', error: {code: 'RATE_LIMIT', message: '429 …'}}`；死前是一串 `llm/retry` 事件，`retry` 计数递增到 `maxRetries` 顶格、`failure.code` 全部 RATE_LIMIT（退避 800ms 起步指数爬坡到 maxDelayMs）。`policyKey` 字段直接读出当时生效的预算（如 `["normal",8,[…],800,30000,0.3]` = 8 次/110 秒）。
- **定位子会话**：子会话目录名 = 子任务 uuid（父会话日志里 spawn 的 tool/result 或 gather 摘要可拿到），桶名 = 子任务 cwd 的 mangle：`find ~/.dsh/feishu-bridge-sessions -type d -name "<uuid>"`。locate-session.py 只按群 chat_id 定位，不覆盖子任务。
- **根因模式**：多路子任务扇出 + 同窗口其他会话共享同一 provider key（本次 5 子任务 + 2 个计划渲染 one-shot = 7 路并发，429 合计 414 次）；限流窗口持续到并发压力消散（约 9 分钟），长于重试总预算 → 预算耗尽判死。谁死谁活取决于哪一步落进长窗口。
- **判死机制**：预算耗尽后 waterfall 落到默认动作抛 `LlmError`，`turn/end` 记 error——不是 watchdog 杀（那会是 aborted/disposed，走指纹 B/E）；重试期间 llm/retry 事件持续刷新活动时钟，不会触发 stall。
- **恢复**：子会话判死后仍存活、上下文完整保留（变 idle）；父 agent 用 `feishu_bridge_subtask` 的 send 发一条继续指令即唤醒，turn 2 从断点续跑。并发压力下降后（其他子任务完成）重试成功率自然恢复。
- **防线状态核对**：看子会话 `llm/retry` 事件里的 `policyKey`——判死时预算是否与 profile 配置一致（不一致说明 daemon 还没 /reload 新配置）；2026-09-14 配置落盘 15 次/60s 帽（总预算 ≈10 分钟，reload 生效后），若新事故仍判死，说明窗口 > 10 分钟，去 `.agents/notes/proposed/architecture/` 找 slowPhase 提案。

### K 答非所问 = 生成失控（正文混入 / 自导自演对话，2026-09-14 oc_7cc5d 实测）

- **症状**：agent 最终回复与本会话内容毫无关系——要么整段是另一话题的完整专业解答（用户直接问「你为什么回复我这个？」），要么交付物是自己幻觉出来的任务产物（如一份没人要的「用户协作备忘录」）。
- **两种形态（同一故障族：GLM-5.3 超长上下文生成失控，与思考复读同族，正文侧新形态）**：
  - **K1 正文域漂移**：`assistant/message` 的 reasoning 块正确响应上一条反馈、text 块却是无关领域的完整解答（实测：reasoning 在分析「去掉草稿反馈回流」，text 是 Java Thymeleaf/Joda 问答）。reasoning/text 分裂是决定性指纹。
  - **K2 对话幻觉**：单条超长生成（实测 45k 字符）里伪造多轮「你说：…」用户追问并自问自答，末尾自我委托一个任务（「生成协作备忘录」）并真实执行（memory_write 已落盘才暴露）。
- **取证法（先排除上下文污染再归因生成侧）**：①全事件类型（含 system/message、request/context、tool/call、relay 转发）grep 混入内容的关键词——零来源即排除「plan 多版本/记忆注入/调研报告把内容带进来」；②`usage.inputTokens` 看规模（实测 186k / 310k）；③`request/header` 看 model 与 reasoningEffort（实测 glm-5.3 + max）；④伪造用户轮验证：幻觉里的「用户原话」在真实 `user/message`（`source.kind=="user"`）与 exit_plan_mode 评审反馈的 tool/result 里均零命中。
- **危害不止答非所问**：失控回合里的工具调用是真的——实测把基于幻觉对话的记忆写进了全局记忆并登记索引。收尾须排查污染（删文件+删索引行；全文可从该回合 memory_write 的 tool/call 参数找回）。
- **恢复**：续用该会话有复发风险（失控上下文仍在模型历史里）；建议 /new 重开。伪造对话轮/域漂移的中流检测属 harness 防线缺口，未立项。

### L 进度卡实时播报出现推敲正文 = 回放跨模型迁移环（2026-09-14 oc_084673f 实测，已修 e794e670c2）

- **症状**：tool process 卡（进度卡）「实时播报」区出现大段推敲式正文——自我演算（「等一下 —— gate 底部 = 230+68 = 298」式）、构建方案的草稿、验证失败分析——而非短状态句；最终回复本身往往正常。轮数少的会话干净，长会话逐渐恶化（反馈环需累积）。与 K 的区分：K 是内容无关/伪造对话；本指纹是推敲内容**正确但出现在错误通道**（text 而非 reasoning）。
- **机制（已修）**：回放历史给 assistant 消息盖「网关回报的裸模型名」（`glm-5.3`），而请求用的是带厂商前缀的路由名（`zhipuai/glm-5.3`，mify 强制）→ pi-ai `transformMessages` 判跨模型 → 历史 thinking 块全部转成 text 回传（签名在也照转）→ 模型看到自己过去的推敲全是正文，学着写正文 → 完成块整块上卡（显示层既有设计，不是显示 bug）。
- **取证法**：①逐 assistant/message 统计块结构：reasoning 块是否在某步后整体消失、text 块是否出现 >2000c 且后跟 tool-call 的推敲块；②**签名查 `source.replayState.blocks[].thinkingSignature`，不在 content 块**（content 的 reasoning 块只有 text 字段——09-10 曾因查错位置误诊「无签名」，签名其实一直在）；③修复验证锚点：live 配置 mify-dsh 路由应有 `replayModelIdentity: requested`（2026-09-15 07:12 起），daemon 构建应 ≥e794e670c2。
- **判复发先排存量污染**：修复前旧会话的历史里已写进正文的推敲块不会消失，旧会话续聊可能仍被存量样本带偏——**判复发必须用新开会话**。新会话仍泄漏才查：构建新旧（reload.log）→ 配置在否 → 该会话 replayState 签名链与 midturn 大文本块。
- **根因与修复全程**：`packages/llm/llm-pi-ai` Agent Note `2026-09-14-replay-requested-model-identity`；回滚 = 删配置里 `replayModelIdentity` 一行再 reload。

### M 完成卡迟到 ~30 分钟、时间戳=出现时刻 = 后台计数泄漏（2026-09-17 oc_f85284 实测，已修 102c4a3fa3 + ea562383ba；重复卡面 f72b7dd4e9、僵尸形态锚定见 2026-09-17-finished-at-anchor note）

- **症状**：回合早已完成（会话日志 `turn/end completed` 后再无事件），群里数十分钟后才冒出一张绿色「执行完成 · HH:MM:SS · N」卡，时间戳正是冒出时刻——读起来像迟到的完成通知；N 是该回合的工具数。
- **机制（已修）**：`run_in_background` 启动 + 同回合 `job_output(wait:true)` 领取 → tool-jobs 抑制完成通知（wait 已交付终态）→ 引擎后台计数无递减路径 → 泄漏计数把完成卡压满 30 分钟宽限 → 耗尽善后清提示时定稿卡早已被摘句柄，`flushLocked` 的 no-handle 分支无条件**新开一张卡**把整份定稿内容重发（f72b7dd4e9 已修：终态预览拒绝开新卡）；旧版标题时间戳取渲染时刻，造成「迟到通知」假象（ea562383ba 冻结后不再）。同后果的第二种形态：通知已投递、被唤醒回合消化，但 `reported` 不因投递翻转，旧探针把该 job 永久计为「在途」，对账同样退 30 分钟兜底、💡 行常驻定稿卡（finishedAt 锚定修复，Agent Note `2026-09-17-feishu-bridge-bg-reconcile-finished-at-anchor`）。
- **取证**：daemon stdout.log 搜 `grace exhausted`（旧版指纹）或 `background count reconciled away`（修复后新日志行 = 对账清理泄漏计数，非故障）；会话日志看该 turn 的 `tool/call` 是否 `run_in_background` + `job_output` 同回合配对。
- **修复后判别**：泄漏计数（含「通知已投递未领取」僵尸形态）约 1–2 个 idle tick 内被对账清（reader 以 `bgWaitStartedAt` 为锚，首个 tick 只设锚点）；结算前对账让注册表无法佐证的计数不进终态卡，💡 行不再常驻；终态卡时间戳冻结为定稿时刻且不再新开第二张。`grace exhausted` 仍会在「通知真在途却超时」场景出现，属既有宽限语义，非本指纹。

## 审批事件判别（卡片没弹 / 反复要授权）

- 会话日志事件 `approval/asked` → `approval/decided` 的**时间差**：秒级/分钟级 = 真弹卡等用户点击；0–1ms = 被常设授权短路放行。两种情况日志事件形态相同，只有时间差能区分。
- 「全准后同工具不再弹、换工具又弹」= 上游设计：常设授权按 (agent, toolName) 记忆，不是授权丢失，不必重查。

## daemon 日志位置与时段切分

- 本机（macOS）：`~/.dsh/feishu-bridge-stdout.log` 与 `~/.dsh/feishu-bridge-stderr.log`（历史轮转为 `.old-<时间戳>` 后缀）。
- dev 服务器：journalctl（systemd 托管）。
- **多数日志行不带时间戳**：用 `~/.dsh/feishu-bridge-reload.log` 的最后 reload 轮转戳 + `.old-` 轮转文件名切定时段，再与会话日志事件的 `time` 字段对齐。
- **零命中先查部署新旧**：`tail ~/.dsh/feishu-bridge-reload.log` + 进程启动时间对比——daemon 常比仓库代码旧得多，新埋点零命中多半是没部署，不是日志被吞。（注意：reload.log 只由群内 `/reload` 命令写入，shell 直跑 reload.sh——含 `FB_RELOAD_FROM_DAEMON=1 systemd-run --user --scope` 逃生路径——不写；此时以 `systemctl --user show feishu-bridge -p ExecMainStartTimestamp` 为准。）
- **区分 in-process 全量重载与真重启**：日志里连续 `ws client closed manually (force)` 且无 systemd `Stopped` = in-process 重载（常由 profile 文件被热编辑触发，用 profile mtime 对齐时刻）；出现 `Stopping` / `Started` = 真重启。

## 常用统计管道

- 事件按类型计数：
  `zstdcat <log> | python3 -c "import sys, collections, json; c = collections.Counter(json.loads(l)['type'] for l in sys.stdin); [print(f'{n:6}  {t}') for t, n in c.most_common()]"`
- 最近 N 个事件的类型与时刻：
  `zstdcat <log> | tail -50 | python3 -c "import sys, json; [print(json.loads(l).get('time'), json.loads(l)['type']) for l in sys.stdin]"`
