/**
 * The #18 workspace routing section injected through the D3 setup hook: the
 * CC_FEISHU_* env entries the engine builds for a session become a
 * system-prompt section naming the bot's default Feishu workspace — the
 * in-process replacement for Go's subprocess env the lark skills read.
 */

import { describe, expect, it } from 'vitest'
import { feishuWorkspaceSection } from '../../src/agent-dsh/adapter.js'

describe('feishuWorkspaceSection (#18)', () => {
  it('returns empty when no workspace env is present', () => {
    expect(feishuWorkspaceSection([])).toBe('')
    expect(feishuWorkspaceSection(['CC_PROJECT=test', 'CC_FEISHU_WIKI_SPACE_ID='])).toBe('')
  })

  it('lists the configured fields and the creation priority', () => {
    const text = feishuWorkspaceSection([
      'CC_PROJECT=test',
      'CC_FEISHU_WIKI_SPACE_ID=7000',
      'CC_FEISHU_FOLDER_TOKEN=fldcn1',
      'CC_FEISHU_WIKI_NODE_TOKEN=wikcn2',
      'CC_FEISHU_WORKSPACE_DESC=Team docs',
    ])
    expect(text).toContain('CC_FEISHU_WIKI_SPACE_ID=7000')
    expect(text).toContain('CC_FEISHU_FOLDER_TOKEN=fldcn1')
    expect(text).toContain('CC_FEISHU_WIKI_NODE_TOKEN=wikcn2')
    expect(text).toContain('Team docs')
    expect(text).toContain('wiki_node_token > wiki_space_id > folder_token')
  })

  it('includes only the non-empty fields', () => {
    const text = feishuWorkspaceSection(['CC_FEISHU_FOLDER_TOKEN=fldcn1'])
    expect(text).toContain('CC_FEISHU_FOLDER_TOKEN=fldcn1')
    expect(text).not.toContain('WIKI_SPACE_ID')
  })
})
