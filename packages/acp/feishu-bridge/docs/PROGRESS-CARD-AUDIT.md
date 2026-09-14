# feishu-bridge 进度卡（tool process）实现审计

> 2026-09-12 落盘。来源：三路并行只读调查（流式预览渲染循环 / 结构化进度卡可达性 / 引擎事件接线）+ 本机实测（`node --import tsx/esm` 直接驱动 `src/` 真实模块喂模拟事件）。全程只读，未改动任何代码。**本文件只记录调查结论与候选方案，不含改动**；所有行号以 2026-09-12 的工作区为准。**§9 是 2026-09-14 追加的处置结果；其上正文保持审计当日原貌，行号锚未回填。**

一句话结论：线上真正在跑的进度卡只有一条链路——`StreamPreview`（下称 sp，`src/streaming.ts`）；另有一条结构化进度卡链路——`CompactProgressWriter` + payload 渲染链（下称 cp），**在飞书平台上永不可达**（766 行，占涉及三文件的 48%）。在跑的这条里，最大的可优化点是**思考阶段以约 3.3 次/秒重复上传正文完全相同的卡片**：去重被"标题时钟每秒变一次"短路了。

## 1. 结论摘要

| # | 发现 | 性质 | 影响（实测 / 推算） |
|---|---|---|---|
| F1 | 思考阶段高频重复 PATCH 同一张卡 | 带宽浪费 | 1.2s 思考流 6 次更新中 5 次正文逐字节相同；3.4s 流 64% 上传字节重复；20 次工具轮次 318 KB 里 95.8% 字符重复 |
| F2 | 异常逃出回合循环时卡片无人收尾 | 稳健性缺口 | 卡片永久停在「执行中」+ 停止按钮仍可点；机制已核实，触发未复现 |
| F3 | 结构化进度卡链路不可达 | 死代码 + 失效配置 | 766 行；`progress_style` 设置后静默无效，无警告 |
| F4 | 两个配置项在 live 是空转的 | 配置与行为不符 | 配 800ms/15 字符仍 2.4s 内更新 10 次，最小一次正文 1 个字符 |
| F5 | 位移自愈的"新建 + 删除"无防抖 | 抖动 | 守护进程日志 25 分钟内 16 次新建 / 8 次删除；同类另一条路径有 1.4s 合并窗 |
| F6 | PATCH 限流桶按机器人共享 | 潜在风险（非现症） | 注释称"每条消息 5 QPS"，实现是每机器人一桶、所有群共用；日志无限流报错 |
| F7 | 零调用方法与过期注释 | 卫生 | 4 处；其中 1 处 JSDoc 与实现相反 |

## 2. 实测方法与可复现数字

方法：用桩平台（只需 `name()` / `sendPreviewStart()` / `updateMessage()` 三个方法）驱动真实模块，记录每次 `updateMessage` 的入参，统计调用次数、正文去重数、JSON 字节数与渲染耗时。

```js
// node --import tsx/esm --input-type=module -e '<script>'  （cwd = packages/acp/feishu-bridge）
import { newStreamPreview, defaultStreamPreviewCfg } from "./src/streaming.ts"
const patches = []
const stub = {
  name: () => "feishu",
  async sendPreviewStart() { return { id: "card-1" } },
  async updateMessage(h, content) { patches.push({ text: content.text, ts: content.status?.ts, state: content.status?.state }) },
}
const sp = newStreamPreview(defaultStreamPreviewCfg(), stub, "ctx", undefined, undefined, "sess")
await sp.showPlaceholder("处理中…")
for (let i = 0; i < 30; i++) { await sp.appendThinking("推理内容".repeat(i + 1)); await new Promise(r => setTimeout(r, 40)) }
```

