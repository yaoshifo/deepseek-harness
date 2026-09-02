# chatroom 抽取为独立插件包：实施计划与调研底稿

> **状态**：计划已批准，本次未实施。恢复实施时以本文档为准，动手前按仓库惯例重新核实代码现状（行号基于 2026-01-30 的 dev 分支）。
>
> **背景**：chatroom（多角色聊天室）现实现于 `packages/acp/feishu-bridge`：`src/engine/chatroom*.ts` 7 个模块（3796 行）+ `src/tools/chatroom.ts`（275 行），另有 12 个专项测试（3790 行）、i18n 79 个 key、`skills/feishu-bridge-chatroom-moderator`、`ChatroomConfig`。目标：整体迁出到新包 `@deepseek-ai/dsh-feishu-bridge-chatroom`（`packages/acp/feishu-bridge-chatroom/`），依赖方向 **chatroom → bridge**（bridge 不 import chatroom），行为零变化，让 feishu-bridge 保持纯净。
>
> **与 B8「明确不做」的关系**：`docs/DEBAGGAGE-ROADMAP.md` 的负结论是「不把 chatroom 内部机制换成原生 dsh 能力」（persona 目录/账本/群形态是产品本体），本计划只动代码归属与表达机制，不改产品语义，不冲突。

## 一、与 dsh 插件规范的对照（评审已确认）

| 设计点 | 规范依据 | 结论 |
|---|---|---|
| chatroom 作为兄弟插件挂载（bundle patch 自 mount） | architecture.md「no privileged core: extend by mounting a plugin beside the others」；dsh-headless→code-runtime-worker-thread 先例 | ✅ |
| `inject: ['feishuBridge']` 声明依赖 | cordis-primer「Declare service dependency via inject」（加载顺序由服务要求表达，非手工排序） | ✅ |
| 拦截/策略走 typed events，不走手搓 hook | cordis-primer「Prefer events for interception and policy; prefer service methods for direct capability calls」——手搓策略投票接口不合规，须用声明合并的 `feishuBridge/*` 事件 | 🔧 已在计划中修正 |
| 单决策策略 = waterfall 短路；options 装饰 = waterfall 改共享对象后 next()；观察 = emit | cordis-primer Waterfall Semantics（「For single-decision events, short-circuiting is the design」） | ✅ |
| 事件 JSDoc 带 `@mode` 与 payload `@param`，dispatch 模式是公开契约 | 根 AGENTS.md typed events 规则 | ✅ |
| 能力缝三角色完整：SD = bridge 扩展服务定义 / SP = bridge / Consumer = chatroom | architecture.md Capability seams（one role alone is not a seam） | ✅ |
| 函数插件形态：named-export name/inject/Config/apply，无 default export | packages/AGENTS.md（postmortem 0001-acp-default-export-drops-inject） | ✅ |
| 注册皆可逆 effect（命令/工具/skill/事件监听都返回 disposer）+ HMR 安全测试 | cordis-primer「Registrations are reversible effects」+ testing policy | ✅ |
| 消费跨插件 typed events 的可行性 | feishu-bridge 自身已在消费 `subagent/end`（src/index.ts:919）与 `approval/request`（adapter.ts:706） | ✅ 有本包实践 |
| 单消费者 seam 的正当性 | 「Require a current owner and need」：owner=chatroom、need=现有行为外移；每个事件/方法命名引擎既有决策点，非投机抽象；理由写入 Agent Note | ✅ 附条件 |

实现要点：Engine 不持有 cordis ctx，事件由 FeishuBridgeService 侧分发——服务向 Engine 注入一个 dispatch 面（emit/waterfall/serial 的薄包装），engine 决策点改为经它分发。

## 二、目标与成功标准

chatroom 全部产品面从 `packages/acp/feishu-bridge` 迁出到新包 `packages/acp/feishu-bridge-chatroom`，依赖方向 chatroom → bridge，行为零变化。

- bridge 的 `src/` 内 grep chatroom 仅剩 v2→v3 快照迁移的 18 个旧字段名原样搬运（不解释语义）。
- 门禁绿：typecheck / lint / test / build / hygiene / constraints / verify-cordis-config；knip 与 tsconfig wildcard 对 acp 组自动覆盖，仅 tsconfig.host.json 加一行 reference。
- chatroom 包有 REAL-composition 测试（经 Loader 起 bridge+chatroom 的 cordis.yml，packages/AGENTS.md 要求）与 HMR dispose 测试。
- 生产 profile 挂新 bundle 后 /reload 冒烟通过（用户执行 reload.sh）。

## 三、关键决策

