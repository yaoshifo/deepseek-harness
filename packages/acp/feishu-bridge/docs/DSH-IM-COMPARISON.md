# feishu-bridge × dsh-im 对照调研（可借鉴项与不建议项）

> 2026-09-12 落盘。来源：两轮只读调研（9 个子任务，覆盖架构分层 / 投递可靠性 / 会话与状态 / 测试工程 / 产品面 / 超时与长任务 / 入站消息 / 审批交互，其中一轮为**对抗性核实**——专门以推翻既有结论为目标）。
>
> 对照对象：`@xmanrui/dsh-im` v4.20.1（本地 `/Users/hm/workspace/dsh-im`，commit `8850276`），一个成熟的开源多渠道 IM 桥接插件（13 渠道 / 182 个测试文件 / 30+ 篇方案与实测记录）。本插件为单渠道（飞书）fork-local 插件。
>
> **本文是调研记录，不是实施计划。** 所有结论按「已核实 / 部分成立 / 不成立」标注并可回溯到两侧源码位置；被推翻的结论保留在 §1 台账中。行号与定量数字基于两侧钉定快照——dsh-im 侧 commit `8850276`，本仓侧 `c3e4612d9d`（本文落盘提交）——后续改动会使行号漂移，检索时以函数名/日志串为准；本仓数字已随后续提交变化（如能力接口 101→102、守卫 64→65），引用现值须自行重数。
>
> 相关文档：[MIGRATION.md](MIGRATION.md)（迁移背景与架构决策）、[OPERATIONS.md](OPERATIONS.md)（部署运维）、[FEATURE-PARITY.md](FEATURE-PARITY.md)（cc-connect 功能对照）、[DEBAGGAGE-ROADMAP.md](DEBAGGAGE-ROADMAP.md)（去包袱路线图）、[PROGRESS-CARD-AUDIT.md](PROGRESS-CARD-AUDIT.md)（进度卡实现审计——其 F1/F2/F4 与本文 §3.2/§4.2 的节流与终态卡表述相关，见各处交叉引用）。

## 0. 一句话结论

**dsh-im 最值得借鉴的不是它的任何功能，而是它坚持的一条原则：投递结果必须回灌到用户可见状态。** 具体表现为三处做法——(a) 发送结果区分「确定成功 / 确定失败 / 结果未知」，未知时不再重试并告知用户；(b) 超时只"停等"不"杀回合"，回合跑完后从会话历史捞回答案补投；(c) 引用他人文本时用不可伪造的包裹标签并加长度上限。

对应到本插件，是三个已核实的真实缺口：**说完成但可能没送达**、**重试可能重复发**、**超时直接丢答案**。

反之，**架构层面不需要向 dsh-im 学习**：本插件的分层（中性 Platform 接口 + 中性卡 IR + 渠道渲染器）比 dsh-im 更干净，dsh-im 的架构 ADR 所主张的"能力矩阵"在它自己仓库里也没有落地成代码。

---

## 1. 方法与可信度

### 1.1 调研方式

两轮共 9 个子任务，全部为只读调研（读源码、grep 验证、不修改任何文件）：

| 轮次 | 覆盖方向 |
|---|---|
| 第一轮 | 架构分层与语义核心 / 出站投递可靠性 / 会话·工作区·多机器人·配置 / 测试体系与工程化 / 产品能力面与配置形态 |
| 第二轮 | 超时与长任务的结果保留 / **对抗性核实（8 条既有结论）** / 入站消息（图片·文件·引用·批量）/ 审批·提问·交互确认 |

第二轮新增对抗性核实环节：把第一轮产出的待写入计划的结论交给独立子任务，**明确要求以推翻结论为目标**，逐条独立读码复核。

### 1.2 对抗性核实台账（8 条结论的最终判定）

这一节是本文最有价值的产出之一：**第一轮结论中有 5 条被夸大或写反**。若不核实就照着改代码，会做出错误的修改。

| # | 第一轮结论 | 判定 | 修正后的准确表述 |
|---|---|---|---|
| 1 | `project-state.ts` 的 `save()` 写盘失败只 `console.error` 不上抛，内存与磁盘静默分叉 | **成立** | 成立，但风险表述要改：因每次整文件重写，实际后果是「最后一次写盘失败 → 重启回退到上一次成功快照」，且用户已收到成功 ack。修法应收窄——只对 EACCES/EROFS 类永久错误做一次性提示，瞬时失败由下次 save 自愈 |
| 2 | `load()` 遇损坏 JSON 静默从空态开始，丢光所有按群覆盖 | **部分成立** | "静默"不准确（有 `console.error`）。真正的风险是**下一次任意 save 会用空态整文件覆盖原文件**，且 `state.json` 无任何备份。另有字段类型不校验的问题（`provider_overrides` 为字符串时 `{...'x'}` 生成下标键）。修法有同仓现成范式可抄 |
| 3 | `formatReplyChain` 把被引消息原文无长度上限地拼进前缀，且该前缀进模型输入 | **部分成立** | 对**单条**被引正文确实无上限；但**条数**有硬上限 5。影响路径需修正：监控群在 `extraContent` 合并之前就分流，前缀不进 triage prompt；唯一路径是 `/learn` 把内容存成示例后被原样注入 |
| 4 | 发送重试把"投递后症状"当可重试，最多 4 次，有重复消息风险 | **成立（前提写反）** | 结论成立，且**前提完全写反**：飞书 `im/v1` 的 create/reply **支持** uuid 幂等去重（SDK 类型里就有），是本插件从不传，才等于没有服务端去重。次数确为最多 4 次（`maxRetries=3`），且可重试集合含桥**自己合成**的 `context deadline exceeded`。修法因此极简 |
| 5 | 发送结果未知时用户得不到任何提示 | **成立** | 成立于答案正文；提示能力在同仓已存在（交付物读失败、旁路提问超时各有专门文案），可与 #6 用同一处改法 |
| 6 | 完成卡无条件打 ✅，即使消息发送失败 | **部分成立** | "无条件"与"✅"都不准确：error 回合是红 failed、max-tokens 是橙 truncated，卡片头无字面 ✅。准确表述是**「答案是否送达」完全不是终态输入**——正文投递失败被吞掉后进度卡仍 finalize 绿"执行完成"、完成卡照发 |
| 7 | 卡片降级为纯文本的兜底路径自身失败时无任何提示 | **成立** | 成立，且最坏情形要写明：`fallbackSend` **先删掉冻结卡再投递**，失败则卡片消失且答案彻底收不到 |
| 8 | `install.sh` 零测试 | **成立** | 成立（全包 grep 仅命中两份文档，`tests/` 与 `src/` 零引用，亦无 shellcheck 门禁）。附录：`install.sh:6-9` 注释称 cordis.patch.yml "NEVER written"，与 `:19-25` 的实际行为不一致 |

### 1.3 同时被推翻的架构假设

第一轮曾假设"本插件缺少渠道抽象层，应向 dsh-im 学习分层"。**该假设被调研推翻**：本插件的分层实际上比 dsh-im 更干净（详见 §2）。这一条推翻了整个"架构重构"方向。

---

## 2. 架构分层对照

**结论：本插件的分层更干净，不需要引入 dsh-im 的架构。**

### 2.1 dsh-im 的"语义核心"实态

其 ADR（`docs/adr/0001-semantic-core-native-channel-adapters.md`，状态 accepted）主张"统一语义核心 + 渠道原生适配"。但落地实态是：

