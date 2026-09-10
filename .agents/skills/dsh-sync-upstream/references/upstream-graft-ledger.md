# 上游嫁接台账（upstream graft ledger）

原则 2 的执行清单：所有嫁接在上游拥有 seam 上的 fork 改动。每次上游吸收后按此逐项核对重嫁接成本；提案状态变更即时更新本表；上游等价物落地且吸收后本地 diff 归零的行删除。基线：2026-09-06 审计（master d347e70390，dev 领先 706 提交，381 个上游文件被改）；2026-09-08 吸收（master c389f96bf3，449 提交）后全部 subagent 载荷重嫁接到上游新抽出的 ContinuableActivationRegistry 结构上（continuation-activation.ts 现承载 setup 贡献、settlement 交付、jobs 常驻三 graft），lsp-stdio 的 symbol 面与上游重试重写并存，session-format v1-to-v2 的读路径校验收编 oneshot origin；2026-09-10 吸收（master aa8262ec09，718 提交，merge 9fe54af7a3）后上游落地了双参 AgentSetup seam（setup 回调显式收 `(ctx, agent)`，create/resume 带 `parentAgent`），mcp-workspace 挂载三路全部改搭该 seam，session-log v3 全链随合并吸收。

## subagent 组（历史成本最高，continuation.ts/index.ts 各 11 次重嫁接）

| 载荷 | 引入 | 状态 |
| --- | --- | --- |
| delegation cwd override（旗标门控 + provider 广告 + 工具参数） | 4c6312829f | 待提上游 |
| reportFrom / CoordinatorMessageSource 安全上报链 | — | 待提上游（需 Activation 表鉴权，无法外置） |
| activation-setup-registry / registerContinuableSetup seam（~250 行） | — | 待提上游（通用扩展点） |
| jobs 常驻 ownsLiveJobs（后台 job 存活期不拆 Activation，真 bug 修复） | c48b659543 | 待提上游 |
| settlementNotice: 'external' 部署旋钮 | — | 待提上游 |
| SubagentRunEndInfo.diagnostic 失败细节上浮 | — | 待提上游 |
| list-agents status 图例行 | — | 待提上游 |
| mcp-workspace 挂载 graft ×3（child-agent / in-process-driver / session-controller） | bec306dc49 | 三路已全部搭上游双参 AgentSetup seam（2026-09-10 合并吸收）：continuable 走 registerContinuableSetup（贡献签名扩为 `(childCtx, child)`）；one-shot 经 `mountDirectoryMcp(childCtx, child)` 显式传 Agent（child-agent 仍持本地 DirectoryMcpService 切片 + 集成特征测试防线）；session-controller wrap 流经真实 `AgentSetup` 类型。剩余嫁接面收敛为 mcp-workspace 包本体 + activation-setup-registry seam（单列一行） |

## lsp 组（25 文件，fork 已卸载仍付嫁接税）

| 载荷 | 状态 |
| --- | --- |
| workspaceSymbol 第五操作：lsp symbol() fan-out、lsp-stdio provider、tool-lsp 操作与 render | 待提上游（唯一解；拒收则接受现状，remount 仅需配置） |

## context / interaction / core

| 载荷 | 引入 | 状态 |
| --- | --- | --- |
| agent-instructions @path imports + candidateSelection first-existing | cfe84bd714 | 待提上游 |
| agent-instructions suppression 服务（chatroom bare persona 消费） | 1a2dad9dcd | fork-local 合理（可选服务，可另行评估） |
| user-approval allowed-always + answerer notes + toolInput（含 core/tools、sandbox、editor 消费链） | e704d3b8bb | 待提上游（最成型候选） |
| user-questions recommended 旗标 + tool-ask-user schema 收紧 | — | 待提上游 |
| core/tools normalizeKeyStyleVariants 输入边界键风格归一 | cec5236dfd | 待提上游 |
| core/session SessionOrigin oneshot（8 文件一行级涟漪） | — | 待提上游 |
| dsh-agent-loop 导出 inboxProjectionDefinition（桥重启 pending 告知要注册该单元） | 972c03a146 | 待提上游（导出一行；桥的 G3 依赖它） |
| core/agent reasoningEffort 会话级覆盖 | — | 随批提 |

## fs / todo / shell / mcp / skill / llm / client（S 级批）

| 载荷 | 引入 | 状态 |
| --- | --- | --- |
| fs-search 搜索根锚定重构（rg 根、~ 展开、路径再锚定） | 77e8a6df31 | decider note（6146e5a65e）在案：提上游或等吸收 |
| str-replace-editor 逐调用 sandbox 升级参数 | — | 随审批链提 |
| todo activeForm | — | 待提上游 |
| bash-local envFile 部署密钥白名单 | 6e745cea6e | 待提上游 |
| mcp-client startupTimeoutMs | — | 待提上游 |
| skill SkillRestriction + skill-filesystem scopedSkillDirs | de9e935ae3 | 待提上游 |
| llm-pi-ai tagStrictSampling | — | 待提上游 |
| client/connection fixture stripNodeWarningLines | — | 待提上游 |

## api / acp / apps / bundle

| 载荷 | 引入 | 状态 |
| --- | --- | --- |
| acp armTopologyNotifications 创建窗口竞态修复（带回归测试） | f8d269b596 | 现成 PR 素材，pilot 首选 |
| apps/cli DSH_CONFIG_HMR_DISABLED | — | 待提上游（S） |
| plan 引导散文嫁接 4 文件（3 preset + bundle/base patch） | eef9cb0327 | 讨论轮段已搬 fork patch layer；并行探索段评估提上游 |
| lefthook secrets job + 配对 glob 扩展、生成器 fork 注册 | — | 保留（fork 政策落地，加严非跳过） |

## 定位备注

- **dsh-memory**：上游 2026-07-31 note 明确「不做」memory（仅 MCP overlay 示例）——不提上游。fork-only 定位已拍板（2026-09-06）并写入包 README 与原则 note；durable kind 'dsh-memory' 不可回收，若上游将来自己做 memory → 采纳上游表面 + 重放 fork 增量。
- **vitest 工具链**：四 lane 原生解析半分叉已于 2026-09-06 全量退回 vite-tsconfig-paths 插件，原则 4 偏差终结。
- **README 双语对债务**（74 文件）：随各 seam 上游 PR 走（fork 侧 revert）；上游化即自动收缩。
- **dsh-context 外部仓移植**（aggregate.ts / chartspec.ts）：来源是 bowenliang123/dsh-context 独立仓（live profile 直链，非本仓依赖、无上游对应物，无法改 import）。升级 profile 里的 dsh-context 版本时须手工重对齐两份移植；移植头注释已标明来源仓与版本锚。
