# Agent Note: 并行 research 聊天室的按场草稿目录

Status: implemented

[English](2026-09-04-chatroom-parallel-run-dirs.md) | 中文

## Problem

同一启用机器人下并行多个聊天室在架构上是支持的：chatroom 状态按 hub 键控、账本目录按 `hashID(hubKey)-run` 键控、共享研究 venv 的创建已有跨聊天室互斥。剩下的干扰面是研究工作区根目录：每个研究助手与数据管家都以工作区根为 cwd，而助手前言的第一条纪律让他们把"所有脚本和数据写到当前目录"。并行的场随即互撞根目录下的笼统文件名（`logs_*.txt`、`beijing_housing/` 这类临时目录——生产工作区连单场运行都已留下这类残留），单场运行也会积累无从归属的草稿。

## Decision

引擎簿记隔离运行期草稿；共享资产按设计保持共享。research 预配时，每个角色助手拿到 `<researchWorkspace>/runs/<账本标记>/assistant-<角色>/`，管家拿到 `.../steward/`，账本标记即 `hashID(hubKey)-chatroomLedgerRun`——与账本目录同标记，一个聊天室实例一份草稿目录、审计线索对齐。目录预建（mkdir 失败仅告警；stamp 本身够用——助手首次使用时自行 mkdir -p），stamp 到 child 的 chatroom featureState（`researchRunDir`），由 chatroom 插件的 session-start-options 监听器经 `SessionStartOptions.subtask.researchRunDir` 携带，并写进助手前言第一条纪律。stamp 为空（无工作区，或从盘上恢复的未 stamp 会话）保持原有 cwd 文案。

不动的共享：venv、`data/core/`、`data/<角色>/`、append-only 的 `DATA_LEDGER.md` 留在工作区根——并行场照旧通过台账去重抓取。

## Alternatives considered

**cwd = 运行目录。** 否决：台账与数据纪律都是从工作区根出发的相对路径（`DATA_LEDGER.md`、`data/core/`），管家预取也假设唯一共享区；挪 cwd 会弄丢台账发现，只换来一行草稿收益。

**引擎级按域抓取队列 / 单一调度器。** 包 README 已延后；目录方案修不掉的并行代价是话题重叠（单域抓取压力放大反爬封禁）。用法约定不变：话题重叠的 research 场错峰；不相干话题与普通模式可安全并行。

## Consequences

两个并行 research 聊天室不再互覆草稿，每场的草稿可与其账本对齐审计。运行目录与账本同策略保留（不自动清理）。剩余并行毛边已记入包 README：同角色并行两场时 `data/<角色>/` 撞名、单一 `DATA_LEDGER.md` 的尾追加竞态、同角色跨场记忆 lost-update（dsh-memory 索引 upsert 是 last-write-wins——dsh-memory 通用并发事实，延后到该包处理）。

## Testing

`chatroom-state.spec.ts` 覆盖 `researchRunDir` 编解码往返（投影与 survive-reset carry）。`engine-chatroom-steward.spec.ts` 断言助手与管家的 stamp、落盘创建、无工作区时的 `''` 回退。`chatroom-subtask-seam.spec.ts` 断言 `subtask.researchRunDir` 装配及其缺省。`adapter-persona.spec.ts` 双向钉住 model-visible 的前言文本（指名运行目录、cwd 回退）。chatroom + 桥双包全量：180 文件、3175 过。