- 语义核心**不是集中在 `semantic/` 目录**（该目录仅 4 个文件：`artifact` / `artifact-delivery` / `delivery` / `reply-reference`），而是整个 `src/channels/shared/`（65 个 `.mjs` / 15,422 行，含 semantic/ 与 i18n-en/ 子目录；实测于钉定 commit）。
- 契约由四件事表达，而非显式接口：①注入闭包 + `typeof` 探测（`semantic/artifact-delivery.mjs:41,54`、`text-harness-bridge.mjs:550,553`）②带 `schemaVersion` 的冻结数据对象（`semantic/delivery.mjs:1,130`）③错误码词表（`delivery.mjs:6-16`）④可选渠道渲染钩子（`harness-approval.mjs:251-253`，飞书卡片按钮走此路）。
- **ADR 声称的"能力矩阵"没有落地文件**——`grep capabilit` 的代码命中（office 渠道 `capabilities()` 心跳协商、repair capability 命名）均非降级矩阵；降级规则靠每个调用点手写（`text-harness-bridge.mjs:83-117` 按渠道 key 分支）。
- 配比：核心 13.9k 行 : 各渠道 39.8k 行（飞书渠道自身 11.9k，为最大）；最小契约面 = `descriptor{key,label,reactions}` + `bot{sendText 必需；sendImage/sendFile/sendDelivery/openDeliveryStream/openStream/sendTyping 可选}` + `harness` + `state`（`text-harness-bridge.mjs:135-172`）。其杠杆来自 5 个纯文本渠道共用一个 bridge（`telegram/telegram-bridge.mjs` 全文仅 16 行）。

### 2.2 本插件的分层实态

`src` 共 51,459 行（engine 42 文件 / 25,512；feishu 15 文件 / 8,372；顶层 6,465；余 agent-dash/core/context/i18n/tools/markdown 等目录 11,110）。已有结构：

- `src/core/types.ts:392` 起：中性 Platform 基接口 + 101 个可选能力接口 + 64 个 `asXxx` 结构守卫
- `src/card.ts`：中性卡片中间表示（IR）
- `src/feishu/card.ts`：`renderElement` → `FeishuCardMap` 的渠道渲染器
- **`engine → ../feishu/` 仅 2 处 import**（`engine.ts:23` 的 AllowList、`status-footer.ts:20` 的 BoundedMap；同类反向依赖共 6 处，逐条见 §2.3）

即 ADR 主张的"核心表达语义、渠道适配器原生呈现"在本插件**已经实现**，且实现得比 dsh-im 更显式（有真实接口与守卫，而非 `typeof` 探测）。

### 2.3 确属写错层的同类项（范围外的技术债，共 6 处）

| 处 | 现象 | 影响 |
|---|---|---|
| `src/feishu/platform.ts:3503` | 在该文件定义 `BoundedMap`，却被 `src/engine/status-footer.ts:20,339`（git 分支缓存）反向 import | engine→feishu 的 import 之一（另一处为下条 AllowList）；接第二渠道时多一处反向依赖 |
| `src/engine/engine.ts:23` | import `feishu/allowlist.ts` 的 `AllowList`——准入门面属渠道中立逻辑，却放在 feishu/ 且被 engine 反向依赖 | §2.2「仅 2 处」的另一处（本表初版漏列）；与 BoundedMap 同类 |
| `src/feishu/platform.ts:133` | 定义引用串格式，`src/engine/monitor.ts:443-450` 反向反解析该格式 | 跨层格式耦合（非 import）；多条链时静默返回整段 blob（详见 §6.4） |
| `src/streaming.ts:34` | import `feishu/markdown.ts` | 通用流式层知道飞书排版细节；17/42 个 engine 文件依赖 card/streaming |
| `src/markdown/markdown-html.ts:10` | 通用 markdown→HTML 转换器（自述面向 HTML 受限平台）import `feishu/markdown.ts` 的 `FenceTracker`；生产路径在用（`engine/plan-render.ts:41`） | 与 `streaming.ts:34` 同类：通用层依赖飞书排版模块内部 |
| `src/context/render.ts:23` | `/context` 命令的飞书卡渲染器 import `feishu/card.ts` 的 `renderCardMap`，却放在通用命名的 `context/` 目录 | 放置错位（文件本身飞书专用）；接第二渠道时需挪位或分目录 |

### 2.4 真正的巨兽

`src/engine/engine.ts:987` 起的单个 `Engine` 类：**8,200 行 / 252 个成员**。按特性（cron / monitor / subtask / plan）拆分是合理的；**按渠道拆是错的**（单渠道插件，且分层已经就位）。

---

## 3. 投递可靠性与故障恢复对照

这是 dsh-im 相对领先最多、也是本插件历史事故最集中的面。

### 3.1 dsh-im 的机制

- **三态回执**：`src/channels/shared/semantic/delivery.mjs:116-139` 定义 `receipt{providerMessageIds, deliveryOutcome: sent|failed|unknown}`；判据见 `message-failure.mjs:217-229`（401/403 → permission、429 → rate-limit、其余默认 **uncertain**）。
- **重试边界**：`telegram-api.mjs:383-400`——fetch 抛错 / 超时 / 响应后解析失败 → `unknown`；明确的 HTTP 或业务错误码 → 确定失败。
- **未知不重试**：`deferred-delivery-coordinator.mjs:165-174`——`unknown` 标记为 `failed/deliveryOutcome:'unknown'` 并停手；用户侧文案 `message-failure.mjs:85-86`「结果未能确认……不要立即重复提交」。
- **补发不重放**：幂等 id `${key} ${sessionId} ${turn|promptRpcId}` + `afterSeq` 水位 + `attempts≥3` 停止（`deferred-delivery.mjs:112-126`）；持久 outbox 落在渠道 state 的 `deferred` 字段（`deferred-state.mjs:17-52`）；启动 / `onReconnect` / turn-end 三处 resume（`coordinator.mjs:181-197`）；`bound()` 防会话改绑后误发（`:42`）。
- **超时不杀**：`harness-client.mjs:1611-1627`——无进展**且** `isSessionRunning=false` 才判超时。

### 3.2 本插件现状（含"已更强"的部分）

**已具备且更强**：

| 能力 | 落点 | 说明 |
|---|---|---|
| 节流与抖动合并 | `src/streaming.ts:67-75`、`:514`、`src/feishu/platform.ts:654`、`src/async-sender.ts:60-70` | 800ms + minDelta 15 + maxChars 2000 + 进度 300ms + 每实例 `TokenBucket(200ms,3)` + 队列合并。**限定**：三个旋钮仅作用于 progressMode 之前的文本窗口，进度路径是固定 300ms 节流且无最小增量门槛（[PROGRESS-CARD-AUDIT.md](PROGRESS-CARD-AUDIT.md) F1/F4），「≥ dsh-im 的 800ms 单飞」仅覆盖早期文本阶段 |
| 230020 限流处理 | `src/feishu/retry.ts:118-120`、`src/streaming.ts:903-910,938-941` | 已判为 transient 且**不计入**降级计数；dsh-im 相应文件反而无错误码感知 |
| 终态不丢弃 + 终态前排空在途 PATCH | `src/async-sender.ts:130-138`、`src/streaming.ts:1020-1022,1948-1958` | — |
| 熔断后整条重发 | `src/streaming.ts:1773-1788` | 删冻结卡 → `deliverAnswer` |
| 入站去重 | `src/dedup.ts:10,17,54-56` | 内存 TTL + LRU，与 dsh-im 大体相当 |
| 通道异常退出/插件重载分片补投 | `src/engine/engine.ts:4298-4373`（`:4359-4372` 为范式） | **已存在"部分答案投递"范式**，是后续改动的可复用资产 |

**缺口**：