| 场景 | 结果 |
|---|---|
| 思考流 30 delta / 40ms（≈1.2s），默认预览配置 | **6 次 PATCH**；不同正文 **1 个**；不同标题时间戳 2 个（即 5 次为纯重复） |
| 思考流 3.4s（10 delta/s） | 11 次 PATCH；不同正文 1 个；**7/10 整卡 JSON 与上一次逐字节相同**；31.4 KB/s；重复字节 64% |
| 20 次工具调用的构造轮次 | 40 次 PATCH；194,587 正文字符；**318,549 JSON 字节**；**95.8% 字符与上一次 PATCH 重复**，整轮真实变化 7,929 字符 |
| 配置 `intervalMs: 800, minDeltaChars: 15` 下的旁白流 | 2.4s 内 **10 次 PATCH**（按配置预期约 3 次）；发出正文长度依次 1, 8, 15, 22 … → **最小一次只有 1 个字符** |
| 单卡 JSON 体积 | 0.9–9.9 KB（随正文字符数 555–6,544 变化；中文约 3 B/字符 + JSON 转义约 2.5×） |
| 渲染 CPU | 整卡渲染 0.10–0.19 ms/次；3.3 次/秒 ≈ 0.3–0.6 ms/s，**可忽略，不是瓶颈** |

第 2、3 行由并行调查的第二路独立测得，与第 1 行同法同源。

## 3. 发现明细

### F1 思考阶段高频重复 PATCH 同一张卡（VERIFIED）

链路（逐跳已核实）：

1. 引擎对**每个** `thinking_delta` 调一次 `sp.appendThinking(thinkingAccum)`，传入的是累积全文：`src/engine/engine.ts:3545`。
2. `appendThinking` 写入 `this.thinkingText`、置 `progressMode = true`、取消已排定的定时器，然后调 `flushProgressLocked`：`src/streaming.ts:1670-1681`。
3. **`thinkingText` 从不进入卡片正文**，只驱动标题状态：`buildProgressDisplayLocked`（`src/streaming.ts:1993`）只拼五段——回复正文 / 待办与统计 / 工具条目 / 实时播报 / 后台提示；标题状态来自 `progressStatusLocked`（`:793-810`）。所以在纯思考阶段，段落内容一字不变。
4. `flushProgressLocked`（`:1537-1560`）按 `progressFlushInterval = 300`（`:514`）节流；节流窗内排定延迟 flush，窗外则 **`this.lastSentText = ''`（`:1553`）后交给 `flushLocked`**。
5. `flushLocked` 唯一的去重守卫对"带状态"的内容直接失效：`src/streaming.ts:834`
   `if (contentIn.status === undefined && (text === this.lastSentText || text === '')) return`
6. 而标题里的时间戳是**渲染时刻的墙上时钟**：`progressStatusLocked` 返回 `ts: hms()`，`progressTitleAndColor` 把它拼进标题（`src/feishu/progress.ts:616`）。于是每次 PATCH 的标题都不同——但正文字节完全相同。

结论：**约 3.3 次/秒的上传里，纯思考阶段几乎没有一次携带新信息**，唯一变化是标题里的秒数（时钟每秒只变一次，故约 2/3 的 PATCH 连标题都重复）。思考是长任务里最长的阶段——live profile 注释里记着实测 375–587 秒的纯推理（`~/.dsh/profiles/feishu-bridge/cordis.patch.yml` 的 `stallTimeoutSecs` 段）——按每次 1–10 KB 算，一轮纯推理的重复上传量在几百 KB 到数 MB 量级。

时钟每秒推进本身**是**有意设计：现有测试名即 `thinking header timestamp stays current while deltas flow`（`tests/streaming.spec.ts:802`）。本发现针对的是"同一秒内、正文与状态全都未变"的那部分重复。

**候选方案（未实施）**：把去重键从"仅纯文本"扩展到"整卡渲染结果"——正文 + 状态（state/ts/toolCallSeq/pendingSubtasks）+ 后台提示全部相同则跳过本次 PATCH。时钟的秒值参与比较，因此每秒仍会更新一次，观感不变。详见 §7 附录的同步台账与测试清单。

### F2 异常逃出回合循环时卡片无人收尾（机制 VERIFIED，触发 INFERENCE）

三处回合循环的兜底 catch 只记日志、不碰卡片：

- `src/engine/engine.ts:2615-2616`（`engine: turn processing failed`）
- `src/engine/engine.ts:2766-2767`（`engine: orphan turn failed`）
- `src/engine/engine.ts:4473-4474`（`engine: queued turn failed`）

而下一回合在 `state.preview = sp`（`:3204`，另见 `:3378` / `:3843` / `:5693`）处**直接覆盖旧引用**，此后没有任何路径还能找到那张卡。可兜底的既有路径都覆盖不到它：

