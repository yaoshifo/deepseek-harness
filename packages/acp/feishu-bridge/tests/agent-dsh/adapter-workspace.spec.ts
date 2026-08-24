/**
 * The #18 workspace routing section injected through the D3 setup hook: the
 * typed feishuWorkspace start options become a system-prompt section naming
 * the bot's default Feishu workspace — the in-process replacement for Go's
 * subprocess env the lark skills read.
 */

import { describe, expect, it } from 'vitest'
import { feishuWorkspaceSection } from '../../src/agent-dsh/adapter.js'
import type { SessionStartOptions } from '../../src/core/types.js'

function withWorkspace(fields: Partial<SessionStartOptions['feishuWorkspace']>): SessionStartOptions {
  return {
    sessionKey: 'k',
    feishuWorkspace: {
      wikiSpaceId: '',
      folderToken: '',
      wikiNodeToken: '',
      description: '',
      ...fields,
    },
  }
}

describe('feishuWorkspaceSection (#18)', () => {
  it('returns empty when no workspace is configured', () => {
    expect(feishuWorkspaceSection(undefined)).toBe('')
    expect(feishuWorkspaceSection({ sessionKey: 'k' })).toBe('')
    expect(feishuWorkspaceSection(withWorkspace({}))).toBe('')
  })

  it('lists the configured fields and the creation priority', () => {
    const text = feishuWorkspaceSection(withWorkspace({
      wikiSpaceId: '7000',
      folderToken: 'fldcn1',
      wikiNodeToken: 'wikcn2',
      description: 'Team docs',
    }))
    expect(text).toContain('CC_FEISHU_WIKI_SPACE_ID=7000')
    expect(text).toContain('CC_FEISHU_FOLDER_TOKEN=fldcn1')
    expect(text).toContain('CC_FEISHU_WIKI_NODE_TOKEN=wikcn2')
    expect(text).toContain('Team docs')
    expect(text).toContain('wiki_node_token > wiki_space_id > folder_token')
  })

  it('includes only the non-empty fields', () => {
    const text = feishuWorkspaceSection(withWorkspace({ folderToken: 'fldcn1' }))
    expect(text).toContain('CC_FEISHU_FOLDER_TOKEN=fldcn1')
    expect(text).not.toContain('WIKI_SPACE_ID')
  })
})
