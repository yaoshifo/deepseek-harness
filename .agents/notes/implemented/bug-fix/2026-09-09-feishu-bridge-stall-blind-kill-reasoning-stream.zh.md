# Agent Note: stall watchdog 必须看见流式 chunk，resume 的会话必须保住已批准的模式

Status: implemented

[English](2026-09-09-feishu-bridge-stall-blind-kill-reasoning-stream.md) | 中文

## Problem

2026-09-09 oc_a8f451 事故（spawn 群「Pelican Bicycle SVG」，开发虾 daemon）：该群循环经历三张计划卡、两次 ⚠️ 无响应超时（200）重试、两张执行失败卡，最终以用户 /done 收场。会话日志显示两个执行 turn 都在精确的 200.5s 上以 `turn/end aborted/disposed` 死亡，而 mify 代理日志证明两次 LLM 流都活着——分别跑了 375.9s 和 587.1s 直到自然完成，被杀时刻各积累了 9.9k/20.4k 字符的连贯推理文本。两个缺陷叠加：

1. **盲杀。** GLM max 档生成单条超长消息：纯推理阶段以瞬态 `agent/assistant-stream` chunk 帧流出，消息完成前不落任何持久会话事件，引擎 pump 整个窗口收不到事件，`stallConfirmed` 无法区分「活流」与「挂死」——它的 `lastStreamActivity` 时钟此前只统计投影出的持久事件。watchdog 杀掉了全程在出流的 turn：与 2026-08-25 oc_29bb 事故同族，但那次修复只覆盖了通道退化场景（adapter 仍在投影、pump 已收不到）。
2. **重批准死循环。** stall retry 经 `startAgentLocked` 用原始启动选项重启会话，项目默认模式（live profile 开发虾 `agent.mode: plan`）在**每次** `startSession` 上重放——包括 resume——盖掉 resume 本应从会话日志恢复的 plan 状态（plan projection 折叠日志，最后一条 `plan/mode` 生效）。已批准的计划被退回 plan 模式，retry 注入合成「继续」，模型只能重新出计划等批准。

## Decision

- adapter 增订瞬态 `agent/assistant-stream` 帧（`packages/acp/feishu-bridge/src/agent-dsh/adapter.ts`）：每个 `chunk` 帧刷新所属 live 会话的流活动时钟（`DshAgentSession.noteStreamActivity`），使 `stallConfirmed` 既有的盲泵豁免覆盖引擎增量投影保持静默的 chunk 流——今天是 tool-argument 增量。reasoning/text 增量投影为引擎事件（`DshAgentSession.projectStreamChunk`，session format v2 的预览恢复）直接喂 pump，时钟是它们的第二道网。流自身静默满整个 idle 窗口的仍会被判 stall——2026-08-26 oc_b46da 冻结时钟对保护不回退。
- `startSession` 的模式解析对 resume 跳过群钉住的 `spawnMode` 与项目 `defaultMode`：resume 的会话以自身日志恢复 plan 状态，继承来的模式不得在其上重放。显式武装的 one-shot 覆盖在 resume 上仍生效（回收会话上的 /mode 切换依赖它）；fresh 会话保持完整优先级。

## Alternatives considered

- **把推理增量以 thinking_delta 事件投进引擎 channel。** 也能直接喂 pump，但会点亮流式思考卡片的 UX——超出 stall 修复的行为面，stall 修复只需要活动时钟。该投影后来在独立驱动下落地（2026-09-09，`projectStreamChunk`）：session format v2 砍掉了引擎增量投影所依赖的持久 `assistant/chunk` 事件，恢复思考预览必须投影瞬态帧。两者分层：投影为 reasoning/text 窗口喂 pump，时钟兜住其余一切 chunk 类型。
- **只调大 stallTimeoutSecs。** 已作为过渡措施部署（live profile 200→600），但它只是移动悬崖：任何超过窗口的单条消息生成仍会死。流活动信号才是机制修复。
- **用 mode-policy 监听器修循环（照 chatroom moderator 降级先例）。** 只补一个调用方；adapter 层的 resume 跳过对所有重启路径（stall retry、live-guard 回收、引擎重启）根治机制。

## Consequences

- 测试：真组合回归（脚本化 LLM 以 300ms 节奏流 reasoning chunk、对抗 400ms idle 窗口、2.4s 后才完成）以投影增量持续喂 pump 钉住不杀行为（`packages/acp/feishu-bridge/tests/engine/engine-stall-retry.spec.ts`）；同族 tool-argument 节奏用例（投影保持静默的 chunk 类型）钉住 `stall check overridden` 警告；既有挂流、重试耗尽、冻结时钟用例保持绿。adapter 单元测试钉住帧订阅契约与 resume 模式优先级（`packages/acp/feishu-bridge/tests/agent-dsh/adapter.spec.ts`）。
- 泵盲流——今天即投影保持静默的长 tool-argument 生成——每个 idle 窗口向 stderr 打一条 `stall check overridden` 警告，信息性噪音，接受；reasoning/text 生成直接喂 pump，保持静默。
- fork 会话仍继承 spawn/default 模式（它们是新会话）；unattended 子任务的 bypassPermissions 覆盖仍压过一切。
- 部署：桥重建 + `/reload`；live profile 的 `display.stallTimeoutSecs` 200→600 随同一次 reload 生效。
