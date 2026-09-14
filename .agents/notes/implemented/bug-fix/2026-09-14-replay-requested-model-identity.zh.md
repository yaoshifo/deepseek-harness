# Agent Note: 网关路由历史按请求模型身份回放

Status: implemented

[English](2026-09-14-replay-requested-model-identity.md) | 中文

## Problem

网关路由（mify 后面的 `anthropic-messages`：请求 id `zhipuai/glm-5.3`，回报模型 `glm-5.3`）上的长多步会话，模型的工作推敲逐渐从思考通道迁入普通正文块，飞书进度卡实时播报区随即把它们当正常正文显示（oc_084673f seq 333，一段 667 字的几何推敲块，被用户逐字引用）。机制已于 2026-09-14 端到端验证：

1. `replayedAssistant`（7bab91d247，2026-09-08 合入 dev）给回放的 `anthropic-messages` assistant 历史盖提供方回报的模型名，使 pi-ai 的跨模型签名规则适用于 Anthropic 别名/回退历史。
2. 路由 id 必须带厂商前缀而回报名不带的网关，因此在**每条**消息上错配：`transformMessages` 看到 `model: 'glm-5.3'` 的历史对着 `zhipuai/glm-5.3` 的请求，判定为跨模型。
3. 跨模型回放把每个思考块转成纯文本——签名在不在都一样（`allowEmptySignature` 只管另一条「签名缺失」路径，而该路径从未触发：签名一直记录在回放状态里）。
4. 模型一轮轮读到自己先前的推敲以正文形式存在，模仿该模式，把推敲迁入正文通道。这个环需要轮数累积才成型，所以短会话看起来干净、长会话泄漏——与 2026-09-10 观察到的会话内梯度一致。

证据：用泄漏会话自身的回放状态做源码级复现（默认盖章下思考块上 wire 前变成 text，修复后保留）；dev 服务器对照组（同代码、同 pi-ai、智谱直连路由的裸名 id 恒匹配——五天 148 个会话几乎零迁移，对比 mify 480 个会话 356 个迁移块，87 倍差）；网关探针（mify 接受带签名与空签名思考回放，拒收裸名模型 id，因此不能靠改路由 id 绕过）。

2026-09-10 对同一症状的排查结论是「mify 返回无签名思考」，并把 `allowEmptySignature` 留作止血方案。该诊断查的是 content 块上的 `signature` 字段，而 dsh 把签名存在 `source.replayState.blocks[].thinkingSignature`——签名当时就在。记录在案的根因与止血方案对真实机制均无效。

## Decision

新增路由级 profile 字段 `replayModelIdentity: 'requested' | 'resolved'`（默认 `'resolved'`），选择回放 assistant 消息携带的模型身份。`'requested'` 盖当时的请求 id，让「同模型、不同拼写」的网关按同模型回放：pi-ai 连签名保留思考块，反馈环关闭。只有 `anthropic-messages` 分支读该开关；Completions 回放本来就用的请求 id。mify-dsh live 路由配 `'requested'`。

默认保持 `'resolved'`：上游的盖章是为真实的 Anthropic 别名/回退历史存在的，那里 pi-ai 的跨模型转换是保护——回退模型的思考签名对主模型无效，转文本才是安全回放。「网关名字错配」是只有路由所有者能陈述的部署事实，所以这里是配置项而不是对所有部署的行为变更。

## Alternatives considered

- **无条件回放请求 id（撤掉 7bab91d247 的盖章）。** 否决：对盖章真正保护的回退场景是回归，且让所有部署偏离上游行为，而问题只有名字不同的网关路由才有。
- **把路由的模型 id 改成网关回报名。** 不可行：mify 拒收不带前缀的模型 id（探针：401「该模型未指定供应商」），且路由 id 就是 wire 上的 `params.model`。
- **修 pi-ai 的 `transformMessages`，把名字相似的模型当同模型。** 本仓库做不到：pi-ai 是 npm 依赖，且任何命名启发式都分不清「同模型的别名」与「另一个模型的回退」。opt-in 开关陈述的正是只有部署知道的事实；向 pi-ai 上游提议「带签名回放、失败即响」仍是开放项。
- **在飞书卡片显示层过滤疑似推敲的文本块。** 产品所有者 2026-09-10 已否决（显示层维持设计），且修不了底层的通道迁移——它同时降低回复质量、膨胀回放上下文。

## Consequences

- mify-dsh 路由的历史按同模型带签名回放；其模型的思考留在思考通道，不再迁入正文。存量会话无需迁移：回放状态一直记录着请求 id。
- Anthropic 别名/回退行为不变（默认 `'resolved'`）；开关对 Completions 路由无效。
- 网关将来若拒收带签名思考回放，会以提供方 400 显性失败；回滚只需删掉 profile 一行。
- 测试：`convert.spec.ts` 锁定三个行为——`'requested'` 让思考块穿过 `transformMessages` 保留（修复本体）、默认盖回报模型（上游行为）、Completions 回放不受开关影响。
- 上游化：「别名 vs 网关」的区分是 pi-ai 层的盲区，待本 fork 的 opt-in 积累生产里程后值得向上游提议。
