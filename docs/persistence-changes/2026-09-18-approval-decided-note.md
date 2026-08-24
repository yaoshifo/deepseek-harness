---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-18-approval-decided-note

English | [中文](2026-09-18-approval-decided-note.zh.md)

## Summary

Adds an optional bounded answerer note to the persisted approval decision.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing records remain valid: note is optional and absent notes decode unchanged, so no reader needs a fallback. Producers write it only when the answerer returned one, bounded and trimmed by the service; readers that predate the field ignore it rather than failing the payload.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/interaction/user-approval: note round-trip and bounds cases pass; packages/core/tools: the rejection text carries the note through the ask path.

<a id="dev-note"></a>
## Dev Note

None.
