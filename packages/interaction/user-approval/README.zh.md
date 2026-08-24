# @deepseek-ai/dsh-user-approval

[English](README.md) | 中文

与通道无关的审批 seam。`ctx.approval.request(req)` 返回 `ApprovalResult`：一个 `allowed-once`、`allowed-always`、`rejected`、`cancelled` 或 `unavailable` 结果，外加可选的有界应答者附言；应答者缺失或失败时会以拒绝方式关闭，授权也只适用于所请求的操作。应答者返回的 `allowed-always` 会额外记录一条内存常驻授权，同一 (agent, 工具) 对的后续询问不再分发、直接判定——但仍以 asked/decided 事件对完整审计。确切事件签名见 [approval.md](../../../docs/subsystems/approval.zh.md#cordis-surface) 的生成区块。

每个请求都必须属于一个尚未结束的 agent（智能体）轮次。服务会追加一对 `approval/asked` 与 `approval/decided` 审计记录，而模型只会看到由此产生且已写入日志的工具结果。已中止的请求会解析为 `cancelled`；如果审计记录的追加在提交前失败，Promise 会被拒绝，而不会返回一项未记录的决定。

应答者是 `approval/request` waterfall（瀑布式事件）监听器。要回答其负责的 agent 请求，请返回一个结果（或携带附言的 `ApprovalAnswer`）；否则调用 `next()` 委托。限定到 agent 的监听器只接收该 agent 的请求；每项部署应当组合一个最终应答者，因为同级监听器的顺序不是策略优先级机制。ACP（Agent Client Protocol）自动化桥接层为其负责的会话提供一次性机器决定。

`ApprovalPolicy` 为 `'ask'` 或 `'never'`。实际值取最后一条 `approval/policy` 事件，并回退到配置；`setApprovalPolicy()` 是写入路径。`'never'` 会在交互式分发之前拒绝请求。两种策略都会将各自完整的当前含义贡献给缓存安全的运行时上下文快照。

工具流水线通过此 seam 路由 `ask` 决定，并在该 seam 缺失时以拒绝方式关闭；沙箱 bash 工具也会将它用于升权重试。ACP 自动化桥接层根据客户端的机器策略，回答其自有 agent 的调用。审计事件仍只写入日志，因此模型只会看到发起请求的消费方所返回的结果。详见[审批 seam Agent Note](../../../.agents/notes/implemented/feature/2026-07-06-approval-seam.zh.md)和[沙箱 Agent Note](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.zh.md)。

## 模型体验

### 当前审批策略上下文

#### 模型看到的内容

首次请求和有效策略每次变化时，都会在保留的历史后追加一份完整运行时上下文快照。在 `ask` 下，审批上下文内容会说明系统可以咨询已配置的应答者，缺少可用应答者时则以拒绝方式关闭。在 `never` 下，它会说明确定性的拒绝与非升权后果。未变化的请求会保留先前快照，不增加另一条消息。

##### Ask 策略贡献

```markdown
Approval policy: ask. Operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed.
```

##### Never 策略贡献

```markdown
Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).
```

#### Token 影响

首次请求和策略实际变化时增加一条简洁的上下文消息；未变化的请求不增加重复的策略 token。

#### KV Cache 影响

在保留的历史之后仅追加。`ask`／`never` 切换会保留稳定的系统与对话前缀，而不会改写第一条 wire 消息。

### 工具结果

#### 模型看到的内容

`approval/asked` 和 `approval/decided` 只写入日志。模型只会看到发起请求的消费方最终给出的允许、拒绝、取消或不可用工具结果；面向人类的权限 UI 不属于上下文。应答者附言随消费方的拒绝文案进入模型（工具流水线为 `the user rejected tool "<name>": <note>`）；授权附言对模型不可见。

#### Token 影响

不会产生重复的审计 token。拒绝可能以一条简短且会保留的错误信息替换正常工具结果，而允许会保留消费方的普通结果。

#### KV Cache 影响

仅追加；新出现的可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与暂缓事项

- **请求只在尚未结束的轮次内有效**：在空闲时或轮次之间发起调用，会在审计前抛出异常；持久化的轮次外审批工作流仍属暂缓事项。
- **常驻授权是内存态且以 agent 生命周期为界**：`allowed-always` 让同一 (agent, 工具) 对的后续询问免于重问，直到该 agent 对象消亡；没有撤销面、没有持久化授权存储，会话策略仍只有 `ask`／`never`。
- **工具入参预览由发起方限界、服务不限界**：`ApprovalRequest.toolInput` 仅供 UI（不进审计；原始参数已在配对的 `tool/call` 里），应答者展示时需自行限界；ACP 机器通道仍要求调用 id，并会委托不含 id 的请求。
- **附言通道止于进程内应答者**：api-proxy wire 中继只转发结果，远端客户端的评注无法经 `ApprovalAnswer.note` 传递；待远端应答者需要时再扩展 wire。
- **没有内置应答者**：无头或组合不完整的部署会返回 `unavailable` 并以拒绝方式关闭；服务自身绝不会提示人类。
