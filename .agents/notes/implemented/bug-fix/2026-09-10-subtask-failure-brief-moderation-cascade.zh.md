# Agent Note: 失败汇报只带固定摘要，不带错误原文——关闭内容拦截级联

Status: implemented

[English](2026-09-10-subtask-failure-brief-moderation-cascade.md) | 中文

## Problem

2026-09-09/10 智谱 GLM 网关收紧了内容审核（code 1301：「系统检测到输入或生成内容可能包含不安全或敏感内容…」）。dev 服务器上 10 个会话被拦——而桥自身的失败汇报放大了波及面：子任务或聊天室角色回合出错时，失败汇报把**平台错误原文**（连同回合的半截流式输出）经 `deliverMachineMessage` 推进父/主持 agent 的上下文。上下文里平台的指控措辞（「不安全或敏感内容」）随即让父的下一个请求撞上同一个拦截——会话失败、汇报、下游再失败（deepseek-harness 桶三个会话的历史以传播来的 `⚠️ 子任务回合失败：[1301]…` 文本开头）。会话日志证据表明 `turn/end` 错误元数据从不进入模型上下文；失败汇报注入点是错误原文进入另一 agent 上下文的唯一通道。

## Decision

错误原因的失败汇报是**固定模板、零外来文本**——唯一的判别依据是「回合出错了」这个结构性事实（`if (errored)`），因为任何「哪些错误危险」的检测本身就是对平台输出的猜测（关键词匹配换措辞即破；JSON 形态匹配破于非 JSON 平台错误；设计评审中两者均被否决）。

- `failureBriefForAgentContext(errorText)`（feishu-bridge `engine/subtask.ts`，经 `./exports` 导出给 chatroom 包）渲染摘要：`[failure code=1301] 子任务回合中断（<处置建议>）。错误原文与半截输出未随附（防下游连锁误判）…；可用 feishu_bridge_subtask（action: send）追问该子任务获取进展。请求 ID：<id>。`
- 动态字段为正则提取 + 白名单校验（code 限 `[A-Za-z0-9_.-]{1,32}`；请求 ID 限十六进制/时间戳形态）——平台往字段里塞散文或超长文本时字段被丢弃，载荷永远进不来。零抛出路径：纯字符串扫描，无 `JSON.parse`。
- 按码处置建议表（1301 内容拦截 →「重试大概率再触发，建议调整任务或换模型路由」；429 → 稍候重试；401/403 → 报告配置问题；5xx → 稍后重试；未知 → 通用指引）在不回传平台措辞的前提下恢复父的决策质量。确认新错误码语义后在此表追加。
- 接线在三个 `if (errored)` 源头：子任务自动汇报（`engine.ts` processInteractiveEvents）、chatroom 角色失败 note、chatroom serial 失败唤醒（`chatroom.ts`）。Gather / end-barrier / native-child 路径消费这些源头，天然继承摘要。
- **半截流式输出不再随失败汇报传递**——它是被平台中途掐断的输出，无法验证其干净；恢复通道是落盘成果、子会话日志、`feishu_bridge_subtask` 追问（摘要内已指引）。
- 人保留原文：子群错误卡与 daemon 日志不动；父群汇报卡经新 `cardDetail` 通道（`maybeAutoReportSubtask` → `replyToParent` → `deliverParentReply`，可选参数）在 `---` 分隔线后追加错误原文；注入唤醒恒只带摘要。

**面向未来路径的约定**：任何把出错回合文本注入另一 agent 上下文的新代码路径必须经 `failureBriefForAgentContext`——原文只能到达人看的面（卡片、日志）。

## Alternatives considered

- **关键词/错误码检测「内容拦截」错误：** 否决——平台换措辞或换服务商即破防；漏判重开级联。
- **JSON 形态判别（平台 vs 本地错误）：** 否决——仍是形态猜测；非 JSON 平台错误（纯文本 SDK 失败、代理 HTML）漏过，且「本地」错误文本可能内嵌平台内容。
- **请求层自愈（自动摘除毒消息并重试父回合）：** 否决——改写回合语义与会话历史；触发物是任务自身内容时（本次事故中的台账数据）无能为力。
- **详情落盘传指针：** 否决——父 `read` 该文件即重新引入原文；指针只是推迟问题。

## Consequences

- 父/主持收到可决策信息（谁失败、错误码、建议、请求 ID、追问通道）且零外来文本；人在父群卡片与子群错误卡上看到完整原文。
- `code=未分类`（纯文本本地错误如 `No API key for provider`）会让父多一次可能无效的重派——接受；对人而言原文一次 `read` 或瞄一眼卡片即得。
- 丢失半截输出对叙述有价值的长任务是真实信息损失；若反复成为痛点，升级路径是「失败前进度汇报」（子任务在风险收尾步骤前主动汇报落盘状态），而非重新放行原文。
- 建议表覆盖开放：未知码落通用指引；确认的码在表内追加。
- 固定摘要措辞避开已知触发词（敏感/不安全/审核一类）；平台侧黑盒无法预先验证，部署后实效即验收。

## Testing

`packages/acp/feishu-bridge/tests/engine/engine-subtask.spec.ts`：摘要的防级联性（1301 JSON → 含码/建议/请求 ID 的摘要，无平台措辞、无半截输出，卡片附录携带原文）、提取矩阵（429/401/未知/5xx 建议、方括号前缀码、超长与非白名单 code 丢弃、请求 ID 缺省）、改写后的错误汇报行为测试。`packages/acp/feishu-bridge-chatroom/tests/engine/engine-chatroom-ask-routing.spec.ts` + `engine-chatroom-gather.spec.ts`：主持唤醒与 gather barrier 记录携带摘要而非原文或半截输出。两包全套 3379 测试全绿，`tsc -b` 双包干净。
