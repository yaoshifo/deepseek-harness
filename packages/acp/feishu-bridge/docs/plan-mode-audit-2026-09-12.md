# Plan 模式实现审计报告

- **日期**：2026-09-12
- **基线**：dev @ fa9b76a005（未推送批次之上）
- **范围**：plan mode 三层实现——核心包 `packages/plan/plan-mode`、feishu-bridge 计划卡与审批链路、提示词引导面与压缩保留层；重点是最近的 fork 改动（de2def5b0e 两层拆分、6cbbfd489b 内嵌拒绝门、215c0e9507 折叠卡、f55c07520e 白话层取图、947fe0eaad/765a901b1b 渲染取消、3d6df58dcd 会话级修订计数、5691013c83/bc9c8a156c 并行引导、797294d9d1/4379cb7e06 压缩保留、1a847c57c6 引导收编、fff1ed7aa2 命令身份修复等）
- **方法**：三个方向并行只读审计（核心包 / bridge 渲染链路 / 提示词与压缩层），每条关键发现逐一复核（正则行为 node 逐例实测、engine.ts 路由逻辑亲读、死代码全仓 grep、压缩实现亲读）。全程只读，未改动任何文件。
- **复审**：2026-09-14（dev @ cb939daaf0）——15 条修复项全数独立复核（13 条属实，#14/#21 勘误），§3 分组与 §4 部署状态按当日 dev 更新，行号漂移说明见 §3。另见同主题补充审计 `plan-mode-audit-2026-09-14.md`（F1 回放门禁已红、F4a 渲染族第 5 缺陷、F6 台账漏记等新增发现与两份报告的合并修复顺序）。

## 总体结论

架构层面健康：投影折叠恢复、会话级修订计数、两层结构化透传（`intent.layers`）、渲染取消族（plan/reply 分族）、压缩保留条款均实现正确且有测试。问题集中在三类：**引导面互相矛盾**（两层契约只教了一半的面）、**审批概览图的生命周期 bug**（4 个，叠加后表现为「图经常缺」）、**提交校验门与文案的偏差**（误报 + 承诺过强）。共 26 条发现（1 高、6 中、3 中低、12 低、3 可简化、1 upstream 继承），其中 13 条建议修（见「建议修复方案」）。

---

## 一、发现清单（按严重性）

### 高

**1. 子任务 skill 教错工具名 `ExitPlanMode`（Go 时代遗留）**
`packages/acp/feishu-bridge/skills/feishu-bridge-subtask/SKILL.md:16,18,22`
三处教模型「调用 `ExitPlanMode`，带一个具体计划」，dsh 注册的真名是 `exit_plan_mode`（plan-mode/src/index.ts:61）。文本源自 Go 引擎 M4 时代；同族 subtask-tool.spec 已清过 M4 漂移，但 SKILL.md 是**唯一没有内容 pin 的引导面**（bundled-skills.spec 只 pin name/provider；复审注：该口径限 subtask/plan 引导面家族——tdd/skillify 的 SKILL.md 正文同样无内容 pin），所以一直漏网。附带 ：16 「plan mode 会拦住它」也不准确——dsh plan mode 是提示词引导，强制门是 exit_plan_mode 的用户评审（2026-08-28 已裁定不加硬门）。
→ 改为 `exit_plan_mode` 并加内容 pin（断言不再出现旧名）。

### 中

**2. bridge patch 的 plan-mode 段仍是单层叙事，与两层约定同请求互相矛盾**
`packages/acp/feishu-bridge/cordis.patch.yml:156,158` vs `src/engine/agent-conventions.ts:44-45`
762ec26255（9-9）引入两层契约时漏了 bridge patch 的第 4 个 delta。plan mode 期间模型同时收到：「计划要详细到另一个工程师能直接实现」「带完整 plan markdown 调用」（patch 段）与「白话层不许出现文件路径/函数名」「实施细节层写进 details 参数」（conventions）。details 参数是 fork-only 特性（upstream 只有 plan 参数），两层卡片的分层提交率被直接拉低。lockstep spec（bundle-patch.spec.ts:152-180）也只登记 3 个 delta。
→ 补第 4 个 delta：退出句改两参数版，「详细到能实现」补「（连同其细节层）」。

