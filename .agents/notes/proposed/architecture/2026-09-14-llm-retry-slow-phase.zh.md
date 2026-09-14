# Agent Note: 面向持续限流窗口的慢速重试阶段

Status: proposed

[English](2026-09-14-llm-retry-slow-phase.md) | 中文

## 问题

在同一个按 key 限流的 provider 上并行扇出子任务，429 窗口可以持续得比整个重试预算还长，而预算耗尽会判死回合。2026-09-14（群 oc_7cc55d35d47b058d17becd902ff39dda），五个调研子任务加两个计划渲染一次性会话共用 mify-dsh key：约九分钟的压力期内七个会话合计 414 次 429 重试。两个子任务在窗口中途耗尽了当时配置的 8 次 / ≈110 秒预算，回合以 `turn/end {kind: 'error', error: {code: 'RATE_LIMIT'}}` 结束。子会话以 idle 形态存活、上下文完整，被父 agent 重新唤醒——但这发生在父 agent 从 gather 看到失败摘要之后，多一跳往返且失败对用户可见。

同一失败模式 2026-09-11 也发生过（群 oc_4e9fa583，八个 agent，当时默认 5 次 / ≈16 秒预算，扇出回合全灭）。那次的修复把预算提到 8 次 / 30 秒帽；2026-09-14 事故说明加预算收窄但不关闭缺口——窗口长度本身跟随并发压力期：只要多个 agent 还在对着同一个 key 重试，窗口就不会闭合。

2026-09-14 已落地的缓解（纯配置：15 次 / 60 秒帽，总预算 ≈10 分钟，双机，[`cordis.patch.yml` 里 `providers.mify-dsh` / dev `providers.glm` 的 `retryPolicy`]）以有限余量覆盖实测的九分钟压力期。本提案负责剩余情形的设计：持续得连这个预算也压穿的窗口。

## 为什么显而易见的 fail-soft 行不通

最初设想的修法——「把限流错误回给 agent，让它自行退避续跑」——不可实现。RATE_LIMIT 失败意味着模型请求本身失败了，没有模型可以接收错误消息并做任何决定。agent loop 的请求错误路径（`packages/core/agent-loop/src/agent.ts`，`agent/request-error` 瀑布及其默认抛 `LlmError`）整体运行在模型之下。一切可行设计都把决策留在 harness 内部，唯一的问题是哪一层来等。

## 提案

在 `dsh-llm-retry` 的 normal 重试模式里加一个可选的慢速阶段，落在 provider 自有的 `retryPolicy` 配置上（`packages/llm/llm/src/retry-policy.ts`）：

```yaml
retryPolicy:
  mode: normal
  maxRetries: 8                 # fast phase: exponential 800ms → maxDelayMs (current behavior)
  backoff: {initialDelayMs: 800, maxDelayMs: 30000, jitterRatio: 0.3}
  slowPhase:                    # optional; absent = current behavior exactly
    maxRetries: 5               # slow phase: fixed cooldown attempts after fast exhausts
    cooldownMs: 300000          # jittered ±30%
```

机制：

- **执行器分支。** `dsh-llm-retry`（`packages/llm/llm-retry/src/index.ts`）现行在 `previousRetry >= policy.maxRetries` 时返回 `next()`——把失败交给瀑布默认动作抛错（第 223 行）。配置了 `slowPhase` 后，该分支在 `previousRetry < maxRetries + slowPhase.maxRetries` 时改为调度一次慢速重试，等待 `cooldownMs`（沿用现有抖动与取消语义）。慢阶段继承快阶段的 `retryableCodes` 门：认证类硬失败永不进入慢阶段、保持快速失败。慢预算也耗尽时照旧走 `next()`，回合仍会结束——有界、可见、不被掩盖。
- **连续计数器，投影不变。** `llmRetry` 投影状态保持 `{retry, retryId}` 形状：计数器跨阶段边界连续（快 1..8、慢 9..13）。阶段可从现有事件字段推导（`retry > maxRetries`），`LlmRetryEventData` 不加新字段，会话事件 schema 维持原样。
- **策略键。** normal 模式的 `retryPolicyKey` 追加慢阶段参数，配置变更时按新键重开本步重试状态，避免跨策略错记计数。
- **配置校验。** `slowPhase` 加入策略 schema 接受的顶层键（`validateKeys` 现行拒绝未知平铺键）；`resolveRetryPolicy` 负责默认值、校验与冻结。`maxDelayMs` 不封顶 `cooldownMs`——两者回答不同问题（单次退避上限 vs 第二阶段等待时长），封顶会静默删掉配置的余量。
- **不变量。** `dsh-llm-retry` 的 `invariant` 伴随包扩展其历史校验：会话策略键带慢阶段时接受 `retry` 超出快 `maxRetries` 的计数，否则拒绝。

为什么是这个形状而不是更大的单一快预算：一条要覆盖多分钟窗口的指数曲线，要么把早期重试浪费在一个短期不会闭合的窗口里，要么把帽设得连瞬态毛刺也要等好几分钟。两阶段让瞬态恢复保持今天的速度，只在快预算证明了窗口是持续型之后才花长等待。上述形状的典型总韧性：快阶段 ≈2 分钟 + 5×5 分钟 ≈27 分钟。

## 已考虑的替代方案

- **`mode: 'always'`（已实现）。** 对每次失败重试——包括认证及其他硬错误——直到成功、取消或 dispose。对共享 key 的生产路由被否决：配错的凭证会让回合无限期挂住，而不是快速失败并暴露。
- **回合级自动续跑。** 照旧结束回合，再由插件调度延迟的续跑消息（即父 agent 本次手动使用的唤醒路径）。活动部件更多——合成消息语义、会话之外的计时器归属、与 gather「先结算后失败摘要」次序的交互——换来的恢复效果与慢阶段相同，而慢阶段根本不结束回合。只有当出现真正需要先结束回合的失败类别时再重议。
- **provider key 并发信号量。** 按 key 封顶在途请求数，让扇出根本不触发限流。这是根因修复，但它跨会话（daemon 全局状态）、mify key 的安全并发数未知、排队改变所有消费者的吞吐特征。不在本提案范围；若慢阶段落地后扇出限流事故仍复发，这是下一级升级，由独立提案承接。

## 实施门槛

实现有意推迟。2026-09-14 部署的 15 次 / 60 秒帽必须先被证明不够——即未来出现子任务回合死于 RATE_LIMIT 耗尽、且其 `llm/retry` 事件里可见新 `policyKey` 的事故（这一类的排查指纹已记录核对方法）。在那之前，本文持有设计，使实现成为一个决定而非一次调研。

## 验证计划（供实施变更使用）

- `resolveRetryPolicy` 单测：`slowPhase` 缺省 → 行为与现行完全一致；存在 → 默认值、校验（拒绝平铺键与非正值）、冻结输出。
- 执行器测试（`dsh-llm-retry`）：带 `slowPhase` 的快耗尽调度冷却重试而非 `next()`；慢耗尽到达 `next()`；不可重试码永不进入慢阶段；慢等待期间 abort 干净结算、不再尝试。
- 不变量测试：带慢阶段策略键的历史接受 `retry > maxRetries`，不带则拒绝。
- 现有 llm-retry 面的录制会话快照不受影响（事件形状不变）——通过其现有快照套件确认。
