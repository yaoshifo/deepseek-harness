# Agent Note: 子任务目录重启对账——吸收上游 parent-subagent catalog 的读取面

Status: implemented

[English](2026-09-11-native-catalog-restart-reconciliation.md) | 中文

## Problem

2026-09-10 上游合并（9fe54af7a3）落地了 parent-owned subagent catalog：桥派生的每个 continuable 子任务都会在父会话日志写 `subagent/catalog` 创建事实（写入侧零成本继承），但 fork 的读取面零引用。桥自有的 `NativeChildRecord`（projectState JSON）有两个覆盖不到的丢失窗口：① crash 窗口——catalog 事实在 `startContinuable` 内落盘，而 projectState 保存发生在其返回后，中间崩溃则孩子既无通知也无 worktree 清理线索；② state 文件损坏/删除时 load 静默置空。重启恢复（`recoverInterruptedNativeChildren`）只对「登记在册且未汇报」的孩子宣布死亡，丢失登记的孩子完全不可见。

## Decision

只吸收「重启对账 + 丢失记录通知完整性」这一窄场景，面板数据源维持 projectState + 内存 activity map 不动：

- **墓碑**（`project-state.ts`）：drain 清理子任务记录前先 `markNativeChildCleared`（FIFO 上限 512），因为 catalog 只记创建不记删除——没有墓碑，对账会把已正常清理的孩子误报成丢失。
- **冷读取器**（`src/index.ts` `createNativeCatalogReader`）：照 `createPendingInboxReader` 模式——一次 `observeSession`（projectionMode 'all'）读 `subagentCatalog` 投影的直接子任务列表；投影单元由此处注册（fresh host 无 subagent runtime），为此在 `dsh-subagent` 主入口补了 `subagentCatalogProjectionDefinition` 运行时导出（与 dsh-agent-loop 导出 `inboxProjectionDefinition` 同款 seam）。未知/不可读会话解析为空列表。
- **对账**（`engine.ts` `reconcileNativeCatalog`）：`recoverInterruptedNativeChildren` 早期 return **之前**触发（丢失记录与中断是独立失败类）；对每个活跃会话冷读 catalog，catalog 有而登记无且无墓碑 → 红色警告卡（新词条 `SubtaskCatalogLostCardTitle/Notice`）说明「登记丢失、会话仍在存储、worktree 需手动清理」。可见性 only，不自动动作。

## Alternatives considered

**面板数据源整体切 catalog 为 membership 权威。** 放弃：catalog 是创建时事实，不含运行状态（activity 在内存）也不含 reported/worktree 字段，须 join projectState 补齐——单引擎所有权下无净收益，天级工作量。

**drain 时写补偿事件（catalog 删除面）。** 放弃：改上游事件面；墓碑在 fork 自己的 state 里达到同一判别效果。

**对账自动重建子任务面板。** 放弃：重启后 in-flight epoch 确实已死，重建面板会误导用户以为可续；对账只补通知完整性。

## Consequences

- crash 窗口与 state 损坏两类丢失现在有红色卡片可见，附 child session id（可 `feishu_bridge_subtask action=send` 复活追问）。
- 墓碑窗口 512：极老的历史孩子被逐出后，若其记录也早已不存在，对账会误报一次——可接受的边界（每会话孩子数远低于该量级）。
- 冷观察 O(日志长度) 仅发生在重启时一次性，绝不进 15s tick。
- `dsh-subagent` 导出加一行属上游文件改动，记入嫁接台账 subagent 组（与 inboxProjectionDefinition 导出同模式，随批提上游）。

## Testing

`tests/engine/project-state-shape.spec.ts`：墓碑往返与 FIFO 上限。`tests/engine/engine-subtask.spec.ts`：drain 落墓碑；对账三情形（丢失→通知含 id+label、墓碑→静默、全追踪→静默、无 reader→跳过）。`tests/agent-dsh/native-catalog-reader.spec.ts`：真组合冷读（真实投影+持久化，含 fork 切点语义由投影自身保证）。桥全量 3394 测试仅 1 例负载性超时（done-worktree-merged，单跑绿）。