- 空闲回收 `reapIdleInteractiveStates`（`:4693` → `cleanupInteractiveState`，`:4552`）只调 `state.markStopped()`（`:4574`），那只翻标志位并唤醒等待者，**不碰 `preview`**。
- 只有用户 `/stop` 的 `stopInteractiveSession`（`:4624`）会 `preview.markStoppedSync()`（`:4645`）；另一处是 reload 拆卸（`:1870`）。

后果：卡片永久停在「执行中」+ 一个仍可点的「⏹ 停止执行」按钮。排查手册已把"卡片冻结"列为最易误诊指纹之一。抛出面已被收窄（`this.send`、`i18n.tf`、`sprintf`、`sessions.save`、`applyChatPhase`、`readAttachment` 均自吞或自带 catch，`Mutex` 不会因 reject 污染队列），所以这属**缺安全网**而非已证实的活泄漏。

**候选方案（未实施）**：三处 catch 内补一次失败态收尾（`state.preview?.markFailed()`），自身再包一层 try/catch 以免掩盖原始异常。

### F3 结构化进度卡链路不可达（VERIFIED）

根因是一处**移植漂移**：Go 的 `ProgressStyle()` 是**方法**（`/Users/hm/workspace/cc-connect/core/interfaces.go:476-478` 的 `ProgressStyleProvider` 接口；`platform/feishu/feishu.go:433` 的平台实现），TS 把它移植成了**字符串字段**（`src/feishu/platform.ts:559` 声明 + `:644` 赋值），而消费端仍按方法做鸭子类型探测：

- `src/progress-compact.ts:70`：`if (typeof provider.progressStyle !== 'function') return progressStyleLegacy`
- 同因连带 `src/progress-compact.ts:106`（`suppressStandaloneToolResultEvent` 直接早退）

于是构造器在 `src/progress-compact.ts:222` 提前返回，`enabled` 恒为 `false`，`appendStructured`（`:274`）、`setTodos`（`:239`）、`finalize`（`:405`）全部立即返回。**任何可达配置都无法让它变成 compact/card**：

- 第二条来源（replyCtx 的 `progressStyleHint` / `supportsProgressCardPayloadHint`，`src/progress-compact.ts:86-95`）在 `src/` 内**零生产者**（Go 侧有：`core/bridge.go` 的 `bridgeReplyCtx`）。
- 全仓只有 `FeishuPlatform` 一个 `Platform` 实现（`src/feishu/platform.ts:544`）。
- 线上构建产物同源：`lib/index.js` 里同样是该函数探测与字符串字段。

反证"这是疏忽而非预留接缝"：同一个类把兄弟 provider `supportsProgressCardPayload()` 实现成了**方法**（`src/feishu/platform.ts:2035-2037`），而它正是 `progressCardPayloadForTarget` 要探测的形状——同一份契约一个通一个不通。`git blame` 显示两半出自同一次移植（`71a429c058` 引入函数探测，`480d2497ec` 同日引入字符串字段），中间无接口变更。

**不可达面（按"在飞书活路径上不可达"计，共 766 行 = 三文件 1,605 行的 48%）**：

| 文件 | 不可达行数 / 总行数 | 主体 |
|---|---|---|
| `src/progress-compact.ts` | 201 / 447 | `appendStructured` 主体 275-379、`currentContent` 381-389、`currentSignature` 391-397、ctor 的 enabled 块 223-230、`append` 243-251（全仓零调用者）等 |
| `src/feishu/progress.ts` | 429 / 912 | 整条 payload 渲染链：入口 `buildProgressCardJSONFromPayload` 460-545，连带 `progressStateMeta` 122-160、`normalizeProgressItems` 185-206、`formatTodoWriteInput` 218-261、`padProgressLines` 269-291、`padCodeBlockContent` 293-332、`formatProgressToolInput` 338-362、`formatProgressToolResult` 364-379、`renderProgressEntryElement` 406-458 等 |
| `src/progress.ts` | 136 / 246 | `ProgressCardPayload` 74-89、`ProgressCardPayloadPrefix` 91-99、`buildProgressCardPayload` 151-191、`parseProgressCardPayload` 193-232、`inferLegacyEntryKind` 234-245 |

可达性收口（已逐条核对）：

