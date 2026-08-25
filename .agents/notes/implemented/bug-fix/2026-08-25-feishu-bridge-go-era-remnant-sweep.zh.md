# Agent Note: Go 时代残留清扫——模型可见文本、plan 文件链、铸造影子的查找

Status: implemented

[English](2026-08-25-feishu-bridge-go-era-remnant-sweep.md) | 中文

## Problem

继 oc_ac5db 助手 key 事故之后，三路并行审计（模型可见文本、选项管道、创建性查找）全面排查了 bridge 中「引用的机制在 dsh 后端不存在」的 Go/cc-connect 时代残留。经逐条验证，以下发现全部属实：

- 聊天室收尾流程的第一条指令（`dir: /tmp/chatroom-summary-<时间戳>`）指向一个没人创建的目录——`resolveDirPath` 要求目录已存在，spawn 每次当场失败。
- 研究助手前导用 `$VIRTUAL_ENV/bin/python` 跑脚本；Go 的 `buildSessionEnv` 注入从未移植（venv 启动选项被传递但从未消费），变量展开为空。
- 约 13 处文本以 `AskUserQuestion` + `MultiSelect` 参数称呼原生工具；dsh 实名是 `ask_user_question`/`multi_select`，错误的参数名被 schema 静默忽略——主持人澄清阶段的多选卡降级为单选。
- plan 文件追踪链自移植起经三处断点全断：引擎匹配 `'Write'` 而 adapter 投影的是 dsh 的 `'write'`；`toolInputRaw` 从未投影；升级条件要求 tool_result 事件携带它从不携带的 `toolName` 与 `done`（`done` 只在回合结束的 result 事件为 true）。plan-review 的「文件比提交副本新则优先」精化与 plan 导出的 .md 产物静默退化为提交副本。
- 所有 chatroom/hub 状态读取与子任务结算路由都使用创建性查找：悬空的 hub 或父 key 静默铸造无 parent 的注册表记录，其空标志随后误导一切（幽灵 hub → research 契约静默丢失、gather 退化为串行中继；幽灵父 → 结算在死记录里以无上下文的 agent 轮次投递）。多个测试 harness 一直在暗中依赖这种铸造。
- 更小的残留：收尾流程仍声称文件投递工具「未上线」而同一人设就在教它；`ExitPlanMode` 应为 `exit_plan_mode`；结算唤醒提示引用已退役的 `cc-connect subtask send` CLI。

## Decision

`fix/go-era-remnants` 分支（worktree `.claude/worktrees/go-remnants`）三个提交：

1. **文本只引用存在的机制。** 收尾 spawn 用 `dir: ${ledgerDir}`（brief 本就写到那里）；助手前导从 venv 启动选项内联具体 `<venv>/bin/python` 路径（adapter 开始消费该选项；删除死字段 `venv.pathBin`；未预配时给系统 python 降级文案）；全部改为 `ask_user_question`/`multi_select`；修正陈旧的投递声明、`ExitPlanMode` 与 CLI 提示。
2. **plan 文件链接线。** adapter 投影 `toolInputRaw`（解析后的 JSON 对象参数）；引擎以 dsh 的 `write` 追踪待定 plan 写入，并在结果事件上按工具调用 id 匹配升级（成功与拒绝都升级，保留「改同一文件」的行为）。移植来的测试桩改为投喂真实事件形态，替代那个把断链藏起来的不可能的 Go 时代形态。
3. **查找停止铸造。** `chatroomHubOf`（findActive + 告警）支撑全部 17 处 hub 状态读取——入口点大声失败，timer/中继路径按无状态处理，finalize 仍清理角色；`deliverParentReply` 在悬空父 key 时投卡但不唤醒、不铸造；`buildSessionStartOptions` 非创建读取 hub；`reportSubtask` 对未知 key 大声失败，与 `sendToSubtask` 对称。

## Alternatives considered

**给收尾 spawn 的 resolveDirPath 加自动 mkdir。** 弃用：`--dir` 不存在即失败是有意设计（错字不应静默建目录）；错的是 prompt 不是引擎。

**为 VIRTUAL_ENV 做真实 env 注入。** 弃用：dsh agent 没有 per-session env 机制；前导内联具体路径即可兑现契约，无需新机制。

**同时转换记录枚举类查找（findRoleKeyByName/collectSubtree 消费者）。** 延期：它们 suffer 的是 active 记录 vs 存储标志的结构性错配（见下），findActive 治不了。

## Consequences

延期并带明确触发条件、留待单独变更：结构性错配——chatroom 状态存在 per-Session 记录上却经 per-key 的 active 映射解析，hub 或角色聊天里 `/new` 换 active 记录后 moderator/research/barrier 标志被静默遗落（gather 永不完成、人设重置）。修法需要按记录 id 解析。同样延期：未移植的 `/allow`/`/yolo` 命令的死 i18n 键、半接线的 `toolResultMeta` 投影、死的 Event 类型字段（`arrivedAt`、`requestID`、`sessionID`/`error` 死读、`gitBranch`、`UserQuestionOption.preview`）。

## Testing

各提交的专属套件全绿：文本（persona/gather/venv/adapter，109）、plan 文件链（plan-file/subagent-card/projection，30，含新投影用例）、查找（engine 1348 + agent-dsh + assembly；新增 gather、buildSessionStartOptions、幽灵父结算的悬空 key 测试，均带会话数断言）。组合全量跑中复现的 `skips the rollback when --worktree is requested`（5 秒超时）在基线提交上同样复现——属既有负载相关 flaky，非本变更引入。bridge typecheck 通过。