**3. 挂起审批时一句澄清就杀死在途 plan 渲染，但审批仍挂着**
`packages/acp/feishu-bridge/src/engine/engine.ts:6041-6045`（routeAskResponse）
`if (approving) cancelPlanRenders else cancelRenders` 在判决路由**之前**执行。plan-review 挂起走 routePermissionResponse：非判决自由文本 → `parsePermissionVerdict` 返回 undefined → 只回 PermissionHint、ask 保持挂起（routePermissionResponse:6204-6209，亲读确认）——但渲染已被杀。用户澄清后点「批准」，看不到概览图。注释声称「the waiting window ended」与实际矛盾；handleCardAction（engine.ts:8958）的卡片点击同样全量 cancel。与 #4 叠加成「图经常缺」。
→ 只在判决实际落定（批准/拒绝/问答结算）时取消；非判决文本不取消。

**4. 渲染去重哈希在启动时记录，失败/被取消也算「已渲染」**
`packages/acp/feishu-bridge/src/engine/plan-render.ts:554-563`（shouldRenderPlan）
`lastRenderedPlanHash/At` 在渲染启动时同步写入；渲染失败或被 #3 杀掉后，同内容 plan 在 rev>1 被 hash 相等永久跳过——图永不重试（markdown 卡兜底存在，但概览图丢失且无状态行）。
→ 哈希改为仅在图片送达（delivered）后记录。

**5. 内嵌细节检测正则有围栏误报与非 ATX 误报**
`packages/plan/plan-mode/src/index.ts:104`（EMBEDDED_DETAILS_HEADING）
node 逐例实测：plan 引用的代码样例含 `` ``` `` 围栏内的 `## Implementation Details` 且未交 details 时被整单误拒，报错指令（「移入 details」）对代码样例自相矛盾；`##Implementation Details`（无空格，CommonMark 里不是标题）与跨行 `##\n实施细节` 也误命中（`\s*` 允许换行）。
→ 逐行扫描 + 跟踪围栏状态，`\s*` 收紧为 `[ \t]*`。

**6. 三处文案承诺强于实际校验**
`index.ts:86`（EXIT_DESCRIPTION "An inlined details section in the plan is rejected"）、`packages/plan/plan-mode/README.md:95`、`agent-conventions.ts:45`（「内嵌会被 exit_plan_mode 直接拒绝」）
实际只匹配 4 个精确 h2 标题（实施细节/技术细节/Implementation Details?/Implementation Notes?）、大小写敏感、标题行不得带其他内容。node 实测漏报：`### 实施细节`、`## 实现细节`、`## implementation details`、`## Implementation Details: files`、`## Technical Details` 全放行。文件内部也不一致：firstHeading 接受 h1–h6，门只认 h2。设计笔记（2026-09-10-plan-details-structured-split）本身措辞是准确的（"without submitting details is rejected"），是三处传播文案简化失真。
→ 文案条件化（「未随 details 提交时会被拒绝」），可顺带把英文变体大小写不敏感、层级放宽到 2–6 级。

**7. 压缩「verbatim 保留两层」是纯提示词实现，无机械校验**
`packages/compaction/compaction-basic/src/summarizer.ts:63,66`
保留规则只存在于 COMPACTION_INSTRUCTION 文本（亲读确认）；摘要模型改写/截短计划会**静默通过**，仅 maxTokens 截断 fail-closed（README limitations 也只承认这一条）。兼容面无问题（老会话单参数自然覆盖）。
→ 候选：frameSummary 落盘前机械比对 shadowed region 里 exit_plan_mode 原参数（可直接读出）与 Critical Context fenced 块逐字一致，不一致 fail-closed；或代码结构化拼接。属设计变更，单独拍板。

### 中低

**8. plan 两层提交约定不注入 plan-mode 子会话**
`packages/acp/feishu-bridge/src/agent-dsh/adapter.ts:550-562`
agentConventionsPrompt（含两层提交约定）只在 plain session 注册；`/sp --plan` 子群（engine.ts:3086-3093 带 subtask 选项）跳过约定，只能从工具 description 看到 details 参数——两层卡在子群大概率退化为单块。
→ 把分层约定拆独立 section 注入 plan-mode 会话（含子会话），或至少在 limitations 记录。动 persona 组装逻辑，单独评估。

**9. feishu-bridge README 仍描述已被撤销的 base「委派句覆盖」机制**
`README.md:34` / `README.zh.md:34`
说「the same patch also overrides the plan-mode section's delegation sentence」，但两个 patch 文件 grep "background subagent delegations" 均 0 命中——1a847c57c6 后 base 是上游原文、无委派句；bridge patch 是「附加三段引导」。fork 跳过 doc-sync，无门禁兜底。
→ 更新因果描述。