- `{ kind: 'card' }` 内容的生产者只有两处，都在死掉的 writer 内：`src/progress-compact.ts:387` 与 `:416`。
- `buildProgressCardJSONFromPayload` 的调用者只有 `src/feishu/platform.ts:2181`（card 分支）与 `src/feishu/progress.ts:677`（文本路径上的 payload 分支）。
- `ProgressCardPayloadPrefix` 在 `src/` 内**只被消费、无生产者**（`src/progress.ts:200-201`），只有测试构造它（`tests/progress-compact.spec.ts:121,128,129`）→ 文本路径的 payload 分支同样不可达。

**抑制语义的移植差异**：Go 的 `SuppressStandaloneToolResultEvent`（`cc-connect/core/progress_compact.go:295-301`）= "平台实现 ProgressStyleProvider" 且 "样式为 legacy" → 飞书默认配置下返回 **true**；TS 版恒为 **false**。因此某个把 `toolMessages` 打开（非 quiet）的项目在 TS 下会为每条工具结果多发一条独立消息，而 Go 会抑制——**live 不受影响**：两个项目都是 quiet，`src/index.ts:878-879` 把 `toolMessages` 置 false，`engine.ts:3643` 走 `else if (this.display.toolProgress)` 分支，`:3626-3642` 的 `toolMessages` 分支（含该抑制判断）根本不求值。**注意这与并行调查初稿的一处结论相反**，以本节（已按 `engine.ts:3626-3650` 的 if/else 结构核实）为准。

**为什么测试没抓到**：所有 cp 测试用的假平台都把 `progressStyle` 造成**函数**——`tests/progress-compact.spec.ts:25-26`（`platformWithStyle`）、`:56`；引擎级三处 `tests/engine/engine-card-progress-finalize.spec.ts:29`、`engine-queued-takeover.spec.ts:27`、`engine-send-failure-card.spec.ts:70` 均为 `progressStyle: () => 'card'`。即**生产不存在的形状**。更糟的是 `tests/assembly-config.spec.ts:273,279` 断言 `platform.progressStyle` 等于 `'compact'` / `'legacy'`，把字符串字段**反向钉成了契约**。

**若把鸭子类型修好会发生什么（代码路径推理，未真机验证）**：每回合出现**两张卡**（sp 与 cp 各自 `sendPreviewStart`，`src/feishu/platform.ts:2118-2148` 是无条件新建消息）；cp 卡在有思考增量的回合里**永不终结**（三处 `finalize` 都在 `!sp.inProgressMode()` 门后，`:3334` / `:3866` / `:4201`，而 `appendThinking` 会置 `progressMode = true`），停在黄色「执行中」+ 活按钮；且 TS 引擎从不给 cp 喂 `tool_use`（Go 在 `engine_events.go:3913` 有喂），故 tool_use 渲染分支与 `lastTS` 仍死、标题永远没有时间戳。所以修它不是一行改动，**必须先定特性去留**。

### F4 两个配置项在 live 是空转的（VERIFIED）

`streamPreview` 的三个旋钮（`src/index.ts:733-739`，默认值见 `src/streaming.ts:74`：`intervalMs: 800, minDeltaChars: 15, maxChars: 2000`）只在 `appendText`（`:715-741`）里生效，而 `appendText` 只服务 **progressMode 之前**的短窗口：一旦有 thinking/tool 事件，引擎改走 `appendAnalysisText`（`:3785`/`:3791`）→ `flushProgressRebuildLocked`（`:1562`），后者用**写死的 300 ms** 且**没有任何最小增量门槛**，实时播报段的上限也是写死的 `maxAnalysisDisplayChars = 6000`（`:49`）——是配置项 `maxChars`（2000）的 3 倍。

实测：把 `intervalMs` 设成 800、`minDeltaChars` 设成 15，旁白流仍在 2.4 秒内发出 10 次 PATCH，其中一次正文只有 1 个字符。

即：**profile 里调这三个数值，对用户真正盯着的那张卡的更新频率与体积基本无效**，而 schema 描述写的是"Minimum ms between updates" / "Minimum new chars before an update"。同族对照：兄弟特性子任务面板的刷新间隔是可配置的（`features.subtaskLivePanelIntervalMs`，默认 15,000，`src/index.ts:598`/`1541`），默认 15 秒；卡片这条链路没有对应开关。

