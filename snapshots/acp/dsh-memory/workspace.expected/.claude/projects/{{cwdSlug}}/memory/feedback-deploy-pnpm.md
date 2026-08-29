---
name: feedback-deploy-pnpm
description: This project deploys with pnpm, never npm or yarn
metadata:
  type: feedback
  node_type: memory
  originSessionId: {{sessionId}}
---
This project deploys with pnpm.

**Why:** The workspace is pnpm-based; npm installs corrupt the lockfile.

**How to apply:** Run installs and script entry through pnpm.