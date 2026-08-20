# Agent Note: feishu_bridge_send — the agent-to-user file delivery tool

Status: implemented

English | [中文](2026-08-20-feishu-bridge-send-tool.zh.md)

## Problem

In cc-connect, an agent delivered generated artifacts with the `cc-connect send --file/--image` CLI, and `AgentSystemPrompt()` told every agent that path existed. The faithful TS port left this chain broken at exactly one link: `Engine.sendToSessionWithAttachments` (the port of Go `SendToSessionWithAttachments`, with the attachmentSend gate, capability-first checks, and sideText duplicate suppression) shipped in M1 and was covered by engine tests, but nothing model-visible ever called it — dead code waiting for its consumer. Plain sessions get no capability prompt (the D4 design replaced Go's injected prompt with self-describing tools), and the chatroom persona deliberately dropped Go `ChatroomRoleBaseSystemPrompt`'s file-delivery section until a send tool landed. So "send me that file" produced a path in a text reply at best; the user received nothing in the chat.

## Decision

`src/tools/send.ts` registers `feishu_bridge_send` (plan D4, alongside the other five tool families, on the shared caller-agent `route` in `index.ts`): parameters are `files: string[]` plus an optional `message`. The tool reads each local path (port of Go `readAttachment`'s local branch: existence + 50 MB ceiling before reading, extension-table mime with a magic-byte sniff fallback), classifies `image/*` mimes into `ImageAttachment` (sent as image messages) and everything else into `FileAttachment` (file messages), and calls `engine.sendToSessionWithAttachments(sessionKey, message, images, files)`. Relative paths resolve against a new `Engine.sessionWorkDir(sessionKey)` — per-chat `/dir` override, else the agent's base work dir — the in-process equivalent of the Go CLI resolving against the agent subprocess's cwd. The tool description is the plain session's only discovery surface and states the contract explicitly: a bare path in a text reply is NOT delivered; a `message` sent with files must not be repeated in the normal reply. The chatroom base persona regained the file-delivery section in tool form, and the research-role/research-assistant "only when asked for visualization" lines now name `feishu_bridge_send`.

Two deliberate cuts. Go's http(s) URL fetch branch is not ported: agent artifacts live on disk, and the daemon fetching arbitrary URLs a model names is a surface with no current consumer. A single `files` parameter with mime-based classification replaces Go's separate `--image/--file` flags; the ceiling is that a user wanting an image delivered as a downloadable file rather than an image message cannot ask for that (the fix is an `asFile` flag on the existing parameter).

## Alternatives considered

**Teach agents to deliver through `feishu_bridge_lark` (im +send).** Rejected: it would make the model compose a chat_id it has no reliable source for, bypass the `attachmentSend` config gate and the sideText duplicate-suppression path, and skip the reply-context quoting the engine path preserves.

**Inject a plain-session capability prompt section mirroring Go `AgentSystemPrompt()`.** Rejected as the first move: every existing tool family (cron/relay/subtask/chatroom) is discovered through its description alone and works on the real device; adding a prompt section changes model-visible input for every session to fix a problem that may not exist. It remains the named fallback if the smoke run shows models answering with a path instead of calling the tool.

**Port Go's `setupMemoryFile` (`/bind setup`, `/cron setup` writing CLI instructions into agent memory files) and wire the `RelaySetupOK`/`CronSetupOK` i18n keys.** Rejected: that mechanism serves backends without system-prompt injection; under dsh every session has the native section mechanism, so Go's `setupNative` branch would always win. The two i18n keys stay as ported-but-unwired residue, documented in the README's Known Limitations.

## Consequences

An agent can now deliver any local artifact to the user's chat as a real file/image message, gated by `attachmentSend` and routed by the caller agent — the last Go CLI surface with no in-process equivalent is closed (FEATURE-PARITY row #62). Monitor `no_report` children and chatroom roles gain the same ability through the shared tool registration and the restored persona section. The investigation surfaced two adjacent prompt-wiring gaps left unfixed here: plain subtask children (`CC_SUBTASK=1`, non-research) never receive the `subtaskAgentSystemPrompt` report-back preamble, and `CC_SUBTASK_NO_REPORT` never receives the no-report preamble — `buildSessionSetup` consumes only the research-assistant flag. M4 smoke masked both behind the tool's self-describing report action and user-typed `/done`; they deserve their own change.

## Testing

`tests/tools/send-tool.spec.ts` runs the tool through a real Cordis Context + ToolRuntime: caller routing into `sendToSessionWithAttachments` (session key, message, image/file split), bare-file and relative-path delivery against a project-state workdir override, missing-file and empty-list failures, the 50 MB ceiling rejected before reading, the attachmentSend-disabled error surfacing, foreign-caller rejection, and HMR disposal. `tests/engine/chatroom-persona.spec.ts` pins the restored delivery section. Real-device smoke (file message + image message in the test group) follows the MIGRATION.md flow.