1. **bridge 服务化**：新增 `FeishuBridgeService extends Service`（`super(ctx, 'feishuBridge')`，先例 SkillRegistry），暴露 live 项目（name/engine/adapter）、`route(caller) → {engine, sessionKey}`、命令注册（服务方法，直接能力调用）、`feishuBridge/*` typed events。导出面用专门 extension 导出模块收窄（SubtaskAgentRouter 类型、engine 通用符号、i18n 查表助手），不整只导出 Engine 类。
2. **扩展事件面**（通用命名，对应 engine.ts 147 处 / session.ts 175 处 / adapter.ts 24 处内联分支）：
   - `feishuBridge/permission-policy`、`/mode-policy`、`/rename-exemption`、`/auto-render-policy`：waterfall，单决策短路（权限豁免、moderator plan 降级、spawn 改名豁免、auto-render 抑制）
   - `feishuBridge/session-start-options`：waterfall，改共享 options 对象后 next()（现 buildSessionStartOptions chatroom 块，persona 语义泛化）
   - `feishuBridge/turn-start` / `feishuBridge/turn-end`：ask stamp（需改队列元数据，serial 带返回）与 role 回复 relay（路由决策，waterfall）
   - `feishuBridge/ask-approval`：waterfall（plan-review 自动批准）
   - `feishuBridge/platforms-ready`：emit（barrier 恢复）
   - 队列 opaque metadata 透传：QueuedMessage.chatroomAskSeq/AwaitAssistant 泛化为不透明 metadata（engine.ts:259-261 + core/types.ts:198-204）
   - 家族头像 capability 改通用名（core/types.ts:1040 已是能力接口形态）；renameHubToTopic 泛化为可注入命名器，chatroomHubGroupName 随包走；工具家族颜色改注册时声明（streaming.ts:254）
3. **持久化：不透明 featureState 分节（快照 v3）**：session 快照新增 `featureState: Record<string, unknown>`，bridge 原样持久化/透传/随 carryChatScopedState 携带；编解码器、typed 句柄、recoverChatroomBarriers 全归 chatroom 包经 codec 注册接口挂载。字段留在 session.ts 会迫使 bridge 反向 import chatroom 类型（类型环），不透明分节是唯一干净方向；B7 的 v1→v2 是迁移先例。注：chatroom 状态留在 bridge 自有 sessions.json 快照（bridge 的会话路由存储），不涉核心 SessionEventMap。
4. **前置拆分**：chatroom-persona.ts 混装的 4 个非 chatroom 通用 prompt（:229/:250/:272/:294，adapter.ts:33-39 依赖）先拆回 bridge。
5. **配置迁移**：ChatroomConfig（index.ts:616-627 项目级 + :715-726 顶层 + wireChatroom :1382）迁为 chatroom 插件自身 Config（`defaults` + `projects: Record<项目名, …>` 按名对齐 bridge projects）；生产 cordis.patch.yml 是用户侧自演化层（install.sh 永不覆盖），提供迁移片段由用户合并。

## 四、实施批次（每批独立提交、独立可上线、全绿后进下一批）

**C1 桥侧扩展面（行为不变，chatroom 仍住桥内但全部走服务/事件）**
FeishuBridgeService + 收窄导出；全部 `feishuBridge/*` 事件声明与分发面；队列 metadata 泛化；persona 文件拆分；i18n 助手导出；头像/改名泛化。桥内受影响测试同步改缝。不动持久化格式。

**C2 建包与搬移**
新包骨架（package invariants、./invariant、README 含 Model Experience + Known Limitations）；搬 8 个源文件（约 4.1k 行）+ 12 个专项测试（3.8k 行）+ skill 目录 + i18n 子表；bundle patch 自 mount；REAL-composition + HMR 测试；bridge 删除 chatroom 面；快照 v3 + 迁移用例（含 barrier 跨重启恢复语义保持）。

**C3 配置与部署收尾**
ChatroomConfig 迁移 + wireChatroom 重写为插件 apply；profile 模板 + 生产迁移片段；Agent Note（决策、单消费者 seam 理由、事件 dispatch 模式选择、迁移语义）；双方 README/JSDoc；真机冒烟清单（pick 出卡、research venv、end 排空、重启恢复）交用户 /reload 执行。

## 五、测试与验收

- 12 个搬移 spec 语义不变；桥内 15 个含 chatroom 引用的测试文件改事件/服务桩，覆盖不降级。
- 新增：REAL-composition、HMR dispose、v2→v3 迁移用例、每个新事件的决策路径正反用例（wire mechanically checkable invariants into an executed gate 的要求落在专项 spec）。
- 零行为重构，既有快照基线不动（test:snapshot 不涉 feishu 侧时无感）。

## 六、风险与回退

- **最大风险：改造中语义漂移**（ask stamp 排空路径、gather fan-in、wake 通道）。缓解：C1 先事件化并全套测试绿再搬移；每批独立 revert。
- **生产切换**集中在 C2/C3：sessions.json v2→v3 一次性迁移 + profile 配置搬迁；在跑 chatroom 的 barrier 恢复有专项测试（engine-chatroom-recovery 语义保持）；切换由用户经 reload.sh 执行。
- **导出面冻结**：窄 extension 模块而非整只 Engine 类，控制公开承诺面。
- **规模估计**：源面 ~4.3k 行搬移 + 桥内 ~320 处引用改造；测试面 3.8k 行搬移 + 15 个文件（约 9.8k 行）中的相关用例调整。