**10. 单焦点/并行边界在 ≥4 个模型可见面重复，全局副本缺广度判据**
`cordis.patch.yml:150` + `src/tools/subtask.ts:50-53`（2224 字符/请求）+ `skills/feishu-bridge-subtask/SKILL.md`（frontmatter 318 字符/请求）+ 机器全局 `~/.claude/CLAUDE.md`（经符号链接注入每个会话）
三面收敛（preset 逐字一致）已完成；剩余问题：全局 AGENTS.md 并行条目与工具描述完全重叠，且**未带 bc9c8a156c 的广度判据**——非 bridge 的 fork 会话（headless/web + 通用 subagent 工具）只看得到粗粒度版，328-commit 合并审查被误判单焦点的原故障模式仍可复现。
→ 全局条目退役（有 762ec26255 退役机器条目的先例）或补一句广度判据。

### 低

**11. 拒绝门可被「补交任意非空 details」绕过，测试名名不副实**
`index.ts:319-324`；`tests/plan-mode.spec.ts:887-892`
报错文案说 "(the plan keeps the plain-language layer only)"，但补交非空 details、小节原样留在 plan 里即通过——平铺卡问题照旧。测试名 'accepts the same inlined section once its content rides in details' 暗示内容已移动，实际传入的 plan 仍含 `## 实施细节`。设计笔记将此钉为已接受行为（graceful degradation），故建议只改测试名如实描述，不升级为无条件拒绝（升级路径「required 化」笔记已有预案）。

**12. plan 渲染重试泄漏 cc-plan-render-\* 临时目录**
`plan-render.ts:1007` vs `:1040`
renderPlanToHTML 每次 attempt 新建临时目录且失败不清理；renderReplyToHTML 失败即 removeRenderedTemp。launchPlanRender（:1418/1425/1436）只清最后一次路径——attempt-1 失败 + attempt-2 重试（无论成败）都泄漏 attempt-1 的空目录。两条路径不对称。
→ renderPlanToHTML 对齐 reply 的 per-attempt 清理。

**13. reply 渲染心跳时序保证未真正成立**
`plan-render.ts:1279-1288,1336`
注释称 "stopped before the final PATCH so a late tick cannot reorder statuses"，但 stopProgress 只停未来 tick；已 in-flight 的 tick 可在终态 PATCH 之后落地（`await Promise.allSettled(progressInflight)` 在终态 PATCH 之后才执行）。卡片可能永远停在「渲染中 Xs」。
→ stopProgress 后、终态 PATCH 前排空 progressInflight（三条出口路径都要）。

**14. 挂起审批期间「文本+附件」组合消息被吞，附件未收纳（复审更正 2026-09-14）**
`engine.ts:6222-6241`（routePermissionResponse，当前行号）vs `:6135-6142`（routeQuestionResponse）
原表述「纯附件被吞」不成立：handleMessage（:1988-1991，da72dfd41a 所加、早于审计基线）在 ask 路由之前就把纯附件 stage 并 return——纯附件到不了审批路由，routeQuestionResponse 的纯附件豁免（:6140-6142）在生产上同样不可达。真实缺口是**文本+附件组合**（如「看这张图」+截图）：content 非空不被拦截 → routeAskResponse → verdict undefined → cancelRenders（叠加 #3）→ routePermissionResponse 回 PermissionHint 并消费——附件既未 stage（对比 questions 路径 :6181-6183 有 stage 并存）也到不了模型，用户必须重发。
→ 修法更正：在 routePermissionResponse 非判决分支补附件 stage（镜像 questions 路径的文本+附件处理）；不加纯附件豁免（死检查）。

**15. sentPlanContent 是死状态（Go 残留）**
`engine.ts:467-468`（定义，JSDoc 称 "dedup across asks"）、`:3232`（每回合清零）、`:5539`（条件写入）
全仓 grep 无任何读取者；写入条件无意义。注意保留 launchPlanRender 的同名**参数**（无关）。
→ 删除字段与写入。

**16. getRenderStatus 生产零调用**
`plan-render.ts:668-677`——仅测试读取（plan-render.spec.ts:315 等）。Go parity 导出但属死面。
→ 标注或下沉测试 helper；不动也可（测试依赖它断言状态迁移）。

