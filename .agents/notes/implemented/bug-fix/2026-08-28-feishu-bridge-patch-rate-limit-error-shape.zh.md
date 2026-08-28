# Agent Note: Feishu PATCH rate-limit errors are classified by body code, and the PATCH bucket sits under the 5 QPS limit

Status: implemented

[English](2026-08-28-feishu-bridge-patch-rate-limit-error-shape.md) | 中文

## Problem

飞书卡片 PATCH 撞上单条消息更新频控(业务码 230020,「update the single messages too frequently」)时,按设计应当视为瞬态错误:`retry.ts` 的 `isTransientError`(经 `code=230020` 消息子串)和 `platform.ts` 的 `isTransientPatchError` 都为 230020 写了专门分支,注释明说它数秒内自愈、绝不能把流式卡片打入降级。但生产里这两个判定从未命中:`@larksuiteoapi/node-sdk` 重新抛出的是 AxiosError,message 只有「Request failed with status code 400」——业务码在 `err.response.data.code` 里。于是连续 4 次限流拒绝把 `failedPatchStreak` 推过降级阈值,流式卡片在 turn 中途冻结,而 agent 还在后台正常干活(2026-08-28,「飞书卡片触发场景分析」群:16 分钟无任何卡片更新,直到用户终止 turn)。

既有测试不可能抓到这一点:所有 fixture 都把假错误构造成「码拼在 message 里」的文本形状,两个分类器对着一种生产中不存在的形状全绿。

触发侧同样有账要算:PATCH 令牌桶默认 120 ms、burst 3(约 8.3 次/秒),高于飞书文档的单条消息更新 5 QPS 限制——热卡的突发本来就会越线,限流拒绝串是这么来的。

## Decision

业务码提取改为形状感知并单一来源:

- `retry.ts` 新增 `feishuBusinessCode(err)`:读 `err.response.data.code`(SDK 的 AxiosError 形状,归一为字符串),并回退到 `code=(\d+)` 的消息扫描以兼容旧文本形状。两者都不用 instanceof——本包不依赖 axios,响应体是唯一有承载意义的部分。
- `isTransientError` 在消息子串扫描之前,先判提取出的业务码是否为 `230020`(导出为 `feishuPatchRateLimitCode`);冗余的 `code=230020` 子串从列表移除。
- `FeishuPlatform.isTransientPatchError` 即 `feishuBusinessCode(err) === feishuPatchRateLimitCode`。

PATCH 桶默认值从 120 ms 调到 200 ms(`patchRateIntervalMs ?? 200`),让单张热卡正好落在文档频控 5 QPS 之内而不是之上。burst 3 保留:一秒窗口内的瞬时突发仍可能被拒,这部分残余交给瞬态路径——乐观写入的 `lastSentText` 回卷、下一次 flush 重发,卡片短暂滞后而不是降级。

## Alternatives considered

**放宽 message 匹配。** 在关键方向上不可行:message 里根本没有码。改按 HTTP 400 状态匹配则会把一切业务失败都当成瞬态。

**用 `instanceof AxiosError` 区分错误。** 否决:分类器只需要响应体,为此给代码引入 axios 依赖不值得,鸭子类型的 fixture 也让测试保持零依赖。

**按消息限流,替代全局桶。** 暂时否决:全局 200 ms 桶已把任意单卡压在文档频控之下,两张并发流式卡各 5 QPS 也远低于应用级 50 次/秒上限;按消息限流的簿记成本是瞬态路径不需要的。

**改用 cardkit 流式更新 API(单卡实体 10 次/秒)。** 这是更新吞吐的正解,但需要大改预览卡的构建与发送方式;延后处理,本次不做决定。

## Consequences

- 230020 拒绝的代价变成丢一帧中间态、下次 flush 重发;`degraded` 只对真正的非瞬态失败连击生效。「卡片已死、agent 还活着」的冻结形态必须有非瞬态原因才会出现。
- 所有走 `withTransientRetry` 的飞书操作(send、reply、patch 等)现在都会对 230020 退避重试。对「过于频繁」类错误这是无论哪个接口都正确的语义;各接口的限流桶相互独立,所以只会在真正发生拒绝的地方多出退避。
- 200 ms 默认值轻微抬高了所有卡片的更新下限;有 flush 合并在,实际感知不到。

## Testing

`tests/feishu/transient-retry.spec.ts` 对 AxiosError 体形状与旧文本形状都断言 transient,体形状下的 230011(消息已撤回)断言为非瞬态,并为 `feishuBusinessCode` 补了单元用例(响应体优先、文本回退、普通错误返回 undefined);patch 包装器的重试用例改用体形状。`tests/streaming.spec.ts` 的假 checker 改建在 `feishuBusinessCode` 之上,「transient (230020) PATCH failures never degrade」用例用真实体形状跑满六次更新尝试,并断言失败串之后的重发成功。feishu-bridge 整包 2706 个测试(158 个文件)全绿;host/client 双 face typecheck 通过。
