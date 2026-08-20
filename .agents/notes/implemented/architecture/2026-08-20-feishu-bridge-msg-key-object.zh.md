# Agent Note: feishu-bridge i18n 键统一为单一 Msg 对象

Status: implemented

[English](2026-08-20-feishu-bridge-msg-key-object.md) | 中文

## Problem

M0 移植脚本按 Go 源生成了 `src/i18n/keys.ts`，每个 Go 消息键一个导出常量——632 个 `export const MsgXxx: MsgKey = 'xxx'` 声明，镜像 Go 的扁平 `i18n.MsgXxx` 常量块。`verify-export-jsdoc` 要求为每个导出写文档，于是这个形状一落地就背上 632 个强制 JSDoc 块，而它们唯一诚实的写法是 `Message key 'xxx'.`——在行文标准「不复述显而易见的事实」之下是纯噪音，且门禁无法豁免。

## Decision

`keys.ts` 改为导出一个带文档的 `Msg` 常量对象：`Msg.ToolResult` 即 `'tool_result'`，经 `as const` 由既有 `MsgKey` 联合类型约束。`ALL_MSG_KEYS` 与 `MsgKey` 类型不变；模块头注释记录「分组对象是对 Go 扁平常量的有意偏离」。15 个源文件与 3 个测试文件的消费方改引 `Msg.Xxx`。i18n 运行时与消息表不动。

## Alternatives considered

**写 632 个逐常量 JSDoc 块。** 门禁合规，但生成文件会携带数百条零信息注释，且再生成时必须逐字维护。

**字符串枚举。** `verify-export-jsdoc` 对枚举声明只查一个文档符号，同样能收拢导出面，但它把 `MsgKey` 字符串字面量联合换成了枚举类型，会波及消息表的 `Record<MsgKey, …>` 键，没有收益。

**去掉常量的导出。** 18 个模块引用这些常量，非导出常量无法跨模块导入；只有对象（或 namespace，其导出成员门禁照样逐个查）能还原成单一受文档导出。

## Consequences

包的 i18n 键 API 形状与 Go 原版不同（调用点写 `Msg.X` 而非 `MsgX`），今后对照 `core/i18n/i18n.go` 再生成 `keys.ts` 时必须产出分组对象而非扁平常量。一个 JSDoc 块替代 632 条门禁义务，导出面缩小 631 个符号。若某天确实需要逐键文档，扁平命名导出会连同其文档义务一起回来。