**候选方向（需拍板）**：(a) 改说明——声明这三个旋钮只管 progressMode 之前的文本路径，并把真正生效的两个常量标注为 live 常量 + 补 WHY；(b) 改行为——让进度路径也读 `intervalMs`/`minDeltaChars`（默认 800ms 意味着卡片更新变慢 2.7 倍，属可见节奏变化）；(c) 折中——新增一个显示层配置项（默认 300 = 保持现行为），把写死的值变成可部署调参。

### F5 位移自愈的"新建 + 删除"无防抖（实测观察，危害未证）

卡片被后来的消息顶下聊天尾部时，是靠**新建一张卡 + 删掉旧卡**回到尾部的：`reissueLocked`（`src/streaming.ts:1227-1252`，注释自述 "Not throttled"），平台侧为 `sendPreviewStart` 新建（`src/feishu/platform.ts:2118-2148`）+ `deletePreviewMessage`（`:2245`）。触发点有两类：

- `flushLocked` 内联的位移自愈（每次 flush 都可能触发，仅受 `progressFlushInterval` 300ms 节流）；
- `bumpToEnd`（`:1275-1282`）→ 引擎 `onChatChanged` 有防抖合并（`src/engine/engine.ts:5269-5278`）。

守护进程日志（`~/.dsh/feishu-bridge-stdout.log`，约 25 分钟窗口）实测 **16 次新建 / 8 次删除**，其中单群曾 4 秒内连发 3 次新建（21:58:01 → :04 → :05，紧跟该群的改名 + 换头像系统通知）。新建一张卡会把整张卡（可能含数千字符旁白）重新全量发送，比 PATCH 贵，且会在聊天里产生消息顺序跳动。未见用户可见故障记录。

**候选方向（未实施）**：给位移自愈加一个冷却窗（例如同一张卡 N 秒内最多重发一次），语义上向 `onChatChanged` 的 1.4s 合并窗看齐。

### F6 PATCH 限流桶按机器人共享（实现 VERIFIED，危害 INFERENCE）

`src/feishu/platform.ts:652-654` 的注释写"飞书限制是**每条消息** 5 QPS"，但实现是平台实例上一个令牌桶：

- `:575` 字段声明、`:654` `new TokenBucketRateLimiter(options.patchRateIntervalMs ?? 200, 3)`
- 唯一取用点 `:2281` `await this.patchRL.wait(signal)`（`updateMessage` / `updateRenderStatus` / `renderStoppedCard` 共用）

平台实例是**按项目（即按机器人）**构造的（`src/index.ts:1326`），于是一个机器人下**所有群的卡片共享同一个桶**（聊天室多角色群 + 子任务面板 + 各会话都在其中）。另外 `TokenBucketRateLimiter.wait`（`src/feishu/retry.ts:190-241`）用 `setTimeout` 轮询、无 FIFO 队列，公平性无保证。

现状：日志中没有 230020 限流报错、也没有 `degrade` 告警，故属**潜在风险而非现症**；但多会话并发时每张卡的实际更新速率会被摊薄到远低于 API 允许值。

**候选方向（需拍板）**：按 messageID 分桶（或按 sender/会话分桶），保持单卡 5 QPS 上限不变。

### F7 零调用方法与过期注释（VERIFIED，卫生类）

- `StreamPreview.resetProgressEntries`（`src/streaming.ts:1406-1417`）：全仓零调用者；其 JSDoc 称"供 unsolicited reader 使用，使每个后台回合在**同一张共享卡**上从干净的「工具调用」段开始"，而实现是每个回合新建 sp（`engine.ts:3204`），**注释与实现相反**。
- `truncateToMaxLines`（`src/streaming.ts:211`）：仅测试调用，无生产调用者。
- `progressNoOutputText`（`src/feishu/progress.ts:387`）：全仓零调用者。
- `CompactProgressWriter.append`（`src/progress-compact.ts:249`）：全仓零调用者。
- `ProgressEntry.render` 的 `isThinking` 分支（`src/streaming.ts:173-177`）：`padToFixedLines(body, 5)` 后 `split('\n', 2)`，只输出前两行且**不带 `... (N more lines)` 溢出标记**，而 JSDoc 与行内注释都声称"5 行"——注释与代码矛盾。该分支当前无生产者（`newToolProgressEntry('Thinking', ...)` 无调用者），但 `toolTagForProgress` 仍保留了 `Thinking` 名字分支，兄弟调用方一旦启用即踩中。

