/**
 * Shared test helper: register the chatroom message subtable for specs that
 * assert localized text through an engine's i18n instance. The plugin apply
 * registers it in production; unit specs that never mount the plugin do it
 * here (per test file — the forks pool isolates module state per file).
 *
 * @module dsh-feishu-bridge-chatroom/tests-stubs
 */

import { afterAll } from 'vitest'
import { registerMessages } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { chatroomMessages } from '../../src/i18n.ts'

const dispose = registerMessages(chatroomMessages)
afterAll(() => { dispose() })