| 缺口 | 证据 | 说明 |
|---|---|---|
| 无投递三态 | 全仓 grep `receipt` / `deliveryOutcome` / `unknown` 零命中 | 失败只 `console.debug`（`src/engine/engine.ts:1911-1926`）或 `console.warn`（`src/streaming.ts:1768`） |
| **uuid 幂等未使用** | SDK 支持：`node_modules/@larksuiteoapi/node-sdk/types/index.d.ts:264216-264222`、`263899-263911`；本插件 `src/feishu/platform.ts:3638-3651` 未传 | 重试致重复消息的真实成因 |
| 投递后症状被当作可重试 | `src/feishu/retry.ts:17-23`（maxRetries=3，共 4 次尝试）、`:126-132`、`:156-158` | `context deadline exceeded` 是桥**自己合成**的 30 秒单次期限；超时时请求可能已投递成功 |
| 终态与投递结果脱钩 | 终态只看 `errorText`（`src/engine/engine.ts:3987`）；进度卡 finalize 绿 `src/feishu/progress.ts:141-144`；完成卡 `src/engine/engine.ts:4198-4227` | 见 §1.2 #6 的准确表述 |
| 降级兜底失败静默 | `src/streaming.ts:1748-1771`（`deliverAnswer` 返回 void）、`:1778-1788`（`fallbackSend` 先删卡再投递） | 最坏：卡片消失且答案彻底收不到 |

---

## 4. 超时与长任务

### 4.1 dsh-im：客户端停等 + 完成即补投

时间线（`docs/deferred-delivery.md` 为正式特性文档）：

| 阶段 | 行为 | 证据 |
|---|---|---|
| t0 | 前台等待一窗 600s（`HARNESS_REPLY_TIMEOUT_MS`） | `harness-client.mjs:1394` |
| t1 | 每 300ms 轮询会话历史，唯一进度信号 = 事件 seq 前进 | `:1560,1576-1578` |
| t2 | 静默满窗 → 先探活 `isSessionRunning`；仍 running 则**续期**（超时只"停等"，不杀回合） | `:1615,1621` |
| t3 | 确认真超时才抛出，携带 turn / promptRpcId / baselineSeq | `:1624-1627` |
| t4 | 捕获后登记 outbox（含原回复目标） | `workspace-session.mjs:156-164`、`coordinator.mjs:203` |
| t5 | 用户只看到「等待模型回复超时，任务可能仍在运行……不要立即重复提交」 | `message-failure.mjs:39-40,117` |
| t6 | 补发触发 = 启动 / `onReconnect` / turn-end，另每 30s 复查 | `coordinator.mjs:181-197` |
| t7 | 从会话历史捞答案（≤20 页×100）；仅 `reason==='completed' && !interrupted` 算 found；读到截断历史一律判未找到 | `deferred-delivery.mjs:69`、`coordinator.mjs:74,77,110-112` |
| t8 | 按原路由 reply 原消息 → 成功即删记录。**从会话重建答案，不重放请求** | `:147,153` |

放弃条件：换绑 / 会话消失即弃（`:117,124,157`）；发送失败 3 次转 failed（`:175`）；单 key 上限 4，丢最旧。

### 4.2 本插件：超时 = 杀回合

profile 实测参数（`~/.dsh/profiles/feishu-bridge/cordis.patch.yml:218-227`）：stall 600s、重试 3 次、绝对上限 7200s；代码默认 10min / 1 次 / idle×2（`src/engine/engine.ts:203-207`）。

| 路径 | 行为 | 证据 |
|---|---|---|
| 停滞判定 | `stallConfirmed` 用 `lastStreamActivity` 排除"还在流式" | `src/engine/engine.ts:3903-3918`（**与 dsh-im t2 的探活等价，此项已具备**） |
| 停滞重试 | 重启 agent（`--resume`）+ 发「继续」，最多 N 次 | `:3358-3395` |
| 重试耗尽 | 💀 通告 + `markFailed` + 关 agent 会话 + **return** | `:3398-3413` |
| 硬帽 | `hardCapMs = idle×3`（profile 实测 3×7200s）；仅在事件到达时判定，park 时长豁免 | `:3251-3252,3431-3432` |
| 硬帽触发 | ⚠️ 通告 + `markFailed` + 关会话 + **return** | `:3432-3447` |
| 答案去向 | 两条路径都 return，不经过任何 turn-end 投递点；文本只剩卡面播报且**截到 6000 字**（`src/streaming.ts:49,2054-2064`）；`textParts` 随后随 state 删除 | `src/engine/engine.ts:4682-4686` |
| 通告口径 | 反向引导重发：「请重新发送上一条消息」「会话已终止，请 /new」 | `src/i18n/messages.ts:277-278` |
| 补发能力 | **无**：全仓 grep `deferred` / `补发` / `redeliver` / `pendingReply` / `onReconnect` 仅命中 followups 工具，engine 无关键 | `src/engine/engine.ts:5364,5395` |

**已具备、不算缺口的**（避免误判）：

- 通道异常退出 / 插件重载已分片补投已产出内容（`src/engine/engine.ts:4298-4373`）
- errored turn 走 `deliverAnswer` 明文补投（`:4118-4130,4164-4167`）
- stall 重试耗尽后有 ⏹ 卡与「▶ 继续执行」按钮，body 原样保留（`src/feishu/progress.ts:883`、`src/feishu/platform.ts:2224-2233`）
- 引擎主动退出路径（stall 耗尽/硬帽/stop）都有终态卡（`markFailed`/`markStopped`）——「强杀无终态」已修；异常逃出回合循环的三处兜底 catch 只记日志不收尾卡片（[PROGRESS-CARD-AUDIT.md](PROGRESS-CARD-AUDIT.md) F2，机制已核实、触发未复现）
- park 期间不被 idle 杀、不计入硬帽时钟（`src/engine/engine.ts:3284-3285,5532,1429-1436`）
- `markFailedLocked` **已保留**卡面显示（`src/streaming.ts:1872-1907`）——丢的是超出截断的部分与"以消息形式交付"这个动作

### 4.3 勘误

- `src/index.ts:690-710` 现为 config schema，**该处没有 watchdog**；真正的 watchdog 在 engine 循环内（日志串 `src/engine/engine.ts:3433`），包内无进程级 watchdog（重启交由 launchd / `deploy/feishu-bridge.service.template:21`）。
- `freeze()` / `resumeFromFreeze()` 是**死代码**：`src` 内零调用点，仅 `tests/streaming.spec.ts:304,639` 调用。修或删属独立议题。

---

## 5. 会话绑定、工作区与配置持久化

### 5.1 两侧状态格式与恢复路径（均已从代码核实，非推测）

**dsh-im**（per-bot 三份，`plugin-src/host/channels/feishu/production.mjs:80-91,146-150`）：

- `<DSH_HOME>/integrations/dsh-feishu/config.json`（仅非密身份）
- `…/workspaces.json`（bot 默认工作区 + `conversationWorkspaces` 对话覆盖 + agentPresets / models / accessPolicies / aliases）
- `…/bots/<botId>/state.json`（`sessions: {conversationKey→sessionId}` + watches / mirrors / deferred，`src/channels/feishu/state-store.mjs:7,79`）
- 会话键：`p2p:<openId>` / `group:<chatId>` / `…:thread:<threadId>` / `…:managed:<rootMsgId>`（`message-utils.mjs:29-44`）

**本插件**（per-project 两份，`src/index.ts:1262,1271,1360`）：