## 七、明确不做

- 不改 chatroom 产品语义（B8 负结论维持：persona 目录/账本/群形态/gather barrier 机制原样，只动代码归属与表达机制）。
- 不把 chatroom 抽成通用 dsh capability（它是 feishu-bridge 产品功能，非跨产品能力）。
- 不动 cron / relay / subtask / monitor 等其它面。

---

## 附录 A：chatroom 与引擎核心耦合面清单（调研全文）

引用计数核实：engine.ts 147 处、session.ts 175 处、adapter.ts 24 处。chatroom 模块 importer 闭环：engine.ts、session.ts（纯 type-only inline import）、index.ts、agent-dsh/adapter.ts、tools/chatroom.ts，共 5 个。

### A.0 模块构成

- 本体 7 文件 3796 行：engine/chatroom.ts(1709)、chatroom-pick.ts(694)、chatroom-cmd.ts(549)、chatroom-persona.ts(314)、chatroom-priming.ts(264)、chatroom-ledger.ts(136)、chatroom-roles.ts(130) + tools/chatroom.ts(275)
- 其中 4 个文件已零引擎依赖：chatroom-ledger.ts（仅依赖 ../atomicwrite.ts:17）、chatroom-roles.ts（仅 node fs/os/path:10-12）、chatroom-persona.ts（仅 node fs/path:16-17）、chatroom-priming.ts（仅 chatroom.ts 的 ChatroomRole 类型:12）

### A.1 持久化状态（Session/Engine 字段）

**进 sessions.json 快照的 Session 字段**（session.ts 声明 → serialize → wire）：

- chatroomHubKey(s:89)、chatroomRoleName(:91)、chatroomAsked(:93)、chatroomResearch(:95)、chatroomDirectRole(:97)、chatroomModerator(:109)、chatroomResearchMode(:111)、chatroomResearchRound(:113)、chatroomResearchMaxRounds(:115)、chatroomGatherSeq(:117)、pendingHumanQuestionRole(:123)；research 配套：researchAssistantKey(:99)、researchAssistant(:101)、researchAwaitingAssistant(:102)、researchVenv(:119)
- 序列化：SerializedSession 类型 s:1101-1117；serializeSession s:1122（chatroom 字段 1150-1164；barrier 快照 s.pendingGather?.snapshot() 于 1124-1125→1165-1166）；反序列化 deserializeSession s:1198-1214；v1 snake_case 兼容 LegacySessionV1 s:1261-1273 + deserializeSessionV1 s:1306-1319；写盘 SessionManager.save→atomicWriteFileSync s:1697
- **半持久 barrier 快照**：pendingGatherData(s:132)/pendingEndBarrierData(s:137) 落盘，启动时 recoverChatroomBarriers（chatroom.ts:1439-1448）消费后清 undefined；快照类型 GatherBarrierSnapshot/EndBarrierSnapshot 定义在 chatroom.ts:98/110

**纯内存 Session 字段**：chatroomAskSeq(s:107)、chatroomInFlight(s:121)、pendingGather(s:125)/pendingEndBarrier(s:127)（armed barrier 类实例，类本体 ChatroomGather/ChatroomEndBarrier 在 chatroom.ts:125/228）

**生命周期继承**：carryChatScopedState s:172-204（chatroom 身份块 184-193 + barrier/待答问题 198-204）——/new、idle reset 不孤儿化 chatroom 身份，引擎所有。

**Engine 配置字段**（纯内存）：engine.ts:928-950 共 11 个（chatroomGatherTimeout/EndTimeout/ResearchTimeout、maxChatroomResearchRounds、defaultChatroomResearchMode、chatroomRolesDirCfg、maxChatroomRolesCfg、chatroomModeratorDirCfg、chatroomResearchWorkspaceCfg、chatroomResearchPythonEnv、chatroomIsolateRoleContext）；setter 集 engine.ts:5317-5473；装配 index.ts:1376-1418 wireChatroom；Config schema index.ts:616-627（顶层）+715-726（per-project），类型 index.ts:443-449。

### A.2 消息流转分支（engine.ts）

