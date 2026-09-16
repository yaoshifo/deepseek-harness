# Agent Note：子任务汇报上限 —— 头尾投递 + 落盘文件

状态：已实现

[English](2026-09-16-feishu-bridge-subtask-report-cap.md) | 中文

## 问题

主 agent 的上下文对超长子任务汇报完全不设防：`deliverParentReply` 把汇报正文原样注入唤醒、原样攒进 gather 屏障、原样渲染到人侧卡片——整条注入路径没有任何大小帽。一份病态汇报（贴回来的日志、文件清单）会一直占着上下文，直到核心层自动压缩（0.8 × 窗口）把它摘要掉；一步之内涌入多条大汇报时，可能在 pre-step 压力检查跟上之前就把请求推过窗口（溢出恢复能接住，但重试失败该回合就报错）。同一轮调研也确认了子任务的执行过程从不进父——工具调用、文件读取、思考都留在子会话记录里；汇报正文是唯一值得设界的面。（上下文流转事实：2026-09-16 三路调研，记录于项目记忆 `dsh-subagent-context-flow-and-compaction`。）

## 决定

给投递的汇报设 `subtask.reportMaxChars` 上限（默认 8192 码点；下限 1024 加载期强制——再小的帽会让每份汇报都被说明行挤掉）：

- **单一截断点**：`deliverParentReply` 函数体第一句，早于卡片发送、去重哈希、gather banking、唤醒组装。三个下游消费者读同一个重赋值的 `content` 参数，卡片、banking、唤醒承载同一份截断文本——不存在「人看全文、模型看截断」的错位。
- **纯预算算术**在 `src/engine/subtask-report-cap.ts`（`planSubtaskReportCap`）：码点计数（`Array.from`，与桥内其它 rune 语义一致），头 2/3 / 尾 1/3 按扣除说明行与分隔符后的预算切分——投递文本永不超帽——头尾之间用一行省略号标记切口。
- **全文落盘**到 `<会话目录>/subtask-reports/report-<sha256(childKey) 前 12 位 hex>-<ISO 时间戳>.md`（原子写；chatroom-research 的目录推导先例）。`storePath === ''`（测试、无持久化）即「无法落盘」：说明行降级为指向子会话的「未落盘」文案——`feishu_bridge_subtask action: send` 可追问找回，原文永远在子会话记录里——绝不留假路径。
- **绝不抛异常**：投递路径的 rejection 会让调用方回滚子任务的 `reported` 标记、形成重投循环；一切失败都是 warn + 降级。
- **去重哈希取原文**（2026-09-13 subtask-report-dedup）：被截断的汇报必须仍能与先前的同文直发去重——对截断文本取哈希会让同一份文本二次进父。
- **落盘文案的反馈收敛**：saved 变体的说明行内嵌省略字符数，它反过来影响头尾预算；一轮定点 `while` 迭代收敛（说明行长度只随位数变化）。
- **子任务前导携带同一个数字**（`subtaskAgentSystemPrompt(reportMaxChars)`，adapter setter 与 engine setter 由同一次配置读取接线）：子任务被直接告知上限而不是撞上去——汇报控制在 N 码点内，更长内容写文件、汇报里给路径。

## Alternatives considered

- **复用 spill-policy / `ctx.spillStore` 服务**（工具结果上限的机制）：否——它把帽绑死在 daemon 组合上（没装 spill-local 后端的部署会静默保全文）、新增三个 workspace 依赖，且 session-reference 的来源词汇更适合捕获会话而非子任务汇报。自包含目录让行为在一切有会话存储的部署上都确定。
- **只截唤醒、卡片保全文**：否——「人看全文、模型看截断」是认知错位，几万字的卡片本身就是渲染负担；卡片带路径，人照样能打开文件。
- **gather 汇总总量帽（N × 单份帽）**：刻意不做——每份入账汇报已有界，极端条数场景离核心层 0.8×窗口压缩线还很远，而汇总级帽会把几条中等长度的汇报截成预览汤。真需要时的唯一收口点：`resolveOrWakeGather` 的汇总。
- **对齐 spill-policy `maxInlineBytes` 的 50KB 字节帽**：否——码点与桥内 rune 语义（标签、提示词）一致、对中文计价公平；字节帽会把中文汇报三倍计数。

## 后果

- 父上下文为汇报支付的开销有界于 N × 帽；正常调研汇报（几百到几千码点）原样投递——不产文件、不加说明行。
- 模型需要全文时多付一次 read；人从卡片点开文件。
- 汇报以文件形式落在项目的会话目录下（`subtask-reports/`）；本轮不做清理（量小且是价值产物——积累起来后可循既有惯例做 30 天清理）。
- 子任务前导多一行（每次子任务请求多几十 token）；人设 pin 断言已携带（`tests/agent-dsh/adapter-persona.spec.ts`）。
- `docs/config-catalog.md`（生成物）按 fork 政策不重生成；漂移记录在本 Note。
- 已知未覆盖（有意）：子任务经 `send_message` 直发父的运行时旁路与孙任务对子的汇报（收件人都不是主 agent）、人侧卡片的 `cardDetail` 附录（纯展示面）、gather 异步唤醒汇总总量（N × 帽）。投递口施工中的范围外发现，已上报未修：`deliverParentReply` 的 `cardDetail` 拼接无上限——仅人侧卡片展示。