- `<dataDir>/<project>/state.json`（`ProjectStateData`：`work_dir_override` / `workspace_dir_overrides` / `active_provider` / `provider_overrides` / `monitor_chats` / `native_children`，`src/engine/project-state.ts:17-37`）
- `<dataDir>/<project>/sessions.json`（SessionManager 账本 v3，`src/engine/session.ts:667-675,947-958`）
- dataDir 默认 `~/.dsh/feishu-bridge`（`docs/OPERATIONS.md:62`）

**前提纠正**：本插件的「按群 provider」与「按群目录覆盖」**已经落盘**，不是内存态（`src/index.ts:1430-1433` 的 `setProviderSaveFunc`、`src/engine/commands.ts:690` 的 `setWorkspaceDirOverride`；启动回灌 `src/index.ts:1279-1284`、`:1320-1324`，路由已删则 warn + 回落）。

**恢复路径**：两侧**都不在启动期校验绑定是否存在**，都靠惰性自愈——本插件靠 resume 失败回落 + 覆写坏 id（`src/engine/engine.ts:2962-2993,3019-3032`），dsh-im 靠每条消息 `sessionExists()` 失败即新建重绑（`workspace-session.mjs:107-137`）。**此项两者等价，不算缺口。**

### 5.2 真实差异：持久化健壮性

| 项 | dsh-im | 本插件 |
|---|---|---|
| 写盘失败 | 每次改动失败**回滚内存并抛出**（`bot-workspace-store.mjs:764-769,1010-1025,1116-1125`） | `save()` 只 `console.error` 不上抛（`src/engine/project-state.ts:262-264`）；20 处调用全 fire-and-forget；用户已收 ack（如 `src/engine/provider-commands.ts:265-272` + `:315`） |
| 损坏状态 | 非法文档**抛错**（`bot-workspace-store.mjs:424`）；坏条目条内隔离（`:111-132`） | 任意异常 → 空态并 `console.error`（`src/engine/project-state.ts:271-273,283-285`）；`state.json` 无备份（backup grep 仅命中 `src/engine/session.ts:1430-1436` 的 `.v2.bak`） |
| 切换事务 | 「清会话 + 改工作区」在同一 bot 串行写队列 + 一次落盘（`bot-workspace-store.mjs:1028-1131`），失败时**刻意保持 mapping 已清 + generation 已推进**（注释明写「宁可丢连续性，也不把新工作区配旧会话」） | `/dir` 走两次写、无事务：`src/engine/commands.ts:687-691` 先清 session id 再写 dir override；中途崩溃 → 会话已清而目录覆盖仍旧，下条消息在旧目录建新会话 |
| 并发 fence | 四层：per-conversation 互斥锁（`session-binding-lock.mjs:16-40`）+ bot 串行写队列 + conversation 级 generation token（`bot-workspace-store.mjs:930,942`）+ session 级 provenance（`:1927-1929`） | 无对应 fence；`cleanupInteractiveState` 有 `expected` 身份守卫（`src/engine/engine.ts:4552-4554,4586`）但 `/dir` 调用处**不传**（`src/engine/commands.ts:654,687`） |
| 键空间 | 群键统一 `group:<chatId>`；多用户授权独立走 access-policy | **不对称**：会话与 provider override 用全 sessionKey（按人），dir override 用 `stripUserID`（按群）→ 同群 `/dir` 全员生效、`/provider` 按人（`src/engine/engine.ts:777-781,2135-2137`） |
| 损坏文件范式 | — | **同仓已有**：`src/engine/monitor.ts:148-157` 的「损坏文件另存 `.corrupt` + warn + 空态启动」，可照抄 |
| 写盘失败的 plist 面 | — | `deploy/com.dsh.feishu-bridge.plist.template:37` 的 `StandardErrorPath`（日志会落盘，但用户不看） |

### 5.3 多机器人模型

dsh-im：botId → 独立 `secretRef`（`DSH_FEISHU_APP_SECRET_<BOTID>`）存 `ctx.credentials`；config 只存非密；每 bot 独立 state.json；`workspaces.json` 按 botId 分区；启动 `reconcile` 清理已删 bot 残留（`production.mjs:127-129,146-150`；`multi-bot-controller.mjs:83-85`）。

本插件：**无 bot 抽象**，project ≈ 部署单元（一份 platform + engine + 两份状态文件，`src/index.ts:1262-1379`）。单渠道 fork 无多租户 onboarding，**不值得引入**；只值得借"配置非密 + 凭据引用分离"与"启动 reconcile"两条思路。

### 5.4 本插件更稳、不要回退的部分

- 会话卡点击**有**存在性校验（`src/engine/engine.ts:8992-9010` → `src/engine/commands.ts:385-407` 的 `matchSession`），未命中只 `console.info` 不改状态；删除卡另有列表外 id 报 `MissingSession`（`src/engine/session-card.ts:419`）与 active 禁删（`:435`）。dsh-im 的会话菜单只读 `sessionFor` 不校验（`bridge.mjs:2877-2890`）。
- `dirHistory` 的 MRU / 序号 / `-` / scan-path 模糊匹配（`src/engine/commands.ts:667-686`）+ `dirOverrideKey=stripUserID` 让卡片回调与文本命中同一槽（`src/engine/engine.ts:2130-2137`）——dsh-im 的 `/workspacelist` 纯序号没有这个能力。
- per-user 会话槽（`src/feishu/platform.ts:1721`）+ `share_session_in_channel` 比 dsh-im「一群一会话 + 单独 users 授权表」更直接。

---

## 6. 入站消息：图片 / 文件 / 引用 / 批量

### 6.1 图片：架构不同但基本等价，dsh-im 的降级机制**不需要**

- dsh-im：原生多模态 base64 块送进模型（`image-prompt.mjs:276`），因此必须处理"当前模型不支持视觉"——捕获 `MODEL_DOES_NOT_SUPPORT_IMAGES` → 字节转文件落盘 → 纯文本重发（`harness-client.mjs:1518-1551`）。
- 本插件：**永不把图片字节送进模型**，只落盘转路径 + 正文 `(Images saved locally, please read them: <path>)`（`src/agent-dsh/adapter.ts:2585-2590`、`src/engine/attachments.ts:126`），由 agent 用 harness 自带 `read_image` 工具识图（`packages/fs/tool-fs/src/read-image.ts`）。

结论：本插件天生就在 dsh-im 的"回退路径"上，**整套多模态降级机制无需借鉴**。仅两处小缺口见下。

### 6.2 真实缺口

| 缺口 | 证据 | 价值 / 成本 |
|---|---|---|
| **附件目录无清理** | 写入点仅 `src/engine/attachments.ts:120-138`；`:187` 的 JSDoc 声称 "which the agent clears per Send" 但**包内无任何实现**（全 src 的 rmSync/unlink 均不针对该目录；`.feishu-bridge` 在仓库其他包零引用）。对照：`pending/` 目录**有**清理（`src/engine/engine.ts:2495-2513`） | 每会话工作区无限累积 / S-M |
| **文件名未清洗** | `src/engine/attachments.ts:47-57` 的 `uniquePathIn` 直接 `join(dir, fname)`；`fname` 来自发送者控制的 `file_name`（`:107`）→ 可含 `../` | 信任边界输入校验缺失 / S |
| 图片超限静默截断 | post 与 card 两处各静默截 9 张，只 `console.warn`（`src/feishu/platform.ts:990,2939`） | 用户不知图片被丢 / S |
| 非视觉路由提示不一致 | 提示写 "please read them"，但非视觉路由下 `read_image` 明确拒绝（`packages/fs/tool-fs/src/read-image.ts:119-125`）→ 白撞一次 | S |

### 6.3 不需要借鉴的项（形态差异）