- 启动恢复：:1425-1427 recoverChatroomBarriers(this)（平台就绪后关盘上 barrier）
- 入站优先级：:1611-1614 routePendingHumanReply 高于命令分发与权限处理（chatroom ask-human 待答路由；实现 chatroom.ts:940）
- 队列元数据：QueuedMessage.chatroomAskSeq/chatroomAwaitAssistant :245-262（259-261）；入队拷贝 :2036-2037；协议字段在 core/types.ts:198-204
- 回合开始 stamp：:2167-2169（processInteractiveMessageWith 入口）；排空路径 :3722-3724 与 :3893-3896；实现 stampChatroomAskOnTurnStart :6758-6771
- 回合结束 relay：:3569-3572 maybeAutoRelayRole（角色回复转 hub+唤醒；实现 chatroom.ts:975-1155，含 stale-round 守卫 983-990、research defer 991-1005）
- start options 装饰：buildSessionStartOptions :2657-2707（hub 非创建查找 2658-2662、chatroom 块 2663-2688、注入 2703）；hub 查找同时被 isResearchSession 复用
- ask 交互：plan-review 自动批准 :4667-4673（chatroomPickActive）；research-manual 整卡超时 :4810-4814 armResearchManualAskTimeout（实现 chatroom.ts:1685）
- 卡片路由：:7775-7792 /chatroom-pick、/chatroom-topic-pick → executeChatroomCardAction
- 研究调度：markResearchDispatch :6520-6528；hard-cap 豁免 isResearchSession :1241-1255
- 人接管：markUserInterjectedOnHumanTurn :6773-6788（调用点 :1670-1672）
- gather 语义边界：gatherSubtasks 注释 :6838-6842（chatroom 角色无 depth，不入 subtask gather 预期集）
- idle spawn：:5865-5872（chatroom --research 空消息预置 assistant，spawnSubtask 通用能力）
- 唤醒通道：wakeChatroomModerator（chatroom.ts:853-878）经 e.receiveMessage 合成注入；并发流 per-session interactive state 注释 :4200-4207

### A.3 策略类挂点

- 权限豁免：adapter.ts:334-349 sessionBypassesPermissions（role/directRole→bypassPermissions）；应用 :1569-1573+:1587
- plan 降级：adapter.ts:1588-1594 moderator 强制 default（防 ExitPlanMode 卡死）
- bare persona 组装：adapter.ts:455-534 buildSessionSetup（suppress 工作区指令注入 :511-512、deny skill 工具 :517-520、complete 替换系统提示 :521-532）
- MCP mask 组合：adapter.ts:1493 withMcpMask(buildSessionSetup(...))——mask 本身通用，chatroom setup 与之复合（mask 实现在 :396-434）
- auto-render 抑制：session.ts:841-852 shouldSuppressAutoRender（chatroomHubKey!==''||subtaskDepth>0 且未被接管）
- 改名豁免：groupname.ts:351-362 sessionExemptFromSpawnRename；chatroomHubGroupName 纯函数 :339-349
- hub 改名+家族头像：engine.ts:7423-7474 renameHubToTopic（:7438 用 chatroomHubGroupName；:7460-7463 setChatroomFamilyAvatar）
- 平台能力接口：core/types.ts:1040-1043 ChatroomFamilyAvatarSetter + :1417-1423 asChatroomFamilyAvatarSetter；实现 platform.ts:2603-2657；phase 语言豁免 platform.ts:2327-2333、:2363-2372；家族配色 avatar.ts:46-56
- 工具家族颜色：streaming.ts:254 agentTools 含 'feishu_bridge_chatroom'
- help 分组：misc-commands.ts:68 ['chatroom','session']

### A.4 chatroom 模块反向依赖（最小 API 面）

**从 engine.js 导入**（chatroom.ts:19-21、chatroom-cmd.ts:12-13、chatroom-pick.ts:11-12）：类型 Engine/InteractiveState + 运行时 emptyMessage/jumpButtonsMarkdown/parentJumpButtons；chatroom-cmd 另用 worktree.js WorktreeMode(:39)。

**Engine 方法面**（插件实际需要的能力）：

- 会话注册表：e.sessions（getOrCreateActive/findActive/allSessions/sessionKeyMap/save）
- 消息/回复：e.receiveMessage（wake 合成注入）、e.reply、e.sendAsCard、e.simpleCard
- 平台/生成：e.spawnCapablePlatform、e.spawnSubtask（research assistant 预置）
- 生命周期：e.stopInteractiveSession、e.cleanupInteractiveState
- fan-in：e.collectSubtree、e.drainNativeDescendants
- ask：e.settlePendingAskDefaults
- 展示：e.subtaskParentLabel、e.buildSpawnNotifyCard
- 工作目录：e.perChatWorkDir、e.dirOverrideKey、e.projectState
- 命令注册（直接改引擎槽位）：e.commandHandlers、e.commandResolver（chatroom-cmd.ts:60-78）
- 10 个配置 getter + e.i18n + e.renameHubToTopic

**Session 方法面**：14 个 chatroom getter/setter（session.ts:394-747）+ pendingGather/pendingEndBarrier(:718-747) + research 系列 + parentSessionKey/agentSessionID。

**Platform capability 面**（core/types.js）：asGroupSpawner、asReplyContextReconstructor、asCardSender/WithUpdate、asGroupRenamer——已是能力接口模式。