## 4. 判定为"非问题"的负结论（省后人重复调查）

- **代码块补空格到 100 字符不是浪费**：`ProgressEntry.render` 用 `padLineWidth(body, minCodeBlockLineWidth)`（`minCodeBlockLineWidth = 100`，`src/streaming.ts:242`）补齐每条工具条目的首行。工具密集时它确实占正文很大比例（短正文实测约 49% 字符、卡片 JSON 少 32%），但动机是渲染器需要——上游 Go 侧 commit `cca7104b` 的提交信息写明"Pad code block first line to 100 chars to ensure consistent horizontal scrollbar on desktop, preventing card height jumps during PATCH updates"。在 20 次工具轮次的 318 KB 上传里它约占 3%。**结论：不删**；但该动机目前只存在于上游提交信息里，本仓库无任何注释——建议就地补一句 WHY。
- **渲染 CPU 可忽略**：整卡渲染 0.10–0.19 ms/次（含 HTML 清洗、markdown 预处理、表格收敛、`JSON.stringify`，另加两次 `inject*Button` 的 parse/stringify），3.3 次/秒下占用 <1 ms/s。不存在需要优化或引入 memoize 的理由。
- **PATCH 顺序无"终态被回滚成运行中"的竞态**：运行态走 `enqueueCoalescable`（`src/streaming.ts:898`），终态走 `enqueueTerminal`（`:1839`/`:1887`），`async-sender` 的内层合并遇到非 coalescable 条目即停（`src/async-sender.ts:63-69`），且各终态前有 barrier → FIFO 保证运行快照先落地、终态最后落地。
- **延迟 flush 定时器不会在终态后补刀**：所有终态路径都 `cancelTimerLocked()`（`:962`/`:1135`/`:1824`/`:1873`/`:1915`），回调自带 `degraded || previewMsgID === undefined` 守卫。
- **padding 空格确实会进 PATCH 报文**：全链路上没有任何阶段剥尾部空格（`preprocessFeishuMarkdown` 只对 `line.trim()` 做判断后原样传行）。
- **工具结果没有被双发**：见 F3 的说明——live 走 `else if (toolProgress)` 分支，独立消息那条分支不求值。

## 5. 待拍板决策

1. **F3 的 766 行**：删掉，还是补齐？
   - 删 = 三个文件减 48%，同时删掉 `progress_style` 配置键（`src/index.ts:574`）、`docs/OPERATIONS.md:79` 的说明与相关测试；符合仓库"Require a current owner and need"。
   - 补 = 除修类型外还要定 sp / cp **谁拥有本回合的卡片**（否则两张卡 + cp 不终结），并补 `tool_use` 喂入与终态收尾。
   - 无论选哪个，都建议把"设置了但无效"改为**加载时报错**（`Misconfiguration fails loud`），而不是继续静默。
2. **时钟节拍**：卡片标题的墙上时钟现在每秒推进；兄弟特性子任务面板是 15 秒一跳。要不要把卡片降到同一量级？（这是 F1 之后剩余重复上传的主要来源。）
3. **F4 的方向**：改说明（零行为变更）还是让进度路径也读那两个旋钮（更新节奏变慢约 2.7 倍）？
4. **F6 是否按消息分桶**（现在无实测危害，仅实现与注释不符）。
5. 是否推进 F1 / F2 / F5 的修复。

## 6. 覆盖范围与未验证项

已覆盖（代码级结论，含本机实测）：sp 渲染循环与节流/去重、cp 可达性、引擎事件扇出与卡片生命周期、配置schema 与默认值、PATCH 限流与异步队列、位移自愈、相关测试与假体的形状。

未验证 / 需真机：

