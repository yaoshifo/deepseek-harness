# Agent Note: feishu-bridge context_window 链移除

Status: implemented

[English](2026-09-03-feishu-bridge-context-window-chain-removal.md) | 中文

## Problem

per-provider `context_window` 接线于 2026-08-20 落地（本 note 合并保全其记录），追求的是 Go 的 ctx% 分母语义：Go 里 `/provider` 切到窗口不同的模型后页脚仍按旧窗口做除法，因此该改动把 `ProviderRoute.contextWindow`（配置）→ adapter 路由 → `getActiveProvider()` → `applyActiveProviderContextWindow()` → `Engine.contextWindow` 全链接通，每次切换重算。TS 移植从未接上消费方：2026-09-03 的穷尽检查发现 `Engine.contextWindow` **没有任何读取方**——ctx%/占用率的分母来自各会话自己的 context snapshot（dsh-context 投影与 reply-footer 探测），报告的是模型的真实窗口。引擎字段是只写不读的死状态，按群 provider 改动又移除了切换路径上最后的重解析调用，剩下的配置、adapter 线程、两个引擎方法与三个字段全都在空转。

## Decision

整链移除：`Engine.modelContextWindow` / `contextWindow` / `projectContextWindow`，`setContextWindow()` 与 `applyActiveProviderContextWindow()`；`ProjectConfig.contextWindow` 与 `ProviderRoute.contextWindow`（接口、schema 行、装配转发与接线）；`ProviderConfig.contextWindow`；`AdapterProviderRoute.contextWindow`，`getActiveProvider()` 只回 name。活面不动：monitor 配置的 `contextWindow`（分诊消息数）、会话快照投影的窗口、`ContextUsage` 探测。只验证死行为的测试随行为一并删除。

## 备选方案

**给引擎字段接一个真实消费方。** 否决：会话快照已经报告逐会话的真实窗口，手工声明的配置覆盖只会让显示更失真而非更诚实——原始问题已被运行时自有的数据更好地解决。

**保留配置字段作为未来消费方的前向兼容。** 否决：该字段自落地起就无任何效果，死的配置面只会招来运维者以为有效而抄写的行。

**只移除引擎字段，保留配置与 adapter 线程。** 否决：没有消费方的半条链是同一笔债，还摊到另外三个文件里。

## Consequences

放弃的能力是运维手工声明按路由的 context window；因无任何消费方，无行为回归。bridge projects/routes 下携带 `contextWindow` 的配置行会被 schemastery 当未知键静默剥离——存量行变为惰性（无害，但值得部署时清理；Mac live profile 的 bridge 段没有该字段，其 pi-ai `models:` 条目是另一个活消费方）。重引入条件：若出现需要运维覆盖会话自报窗口的真实消费方，应在 dsh-context 投影侧重引入，而非再造一个平行的引擎字段。MIGRATION.md 的日期化进度条目仍以历史身份提及该接线。被合并的 2026-08-20 note 的动机已保全于上；其三件套按合并规则删除。

## Testing

absence 经 grep 验证：`contextWindow` / `setContextWindow` / `applyActiveProviderContextWindow` / `modelContextWindow` / `projectContextWindow` 在活簇（monitor 分诊计数、快照投影、ContextUsage 探测）之外零残留。死行为测试已删（adapter `getActiveProvider` 窗口带出、assembly-config 窗口接线、provider-commands 项目窗口钉住）。包级全量 2838 绿；仓库 typecheck 唯一失败是并行 merge `478507eb5e` 带来的三处 `followups.spec.ts` 预存错误（stash 本改动后验证一致）；本次触碰的文件零错误。