**tools/chatroom.ts**：cordis ctx.tools.register + defineTool(:85)，依赖 tools/subtask.ts:37 SubtaskAgentRouter 类型 + engine/chatroom.js 9 个函数 + chatroom-pick 2 个渲染函数 + chatroom-roles。

### A.5 结论

**可抽为 feishu-bridge 通用扩展点**：

1. 命令注册表——registerChatroomCommands 已是 (engine)→disposer 形态（chatroom-cmd.ts:60-78，含 resolver 包装与别名前缀匹配），引擎只需公开 registerCommand API + help 分组声明（misc-commands.ts:68 随注册声明）
2. 工具注册——registerChatroomTool 已用 ctx.tools.register；把 SubtaskAgentRouter 提升为包导出类型即可
3. session start options 装饰器——engine.ts:2663-2688 chatroom 块改钩子链；SessionStartOptions.chatroom（core/types.ts:422-432）建议泛化为通用 persona options（role/directRole/moderator/research/ledgerDir 均为 persona 语义）
4. persona/setup 映射 + 策略接口——adapter.ts:466-533 的 chatroom 分支注册为 options→setup 映射；sessionBypassesPermissions(:346) 与 moderator plan 降级(:1594)改为 session 策略投票接口
5. 回合生命周期钩子——turn-start stamp（3 call site）、turn-end relay(:3572)、plan-review 批准(:4670)→ onTurnStart/onTurnEnd/onAsk 事件；QueuedMessage 的 chatroomAskSeq/chatroomAwaitAssistant（engine.ts:259-261+core/types.ts:198-204）泛化为队列 opaque metadata 透传
6. 引擎启动钩子——recoverChatroomBarriers 调用点(:1427)改 platforms-ready 事件
7. 头像/改名——ChatroomFamilyAvatarSetter 已是 capability（core/types.ts:1040），platform 是实现方，天然可随插件走；renameHubToTopic 需 feishu-bridge 暴露 LLM 改名设施
8. 工具家族颜色——streaming.ts:254 改注册时声明 family；配置 11 字段+setter+wireChatroom 全部转插件自持 Config
9. wake 通道——e.receiveMessage+reconstructReplyCtx 均为引擎公共方法，直接复用无需新扩展点

（计划修订说明：A.5.3/4/5 中的「钩子链 / 策略投票接口」表述在规范对照后统一修正为 `feishuBridge/*` typed events，见正文第三节。）

**必须留在引擎核心**：

1. Session 持久化字段与 sessions.json 序列化/迁移（session.ts:88-137、1122-1217、1261-1319）——单一快照格式为引擎所有；除非引入插件 session 扩展字段序列化机制（typed extension bag），14 个 chatroom 字段+4 个 research 字段留在 session.ts（pre-release 可顺势改名）
2. carryChatScopedState（s:172-204）——/new、idle reset 生命周期引擎所有
3. barrier 并发模型——armed barrier 实例挂 Session(s:125-127)、gatherSubtasks depth 语义(:6838-6842)、isResearchSession hard-cap 豁免(:1247)；可泛化为「opaque barrier 句柄+snapshot 工厂」接口（session.ts:132/137 已用 inline import() 引用 chatroom 模块类型，方向已对，运行时无反向环）
4. 队列/排空路径元数据消费（stamp 3 个 call site 与排队模型强耦合）——钩子化后只留通用透传
5. Message 协议字段（core/types.ts:198-204）——入站协议层，泛化 metadata 后可解

（计划修订说明：A.5「必须留在引擎核心」第 1 条的「字段留在 session.ts」方案在计划定稿时被否决，改为不透明 featureState 分节 + 插件自有 codec（正文第三节决策 3），理由是 barrier 句柄类型会迫使 bridge 反向 import chatroom 包。）

**调研中的额外发现**：

- chatroom-persona.ts 混装非 chatroom 通用 prompt：agentConventionsPrompt(:294)、subtaskAgentSystemPrompt(:229)、subtaskNoReportAgentSystemPrompt(:250)、subtaskResearchAssistantPrompt(:272)，被 adapter.ts:33-39 依赖——抽包前必须先拆文件，通用 prompt 留 feishu-bridge（否则 adapter 反向依赖插件包）
- skills/feishu-bridge-chatroom-moderator 随包分发 skill 目录需带走；i18n 79 个 key（keys.ts:307-378,694-717）+messages.ts 64 处为纯搬移

### A.6 测试统计

**专项 chatroom 测试 12 文件共 3790 行**：engine-chatroom.spec(1136)、engine-chatroom-gather(724)、chatroom-persona(324)、engine-chatroom-end(352)、engine-chatroom-recovery(225)、chatroom-session(169)、engine-chatroom-interrupt(168)、engine-chatroom-venv(174)、chatroom-ledger(116)、chatroom-roles(97)、tools/chatroom-tool(187)、assembly-chatroom(118)

