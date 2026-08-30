# Agent Note: feishu-bridge /fork 可种子飞行中的回合 —— 平衡切割加合成收尾

Status: implemented

[English](2026-08-30-feishu-bridge-flying-turn-fork-seed.md) | 中文

## Problem

2026-08-30 事故（群 `oc_5fd5cd` → fork 出的群 `oc_2b8c`）：父会话唯一的 turn 已在 `ask_user_question` 卡片上阻塞数分钟，因此**没有任何已完成的 turn**。fork 种子只裁剪到最后一个 `turn/end` 为止（对齐 Go `copyForkSession`）——得到空前缀。子群建了出来、就绪卡宣称"已复制当前对话上下文"，子 agent 却回答自己什么都没收到。停在交互卡片上的回合正是最典型的飞行中状态，所以"turn 完成后才能 fork"恰好在用户从待决策点分叉出去的时刻失效。

## Decision

`seedablePrefix`（纯逻辑模块 `agent-dsh/fork-seed.ts`，沿 `fork-at.ts` 先例）为全部三个消费方构建种子——live 父会话、`persistedForkSeed`、`seedForLiveParent`（`/btw`、predict）。无飞行 turn 时与旧完成 turn 前缀逐字节一致；有飞行 turn 时按优先级切到最后一个平衡点：开放 step 的 assistant 消息带调用时切到最后一个悬空 `tool/call`，不带调用时切到该消息本身，只有流式 chunk 时切到最后一个 `step/end`，turn 尚无完成 step 时切到首个 step 前最后一个 `user/message`，什么用户可见内容都没有时整个 turn 丢弃。切点用合成事件收尾：每个悬空调用一条结算事件，逐字复用运行时 `/stop` 中止阻塞工具的形状（isError `AbortError` result，带 `surfaceOp: 'append'`、`sourceEventSeqs` 指向被结算的调用；出处：生产日志 `--home-hm-workspace-money--/cc-20260830-130031` seq 1533-1535），随后 `step/end`、再 `turn/end`（`interrupted`，既有的基础设施收尾标记，不扩展词汇表）。种子契约（无开放 turn/step、无悬空调用、seq 连续）由构造保证；父会话自身日志与仍挂着的卡片永不被触碰——fork 保持非破坏性，Git 分支语义。

## Alternatives considered

**无可种子内容时在 `cmdFork` 快速拒绝。** 弃：需求是飞行中 fork 能用，不是被拒绝；拒绝只是把失望换了位置。

**fork 时中止父回合，再复制已结算前缀。** 弃：零合成地复用中止机制，但会拆掉父会话挂着的 ask 卡——用户探索完分支后可能还想回父群作答。fork 不能替父会话做决定。

**整个丢弃开放 step（只收 turn）。** 弃：切割点将永远落在最新、最待决策的内容——概括分析结论的待答问题上；且在"先停再 fork"（保留已结算 step）与"飞行中直接 fork"之间制造信息悬崖。本 note 消除的正是这个不对称。

## Consequences

飞行中 `/fk` 现在继承与"先停再 fork"相同的内容：飞行 turn 的用户输入、已完成 step、以及以 aborted 结算呈现的待答问题（子会话可以重新问）。任何悬空调用——ask、长 bash、gather——统一且如实地结算。只要存在可种子内容，就绪卡的"已复制上下文"即为真话；残余角落（毫无用户可见内容的会话）保留仅 warn 的全新降级。已知后续、刻意不在本改动内：rollback fork 的 `cutAfterTurn` 在引用消息落在仍开放 turn 时返回 `events.length`，产出违反同一契约的非平衡种子——修它需要按引用消息细化 step 语义，不是这个前缀函数。

## Testing

`tests/agent-dsh/fork-seed.spec.ts` 覆盖五种切割形态、并行悬空调用结算、seq 连续性，并用完整形状的合成种子过真实 `Session.create` 边界；`tests/agent-dsh/adapter-fork.spec.ts` 钉住 live 与持久化两条路径上的 ask 阻塞事故形态与飞行用户消息形态。
