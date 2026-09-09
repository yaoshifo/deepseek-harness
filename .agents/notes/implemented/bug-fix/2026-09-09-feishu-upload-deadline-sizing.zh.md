# Agent Note：上传 deadline 按载荷大小决定，不再沿用小请求超时

Status: implemented

[English](2026-09-09-feishu-upload-deadline-sizing.md) | 中文

## 问题

生产环境经 `feishu_bridge_send` 投递 MB 级附件九连败（三篇 PDF，4.9–10.7 MB，每次尝试约 125 秒后死于 `context deadline exceeded`），而同一链路上的小请求毫秒级成功。原因由两个事实叠加。其一，主机到飞书 CDN 的上行在几分钟尺度上于 2.6 KB/s 与 384 KB/s 之间摆动（实测；到 `open.feishu.cn` 的 TLS/RTT 稳定在几十毫秒，DNS 干净，到 Cloudflare 稳定 237 KB/s——劣化是路径特定的，非主机级），慢窗口内 MB 级请求体需要数分钟。其二，上传与其他 API 共用 30 秒 per-attempt deadline `retryTiming.requestTimeout`——忠实移植自 Go 的 `feishuRequestTimeout`，为卡片 PATCH 与回复这类小请求设定——而 deadline 竞速放弃 HTTP 调用却不取消它（node-sdk 的 `IRequestOptions` 不带 `signal`），每次重试都往同一条饥饿的管道上再叠加一路并发上传。

## 决策

`withTransientRetry` 接受可选的 `attemptTimeoutMs`，仅为该次调用覆盖全局 per-attempt deadline；platform 为上传按下式取值：`min(max(requestTimeout, ceil(size / uploadMinBytesPerSec) · 1s), uploadMaxDeadlineMs)`，两个旋钮都是插件顶层配置（`uploadMinBytesPerSec` 默认 16384——实测慢窗口的下界；`uploadMaxDeadlineMs` 默认 900000）。文件大小是已知事实；速率下界是唯一假设，因此它保持为部署可调项而非代码常量。默认值下 4.9 MB 请求体获得 5.1 分钟的尝试窗口、10.7 MB 获得 11.2 分钟，都在 2 小时回合上限之内，而几百 KB 的图片仍保持 30 秒 deadline。

## 备选方案

- **调高全局 `requestTimeout`：** 否决——它拖慢所有小请求的快速失败，且在真正慢的窗口里仍装不下 10.7 MB 请求体，除非放成无界。
- **绕过 node-sdk 自写 multipart fetch 以获得 `AbortSignal` 取消：** 暂缓——为了取消能力引入整套上传实现；deadline 定尺寸已让慢窗口上传得以完成。若陈旧上传的重叠被证明有代价，此为升级路径。
- **修链路（升带宽、钉 CDN 节点）：** 代码层够不着——部署侧事务；旋钮吸收链路实际提供的速率。

## 后果

- 两个行为测试钉住接缝：per-call `attemptTimeoutMs` 越过全局 deadline 存活且不改动全局值；`sendFile` 的 deadline 由载荷大小推导（红运行逐字复现了生产 `upload file` 三连超时指纹）。
- `uploadImage` 共享同一取尺寸逻辑（`uploadAttemptTimeoutMs`），卡片内嵌图片获得同等处理。
- 陈旧上传的重叠仍在：超时尝试的 HTTP 调用会继续在后台运行直至自行 settle。有了按尺寸的 deadline，会超时的尝试是真被饿死，重试更罕见；上限封顶约束总暴露面。
