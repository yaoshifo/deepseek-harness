# Agent Note: tag discover 节流与验证未知语义

Status: implemented

[English](2026-09-03-feishu-tag-frequency-limit-handling.md) | 中文

## Problem

2026-09-02 oc_e51a 聊天室 spawn 暴露了三层 tag 故障。（1）`discoverTagFromSpawnedChats` 对每个 spawn 群（约 185 个且持续增长）背靠背连打 `im/v2 biz_entity_tag_relation` 读；应用撞上该方法的应用级频率限制（HTTP 400、code 99991400「request trigger frequency limit」），此后每一次读都失败——一晚 1388 连拒，且自 2026-08-20 迁移起凡缓存未命中的 tag 触发扫描就是这个模式。（2）绑定校验读回共享被抽干的配额：`chatHasTagID`/`chatHasActiveTag` 在查询失败时返回 false，于是实际已落地的绑定（bind_version 时间戳为证）被判「未生效」，驱逐好缓存 id 并拉黑——驱逐级联又逼出新一轮 discover，把限流坑越挖越深。（3）`im/v2 tag.create` 撞重名返回 402 且不带 `create_tag_fail_reason.duplicate_id`（对 live 租户实测验证），create 永远无法解析既有名称——解析完全依赖 discover 扫描与 sibling 缓存文件。

## Decision

- discover 扫描经共享令牌桶节流（`tagScanTiming`：间隔 400ms、burst 2；测试可注入 `scanLimiter`），并在首个 99991400 拒绝处中止：继续扫描只会进一步抽干应用配额且后续读必然失败。下一个 spawn 会重新发现。
- 校验改为三态：`chatHasTagID`/`chatHasActiveTag` 返回 true（读回含该 id）、false（读回成功且不含——校验为之存在的死 id 场景）或 undefined（查询失败——校验未知）。未知时保留已绑定 id，不驱逐不拉黑；只有干净的 false 才驱逐。`listActiveSpawnedChats` 把未知映射为非活跃，与之前一致。
- `feishuFrequencyLimitCode` 与 `feishuPatchRateLimitCode` 并列成为 retry.ts 的导出业务码常量；刻意不加入 `isTransientError`——扫描要中止，而一次性动作保持现行 fail-fast。

## Alternatives considered

- **对被限流的 chat 退避重试而非中止。** 节流门已防自伤，撞限流说明应用级配额被别处抽干；短退避填不满按分钟的窗口，且该循环本就是 best-effort。
- **把 99991400 当全局 transient 错误加进 `isTransientError`。** 一次性动作重试无害，但扫描会顶着上百次拒绝重试；两类调用点需要相反策略。
- **与 dev 服务器共享 tag id 缓存。** 范围外：两机缓存目录各自独立；租户 tag 名在租户内跨应用唯一，跨应用 402 重名是常态，同机 sibling 缓存仍是唯一共享机制。

## Consequences

- 测试钉住：discover 扫描每次读经一次 limiter wait 并在持有目标 tag 的群上解析；首个被限流读在后续群之前中止；校验读回失败时保留已绑定 id 不驱逐（oc_e51a 驱逐级联作为回归钉住）；既有的「干净 false 才驱逐」测试不变。
- oc_e51a 场次补救：管家群与 marks 助手群（仅有的两个解析彻底失败的群）已重新绑定 research tag 并读回验证；其余五个聊天室群虽有报错日志但早已打上标签。
- 部署：bridge 包重建 + 双机 `/reload`。下一次多群 spawn 复查：无「discover tag query failed」爆发；每次扫描至多一行「frequency limit; stopping」。