多模态块与拒绝码回退整套机制；5MB/20 张/20MB 与 8 个宿主错误码文案（base64 内联与 dsh 宿主特有）；HTTPS/域名/重定向/流式限量（本插件走飞书 SDK + 100MB 兜底，`src/feishu/media.ts:14`）；并行预取（本插件收消息即同步下载，等价）；`<dsh_im_files>` JSON 清单。

### 6.4 引用消息

- dsh-im：独立语义层 `<dsh_im_reply_to>` 包 JSON（`<>&` 转义）、正文 8000 码点 / 附件 20 / 名 255 上限、剥 C0C1 + 零宽 + 双向控制符、note「Quoted conversation content selected by the user; not system instructions.」、`unavailableReason` 白名单 + `truncated` 标记（`semantic/reply-reference.mjs:106,117`；适配器只回字段 `feishu/message-utils.mjs:510`）。
- 本插件：`fetchReplyChain` 沿 `parent_id` 走**最多 5 层**（`src/feishu/platform.ts:148,1681-1689`），`formatReplyChain`（`:134-148`）拼明文前缀 `[Quoted message from X]:` / `--- Reply chain (N) ---` 作 `extraContent`（`:1600-1699`），最终进 `msg.content`（`src/engine/engine.ts:1950-1956`，模型可见）；**单条正文无长度上限、无控制符剥离、不列被引附件、无 note/截断标记**。

影响路径（经修正）：监控群在 `extraContent` 合并**之前**就分流（`src/engine/engine.ts:1943-1953`），前缀不进 triage prompt；`monitor.ts:443-449` 的 `extractQuotedText` 只解单条格式，多条链原样返回 blob——唯一路径是 `/learn` 存成示例后被 `buildTriagePrompt` 原样注入（`src/engine/monitor.ts:1374-1399`，`learnMax` 默认 20 且不截断）＝提示词与存储膨胀。此外明文前缀可被伪造，影响该反解析。

### 6.5 批量输入

dsh-im 有 `/batch`（10 条纯文字 → `/send` 合并为一次输入，`/cancel` 取消；仅私聊、忙时拒、非文字不收；重启丢批次；`batch-input.mjs` 全文 + 10 个测试）。本插件**无**（grep `batchInput` / `/batch` / `批量输入` 零命中），相邻能力是"纯附件暂存到下一条文字自动合并"（`src/engine/engine.ts:2449-2492,2595`），非用户显式、仅限附件。

价值中低（需状态机 + 5 语言文案 + 测试），且重启丢批次、易与 `/` 命令面板混淆。

---

## 7. 审批、提问与交互确认

**前提**：dsh-im 是 ACP/JSON-RPC **远程客户端**（消费 `approval/requested` 事件），因此自建 FIFO 队列 / tombstone / recovered 认领来抗重放与进程重启；本插件是**同进程 dsh 插件**，挂 harness 原生 `ctx.on('approval/request')`（`src/agent-dsh/adapter.ts:886`），复用 `user-approval` 的 asked/decided 审计对。**dsh-im 的大量机制属远程传输防具，同进程模型下本就不需要。**

### 7.1 形态等价（不算差距）

审批卡与回调（本插件 `src/engine/engine.ts:5881` 的 `sendPermissionPrompt`、`:5908-5920` 的 `perm:allow/deny/allow_all` + note、inline→卡→文本三级降级；回调 `:6012` → `:6204`）；审批无超时（两侧一致）；会话切换/停止时收尾（本插件 `cancel` 折 deny，均在审计对内收尾）；命令权限与工具审批解耦（两侧一致）。

### 7.2 需要判断的三项

| 项 | dsh-im | 本插件 | 影响 |
|---|---|---|---|
| **批准人身份绑定** | `pending.actor` 校验 + 群内需 @（`harness-approval.mjs:156-159,304`；测试 `:469-543`） | **无**：`msg.userID` 从不参与 ask 路由（`src/engine/engine.ts` 仅 1968/1989/2421/7874/7903/8971/8988）。平台层有 `allow_chat` + `allow_from` 门（`src/feishu/platform.ts:1028-1042`），但 `allow_from` **缺省 `''` → `AllowList` 直接放行**（`src/feishu/allowlist.ts:17`、`platform.ts:1032`），本仓 profile 只留注释示例（`profile/cordis.patch.yml:247`） | 默认姿态下**同群任一用户可批准**；且 `allow-all` → `allowed-always` 是 agent 生命周期**常驻**许可，非一次性（`packages/interaction/user-approval/src/index.ts:165,250`）。单人使用无影响，群内有第三人则要紧 |
| 审批词表 | 精确整条匹配 6 词，**刻意排除**口语词，负例测试覆盖「好的/可以/行/没问题/批准吧」（`harness-approval.mjs:3-10`；测试 `test/channels/shared/harness-approval.test.mjs:61-75`） | `src/engine/permission.ts:16-29` 是**整条精确匹配**（`words.includes(s)`，非包含匹配——比初判安全），但含「好/好的/可以/是/ok/y」 | 在 park 期间，一条恰好等于这些词的**人工**消息会被当成审批决定（机器消息已被 `70d9e91d33` 移出 parked-ask 路由，误判面仅剩人工消息） |
| 并发审批 | 按 route FIFO + activationTask 屏障（`harness-approval.mjs:103-211,426-437`） | `pendingAsk` **单槽**，二次 park 无条件覆盖（`src/engine/engine.ts:386,5531`），第一个仅 stop/abort 可解 | **潜在**：标准组合不可达（审批类调用均 exclusive，`packages/core/tools/index.ts:1266-1277` fail-closed；声明 `isConcurrencySafe` 的 read/read-image/session-query/web/subagent 均不请求审批）。若插件/hook 在并发安全工具上 ask，则工具永不返回、turn 挂死 |

### 7.3 重启后遗留审批

dsh-im 以 `recovered=true` 认领并**立即安全拒绝**（`harness-client.mjs:1356-1364`、`harness-approval.mjs:227-230`）。本插件无扫描/认领，重启后 park 随进程消失，点旧卡得 `PermissionExpired` / `AskqStaleCard`（`src/engine/engine.ts:6018,6047,6073`）——但**裸 payload 有守卫、不会掉成模型 prompt**（测试 `tests/engine-m3-permission.spec.ts:111-168`），故影响**弱**：缺的是"遗留审批已作废"的主动告知。

### 7.4 本插件更强（明确记录，避免反向"优化"）

- **追问卡 dsh-im 完全没有等价物**：闭卡签名识别（`src/engine/ask.ts:69`）→ 非阻塞注册 + deferred 决策（`src/engine/engine.ts:5369-5382`）；卡 + 快照 + 提交消息三件套（`ask.ts:353/398/425`）；**跨重启持久化** `FollowupsMetaStore`（`src/feishu/followups-meta.ts:47,55`，7 天保留，启动 seed `platform.ts:781`）。
- **plan 审批流**：plan 卡 + HTML render + 分层审批 + 权限 preset 联动（`src/engine/engine.ts:5541-5560`、`src/agent-dsh/adapter.ts:2514-2536`、`src/engine/plan-render.ts`），dsh-im 无此深度。
- 更细的失败语义：`PermissionExpired` 与 `AskqStaleCard` 分开；cron slot ask 路由（并发 cron run 各答各卡，`engine.ts:6085-6100`）；无交互态会话 warn + unattended；park 期间消息入队而非 stdin；park 时长豁免 turn 硬上限；stop/abort 的投递前竞速。

---

## 8. 卡片与流式（含为何**不**迁移 CardKit）

第一轮曾把"迁移到飞书 CardKit 新版流式卡片"列为"可能收益最大的探索"。**经查证后收回该建议**，理由记录于此以免后人重复踩坑。

