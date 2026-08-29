---
name: feedback-daemon-keychain
description: daemon git push reporting gh token invalid is a sandbox false alarm
metadata:
  type: feedback
  node_type: memory
  originSessionId: {{sessionId}}
---
daemon git push reporting gh token invalid is a sandbox false alarm.

**Why:** The daemon sandbox blocks keychain access, so the credential lookup fails.

**How to apply:** Retry with escalated sandbox access before diagnosing credentials.