**另 15 个文件含 chatroom 引用共 9817 行**（只需改其中相关用例）：engine-events(2109)、engine-subtask(1975)、adapter.spec(1300)、stubs/engine-stubs(742)、commands(808)、engine-groupname(672)、session.spec(624)、engine-m3-permission(423)、adapter-mcp-mask(280)、attachment-staging(246)、commands-fork-at(197)、recall(154)、avatar-icon(147)、bundled-skills(70)、shutdown-assembly(70)

含引用测试合计 27 文件 13607 行。

---

## 附录 B：插件组合机制调研（调研全文）

### B.1 cordis 插件组合方式

**层次模型**（docs/architecture.md:15-37, packages/boot/app-boot/src/profile.ts:5-22）：

- **profile** = `$DSH_HOME/profiles/<name>/` 目录：`package.json`（`dsh.profile.bundles` 有序 bundle 列表 + `dependencies` 作 resolver manifest）+ `cordis.patch.yml`（用户 patch 层）。
- **bundle** = npm 包，package.json 声明 `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`（feishu-bridge: packages/acp/feishu-bridge/package.json:50-54；dsh-base: packages/bundle/base/package.json 同构）。
- **组合顺序**：空根 → 各 bundle patch（按 bundles 列表序）→ profile 自己的 cordis.patch.yml → home 层 `~/.dsh/cordis.patch.yml` → `--patch` overlays（apps/cli/src/profile-boot.ts:135-155 `composeProfile`）。
- **patch 语义**：按 `id` 定位行、`config` 整体替换（非深合并）、`- insert:` 插新行、`disabled: true` 关行。后层 bundle 可按 id 改写前层（dsh-base）的行——feishu-bridge 的 bundle patch 就 disable 了 dsh-base 的 hmr 行并改 subagent 行 config（packages/acp/feishu-bridge/cordis.patch.yml:13-23）。
- 根 cordis.yml 直接声明插件（examples/ 模式）：每行 `- id: <行id> name: '@deepseek-ai/dsh-<pkg>'` + 可选 config。
- `!!js` 只允许出现在行的 `config` 与 `disabled`；其余 metadata（id/name/group/inject/intercept/isolate）保持字面量（scripts/verify-cordis-config.ts:20 metadataFields；docs/cordis-primer.md:38）。

**声明依赖另一个本地插件包（workspace 包）的写法**：

- 运行时代码依赖（import + ctx.plugin）：包 package.json `dependencies` 写 `"@deepseek-ai/dsh-x": "workspace:^"`（scripts/check-workspace-constraints.ts 的 `checkWorkspaceProtocol` 强制 workspace: 协议），tsconfig.json `references` 加该包目录（feishu-bridge tsconfig.json:42 即 `../../skill/skill-filesystem`）。
- cordis.yml/bundle patch 里以 bare 包名引用插件：该引用必须能从「所在层的 resolver manifest」解析——examples 层是 examples/package.json，app 层是 apps/cli/package.json ∪ 全部 bundle manifests，bundle patch 层是该 bundle 自己的 package.json dependencies。

**verify-cordis-config 门禁**（scripts/verify-cordis-config.ts）：

- 扫描全部 `**/*cordis*.yml`（排 node_modules/vendor/i18n sidecar）。
- `validateExampleResolution`(226-248)：examples/ 配置里每个 name 必须在 examples/package.json dependencies 且 root tsconfig 有项目引用。
- `validateAppResolution`(250-279)：app overlay 行解析自 apps/cli ∪ bundle manifests。
- `bundlePluginDependencyErrors`(300-311)：每个 bundle 的 patch 文件引用的包名（mount 自身除外）必须声明在该 bundle 自己的 dependencies。先例：dsh-headless 的 patch 插入 `@deepseek-ai/dsh-code-runtime-worker-thread` 行，其 package.json dependencies:48 即声明之。
- `validateSourcePlaneResolution`(322-362)：本地包 specifier 必须经 tsconfig.base.json `paths` 解析到 `.ts` 源（防 source launch 依赖 built lib）。

**运行时解析（部署侧）**：Loader `baseUrl` = 配置文件所在目录即 profile 目录（packages/boot/app-boot/src/index.ts:769）；bundle 名双锚点解析（先 dsh 安装、后 profile 目录，profile.ts:344-355）；`$DSH_HOME/profiles/node_modules` 是 launcher 维护的扁平 symlink 闭包（BFS app+bundle 依赖含 peerDependencies，profile.ts:223-255）——被 link: 的包自身依赖从其真实目录解析，每个包只需一条 link。

### B.2 插件间依赖先例（A 在 apply 里 ctx.plugin(B) / import B 运行时码）

