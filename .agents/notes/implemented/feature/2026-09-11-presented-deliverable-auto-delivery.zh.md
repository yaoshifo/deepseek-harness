# Agent Note: present 声明式交付自动投递——吸收上游 tool-present 的生产面

Status: implemented

[English](2026-09-11-presented-deliverable-auto-delivery.md) | 中文

## Problem

2026-09-10 上游合并（9fe54af7a3）带来了声明式交付：`present` 工具让模型把「已存在的文件」声明为用户要的交付物（不复制内容，只校验元数据），成功后落 `deliverables/presented` 会话事件；web 端的交付卡片与文档预览消费链（ui-deliverables + documentpreview + workspace-files）已随合并自动对桥会话生效，但桥会话的生产面缺失——`present` 只挂载在 standard/ptc/cordis 三个 CLI preset，dsh-base（桥的组合基座）不挂，桥模型看不到该工具；桥对 `deliverables/presented` 事件的消费也是零（adapter 的 projectEvent default:break 静默丢弃）。桥的既有投递是 `feishu_bridge_send`（推副本进飞书），语义不同：按需直发 vs 声明即投。

## Decision

把声明式交付接进桥，形成「present 声明 → 引擎自动投递 → 飞书收到文件」的闭环：

- **挂载**（bundle patch `cordis.patch.yml`）：`tool-present` 插到 `tool-ask-user` 同款 insert 行——每个桥组合（不只 daemon profile）都带上声明式交付；bundle `package.json` 补 `@deepseek-ai/dsh-tool-present` workspace 依赖，daemon profile 的 `package.json` 同步补 link 依赖。
- **投影**（adapter）：`projectSessionEvent` 与 `projectSubagentEvent` 各加 `deliverables/presented` case，推新事件种 `presented`（content=声明路径列表，toolInputRaw.files=带 description 的声明数组，子会话另带 `toolInputRaw.base=子会话 cwd`——委派子任务在 worktree 里跑，其声明路径按子 cwd 解析而非父聊天工作目录；base 从 session/event 回调的 header.cwd 线程化传入）。
- **投递**（engine `processInteractiveEvents` 的 `case 'presented'`）：读声明文件（复用 `feishu_bridge_send` 的 `readAttachment`：路径解析、50MiB 上限、mime 表+魔数嗅探；base 存在用 base，否则用聊天 effectiveWorkDir）→ 经 `sendToSessionWithAttachments` 投递（PresentedDelivery 词条）；读失败或超限跳过并附说明（PresentedSkipNote，进步度卡或独立消息）。子代理的 presented 事件经 `fromSubagent` 流过父聊天的事件循环，自动投到父群——子任务产物汇流的桥接零额外代码。
- **防双发**（v1 指令级）：`feishu_bridge_send` 描述从「唯一投递方式」改为「直发通道——完成的交付物先调 present，已 present 的文件不要再 send（会收到两份）」；子任务指引（subtask-prompts）同步改为优先 present。机械去重护栏（同回合同路径 send 抑制）留作后续。

## Alternatives considered

**只挂载不投递（纯声明，web 卡片消费）。** 放弃：飞书侧用户看不到任何变化，桥用户无感——评估报告判定的价值恰恰在「声明即投进群」。

**投递卡片加「发送到会话」按钮（懒投递）。** 放弃：action 端点 + session+path 寻址 + 声明后文件可能已变更的语义，链路长；评估已列为不推荐先做。

**present 落地时同步渲染 web 交付卡片文案到飞书。** 放弃：那是 web 面的消费（已自动生效），飞书侧用图片/文件消息本身承载。

## Consequences

- 模型一次声明得三件事：飞书收到实际文件、会话日志留持久交付记录（`deliverables/presented` 事件）、web 出交付卡片（消费链上游自带）。
- 上游 present 描述自带强指令（「用户要的输出必须 present」），桥侧只补 send 的防双发措辞——discoverability 两面（schema 描述 + send 的对向指引）就位。
- 子代理产物经 presented 汇到父群依赖指引（subtask-prompts 改为优先 present）；present 的会话归属规则是「子代理声明记在子会话」，桥的投影桥接（fromSubagent + base）正确处理该归属。
- 超限/不可读文件跳过不失败整个回合——present 声明本身是声明而非传输，传输尽力而为。
- 风险（已记）：过渡期模型双调 present+send 会双发——指令级防线的已知残余；出现频率高再上机械护栏。

## Testing

`tests/agent-dsh/adapter-projection.spec.ts`：父会话 presented 投影（content/toolInputRaw.files/description）。`tests/agent-dsh/adapter-subagent.spec.ts`：子会话 presented 投影（fromSubagent + base=子 cwd）。`tests/engine/engine-events.spec.ts`：引擎投递三情形（真实文件读出投递、子 base 解析、空声明静默）。`tests/bundle-patch.spec.ts`：tool-present 挂载断言。桥全量 3399 测试绿；typecheck 绿；verify-cordis-config 153 配置过；配对门 1040 绿。
