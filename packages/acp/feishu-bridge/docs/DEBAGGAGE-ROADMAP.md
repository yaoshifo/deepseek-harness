# feishu-bridge 去包袱路线图：剩余批次（B4–B8）

> 2026-08-23 落盘。来源：2026-08-22 四路调查（文档证据面 / adapter·session 层 / 编排层 / 进度·交互层）+ 已批准的八批次计划。B0（P0 批次）、B1（审批能力补齐）、B2（提问卡合并）、B3（subagent cwd 覆盖，原生半边）已实施；B3 的桥侧消费并入 B4。各批次独立 TDD、独立提交；每批实施前按「现状核实」重新对照原生包演进。

## 已完成批次索引

| 批次 | 内容 | 落点 |
|---|---|---|
| P0 | 投影补原生信号、/sessions 持久化视图、fork-at seed 化、去 cc-connect 品牌、渲染 skill 单一来源、图标表 | commit 41ee88a893；Agent Note `simplification/2026-08-23-feishu-bridge-native-signal-projection` |
| B1 | 原生审批补齐：`allowed-always` 常驻授权、`ApprovalAnswer` 附言、`toolInput` 预览 | commit e704d3b8bb；seam note `feature/2026-07-06-approval-seam` 就地更新 |
| B2 | 提问卡合并：`Engine.askUser` 直接类型化委托（`AskDelegate`）替代合成事件通路；多题一卡（已答冻结/未答可点/自由文本答第一未答题）；`perm:allow_all` → 原生 `allowed-always`、deny 附言进 `ApprovalAnswer.note`、卡片预览用 `toolInput`；`selected`/`custom` 分离；research-manual 整卡超时；删 `permission_request` EventKind、`PendingPermission`、`approveAll`、adapter 双等待表与词表主通路（净 −277 行，permission.ts 178→63）。遗留真机冒烟点：chatroom pick 窗口工具审批出卡、research 整卡超时端到端时序、ask 停留期间并发子会话事件落面 | Agent Note `simplification/2026-08-24-feishu-bridge-ask-delegate` |
| B3 | `SubagentStartRequest.cwd`（能力门控 `cwdOverride`；worktree 编排刻意留调用方） | commit 4c6312829f；Agent Note `architecture/2026-08-23-subagent-cwd-override` |
| B8 | 进度卡文本协议收敛：`ProgressContent` 判别联合（payload 对象直传 Platform 接缝）+ `ProgressStatus` 结构化状态取代 `__cc_state__` 头部行；`toolResultMeta` 与逐请求 usage 投影补全；prefix codec 收缩为接缝解码器，V1 构造器与 `extractProgressState`/`extractProgressTimestamp` 删除 | Agent Note `simplification/2026-08-24-feishu-bridge-preview-content-objects` |

## B4 无人值守子任务走原生（含 B3 桥侧消费）

**现状**：`engine.ts` spawnSubtask/reportSubtask/sendToSubtask/gatherSubtasks（约 5321–5876 行）自建父子注册表、深度、回报路由；barrier 纯逻辑在 `engine/subtask.ts`；worktree 全套在 `engine/worktree.ts`。原生 `SubagentRuntime` 已有 continuable/followup/report/interrupt/list（`packages/subagent/subagent/src/index.ts`）。

**改法**：
- 无飞书群、无用户围观的子任务（`feishu_bridge_subtask` 的 unattended 路径）改经原生 continuable 子会话：世系/深度/枚举用原生 durable 能力，回报走 `reportFrom` + 结算通知。
- `--dir`/`--worktree` 经 B3 的原生 `cwd` 字段落位：worktree 由桥侧 `worktree.ts` 创建后传路径（git 约定留桥）。
- **gather barrier 保留**（原生无对应物，用原生通知计数实现单次合并唤醒）。
- busy 背压采纳原生「排队等当前轮」语义（记录对 Go「busy 即拒」的刻意偏离）。
- 有群语义（/spawn 持久群 + 用户介入 + /done --reply）完全不动——D1 核心理由仍成立。
- 顺手补：桥侧子任务的模型可中断手段（原生 interrupt）。

**语义对照基线**（2026-08-22 调查结论）：世系/深度/headless spawn/追问 已等价或近似；gather barrier、跨目录派发（现已由 B3 解除）、用户介入面 不等价。

