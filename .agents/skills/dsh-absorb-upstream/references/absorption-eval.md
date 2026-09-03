# 吸收评估方法论（第 2 段）

判断 fork 功能能否吃上上游新能力。产出评估报告后**停下等拍板**。

## 三分类

对每个 fork 相关的上游能力，读上游源与 fork 现状后归入：

| 分类 | 判据 | 处置 |
|---|---|---|
| **已等价** | fork 已有同语义原语（哪怕实现路径不同） | 不动；说明为什么等价 |
| **已半消费** | fork 用了服务的一面，另一面闲置（如只有 queue 档没有 steer 档） | 找未用的半边，评估补齐 |
| **完全未用** | 上游新能力 fork 零接入 | 评估接入点 |

## 读上游能力面

- **Service Definition**：包的 `src/index.ts` 服务类公开方法（JSDoc 即语义合同）
- **host 侧扩展**：`src/internal.ts` 的 symbol-keyed 方法与导出助手（host adapter 专用的缝）
- **语义注释**：实现文件里的分档表（如 continuation.ts 的 running/idle/settled 三档投递语义）——投递语义、竞态降级、冷恢复都写在注释里，直接引用，别自己重推

## 读 fork 现状

- `grep -rn "<符号名>" packages/acp/feishu-bridge*/src --include='*.ts'` 找消费点与结构镜像类型
- 顺着调用链走到底（工具 → engine → adapter → 上游服务），每层记 file:line
- 检查测试基座：fake/recorder 是否已预留了字段（如已记录但未断言的参数——补断言通常就是现成的测试切口）

## 托管架构验证（断言适用性之前必做）

断言「fork 功能 X 能用上上游服务 Y」之前，先确认 X 的**托管形态**——形态决定正确接入点，接错了整个评估白做：

| 托管形态 | 识别方法 | 正确接入点 |
|---|---|---|
| native continuable child | 经 `spawnSubtaskNative`/`startContinuable` 创建、在 subagent runtime 注册表里 | `[deliverSubagentPrompt]`（queue/steer 两档） |
| attended group（群会话） | 经 `spawnSubtask` 或 group spawner 创建、有自己的飞书群 | 引擎级 `deliverMachineMessage`（忙 steer / 空闲走管线） |
| 进程内 handle | 桥自己攥着 agent handle（如本会话的 /ps） | `Agent.steer` 直调，无需服务间接层 |

反面案例：初判「chatroom role 经 spawnSubtask 托管、可接 subagent steer 服务」——实际 role 经 group spawner 直接建群，是 attended group，正确原语是 `deliverMachineMessage`。三个形态最终可汇入同一个 inbox 机制（next-step / next-turn），但接入点不能混。

## 应用点映射表（评估报告主体）

每个应用点一行：**落点 | 机制 | 价值 | 工作量 | 权衡**。按推荐顺序排列，写明「明确不做」的边界（如 attended group 支持、更大范围的设计变更——留作后续立项）。

## discoverability 设计（新模型可见能力必答）

用户会问「agent 怎么知道可以这么用」。三处发现面：

1. **参数描述带决策指引**——不只写语义，写何时选它（"prefer steer to correct course..."）
2. **工具 DESCRIPTION** 的对应段落同步两档语义
3. **自然的提示点**（如 spawn/ask 的结果消息）主动写明干预通道——让模型在派发时刻就建立预期，而不是用到时才翻 schema

## 人工检查点

评估交付后停。等用户说「做吧」或选项卡勾选；未拍板前不改产品代码。用户常在此时追问细节（如 discoverability）——把答案折进设计再交一次。