- **CJK 行宽**：`maxProgressLineChars = 120`（`src/feishu/markdown.ts:178`）用 `Array.from(line).length` 按**码点**计数。中文 1 码点 ≈ 2 显示列 → 120 码点 ≈ 240 列，理论上仍可能在卡片代码块里换行、把固定高度窗口撑高。本机无渲染器，需真机抽查一条中文长结果行。（补齐那一半不构成问题：它的不变量是"必然溢出→滚动条恒在"，被补到 100 单元的行必然 ≥100 列。）
- **F5 的用户可见度**：重发/删除连发是否被用户感知（消息顺序跳动），未真机核对。
- **F2 是否会真的发生**：未复现异常逃出，故只作为安全网建议。
- **F3 修好后的"两张卡 + cp 不终结"**：代码路径推理，未在真机跑修复版验证。
- **Go 的 suppress 语义该不该照抄**：影响非 quiet 项目的工具结果可见性，需产品判断。

## 7. 附录：F1 候选实施方案草图（未实施）

**机制**：把 `flushLocked` 的去重从"仅纯文本"扩展到"整卡渲染结果"。

1. 新增私有 `sentKeyOf(text, content)`：`content.status === undefined` 时返回 `text`（纯文本路径语义完全不变）；否则返回由 `text` + `status.state` + `status.ts` + `status.toolCallSeq` + `status.pendingSubtasks ?? 0` + `content.bgTaskHint ?? ''` 拼成的键。
2. 新增 `private lastSentKey = ''`，守卫改为 `previewMsgID !== undefined && key === this.lastSentKey → return`（保留原有"纯文本空串跳过"分支）。
3. **同步台账（必须全部覆盖，漏一处会抑制合法更新）**——`lastSentText` 的全部赋值点（`grep -n "lastSentText = " src/streaming.ts`，共 17 处）：
   - 记录态：`873`（首次发送）、`895`（异步乐观）、`950`（同步成功）、`1241`（`reissueLocked` 重发）、`1836`/`1858`（`markCompletedLocked` 的异步/同步分支）、`1884`/`1904`（`markFailedLocked` 的异步/同步分支）
   - 清空态：`706`（placeholder）、`1356`（`updateProgress` 强制 PATCH）、`1545`/`1553`/`1566`/`1576`（进度 flush 与延迟回调用）
   - 回滚态：`908`/`913`/`930`（瞬态错误、连续失败、队列丢弃三种回滚）
   - 建议把"设 / 清 / 回滚"各自收敛成一个私有 helper，避免以后新增赋值点漏同步。`lastSentText` 必须保留原义——`appendText`（`:726`）用 `runeCount(this.lastSentText)` 计算增量。
4. **测试（先写会失败的）**：
   - 同一秒内 N 次相同内容的思考 flush → `updateMessage` 只增 1 次；
   - 跨秒（`ts` 变化）→ 仍上传；
   - 被跳过之后转入终态（completed / failed / truncated）→ 仍必须上传（`tests/engine/engine-card-progress-finalize.spec.ts` 覆盖三态，不得回归）；
   - PATCH 失败回滚后，下一次相同内容仍上传；
   - `reissueLocked` 之后，相同内容不再重发。
5. **必须保持绿的既有断言**：`tests/streaming.spec.ts:802`（1200ms + 600ms 内 `mp.messages.length >= 2`，标题时钟滞后 ≤ 2000ms）。按秒去重后余量为 0：窗口跨 1 个秒边界即满足；因 `ts` 参与键值，"时钟要走"的语义天然保留。若实测 flaky，应在同一 PR 内把该断言改为"时钟推进"语义，而不是删断言。

**验证口径**：复跑 §2 的脚本，1.2 秒思考流的"不同正文数"应为 1 且 PATCH 次数从 6 降到 ≤ 2。

## 8. 取证命令（供复核）

```sh
cd packages/acp/feishu-bridge
# 去重守卫（F1 的短路点）
grep -n "contentIn.status === undefined && (text === this.lastSentText" src/streaming.ts
# 节流与上限常量（F4）
grep -n "export const progressFlushInterval\|export const maxAnalysisDisplayChars\|const minCodeBlockLineWidth" src/streaming.ts
# 类型漂移两端（F3）
grep -n "typeof provider.progressStyle !== 'function'" src/progress-compact.ts
grep -n "readonly progressStyle: string\|this.progressStyle = parseProgressStyle" src/feishu/platform.ts
# card 内容的唯一生产者（F3）
grep -rn "kind: 'card'" --include=*.ts src/
# 测试假体的形状（F3 为何未被抓到）
grep -rn "progressStyle: () => " tests/
# 零调用者（F7）
grep -rn "resetProgressEntries\|truncateToMaxLines\|progressNoOutputText" --include=*.ts src/
# 位移自愈实测（F5）
grep -c 'preview card sent' ~/.dsh/feishu-bridge-stdout.log
grep -c 'preview card deleted' ~/.dsh/feishu-bridge-stdout.log
```

