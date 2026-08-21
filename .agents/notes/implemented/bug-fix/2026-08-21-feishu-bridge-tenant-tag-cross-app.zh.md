# Agent Note: feishu-bridge 租户标签的跨 app 归属与共享标签缓存目录

Status: implemented

[English](2026-08-21-feishu-bridge-tenant-tag-cross-app.md) | 中文

## Problem

从 cc-connect 切换到 dsh-feishu-bridge 后，spawn 出的群不再带项目名标签（daemon 日志：`ensure tag "harness": no id (code=402 msg=duplicate name in tenant)`）。移植的代码本身是保形的，失败是环境性的。飞书租户标签名在整个租户内唯一，而新 bridge bot 与旧 cc-connect bot 是不同 app：名字已被他 app 占有时，`im/v2 Tag.Create` 返回 402 **且不带 `duplicate_id`**，而 im/v2 没有 List/Get，无法按名反查 id。cc-connect 靠单一共享 sessions 目录挺过这一关——所有 bot 的 `<project>_feishu_tag_cache.json` 放在一起，`lookupSiblingTagCaches` 能借到属主 bot 的 id（已验证：运维虾与开发虾共享同一批 id；用新 app 身份真机 GET 能看到旧 app 绑定的标签，跨 app 绑定 id 可用）。bridge 把数据目录按 project 拆分，sibling 兜底因此结构性失效。

## Decision

`FeishuPlatformOptions.tagCacheDir` 把本 bot 的标签 id 缓存放进装配层跨 project 共享的目录（`<dataRoot>/sessions`），为租户共享状态恢复 Go 的单目录布局。spawned 群注册表保持 per-project：它是 bot 私有状态，而标签缓存是租户共享状态——这一不对称是有意的，已在构造处注释说明。未传该 option 时仍缺省用 per-project `sessions` 目录（测试、独立 platform）。新 bot 的 cutover 还需从 legacy cc-connect 缓存文件 seed 一份，因为被占名且从未绑定到任何群的标签（harness 的情形）无处可发现——只有缓存文件持有它的 id；已记入 MIGRATION.md「M8 前补充 8」，供记账驴 cutover 参照。

## Alternatives considered

**只做数据 seeding 到 per-project 缓存文件。** 修得了单个 bot 的实例，但 sibling 兜底仍是死的：任一 bridge project 创建过的标签名，其他 project 都用不了（同样 402-无-id，且无 sibling 可查）——M8 第二个 project 上线时共享回归会再次发作。

**把发现扫描扩大到 bot 所在的全部群。** 否决：im/v2 除逐群 relation 外没有群-标签列表 API，且「创建了但从未绑定」的名字（harness 的情形）哪里都发现不到——只有缓存文件持有它的 id。

## Consequences

同一租户的两个 bridge project 通过共享目录互相解析标签 id，与 Go 一致。每个部署仍需一次性 cutover 步骤（把 legacy `~/.cc-connect/sessions/*_feishu_tag_cache.json` 合并进 `<dataRoot>/sessions/` 再重启 daemon）。seed 进缓存里的陈旧 id 会自愈：`applySpawnDirTag` 绑定后回读 relation 验证，未生效则驱逐缓存并重解析一次。没有 legacy 占名的租户无需 seeding——全新 create 直接返回 id。

## Testing

`tests/feishu/tag-cache-share.spec.ts`：bot A 的 create 返回 id；bot B 的 create 返回跨 app 402-无-id 占名回复；B 经 sibling 缓存文件解析出该 id，两个缓存文件都落在共享目录（而非 per-project sessions 目录）。包全量套件（1874 测试）保持绿。