**17. `get().pending` 与投影 view 的 `pending` 同名异义**
`index.ts:431-435`（返回待生效**目标值**，pending exit 时为 false）vs `src/types.ts:18-27`、`index.ts:176-182`（是否有待生效变更，布尔）。两者都进了 api-catalog 文档。
→ 改名 pendingTarget 或统一布尔。牵扯上游共享 API，宜走上游提案。

**18. 拒绝门新行为的边界未钉测试**
`plan-mode.spec.ts:872-899,1126-1133`——h3/h1/同义词/大小写漏报无测试（当前行为依赖正则巧合）；围栏误报无测试；whitespace-only details + 内嵌小节组合未测；「非空白 details 保持未 trim」未钉。（复审注：:894 已钉一个同义词漏报正例——`## Details` 放行——不在上述列举内；列举项确实全无测试。）

**19. flush 失败窗口内两处状态读取口径不一致**
`index.ts:237`（plan:policy 段乐观读 `pending?.active ?? loggedActive`）vs `:312`（exit 闸门只读 loggedActive）——append 持续失败时模型看到 plan guidance 但工具报 "only available in plan mode"。窄路径，两处注释已各自声明意图但无交叉引用。
→ 注释互指即可。

**20. ctx.planMode.get 无生产消费者**
`index.ts:431`——仓库内只有测试调用；无 @Remote；Web 客户端读投影 view。按仓库自家规则（"Require a current owner and need"）属无主 API。
→ 删或留档说明预期消费者。同 #17 宜上游提案。

**21. README conventions 段尺寸声明过期（复审勘误 2026-09-14：实测 1961，非 2222）**
`feishu-bridge README.md:48`——写 "roughly 1900 characters"（fe8461f74c 口径），其后 4 个提交扩到复审实测 **1961**（原报告的 2222 系量错对象：subtask 工具描述实测 2231）。实际过期仅 +3.2%，严重性低于原表述。
→ 更新或删掉数值（数值声明最易过期）。

**22. bridge patch 头注释「four transformations」与 lockstep spec 3 个 replace() 口径不一**
`cordis.patch.yml:141` vs `bundle-patch.spec.ts:162-178`——委派句本就嵌在 delta 1 里。若做 #2 则自然变成真 4 个，一并改准。

### 可简化（不建议动）

**23.** sendPlanContent/sendInlinePlanContent 尾部重复——`engine.ts:5772-5794` vs `:5853-5870`，只差内容来源，卡片参数与 export 按钮字面量双份。抽私有 helper 消 ~15 行。
**24.** launchPlanRender/renderAndDeliverReply fork 骨架重复——`plan-render.ts:1363-1442` vs `:1242-1344`，pre-flight/attempt 循环/deliver/finally 成对重复。纯重构、风险大于收益。
**25.** renderSessionPrompt/renderReplySummaryPrompt 前言 3 段逐字重复——`plan-render.ts:123-141` vs `:151-169`（渲染会话定位 + skill 全文声明 + SVG 规则）。

### upstream 继承（fork 不动）

**26.** preset 与 base 的 plan-mode 段 3 字符措辞差（"tool catalog unchanged" vs "request shape stable"）——upstream master 原文即如此，可作上游 PR。

---

## 二、已验证无问题的面（避免重复排查）

- 投影折叠/`planRevisionCount`：stateVersion 3 来自上游迁移（1a72ae202a），单调正确；stall-retry（仅换 agentSession）、/fork（新 sessionKey 新 state）、state 回收（旧 plan:N 导出走 "session expired" 兜底）边界均正确。
- 并发：pendingIntents 布尔域使 between-turns 分支不可能丢更新（全部 set/boundary 交错推演过）；command/done 单槽是 types.ts 声明的 latest 语义；disposed 守卫有测试。
- fff1ed7aa2 命令身份修复干净：dsh-commands 保持 optional peerDependency、仅剩 type-only import、dsh-brand 正确落 dependencies。
- f55c07520e 白话层取图正确：`planLayers?.plain ?? planContent`，fresher-file 覆盖时 layers 同步置 undefined；6cbbfd489b/de2def5b0e 的 bridge 跟随改动（约定文案、layers 透传）映射一致。
- applyPermissionPreset 降级安全（adapter.ts:2525-2538）。
- i18n：plan_details_panel 等 5 locale 齐全，en+zh 门槛满足；渲染会话 prompt 属模型侧文案不受 locale 约束。
- 三份 preset 的 plan-mode 段逐字一致（实测 sha 相同）、1a847c57c6 回退干净。
- compaction README 指令摘录与代码逐字同步。
- 两层拼接 / intent.layers / presentCall 分段均有测试且与 README 一致；plan-mode 73 个单测当前全绿。

