# Agent Note: feishu-bridge 按群生效的 provider 路由（#9 会话级切换）

Status: implemented

[English](2026-09-03-feishu-bridge-per-chat-provider-routes.md) | 中文

## Problem

`/provider` 切换的是 adapter 单一的项目级 active 指针：bot 的每个群都会在下次会话开始时换到新路由，因此同一只 bot 下的两个群无法各用各的模型，一个群里的切换会静默改掉其他所有群。切换还会重解析项目级派生状态——引擎的 context window 与 usage detector 的 active 名推送——而单个群的选择本不该动这两者。部署直接撞上了这一点：同一只 bot 既服务想用 GLM 路由的群，也服务想用别的路由的群。

## Decision

`ProviderSwitcher` 增加 `setSessionProvider(sessionKey, name)` 与带会话键的 `getActiveProvider(sessionKey?)`；dsh adapter 持有 `Map<engineKey, routeName>`，解析次序为：会话 override → 项目默认（`cfg.activeProvider`，装配时取自持久化状态/配置）→ 首个路由。`setProviders` 清理指向已删路由的 override；过期 override 回退项目默认。`asProviderSwitcher` 结构探测要求新成员。

`startSession` 把本就存在的 `options.sessionKey` 传入四个创建/恢复点的 `routeAgentOptions(key)`——agentOptions 本来就是每次创建现算的，adapter 上游无需任何改动。`/provider` 家族（switch/current/clear、卡片行、shortcut）只作用于发令群；项目默认指针在运行期不再移动。持久化落在 project state 新增的 `provider_overrides` map（sessionKey → 路由名），经改签名的 `providerSaveFunc(sessionKey, name)` 写入；清除即删条目，启动时灌入 adapter，持久化的名字已不在 `config.providers` 时告警并回退——与项目级恢复相同的自愈。override 的键是 engine session key，因此跨 `/new` 天然保留（同群新 Session），无需继承逻辑。

⌛ 配额门控改为按回合：`buildCompletionUsage` 解析完成回合那个群的 effective 路由名，传入 detector 门 `isActive(workDir, activeProviderName)`。原推送机制——`syncUsageProvidersActive` 加每个 detector 存储的 `setActiveProvider` 名——被删除，因为单一推送名无法服务按群门控；门控语义本身不变（GLM 匹配 `glm` 前缀、MiniMax 精确匹配，因此需要门控的路由名继续携带厂商前缀）。显示走同一解析：🤖 footer 行、reply footer、`/context` 的模型段、provider 卡片的当前行与 ▶ 标记都接收 session key。旁路查询中 `''` 表示「active provider」的配置（群命名、predict-next、turn summary、plan render、monitor triage）改为解析本群的 effective 路由——每个调用点本就持有 session key。

子任务、chatroom 派生群与 cron 运行解析各自 key 的 override——除非该群自己切过，否则即项目默认；子任务不继承父群路由（v1 有意为之的范围）。

## Alternatives considered

**把 override 存在 Session 记录上（sessions.json）。** 否决：session key 才是跨 `/new` 稳定的群身份；存在 Session 记录上需要 `/new` 继承语义并触碰带版本的快照 schema，而 project state 已有 per-key map 先例（`workspace_dir_overrides`）。

**保留项目级指针的运行期可达性（scope 旗标或第二个命令）。** 否决：一个命令家族里两套切换范围不可学习，且按群切换后没有任何运行期调用方会动项目默认——它保持为配置/启动期所有的值。

**按群的 context window 状态。** 未做：`Engine.contextWindow` 经穷尽检查是只写不读的死状态（ctx%/占用率的分母来自各会话自己的 context snapshot），因此切换路径上的重解析调用直接移除，而非重新定界——该字段及其整条链其后被移除（[context-window 链移除](../simplification/2026-09-03-feishu-bridge-context-window-chain-removal.zh.md)）。

## Consequences

同一 bot 的两个群可并发跑不同路由，其他群的活跃会话保持其创建时锁定的路由——此前只是会话生命周期的偶然，现在按构造即正确。项目默认路由在运行期不可变；要改它就编辑配置（或持久化的 `active_provider`）并 reload。`state.json` 新增 `provider_overrides`（缺字段 = 无 override，向后兼容）；⌛ 行、🤖 行与 `/context` 头各自反映本群路由。已知限制：被派发的子任务与 chatroom 群不继承发令群的路由——它们跑项目默认，或在项目配置了 `agent.spawnProvider` 时跑该路由（[spawn 群默认 provider 路由](2026-09-03-feishu-bridge-spawn-default-provider.zh.md)）；spawn 时继承父群路由仍留待后续。context-window 链其后被整链移除（[context-window 链移除](../simplification/2026-09-03-feishu-bridge-context-window-chain-removal.zh.md) 合并了 2026-08-20 接线 note）；usage-sync note 的推送机制被取代（[usage providers never learned the active provider name](../../archived/bug-fix/2026-08-22-feishu-bridge-usage-provider-active-sync.md) 已归档）。

## Testing

`tests/agent-dsh/adapter.spec.ts`：解析矩阵（override → 项目默认 → 其他群不受影响）、按群 `startSession` 的 agentOptions、未知路由拒绝、清除语义、`setProviders` 清理、带 key 的 `getModel`/`getReasoningEffort`。`tests/engine/provider-commands.spec.ts`：按群的 switch/clear/shortcut/卡片行语义、按群持久化 hook 形状、项目默认不动、按群 ⌛ 门控。`tests/engine/project-state-shape.spec.ts`：override map 的存取往返与条目删除。`tests/engine/engine-groupname.spec.ts`、`predict.spec.ts`、`monitor.spec.ts`：旁路查询的按群回退。`tests/assembly-misc.spec.ts`：装配链——卡片动作钉住单群路由、持久化 override 跨重组装存活、未设置群回退。包级全量 2835 绿；仓库 typecheck 干净。
