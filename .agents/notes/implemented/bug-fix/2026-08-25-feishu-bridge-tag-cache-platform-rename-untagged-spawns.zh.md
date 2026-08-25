# Agent Note: feishu-bridge 平台改名重置标签状态文件；按项目名落键、legacy 合并与不可绑 id 黑名单

Status: implemented

[English](2026-08-25-feishu-bridge-tag-cache-platform-rename-untagged-spawns.md) | 中文

## Problem

给各项目加 `feishu.tag`（`riskai`、`op-dev` 等平台名）会改写每个 bot 的全部状态文件名：tag id 缓存与 spawn 群注册表都以 `` `${projectName}_${platformName}` `` 为键。换名后的文件从空开始，丢掉了 app 已解析出的标签 id——而 im/v2 没有按名查 id 的途径：名字属于本 app 时 create 返回自己的 id；名字被别的 app 占用时返回 402（或指向对方标签的 duplicate），sibling 缓存兜底则照单全收 sibling 文件里的任何 id。绑定外 app 的标签 id 返回 `code=0` 但什么都不创建。

verify-after-bind 能抓到每次失败，但恢复路径是个闭环：清掉缓存 id、重解析，sibling 扫描（过滤条件是 `*_feishu_tag_cache.json`，只看得见改名前的文件）又递回同一个外 app id——`re-resolved the same id; giving up`。改名后每次 spawn 的群都没有标签。2026-08-25 因此在线上产生了 5 个没标签的 `riskai` 群和 8 个没标签的 `dev`/`harness` 群；修复动作（种回各 bot 自己的 id、合并注册表、直连补绑漏掉的群）属于运维处置，不进代码。

## Decision

- **状态文件只按项目名落键**（`<project>_spawned.json`、`<project>_tag_cache.json`）；平台名不再参与，今后改 `feishu.tag` 不会再重置状态。
- **load 时把 legacy 形态合并到主文件之下**：`<project>_<platformTag>` 与 `<project>_feishu` 两种变体在 load 时读入，主文件条目优先，合并结果落盘到主路径。迁移只覆盖这两个历史形态；更老的不尝试。
- **`TagManager` 增加不可绑 id 黑名单**：绑定后验证失败的 id 被标记为不可绑（目录标签重试路径与活跃标签候选循环都会标记）。`ensureTagCached` 在所有来源——缓存、create-duplicate、从 spawn 群反查、sibling 文件——跳过黑名单 id，只剩不可绑 id 时抛错，重解析不可能再落回同一个外 app id。
- **sibling 扫描接受任何 `*_tag_cache.json`**，改名形态之间恢复 sibling 共享。

## Alternatives considered

**持久化黑名单。** 否决：每进程一次失败绑定尝试的成本很低，且盘上格式保持稳定。

**用文件改名做迁移。** 否决：合并幂等、一次覆盖两个历史形态、且绝不丢主文件条目。

**借用前先验证 id。** 做不到：im/v2 没有 tag List/Get；只有绑定加关系回读才能证明一个 id 对本 app 可绑。

## Consequences

黑名单只在内存里，持久化的外 app id 每进程会重试一次再进黑名单。legacy 文件迁移后仍留在盘上并继续供给 sibling 扫描；其条目逐次绑定验证，陈旧性的上界是一次浪费的尝试。注册表合并在 save 时走既有 retention 清扫，给非活跃的迁移条目回填 `doneAt`——既有语义，未改变。

## Testing

`tag.spec.ts`：验证失败的 id 不会被 sibling 文件再次借回（402 create、外 app id、空缓存不落盘）；legacy 缓存合并在主文件之下且主文件条目优先。`tag-cache-share.spec.ts`：状态文件按项目名落键并迁移两种 legacy 形态；sibling 缓存断言更新为新文件名。`assembly.spec.ts`：spawn store 路径 pin 更新。feishu-bridge 全量 2323 通过；仓库 typecheck 通过；改动文件 lint 干净（别处 3 个 lint 错误是本次改动前就存在的 dev 欠账）。
