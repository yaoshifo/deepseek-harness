# dsh-feishu-bridge-chatroom

The chatroom plugin extracted from the Feishu bridge: multi-role chatroom orchestration (role groups, the moderator, the `/chatroom` command family) as its own dsh package mounted beside `@deepseek-ai/dsh-feishu-bridge`. This is the package skeleton — the chatroom implementation still lives in the feishu-bridge engine and moves here in the follow-up migration; `apply()` is empty and the Config schema carries no fields until then.

## Model Experience

### Request context and condition (skeleton)

#### What the model sees

Nothing yet: the skeleton registers no tool, prompt section, or runtime context. The chatroom's model-visible surface (role-group personas, moderator orchestration messages, the chatroom tools) is documented in this section when the migration lands.

#### Token effect

Zero direct token effect while the package is a skeleton.

#### KV Cache effect

None: the plugin contributes no model-request content, so it can neither extend nor invalidate any reusable prefix.

## Known Limitations and Deferred Work

- **Skeleton package — the chatroom implementation has not moved in yet**: all chatroom behavior still lives in `packages/acp/feishu-bridge`; this package ships only the plugin row, the invariant companion, and the bundle patch. The code move — the Config schema, `inject: ['feishuBridge']`, the role-group and moderator wiring, tests, and this README's Model Experience entries — is the immediate follow-up, after which this entry is replaced by the real durable gaps.