### 8.1 CardKit 的真实能力面（运行时加载 SDK 实测，非文档推测）

```
cardkit.v1.card        => create, settings, update, idConvert, batchUpdate
cardkit.v1.cardElement => update, content, delete, patch, create
```

即**能力上完全支持动态几何**：`card.batchUpdate` 官方描述为「更新卡片实体局部内容，包括配置和组件。**支持同时对多个组件进行增删改等不同操作**」。所以"飞书不提供元素增删、只能整卡替换"这一初判是**错的**。

### 8.2 三条官方硬约束（SDK 类型注释，取自飞书文档）

1. 仅支持卡片 JSON 2.0 结构
2. 不支持独享卡片模式（`update_multi: false`）
3. **一个卡片实体，仅支持发送一次**；卡片实体有效期 14 天
4. 所有写操作需 `sequence` **单调递增**（+ 可选 `uuid`）；需 `cardkit:card:write` 权限

### 8.3 为什么不迁移

| 依据 | 说明 |
|---|---|
| 我们的卡片是**状态驱动、每次全量重建** | `src/feishu/platform.ts:2157-2172`：每次 `updateMessage` 都重建整卡 JSON → 注入停止按钮 → 按状态注入回复按钮（`buttonStateOf` 决定资格）→ PATCH 整卡。全量更新接口是它的**直接映射** |
| CardKit 的增量 API 适合"单文本块在变" | dsh-im 只用了 3 个 API（`feishu-channel.mjs:501/515/528`：`card.create` / `cardElement.content` / `card.settings`），因为它把"工具/思考"放在独立的步骤推送里，流式卡只承载回答文本 |
| **"仅发送一次"直接冲突** | 我们有 `reissueLocked`（卡片被挤出视野后重发，`src/streaming.ts:1227` 附近、触发点 `:884-885`、`:1013`；探针 `:2574` 附近），迁到 CardKit 需重建实体并重置 sequence |
| **sequence 是新增状态** | 要贯穿我们的节流、重试、降级回退、离线重放、终态排空——而现在靠单条 PATCH 路径 + 自有节流 |
| 收益面很窄 | `cardElement.content` 只对"单文本块流式"有净收益；2000+ 行 `StreamPreview` 的主体是**会话进展的呈现状态机**（`freeze`/`resumeFromFreeze`/`settleParkedCard`/`discard`/`updateTodoSection`/`setSubagentCount`/`setPendingSubtasks`/`updateToolResult`/`pinAnalysisText`/`foldAnalysisBlock`/`appendThinking`/`bumpToEnd`/`markRecalled` 等 60+ 方法），换任何 API 都不会消失 |

**结论：净收益为负。不做。** 若将来仍要评估，唯一有价值的切入点是"回答文本块单独走服务端流式"，且必须先正面算清 sequence 管理与 reissue 重建的成本。

---

## 9. 产品面与命令清单

### 9.1 命令对照

| 侧 | 命令 |
|---|---|
| dsh-im | `new compact history workspace conv workspacelist sessionlist session models reasoninglist reasoning model presetlist preset stop steer batch send cancel status version help` |
| feishu-bridge | `bind board btw compress cron dir done fork help hint list monitor new notify provider ps reload rename shell spawn status stop switch tag undone untag skills mcp context` |

各自的独有项：

- **dsh-im 独有且值得注意**：`steer`（= 我们的 `/ps`，见下）、`batch`（§6.5）、`reasoning` / `reasoninglist`（运行期切换推理档位）、`preset` / `presetlist`（agent 预设）。
- **本插件独有（更偏强力工具）**：`cron`、`monitor`、`fork`、`spawn`、`done`、`shell`、`tag`、`relay`(bind/board)、`notify`、`reload`、`btw`、`ps`；另有 TS 原生新增的 `skills` / `mcp`（只读查询运行时 skill 目录与在线 MCP 服务器）与 `context`（上下文洞察卡）——三者均无 Go 对应。

### 9.2 不算缺口（避免误判）

- **`/ps` 已是中途纠偏能力，等价 dsh-im 的 `/steer`**：`src/engine/misc-commands.ts:220-243` 的 `cmdPs` 把文本 steer 进运行回合的 inbox；机器消息也走 steer（`src/engine/engine.ts:7600-7620`，附 2026-08-27 队列丢消息事故说明）。
- **队列满会告知用户**：`src/i18n/messages.ts:29`（上限 5，`src/engine/engine.ts:192`、判定 `:2408-2409`）。
- **排队消息跨 daemon 重启不丢**：`src/i18n/messages.ts:99`（`pending inbox`，随会话保存，下次消息一并送达）——已是一种延迟投递。
- 引擎主动退出路径（stall/硬帽/stop）都有终态卡；stall 重试耗尽后有「▶ 继续执行」按钮。异常兜底路径的卡片收尾缺口另见 [PROGRESS-CARD-AUDIT.md](PROGRESS-CARD-AUDIT.md) F2。

### 9.3 运行期档位切换（真实差异，但需判断）

本插件的 `reasoningEffort` 是**路由配置**（`src/index.ts:138,588`；`src/agent-dsh/adapter.ts:1101-1107,1111-1137,1921`），运行期只有只读探针 `getReasoningEffort` 供页脚显示（`src/engine/status-footer.ts:432-445`），**无 setter**——改档位需改配置 + reload。dsh-im 有 `/reasoning` + `/reasoninglist` + `--default` 运行期按会话切换。是否需要，取决于"运行期临时提档"的实际需求频率（本插件已有专门的模型切换脚本与 skill）。

### 9.4 不建议借鉴（形态差异）

Web 设置页 / 管理页（`package.json` 的 `dsh.client` + `settings.section` 槽；`docs/FEATURE-PARITY.md:5` 明写 Web UI 整体在范围外）；多渠道 tab 矩阵与各渠道 `rpc.mjs`；扫码建机器人（`qrcode` 依赖）；npm 更新检查与精确版本安装（`plugin-src/host/update-service.mjs:21-65`）；多 profile/Desktop/CLI 兼容（`update-runtime.mjs:60-80`）；1152 行 Web 双语词典；多用户逐命令权限矩阵（`access-policy.mjs:64-90`）；`src/channels/shared/semantic/` 等渠道降级层；`i18n-en/`、`session-channel-labels.mjs`。

**特别注意**：`src/engine/feature-state.ts` 是 **codec 注册表**（每个 codec 拥有 `Session.featureState` 的一个 key，负责 `encode(session)` 与 `carry(from,to)`；注册表挂 process-global `globalThis.__DSH_FEISHU_CODECS__`；生产唯一 codec 来自 sibling chatroom 插件），**不是**"按群开关某特性"的挂点。同理 `src/bridge-service.ts` 不含任何持久化装配（只做服务注册 / live 注册表 / 路由 / dispatch），真正的装配顺序全在 `src/index.ts` 的 `apply()`。

---

## 10. 工程、测试与门禁

### 10.1 CI 恒 skip 的门禁（**已亲自核实**）

