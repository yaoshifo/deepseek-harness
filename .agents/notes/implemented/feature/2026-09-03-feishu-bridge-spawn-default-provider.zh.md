# Agent Note: feishu-bridge spawn 群默认 provider 路由

Status: implemented

[English](2026-09-03-feishu-bridge-spawn-default-provider.md) | 中文

## Problem

按群生效的 provider 路由让每个既有群拥有自己的路由，但 spawn 出来的群什么都没有：/spawn、//fork、子任务派发群、chatroom 角色群与调研助手、monitor 子群都是新的 session key，各自在首轮解析到项目默认路由（`agent.provider`），且子群有意不继承发令群的路由（[按群 provider 路由](2026-09-03-feishu-bridge-per-chat-provider-routes.zh.md)）。主群聊天跑全量模型、spawn 面是调研与围观群的部署（一次 chatroom research 预派几十个角色群）想给这些群换便宜路由，只能在群出现后逐个手动 pin。

## Decision

新增 per-project 字段 `agent.spawnProvider`，值为 `config.providers` 中的路由名，是这个 bot spawn 出的所有群的默认路由。装配层用与旁路 provider 引用相同的 fail-loud `providerRefError` 清单校验它（未知名字拒绝启动；'' 或缺省表示无默认），再接到 `Engine.spawnProvider` 上。

`Engine.seedSpawnProvider(childKey)` 在两个建群汇聚点运行，时机都在子群首个 agent turn 解析路由之前：`spawnGroupCommon`（/spawn 与 //fork 共用）与 `spawnSubtask`（有人围观的子任务群、chatroom 预派助手含 idle spawn、monitor 子群），各自紧跟在子会话记录写完之后。它种下的是一条真实的 provider override——对 agent switcher 调 `setSessionProvider`，并经 `providerSaveFunc` 持久化——因此被种子的群与用户手动 `/provider` pin 过的群行为完全一致：路由跨 daemon 重启与 `/new` 存活，`/provider switch` 可覆盖，`/provider clear` 把该群退回项目默认路由（不是退回 `spawnProvider`；clear 的语义是「回 bot 默认」，与 workspace-dir override 的回退一致）。

范围（2026-09-03 用户裁定）：覆盖全部建群路径，不只用户命令——一条规则：bot spawn 出的群默认跑配置的路由，bot 自己的群聊保持 `agent.provider`。子群的 🤖 行、回复 footer 与 `/context` 模型行本就按会话解析路由，展示随之生效，无需改动。native continuable 子任务（无人围观的 `feishu_bridge_subtask` 派发，无飞书群）不是群聊：它们继承派发会话的 agent options，不在本范围内。

## Alternatives considered

**spawn 时继承发令群的路由**——per-chat note 预留的种子机制。否决：用户要的是固定默认（spawn 工作面统一走便宜路由），不是传播发令群碰巧所在的路由；pin 在便宜路由上的群会把子群拖到便宜路由，全量模型的群又会让子群继续花全量的钱。父群路由继承仍可日后挂同一个种子调用加上。

**把项目默认翻成便宜路由，再手动 pin 主群**——零代码。否决：项目默认同时兜底所有没有 override 的群（cron 运行、hub 群、每个新群），一动就是整个 bot，且每个既有群都要补一个跨重启存活的 pin。

**`/spawn --provider` 旗标**——镜像 `/spawn --plan`。否决：一次只管一个 spawn，够不着 agent 发起的路径（子任务群、chatroom 预派、monitor）；默认值必须放配置里才能覆盖它们。

## Consequences

买到：spawn 出的群跑配置的路由（本部署：运维虾 `mify-flash` → `zhipuai/glm-5.3-flash`），带项目的 reasoning effort，无需逐群手动 pin，chatroom research 从第一个预派助手起就按便宜路由计费。代价：每个 spawn 群在 project state 里多一条 `provider_overrides`，该 map 随 spawn 量增长——与 `workspace_dir_overrides` 完全同形；实现级子任务群同样跑便宜路由（范围裁定接受——若派发质量要求全量模型，日后可加按路径拆分的第二字段）；既有 spawn 群不追溯，只有配置落地后 spawn 的群受影响。

配置的名字日后从 `config.providers` 消失，下次启动装配即以共享的 providerRefError 失败——它属于配置、在装载时检查，运行期的过期 override 自愈不适用于它。

## Testing

`tests/engine/commands.spec.ts`：/spawn 与 //fork 种 override 并经保存钩子持久化；发令群保持项目默认；未配置时不种子也不持久化。`tests/engine/engine-subtask.spec.ts`：spawnSubtask 为子群种子，idle spawn 同样覆盖。`tests/assembly.spec.ts`：`agent.spawnProvider` 未知路由名 fail loud（'' 通过）、合法名接到 `engine.spawnProvider`。包级全量 3164 绿。真机冒烟待部署：新 spawn 群的 🤖 行读 mify-flash、发令群仍为 mify-dsh。