**验收**：engine-subtask 测试族改写 + 新增 interrupt 用例；真机一次 unattended 派发 + gather + 回报。

## B5 体验补齐（独立，可并行）

- `/list` `/status` `/switch` 卡片化：Go `renderListCardSafe`/`renderStatusCard` + `act:/list switch|delete N` 按钮（只读参照 `/home/hm/workspace/cc-connect`）。
- help 卡族：`renderHelpGroupCard` + `nav:` 路由，修复 cron 卡返回按钮「no handler」；`/dir` 卡补返回按钮。
- #63 unsolicited 三超时（spillover/tool-in-flight/background grace，Go `runUnsolicitedReader`）+ `setBackgroundHint` 接线 + `bg_task_*` i18n 死键复活；后台任务提示不再只增不减。

**验收**：命令族测试 + 卡片 JSON 断言；真机抽查按钮回调。

## B6 env 纸条换正式表单（纯内部）

`buildSessionEnv` 的 `CC_*` 字符串数组（engine.ts ~2246–2309）与 adapter 的 envHasFlag/envValue 逐行解析（adapter.ts ~216–330）改为 `startSession` 收 typed options（persona flags、session key、bypass、feishuWorkspace 等）；`renderQuery` 的 `void sessionEnv` 形参删除。CLI env 契约已退役，唯一读者是 adapter 自身。机械但面广；注意 `adapter.ts` 从 env 偷渡 `CC_SESSION_KEY` 区分 cron slot 的点（原调查 B 报告问题③）要显式化。

## B7 会话账本换原生（纯内部）

- sessions.json 退役 Go 字段名（pre-release 姿态，直接换格式＋重建或一次性迁移）。
- 100 条内存 history 副本改 `sessionPersistence.inspect()`/投影派生（消费点：/show、token 估算、predict 上下文）。
- `knownAgentSessionIDs` 过滤随独占持久化删除（原调查 B 报告问题②：现过滤的是自己的历史会话）。
- EventChannel 手工路由（liveSessions map + lineage walk）评估改 dsh-scope 作用域监听（`packages/core/session/src/index.ts:66-76`）；跨 scope 祖先归因保留。
- SessionHeader 无 updatedAt：「最近会话」排序的已知缺口，用 listSnapshots 或投影补。

**验收**：/sessions /switch /fork /show 回归 + 重启恢复真机验证。

## B8 进度卡文本协议收敛（最大，单独一批，分两段提交）

- ① `__cc_connect_progress_card_v1__:` JSON-in-string（`src/progress.ts:92` 一带）改对象直传：卡片渲染函数输入改内存对象。
- ② `__cc_state__:/__cc_ts__:/__cc_tc__:` 头部行协议（`src/streaming.ts` ~1578–1590 发、`src/feishu/progress.ts` ~533–572 收）改平台层订阅结构化状态。
- cc Event 中间模型的有损字段（step 边界、per-request usage、tool/result.meta）随通路直连逐步补全。
- **承重墙保留**：飞书卡缓存 re-attach 依赖卡片文本往返飞书服务器，该处序列化保留为 wire 格式；legacy 文本回退样式保留。
- 验收：streaming/progress/feishu-progress 三域测试改写；进度卡视觉真机对比（JSON 断言 + 截图）。

## 明确不做（2026-08-22 调查负结论，重申）

- cron 底座不换 dsh schedule（session-local，约六成不可替代）。
- relay 不动（群镜像是产品本体）。
- chatroom persona 目录/账本/群形态是产品本体；gather barrier 保留。
- attended subtask 群语义保留（原生 continuable 无用户可见交互面）。
- 27 条不迁命令、语音输入、失败分类/脱敏维持用户裁定。
- 图片直达模型（ImageBlock + `imagesMode` 按路由能力分流）等 glm 多模态化后再实施。

## 横切原则（各批通用）

- TDD：行为变更先红后绿；移植测试语义不变的保持绿，刻意变化逐条列出。
- 每批独立提交可独立上线；生产 promote（构建 + `systemctl --user restart feishu-bridge` + profile 复核）由用户执行。
- dev 分支豁免 doc-sync 类门禁；代码测试/lint/typecheck 必须绿。
- Agent Note 照常（改公共包的批次同步其 README/JSDoc）。
- 实施前重新核实原生包现状（subagent/interaction 等可能又演进）。