## 9. 处置结果（2026-09-14 落地）

| 项 | 处置 | 落地与验证 |
|---|---|---|
| F1 思考期重复 PATCH | **已修** | `flushLocked` 增加整卡去重键（正文 + state + ts + toolCallSeq + pendingSubtasks + bgTaskHint）：同一秒内正文与状态都没变时不 PATCH。纯文本路径语义不变；位移自愈不受去重抑制（探测到位移仍重发）。实测 1.2 秒思考流 **5 → 2** 次 PATCH，跨秒仍上传（标题时钟逐秒推进不变） |
| F2 异常逃出回合循环 | **已修** | 三处兜底 catch 各补 `StreamPreview.markFailedIfUnsettled()`（已结算卡不被翻面，避免 drain 阶段失败把绿卡刷成失败）；主处理器按槽位键查状态（其 `state` 绑定在该 try 块内）。新增 `tests/engine/engine-turn-catch-card.spec.ts` 三例 |
| F3 766 行死链路 | **已删**（用户裁定） | `src/progress-compact.ts` 整文件、payload 渲染链、payload 类型与 style 解析器、`spinnerKeyForItems`、平台 `progressStyle` 字段、`progress_style` 配置键、payload 专属测试全删；`TextPreviewContent` 收敛为唯一 seam 类型 `ProgressContent`。残留 `feishu.progressStyle` 改为**加载即报错**——schemastery 会保留未知键，只靠校验会让它变成新的「配了却无效」 |
| F4 旋钮空转 | **已配**（用户裁定 (c) 案） | 新增 `streamPreview.progressFlushIntervalMs`（缺省 300 = 原写死值，`0` = 每次变化都 PATCH）；同批 `streamPreview.maxAnalysisChars`（缺省 6000 = 原 `maxAnalysisDisplayChars` 常量，经 `setStreamPreviewCfg` 透出）；三个老旋钮的 schema 说明改为如实作用域（只作用于出现思考/工具之前的纯文本窗口）。实测旁白 2.4 秒：缺省 9 次、1000ms → **3** 次、0 → 10 次 |
| F5 位移重发连发 | **已加冷却窗** | `previewReissueCooldownMs = 2000`（对齐引擎 `bumpDebounceInterval`）：窗口内抑制的只是尾部搬运，内容仍原地 PATCH；已结算卡本就不重发（入口拒绝），故不需要终态例外 |
| F6 限流桶按机器人共享 | **已按消息分桶** | `patchRateWait(cardKey)` 每 messageID 一桶，随卡片删除释放；**撤掉 bot 级共享门**——它正是「单卡 5 QPS 被摊薄成 5/并发卡数」的根因。残余风险：总吞吐随并发热卡数增长（单卡仍限 5 QPS）；日志出现 230020 时在按消息桶之上加一层 bot 帽 |
| F7 零调用与过期注释 | **已删** | `resetProgressEntries`、`truncateToMaxLines`、`isThinking` 渲染分支（连同与实现矛盾的「5 行」注释）、`CompactProgressWriter.append`（随 F3 一并消失）、`progressNoOutputText` 全删；`padToFixedLines`、`TodoItem`/`isTodoToolName`/`parseTodoItems`、文本路径的 spinner 保留 |

§5 另两项待拍板：**时钟节拍**维持逐秒（秒值参与去重键，语义不变）；**F6** 按消息分桶（见上）。§4 的负结论不变；§6 的未验证项（CJK 行宽、F5 用户可见度、Go suppress 语义是否照抄）仍未真机验证。

有意未做：生成物未重生成（`docs/config-catalog.md` / `.zh.md`、`packages/extensions/tool-cordis/src/api-catalog.ts` 仍列着已删的键与类，按 fork 政策接受漂移）；部署与 `/reload` 由用户手动触发。

决策全文、替代方案与残余风险见 Agent Note：[2026-09-14-feishu-bridge-progress-card-fixes](../../../../.agents/notes/implemented/bug-fix/2026-09-14-feishu-bridge-progress-card-fixes.md)。
