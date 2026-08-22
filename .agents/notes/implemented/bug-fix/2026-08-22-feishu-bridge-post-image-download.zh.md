# Agent Note: feishu-bridge 事件路径 post 内嵌图片从未下载

Status: implemented

[English](2026-08-22-feishu-bridge-post-image-download.md) | 中文

## Problem

用户在飞书把「图片+文字」合成一条消息发送——投递形态是富文本 `post`，其 `img` 元素携带 `image_key`。WS 事件路径上 `onMessage` 的 post 分支只抽文字：`extractPostPlainText` 把每个 `img` 元素替换为字面量 `[image]` 占位符，消息以 `images: []` 派发。agent 收到 `"[image]\n看下这个图"`，没有任何文件路径，自然找不到图（真机会话 `cc-20260822-135313`、工作区 `/Users/hm/workspace/chat` 已实证：`.feishu-bridge` 暂存目录从未存在过）。不对称点在于：纯 `image` 消息经 `dispatchImageMessage` 下载、监控轮询路径的卡片图经 `downloadCardImages` 下载、轮询路径甚至顺带命中 post 的 image key（`extractCardImageKeys` 的正则对任意 content JSON 都跑）——唯独事件路径的 post 分支把它们丢了。

## Decision

post 分支下载自己的内嵌图并像纯图片消息一样附带。`extractPostImageKeys`（src/feishu/extract.ts）遍历解析后的 post 正文，按文档序返回去重的 `image_key`——结构化遍历而非 `extractCardImageKeys` 的正则，因为 post 载荷在那里已经过 JSON 解析。`dispatchPostMessage`（src/feishu/platform.ts）抽取文字（保留 `[image]` 占位符以维持图片在文中的位置）、经既有 `downloadImage`（message-resource API）逐 key 下载、经 `dispatchWithQuote` 派发——后者新增可选 `images` 参数。下载上限 9 张、单张失败记日志跳过（文字照常送达），镜像 `downloadCardImages`。模型可见面不变：adapter 把字节落盘 `.feishu-bridge/attachments` 并追加 `(Images saved locally, please read them: <paths>)`，与纯图片消息完全一致。

## Alternatives considered

**保留 `[image]` 占位符，让 agent 经 lark 工具自行取图。** 否决：占位符不携带 `image_key`，agent 无从下手；字节本就经平台自有的 message-resource API 可达，推给 agent 等于每个回合重复平台管道。

**复用 `extractCardImageKeys` 的正则扫原始 post JSON。** 否决：post content 已被 `parsePostBody` 解析过，对序列化形态跑正则虽然可行（轮询路径就是证明）但绕了弯且对 locale 包装敏感，而结构化遍历只需一个循环。

**post 文字立即派发、图片另行暂存。** 否决：暂存通道（pending 目录拼进下一条文字消息）是为不携带文字的纯附件消息设的；post 自带文字，图片应与文字同回合——同一次 dispatch、同一个 `(Images saved locally, ...)` 注记。

## Consequences

图文混排 post 到达 agent 时是文字加本地图片路径；下载失败降级为纯文字而不是丢消息。轮询路径无需改动——`downloadCardImages` 的正则本就命中 post 的 image key，新增回归测试钉住这份顺带覆盖。抽出的文字里 `[image]` 占位符保留，多图 post 仍能看出各图相对文字的位置。表情包等其他消息类型不受影响。

## Testing

`tests/feishu/platform.spec.ts`：`extractPostImageKeys` 单测（顺序、locale 包装、去重、无图、空 key、非法 JSON）与派发用例——含内嵌图的 post 派发文字加下载字节、单张下载失败跳过该图但照常派发、纯图 post 作为附件消息派发。`tests/feishu/monitor-poll.spec.ts`：轮询路径附带 post 内嵌图（对既有正则行为即通过，作为护栏保留）。包级套件 2060 全绿，oxlint/typecheck 0。
