---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-18-approval-decided-note

[English](2026-09-18-approval-decided-note.md) | 中文

## 概述

为已持久化的审批决定增加一个可选的有界应答者附言。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-18-approval-decided-note
baseline: false
changes:
  - root: "event:approval/decided"
    previous: "2026-09-11-initial"
    after: "4db73c3773efc58ce6edca84e689cb5d1b8b05da6956e12944cce3131c5c0979"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效：note 是可选项，缺失时解码结果不变，读取方无需兜底逻辑。仅在应答者给出附言时写入，并由服务做有界与去空白处理；早于该字段的读取方会忽略它，而不会让载荷解析失败。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/interaction/user-approval：附言往返与长度边界用例通过；packages/core/tools：拒绝文案经由 ask 路径携带该附言。

<a id="dev-note"></a>
## 开发备注

无。