## 三、建议修复方案（未实施，供日后启用；复审 2026-09-14 更正分组与快照口径）

**分组更正**：原「三组文件面不相交」不成立——原 A 组 #6 与原 C 组 #5/#18 都要动 `packages/plan/plan-mode/`。更正为三组真正文件互斥，13 项全部 TDD（先红后绿）：

**组一——plan-mode 包（#5、#6 包内两处、#11、#18）**：内嵌检测改逐行扫描（跳过围栏、`[ \t]` ATX 空格、英文大小写不敏感、层级 2–6）+ 表驱动边界测试补齐；`index.ts:86` 与 `README.md:95` 两处「会被拒绝」文案条件化（钉死措辞：中文「未随 details 提交时会被拒绝」，英文 "rejected unless its content rides in `details`"）；#11 测试改名。09-14 补充审计的 F3（`/plan` 文案、guard 判据、描述自洽）与 F8（`set()` 直提交、pre-step 守卫测试）同在本包文件，并组执行。

**组二——bridge 引导面（#1、#2、#6 桥侧、#9、#21、#22）**：SKILL.md 改真名 + 内容 pin（断言不再出现旧名）；bridge patch 补第 4 个 delta（退出句两参数化 + 「连同细节层」）+ lockstep spec + 头注释口径；`agent-conventions.ts:45` 文案条件化；README 两处过期事实更新。09-14 补充审计的 F2（假保护声明改义务陈述）与 F7（README:75、永真断言、三份 note、chatroom 死文本）同面并组。

**组三——bridge 渲染生命周期（#3、#4、#12、#13、#14、#15）**：判决落定才取消渲染；哈希改送达后记录；渲染失败 per-attempt 清理临时目录；终态 PATCH 前排干心跳；#14 按勘误后修法在 routePermissionResponse 非判决分支补附件 stage；删 sentPlanContent 死状态。09-14 补充审计的 F4a（取消与落盘时序）与 F5 死代码项同文件并组。

**行号漂移（复审口径，dev @ cb939daaf0）**：本文行号为基线 fa9b76a005 口径。engine.ts 净 +53——#3 取消块现 :6059-6063、routePermissionResponse :6222-6241、handleCardAction :9011、#15 三点 :469/:3242/:5549；plan-render.ts 净 +2——#4 区域 :554-564 无漂移，#12 现 :1011/:1018 对 :1044，#13 现 :1280-1292/:1340，launchPlanRender :1397-1443。70d9e91d33 在取消块上游加 machine 豁免（:6027-6034），缩小了 #3 的 machine-wake 子场景，人类文本主场景不变。

**快照刷新（复审升级，合并 09-14 F1）**：6 份 expected 样本现已过期、web 回放门禁已红——刷新必须在组一/组二全部模型可见文案改完之后一次性做（受影响 lane = 网页 + 会话；2 份 pwsh 样本手工对齐），不可先刷。改完跑受影响包定向单测；提交 dev 随既有批次走，push/reload 手动。

## 四、已裁定与已知未决（不在本方案内）

- **plan 模式无硬门**：2026-08-28 已裁定暂不加固（候选缓解与 Claude Code 对照参考在案）。
- **审批停卡两个已知缺口**（9-3 在案）：停卡被中断/reload 吞掉后无法再点「允许」；文本「允许」不结算审批不切预设。缓解候选①停卡恢复（修根因不改契约）②批准类文本结算（与 README 裁定冲突，需另行拍板）。
- **待部署复测**（既有清单；复审 2026-09-14 更新）：36ab6062ae/4379cb7e06/b187efe2bd（执行分组归细节层）已推送（origin/dev 已含），live lib 已于 09-14 14:35 重建（live profile 软链直连本仓库）；复测点不变=新会话计划细节层出现分组标注。cb939daaf0 起 /status 可直接查 daemon 构建年龄与漂移。

## 五、审计方法备注

- 三个并行审计各自只读；全部高/中发现均经复核（正则 node 实测、路由代码亲读、grep 验证死代码、压缩源码亲读），低危发现抽核。
- 审计中发现的路径勘误：presets 实际在 `packages/preset/agent-presets/`（非 packages/bundle/agent-presets）。