| 先例 | 位置 | 形态 |
|---|---|---|
| feishu-bridge → dsh-skill-filesystem | packages/acp/feishu-bridge/src/index.ts:16 `import * as SkillFileSystem`；:766 `ctx.plugin(SkillFileSystem, {...})`；package.json:43 依赖 `workspace:^` | 函数插件 A 挂函数插件 B（带 config），这是最贴近 chatroom 抽包的先例 |
| sdk/server → dsh-llm-deepseek | packages/sdk/server/src/server.ts:16,122 `await this.ctx.plugin(LlmDeepSeek, {})`；package.json deps+dev 都声明 | 条件挂载另一包插件 |
| dsh-headless bundle → code-runtime-worker-thread | packages/bundle/headless/cordis.patch.yml:22-25 + deps:48 | bundle patch 引用另一 workspace 包的先例 |
| examples/acp-demo、agent-spine-demo | packages/examples/*/src/index.ts:117-137、220-261 | 编排型：一个 apply 里 ctx.plugin 一串其它包插件 |
| agent-instructions | packages/context/agent-instructions/src/index.ts:441-442 | 函数插件壳 apply 里 `ctx.plugin(自身包的 Service 类)` |

**dsh-skill-filesystem 的入口形态**（被挂载方标准形态）：函数插件 named-export `name`(:45)/`inject = ['skills']`(:46)/`Config: Schema`(:76-89)/`apply`(:130-143)，无 default export。packages/CLAUDE.md 规定：函数插件与 Service 类 default export 不可混（postmortem 0001-acp-default-export-drops-inject）。

### B.3 feishu-bridge 今天导出了什么 / 外部包驱动 Engine 缺什么

**index.ts 实际导出**（grep `^export` 全量确认）：`name`(:57)、`inject = ['agents','tools','systemPrompt']`(:64)、`Config`(:535)、约 20 个 config 接口（含 `ChatroomConfig` :444、`FeishuBridgeConfig` :484）、`mountBundledSkills`(:761)、`apply`(:785)、`registerNativeSettlementListener`(:918)、`buildProjectAssembly`(:1011)。

**未导出**：`Engine`（engine/engine.ts:842）、`DshAgentAdapter`、`FeishuPlatform`、全部 `register*Tool`/`registerChatroomCommands`、`SubtaskAgentRouter`/`SubtaskRoute` 类型（tools/subtask.ts:21,37）、`wireChatroom`（index.ts:1382 私有函数）。外部包在源码面可走 `exports["./src/*"]` 深入 src，但 `files` 不含 src，npm 产物不可用（本部署 link: 直连仓库则可用）。

**route / live 闭包：今天没有任何对外暴露途径。** `live` engines 数组（index.ts:815）、`route`(:866-874)、`nativeRoute`(:879-886)、`larkRoute`(:896-902) 全是 `apply()` 局部闭包，仅传给包内 register* 家族（:887-903）。feishu-bridge 不是 Cordis Service（无 ctx key、无 `ctx.provide`、不导出 getter）；`buildProjectAssembly` 虽导出但创建**新** assembly（测试向），拿不到 apply() 里 live 的 engine。

**外部 chatroom 包所需而今天缺失的符号**：`registerChatroomTool(ctx, route)`（tools/chatroom.ts:85）、`registerChatroomCommands(e)`（engine/chatroom-cmd.ts:60）、`wireChatroom`（index.ts:1382）、`Engine` 类与 engine/chatroom.ts 全部函数（startChatroom/gatherRoles/endChatroom…，chatroom.ts:484+）、`SubtaskAgentRouter` 类型，以及一个 **live engines + route 的服务化暴露**。仓库内服务化先例：`SkillRegistry extends Service` + `super(ctx, 'skills')`（packages/skill/skill/src/index.ts:357-375，消费方 `inject: ['skills']`）；低阶 `ctx.provide` 先例：app-boot index.ts:770、cmdline index.ts:70-71。

另外两点耦合要注意：/chatroom 命令注册是命令式 mutation（`e.commandHandlers.set` + 包装 `e.commandResolver`，chatroom-cmd.ts:60-81，且要求 registerSessionCommands 先跑）；session start options 装饰在 Engine 私有流程 `buildSessionStartOptions`（engine.ts:2657）内部，chatroom-persona/persona 装配与之交织。

### B.4 部署侧

**生产 profile（实读 `~/.dsh/profiles/feishu-bridge/`）**：package.json 的 `dsh.profile.bundles = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-feishu-bridge"]`，dependencies 混合 registry 版（dsh-base 等 0.1.0-rc.6）与 `link:/home/hm/workspace/deepseek-harness/...` 直连仓库（feishu-bridge、agent、llm-pi-ai 等 7 个 link）。cordis.patch.yml（706 行）= 仓库模板 profile/cordis.patch.yml 的演进版（多出 disable tool-subagent/goal 家族、plan-mode section 重写、llm-pi-ai providers、feishu-bridge 行的完整 projects[] 生产配置）。仓库模板由 install.sh 渲染（@FORK_DIR@ 替换），cordis.patch.yml 已存在则永不覆盖（自演化层）。reload.sh 是该部署的 config-apply gate：构建 + launchd/systemd 重启；DSH_CONFIG_HMR_DISABLED 下配置改动经 /reload 生效并 preflight 校验。仓库侧 bundle patch（packages/acp/feishu-bridge/cordis.patch.yml）：insert feishu-bridge 行 + disable hmr + subagent `settlementNotice: external`。

**新插件包加入生产部署的两条路**：

1. **做成 bundle**（feishu-bridge 同款）：包带 cordis.patch.yml + `dsh.bundle.patch`；profile package.json 的 `dsh.profile.bundles` 追加包名、dependencies 加 `link:...`；`pnpm install`；reload.sh。verify-cordis-config 允许 patch mount 自身（:307 过滤）。
2. **普通插件包**（tool-ask-user / claude-memory / lsp 先例，profile/cordis.patch.yml:43-45,62-135）：profile package.json dependencies 加 link: 条目 + profile cordis.patch.yml 加 `- insert: - id: xxx name: '@deepseek-ai/dsh-xxx'`。

`dsh plugin --profile <name> add <package>` = 在 profile 目录原样转发 pnpm（apps/cli/src/args.ts:71,173-181）。

**dsh.bundle.patch 机制**：loadProfile 逐 bundle 读 `dsh.bundle.patch` 指向的 patch 文件（profile.ts:388-397），列名却无 dsh.bundle 声明会 fail-loud（:392-394）；`files` 需含 cordis.patch.yml（constraints 的 expectedDshPackageFiles 认可 bundle 专属 artifact，feishu-bridge files 还含 skills/）。

### B.5 包结构要求（docs/cookbook/adding-a-package.md）

- **目录**：`packages/<group>/<pkg>/`：package.json、tsconfig.json（extends tsconfig.base.json，rootDir src、outDir lib/types，references: vendor/cosmokit + vendor/cordis (+schemastery 用 Config 时) + 每个 dsh 依赖 + invariants）、src/index.ts、src/invariant.ts、README.md、tests/。
- **package.json invariants**（constraints 强制，scripts/check-workspace-constraints.ts:339-380）：private、version 匹配 root、type:module、main/types/exports["."]/exports["./invariant"] 双目标、cordis 同时在 peer+dev 且 range 相同、dsh peer 镜像进 dev、workspace: 协议、files 精确列表。
- **组是开放容器**：组下无 package.json、包恰在组下一级（checkHierarchyShape）。
- **注册面**：放现有组（如 acp）时 tsconfig.base.json 的 `@deepseek-ai/dsh-*` 与 `dsh-*/invariant` wildcard 自动覆盖（tsconfig.base.json:241+），只需在 tsconfig.host.json references 加一行（feishu-bridge 在 :254）；knip.json 的 `packages/*/*` wildcard 自动覆盖（knip.json:206-214）；root workspaces/publint/tsdown/oxlint 全自动。新组才需改两处 wildcard。
- **README**：`## Model Experience`（What the model sees / verbatim / Token effect / KV Cache effect 四段式）+ `## Known Limitations and Deferred Work`；无模型效应用 SENTENCE_MODEL_EXPERIENCE 审计句或 NO_MODEL_EXPERIENCE_SECTION 白名单。
- **./invariant**：每包必备（verify-package-invariants）；feishu-bridge 的空 installer + 理由范本在 src/invariant.ts。
- **验证**：pnpm install → doc-sync → constraints → typecheck → lint → build → hygiene；产品可见插件还需 REAL-composition 测试（boot test-only cordis.yml through the Loader，packages/AGENTS.md）。
- **最近同类先例 commit**：a23b340858（feishu-bridge M0 skeleton）、96e0f0d898（memory/tool-claude-memory）、4064198560（extensions/cordis-host-runner）。

### B.6 对 chatroom 抽包的关键结论与风险

1. **依赖方向**：新包依赖 feishu-bridge，完全有先例支撑（feishu-bridge→skill-filesystem 同构）：deps `workspace:^` + tsconfig references + （若 bundle patch 引用）bundle deps 声明。
2. **最大缺口是暴露面**：chatroom 面 ~4300 行深耦合 Engine（import engine.js 运行时符号 + Session/Platform 类型 + commandHandlers mutation + buildSessionStartOptions 内交织）；route/live 无服务化，抽包第一步必须先在 feishu-bridge 建立 engine/route 的对外通道（Service 或 ctx.provide 或导出注册表），否则外部包无从驱动。
3. **Config 迁移**：`ChatroomConfig` 接口与 Config schema 的 chatroom 字段（index.ts:616-627 项目级、:715-726 顶层）及 `wireChatroom` 需随之迁移/桥接。
4. **部署最顺路形态**：bundle 化（自带 cordis.patch.yml insert 自己），profile bundles 追加 + link: 依赖；与 feishu-bridge 的 bundle patch 同层叠放，无序冲突（行 id 各自独立）。
