# Agent Note: /reload 失败回复现附带脚本输出尾部

Status: implemented

[English](2026-09-03-feishu-bridge-reload-failure-tail.md) | 中文

## 问题

2026-09-03 生产事故（Mac）。09:13 的 /reload 在 `tsc -b tsconfig.host.json` 阶段失败（一处测试文件 TS2345 类型错误），而聊天回复只带退出码和日志路径。此后每次排查失败的 reload 都要先手工 tail 日志，而 tsc 诊断信息就躺在日志最后几行——失败线索距离报告失败的消息只差一跳。

## 决策

`cmdReload` 在写完自己的 `==> /reload by` 头行后记录日志字节偏移，失败路径（`finish`，daemon 卸载前的非零退出）从该偏移读取脚本输出（packages/acp/feishu-bridge/src/engine/reload-commands.ts 的 `readReloadOutput`）。读到内容时回复使用新的 `reload_failed_tail` 文案（退出码 + 日志路径 + 输出），读不到时（spawn 错误、日志打不开）保持原有 `reload_failed` 形态。ANSI CSI 序列被剥除——构建工具的彩色输出在聊天里是原始转义噪音；摘录限制为最后 4 KB 内的最后 15 行：完整构建日志有数百 KB，而失败原因在末尾。

## 备选方案

**始终发送尾部，为空时放占位符。** spawn 错误根本不产生输出；旧形态已经把真实情况说全了，「（未捕获到输出）」占位符纯属噪音。

**流式发送完整构建日志。** 数百 KB 装不进聊天消息，且构建日志的开头是进度噪音，不是失败原因。

## 后果

重启前的失败现在在聊天里自描述——2026-09-03 的形态（tsc 诊断加 ELIFECYCLE 行）随回复直接到达。模块头注释记载的天花板不变：只在重启后才暴露的失败（WS 探活超时）依然无法产生聊天失败回复。摘录只覆盖当前这次 reload 的输出（按记录的偏移），不含更早的运行；4 KB 边界截断到多字节 UTF-8 字符中间时会渲染为一个替换字符。

## 测试

`tests/engine/reload-commands.spec.ts` → "appends the script output tail to the failure reply (a build error lands only in the log)"（先红：回复缺少错误行）、"strips ANSI color codes from the failure tail"、"truncates an oversized output to the last lines (the error sits at the end)"；既有对 `ReloadFailed` 的精确断言覆盖空尾部回退。reload 与 i18n 域 spec 76/76 通过；host face tsc 干净。