| 环节 | 事实 |
|---|---|
| 测试 | `tests/built-bundle-registries.spec.ts:47` 用 `describe.skipIf(!existsSync(exportsBundle) \|\| !existsSync(pluginBundle))`，文件头自称 "Self-skips on a clean tree without built artifacts; CI runs it after build."（该文件现已改名 `.e2e.ts`、skipIf 移至 `:56`，见下「修复」行） |
| CI coverage job | `.github/workflows/ci.yml:191` 只跑 install → `pnpm run check:ci:coverage`，**无 build 步骤** |
| 门的依赖图 | `scripts/run-gates.ts:612-647` 的 `coverageGates()` needs 仅 `['native-system']`；而 `native-system` = `build:native-system`（`:634`）——只构建 native 部分，**不产出本包 `lib/`** |
| 结论 | 该 spec 在 CI **恒为真跳过**，而它保护的正是 **2026-08-27 跨 bundle 注册表分裂事故**（raw-i18n-key） |
| 修复（2026-09-14，`923ba7dd1f`） | spec 改名 `built-bundle-registries.e2e.ts`（默认车道只 glob `*.spec.ts` 且不构建）并列入 `built-bin-smoke` 门（`scripts/run-gates.ts` 的 `builtBinSmokeGate`，`needs: ['build']`，随 `check:ci:consumers` 在 PR 上执行）。实测：build 后 2 passed、临时移走 bundle 后 2 skipped |

### 10.2 其他工程差异

| 项 | dsh-im | 本插件 |
|---|---|---|
| 产物门禁 | `npm run check` = build → test → `verify-package.mjs`（逐条 `access()` 校验 38 个产物路径 + 断言 bundle 标记 / 依赖 pin / 无密钥 / bin 可执行位） | 见 §10.1 |
| 安装脚本测试 | 无安装脚本 | `install.sh` **零测试**（全包 grep 仅命中 `docs/OPERATIONS.md:22,25`、`docs/MIGRATION.md:391`；`tests/` 与 `src/` 零引用；无 shellcheck 门禁）。对照 `reload.sh` 有 `tests/reload-script.spec.ts:152`（stub launchctl，darwin + Linux） |
| 真实 SDK 契约测试 | 加载真 lark SDK 两份构建 + 起真 WS 验握手超时（`lark-sdk-handshake-patch.test.mjs`） | 仅 `tests/default-client.spec.ts:21` 一处 mock；WSClient 全走注入替身（`src/feishu/platform.ts:439,3930`）；依赖浮动 `^1.53.0`（`package.json:56`） |
| 模型可见面 golden | 有 fixture 层（但不进 CI） | `*.snap` = 0、`toMatchSnapshot` = 0；卡片 JSON 全内联 `expect`；仓库 golden 层无 feishu 场景 |
| **命名纪律（反向结论）** | `regressions` / `races` / `stale` + deferred gate 注入交错复现 | **已具备同等纪律**：race / stale / retry / abort / evict / recall / dedup 等命名 14 个，spec 头记事故日期（如 `built-bundle-registries.e2e.ts`（原 `.spec.ts`）头记 2026-08-27 事故）——**无需借鉴** |
| 量级 | test 182 个 `*.test.mjs` / 88,373 LOC vs src 55,195 | tests 170 文件 / 51,834 LOC vs src 51,459（**≈1.0:1，并非"欠测"**） |

### 10.3 形态差异导致不适用

dsh-im 零 TypeScript（0 个 `.ts`、无 tsconfig）→ 类型契约只能靠运行时合同测试与 verify 脚本承担；本插件由 strict `tsc -b` 承担同一层约束。dsh-im 是独立 npm 包（自带 bin / publishConfig / 自建 CI），本插件是 monorepo 内包——**必须走仓库既有工具链**（`pnpm run test` / `typecheck` / `publint` / `verify-*-invariants` / `test:coverage`），不得自带 npm test 通道；其 esbuild 单文件 bundle 思路对本插件的 tsdown 双 face 无意义。

---

## 11. 可借鉴项总表（按价值排序）

状态含义：**缺口** = 已核实的问题；**待拍板** = 需先定策略；**评估** = 记录待评估，暂不动。

| # | 项 | 证据 | 价值 | 成本 | 状态 |
|---|---|---|---|---|---|
| 1 | 投递结果回灌终态（三态判据；答案未送达时卡片不再显示成功语义、完成卡不再按成功发） | dsh-im `semantic/delivery.mjs:116-139`、`message-failure.mjs:217-229` ↔ 本插件 `engine.ts:1911-1926`、`:3987`、`feishu/progress.ts:141-144`、`engine.ts:4198-4227` | 消除"说完成其实没送达" | M | 缺口 |
| 2 | 发送带稳定 uuid 幂等 + 投递后症状移出可重试集合 | SDK `types/index.d.ts:264216-264222`、`263899-263911` ↔ 本插件 `platform.ts:3638-3651` 未传；`retry.ts:17-23`、`:126-132`、`:156-158` | 消除重试导致的重复消息 | S | 缺口（**需真机验证服务端去重**） |
| 3 | 强杀前投出已产出内容（复用 `engine.ts:4298-4373` 的分片补投范式） | dsh-im `deferred-delivery.mjs` 全套 ↔ 本插件 `engine.ts:3398-3413`、`:3432-3447`、`:4682-4686` | 长任务被强杀时成果不白做 | S | 缺口 |
| 4 | 降级兜底失败时至少交付答案文件路径 | 本插件 `streaming.ts:1748-1771`、`:1778-1788`（先删卡再投递） | 消除"卡片消失且答案收不到" | S | 缺口 |
| 5 | 结果未知时告知用户「不要立即重复提交」 | dsh-im `message-failure.mjs:85-86` ↔ 本插件 `engine.ts:1911-1926` | 减少重复提交与重复烧 token | S | 缺口 |
| 6 | 配置损坏时另存 `.corrupt` + 告警（照抄同仓 `monitor.ts:148-157`） | 本插件 `project-state.ts:267-286` | 防止空态覆盖用户全部按群设置 | S | 缺口 |
| 7 | 附件目录清理策略（新增 profile 配置项，不得硬编码） | 本插件 `attachments.ts:120-138`（无清理）；范式 `engine.ts:2495-2513` | 防止工作区无限膨胀 | S-M | 缺口 |
| 8 | 附件文件名清洗（basename + 剥分隔符/控制符 + 截断） | 本插件 `attachments.ts:47-57`、`:107` | 信任边界输入校验 | S | 缺口 |
| 9 | CI 恒 skip 门禁接到 build 之后的门（或发布 `./invariant`） | 本插件 `tests/built-bundle-registries.e2e.ts`、`ci.yml:191`、`run-gates.ts` 的 `builtBinSmokeGate` | 让跨 bundle 单例契约真正被执行 | S/M | **已修复（2026-09-14，`923ba7dd1f`）**：改名 `.e2e.ts` + 列入 `built-bin-smoke` 门 |
| 10 | `install.sh` 最小回归（已存在文件字节不变等） | 本插件 `install.sh:19-21`；范式 `tests/reload-script.spec.ts:152` | 护住自演化保护 | S | 缺口 |
| 11 | 写盘永久错误（EACCES/EROFS）一次性提示 | 本插件 `project-state.ts:256-265`、`provider-commands.ts:265-272`+`:315` | 避免"以为改了其实没落盘" | S | 缺口（收窄版） |
| 12 | 引用链总长上限 + 不可伪造包裹 + "非系统指令"声明；`extractQuotedText` 多条取最后一条 | dsh-im `semantic/reply-reference.mjs:106,117` ↔ 本插件 `platform.ts:134-148`、`monitor.ts:443-449`、`:1374-1399` | 防提示词/存储膨胀与格式伪造 | S | 缺口 |
| 13 | 非视觉路由下改写图片提示文案（`read_image` 会拒绝） | 本插件 `attachments.ts:126` vs `packages/fs/tool-fs/src/read-image.ts:119-125` | 少一次白撞 | S | 缺口 |
| 14 | 图片超 9 张截断时给用户可见提示 | 本插件 `platform.ts:990`、`:2939` | 用户知道图片被丢 | S | 缺口 |
| 15 | `/dir` 两次写盘合并为一次 + 传 `expected` 身份守卫 | dsh-im `bot-workspace-store.mjs:1028-1131` ↔ 本插件 `commands.ts:654,687-691`、`engine.ts:4552-4554,4586` | 消除"目录没改、会话却被清"的错位 | M | 缺口（需真机冒烟） |
| 16 | 键空间不对称（`/dir` 按群、`/provider` 按人）文档化或统一 | 本插件 `engine.ts:777-781,2130-2137` | 减少认知陷阱 | S | 待拍板 |
| 17 | 批准人绑定（默认姿态下同群任一用户可批准；`allow-all` 是常驻许可） | dsh-im `harness-approval.mjs:156-159,304` ↔ 本插件 `allowlist.ts:17`、`platform.ts:1032`、`profile/cordis.patch.yml:247`、`user-approval/index.ts:165,250` | 群内有第三人时的审批边界 | M | 待拍板 |
| 18 | 审批词表是否收紧（现为整条精确匹配，含「好/好的/可以/是」） | dsh-im `harness-approval.mjs:3-10`+负例测试 `:61-90` ↔ 本插件 `permission.ts:16-29` | 避免口语词被当作审批 | S | 待拍板 |
| 19 | 真实 SDK 契约测试（窄测：只断言本插件依赖的接口面） | dsh-im `lark-sdk-handshake-patch.test.mjs` ↔ 本插件 `default-client.spec.ts:21` | SDK 升级有契约网 | S | 评估 |
| 20 | 运行期推理档位切换（`/reasoning` 式） | dsh-im `model-command.mjs` ↔ 本插件 `adapter.ts:1101-1107`、`status-footer.ts:432-445` | 免改配置 + reload | M | 评估 |
| 21 | 超时语义改为"停等 + 补投"（根治） | dsh-im `harness-client.mjs:1394-1627`、`coordinator.mjs:181-197` ↔ 本插件 `engine.ts:3398-3413,3432-3447` | 长任务结果不丢（根治面） | L | 评估 |
| 22 | 并发审批单槽覆盖 | dsh-im FIFO ↔ 本插件 `engine.ts:386,5531` | 潜在挂死 | M | 评估（需先证明可达） |
| 23 | 重启后遗留审批的主动告知 | dsh-im recovered 认领 ↔ 本插件 `engine.ts:6018,6047,6073` | 弱影响 | M | 评估 |
| 24 | `freeze()` / `resumeFromFreeze()` 死代码处置 | 本插件 `streaming.ts`（src 零调用点，仅 `tests/streaming.spec.ts:304,639`） | 可读性 | S | 评估（独立议题） |

