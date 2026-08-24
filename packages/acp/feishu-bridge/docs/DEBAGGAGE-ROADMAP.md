# feishu-bridge 去包袱路线图（B0–B8 全部完成）

> 2026-08-23 落盘，2026-08-24 收官。来源：2026-08-22 四路调查（文档证据面 / adapter·session 层 / 编排层 / 进度·交互层）+ 已批准的八批次计划。B0–B8 全部实施完毕；遗留真机冒烟点见各批次行内标注。各批次独立 TDD、独立提交。

## 已完成批次索引

| 批次 | 内容 | 落点 |
|---|---|---|
| P0 | 投影补原生信号、/sessions 持久化视图、fork-at seed 化、去 cc-connect 品牌、渲染 skill 单一来源、图标表 | commit 41ee88a893；Agent Note `simplification/2026-08-23-feishu-bridge-native-signal-projection` |
| B1 | 原生审批补齐：`allowed-always` 常驻授权、`ApprovalAnswer` 附言、`toolInput` 预览 | commit e704d3b8bb；seam note `feature/2026-07-06-approval-seam` 就地更新 |
| B2 | 提问卡合并：`Engine.askUser` 直接类型化委托（`AskDelegate`）替代合成事件通路；多题一卡（已答冻结/未答可点/自由文本答第一未答题）；`perm:allow_all` → 原生 `allowed-always`、deny 附言进 `ApprovalAnswer.note`、卡片预览用 `toolInput`；`selected`/`custom` 分离；research-manual 整卡超时；删 `permission_request` EventKind、`PendingPermission`、`approveAll`、adapter 双等待表与词表主通路（净 −277 行，permission.ts 178→63）。遗留真机冒烟点：chatroom pick 窗口工具审批出卡、research 整卡超时端到端时序、ask 停留期间并发子会话事件落面 | Agent Note `simplification/2026-08-24-feishu-bridge-ask-delegate` |
| B3 | `SubagentStartRequest.cwd`（能力门控 `cwdOverride`；worktree 编排刻意留调用方） | commit 4c6312829f；Agent Note `architecture/2026-08-23-subagent-cwd-override` |
| B4 | 无人值守子任务走原生：`startContinuable` 消费 cwd + `settlementNotice: 'external'`（原生半场，commit 0657a7a012）；桥侧自挂 `SubagentRuntime(external)` + `asContinuableDelegator` 委派面 + projectState `native_children` 父系记录 + `subagent/end` 结算兜底（共享 `deliverParentReply` 机器）+ gather 并入 + send 排队（对 Go busy-reject 的刻意偏离）+ interrupt 动作 + `/done`/chatroom end 排空回收；群路径（/spawn、monitor、chatroom 预派）不动。遗留真机冒烟点：unattended 派发 + gather + 回报全链 | 原生半场 commit 0657a7a012；桥侧见 Agent Note `feature/2026-08-24-feishu-bridge-native-unattended-subtasks`（前置 note `feature/2026-08-24-subagent-continuable-bridge-seam`） |
| B5 | 体验补齐：/list /status /switch /help 卡片族（`session-card.ts`，act:/switch 行按钮 + delete-mode 状态机 + help 分组卡，修复 cron 卡返回按钮）+ unsolicited reader 四预算（idle/tool-in-flight/background grace/spillover）+ `setBackgroundHint` 接线与 `bg_task_*` 键复活。遗留真机冒烟点：卡片按钮回调抽查 | commits 076d17b314 + ec3f178bb1；Agent Notes `feature/2026-08-24-feishu-bridge-command-card-family`、`feature/2026-08-24-feishu-bridge-unsolicited-reader` |
| B6 | env 纸条换正式表单：`Agent.startSession(sessionID, options?)` 收 typed `SessionStartOptions`（persona/sessionKey/workspace/venv），删 `setSessionEnv` 槽位、`CC_*` env 数组与逐行解析、`renderQuery` 的 `void sessionEnv` 形参、lark 的 `CC_PROJECT` 防御丢弃；无读者变量（`CC_PROJECT`/`CC_SESSION`/`CC_SUBTASK_DEPTH`/`CC_RESEARCH_ASSISTANT_KEY`）直接删除 | Agent Note `simplification/2026-08-24-feishu-bridge-session-start-options` |
| B7 | 会话账本换原生：sessions.json v2（camelCase，v1 内存迁移一次性落盘）；100 条内存 history 副本退役（adapter `recentTurns`：live 增量窗口 + 冷 inspect 折叠缓存）；`knownAgentSessionIDs`/`filterOwned`/`filterExternalSessions` 全删；updatedAt 排序缺口以日志 mtime 补；dsh-scope 作用域监听负结论（手工 lineage walk 保留）。遗留真机冒烟点：重启恢复 + 旧 sessions.json 迁移 | commit 9236abf800；Agent Note `simplification/2026-08-24-feishu-bridge-b7-session-ledger-native` |
| B8 | 进度卡文本协议收敛：`ProgressContent` 判别联合（payload 对象直传 Platform 接缝）+ `ProgressStatus` 结构化状态取代 `__cc_state__` 头部行；`toolResultMeta` 与逐请求 usage 投影补全；prefix codec 收缩为接缝解码器，V1 构造器与 `extractProgressState`/`extractProgressTimestamp` 删除。遗留真机冒烟点：进度卡视觉对比（截图） | commits a7e21b4ce3 + de062baa8b；Agent Note `simplification/2026-08-24-feishu-bridge-preview-content-objects` |

## 明确不做（2026-08-22 调查负结论，重申）

- cron 底座不换 dsh schedule（session-local，约六成不可替代）。
- relay 不动（群镜像是产品本体）。
- chatroom persona 目录/账本/群形态是产品本体；gather barrier 保留。
- attended subtask 群语义保留（原生 continuable 无用户可见交互面）。
- 27 条不迁命令、语音输入、失败分类/脱敏维持用户裁定。
- 图片直达模型（ImageBlock + `imagesMode` 按路由能力分流）等 glm 多模态化后再实施。

## 横切原则（各批通用，存档）

- TDD：行为变更先红后绿；移植测试语义不变的保持绿，刻意变化逐条列出。
- 每批独立提交可独立上线；生产 promote（构建 + `systemctl --user restart feishu-bridge` + profile 复核）由用户执行。
- dev 分支豁免 doc-sync 类门禁；代码测试/lint/typecheck 必须绿。
- Agent Note 照常（改公共包的批次同步其 README/JSDoc）。
- 实施前重新核实原生包现状（subagent/interaction 等可能又演进）。