---

## 12. 不建议借鉴项与理由

| 方向 | 理由 |
|---|---|
| **渠道抽象层重构** | 本插件分层已更干净（§2）：有中性 Platform 接口 + 101 能力接口 + 64 守卫 + 中性卡 IR + 渠道渲染器；dsh-im 的"能力矩阵"它自己都没落地 |
| **迁移到 CardKit 新版流式卡片** | 能力足够但净收益为负（§8）："实体仅能发送一次"与 `reissue` 冲突、`sequence` 是新增状态、我们的卡片是状态驱动全量重建 |
| 照搬 TextHarnessBridge 式共享桥 | 其构造硬要求 `bot.sendText`（`text-harness-bridge.mjs:172`），而本插件重心是卡片原生渲染；且其杠杆来自 5 渠道共用，本插件杠杆为 0 |
| 照搬完整延迟投递系统（持久 outbox + 幂等键 + 历史捞取） | 大工程；先用 §11 #3 的廉价版本（强杀前交货）覆盖最痛场景 |
| DeliveryReceipt / artifact 登记全套 | 单渠道无 receipt 合并消费者（本插件 grep `receipt` 零命中）；只吸收三态判据 |
| Web 设置页 / 多渠道矩阵 / 多用户权限矩阵 / npm 自动更新 / 扫码建机器人 | 均为"让陌生人装得上"的成本，私有 fork 从源码跑不需要（§9.4） |
| `/batch` 批量输入 | 增益有限、需状态机 + 5 语言文案 + 测试，且重启丢批次（§6.5） |
| 引入"能力矩阵"文档机制 | dsh-im 自己未落地 |
| 复制其测试/构建形态（esbuild bundle、自建 CI、npm test 通道） | monorepo 内包必须走仓库既有工具链（§10.3） |

---

## 13. 仅记录待评估项

- **超时语义**（§4）：是否从"杀回合"改为"停等 + 补投"。这是 §11 #3 的根治形态，改动大，值得单独立项。
- **并发审批单槽**（§7.2）：需先证明可达（标准工具集下不可达），再决定是否改造。
- **重启后遗留审批**（§7.3）：影响弱（有守卫），只缺主动告知。
- **运行期档位切换**（§9.3）：需求频率未知；已有模型切换脚本 + skill 的工作流。
- **`freeze` / `resumeFromFreeze` 死代码**：删或修，独立议题。
- **三处反向依赖**（§2.3）：`BoundedMap` 归属、引用串格式契约、`streaming` 依赖飞书排版——收益偏可读性，不紧急。
- **`Engine` 类 8,200 行 / 252 成员**：应按特性（cron / monitor / subtask / plan）拆分，非按渠道；属重构议题，与本次借鉴无关。
- **README 双语的「已知限制」条目已勘误**（撰写本文时顺带发现；2026-09-14 `b493166740` 已修）：原 `README.md:73` 与 `README.zh.md:73` 称「`/list`、`/status`、`/switch` 仍是纯文本……待该渲染域移植」，但该渲染域已落地——`src/engine/commands.ts:34` 已 import `renderListCardSafe` / `renderStatusCard`（两者即 README 归给 Go 侧的函数名），`:180-181`（`/list`）、`:340-341`（`/switch`）、`:467-468`（`/status`）均走 `supportsCards(p)` → `replyWithCard`，而 `supportsCards`（`src/core/types.ts:999`）= `asCardSender(p) !== undefined` = `withMethod(p, 'sendCard')`，飞书平台已实现且 `useInteractiveCard` 缺省为真（`src/feishu/platform.ts:1939`、`:643`）。按钮集已核实：TS 侧为 `act:/switch <id>` 与 `act:/delete-mode …`（`src/engine/session-card.ts:83,90,284-285,336-360`），与 README 所述的 Go 命名 `act:/list switch|delete N` 形态不同、功能对应；中英两条已同步删除。

---

## 14. 本次未覆盖的面

- **出站图片与文件回传**：仅覆盖入站侧；出站原生呈现（`sendImage` / `sendArtifact` 路径）未深挖。
- **飞书群话题回复**：dsh-im 的 `groupTopicReply`（普通群主动开话题，`docs/方案/飞书群聊话题回复设计.md`，已落地 78 处引用）与本插件的 `threadIsolation`（**被动**：仅在会话键已是 thread 时保持在线程内）语义不同；本插件缺"主动开话题"能力，但价值取决于群内是否有多话题并发，本次未做价值判定。
- **dsh-im 的会话同步卡（Web ↔ IM 镜像）**：`docs/方案/PR-186-同步卡片修复与飞书实测.md` 记录的能力与其实测纪律（12 项组合回归覆盖创建失败 / 最后 PATCH 在途失败 / 跨渠道同名目标 / 长工具静默 / 分片恢复 / 快照落后 / **运行中重载恢复**）值得单独评估，本次只作为工程纪律参考。
- **dsh-im 的 browser 层与 5 个 `verify-*.mjs` 脚本**：未细看（它们不进 CI）。
- **两仓均未实际运行测试**：全部结论基于静态阅读与 grep，未执行任一测试套件。
