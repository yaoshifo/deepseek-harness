/**
 * Registration, dispatch, and rendering tests for registerSkillsMcpCommands
 * (TS-native /skills + /mcp): both commands merge into an existing
 * session-command table without clobbering it, resolve ≥2-char prefixes and
 * the /skill alias, render their listings from the injected deps (populated,
 * empty, unavailable, degraded, masked, capped), filter /skills by a fuzzy
 * name/description query, page long listings with nav:/skills buttons whose
 * card action re-renders the captured snapshot in place (query scope kept,
 * stale notice after disposal), and dispose cleanly.
 *
 * @module dsh-feishu-bridge/tests-engine-skills-mcp-commands
 */

import { describe, expect, it } from 'vitest'
import { Engine } from '../../src/engine/engine.ts'
import { registerSessionCommands } from '../../src/engine/commands.ts'
import { registerSkillsMcpCommands } from '../../src/engine/skills-mcp-commands.ts'
import type { SkillsMcpCommandDeps } from '../../src/engine/skills-mcp-commands.ts'
import { createStubAgent, createStubCardPlatform, createStubPlatform, newStubMessage } from '../stubs/engine-stubs.ts'
import type { StubCardPlatform, StubPlatform } from '../stubs/engine-stubs.ts'
import { Msg } from '../../src/i18n/index.ts'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import type { Card } from '../../src/card.ts'

/** One fake skill summary for the injected listSkills source. */
function skill(name: string, description: string, modelInvocable = true): SkillSummary {
  return {
    name,
    description,
    invocation: { modelInvocable, userInvocable: true },
    source: 'runtime',
    provider: 'test',
  }
}

/** Drain the voided async command replies before probing sent texts. */
const flush = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0))
}

interface Fixture {
  e: Engine
  p: StubPlatform
  disposeSession: () => void
  disposeCommands: () => void
}

/** Engine + session commands + the two commands over injected deps. */
function newFixture(deps: Partial<SkillsMcpCommandDeps>, platform: StubPlatform = createStubPlatform('test')): Fixture {
  const e = new Engine('test', createStubAgent(), [platform], '', 'en')
  const disposeSession = registerSessionCommands(e)
  const disposeCommands = registerSkillsMcpCommands(e, { toolNames: () => [], ...deps })
  return { e, p: platform, disposeSession, disposeCommands }
}

function cmdMsg(content: string) {
  return { ...newStubMessage(), sessionKey: 'test:ch1', userID: 'u1', replyCtx: 'ctx', content }
}

/** A card-action message carrying a pressed button's act:/nav: value. */
function cardActionMsg(sessionKey: string, action: string) {
  return { ...newStubMessage(), sessionKey, platform: 'test', userID: 'u1', chatType: 'group', replyCtx: 'ctx', content: action, isCardAction: true }
}

/** Button {text, value} pairs of a card's actions elements. */
function cardButtons(card: Card): Array<{ text: string; value: string }> {
  return card.elements.flatMap(el => el.kind === 'actions' ? el.buttons.map(b => ({ text: b.text, value: b.value })) : [])
}

/** Concatenated note text of a card ('' when it has none). */
function cardNotes(card: Card): string {
  return card.elements.filter(el => el.kind === 'note').map(el => el.kind === 'note' ? el.text : '').join('\n')
}

/** Concatenated markdown content of a card. */
function cardMarkdown(card: unknown): string {
  const c = card as Card | undefined
  if (c === undefined) return ''
  return c.elements.filter(el => el.kind === 'markdown').map(el => el.kind === 'markdown' ? el.content : '').join('\n\n')
}

describe('registerSkillsMcpCommands', () => {
  it('merges into the session command table under the tools group and keeps /new resolvable', () => {
    const { e, disposeSession, disposeCommands } = newFixture({})
    try {
      expect(e.commandHandlers?.get('skills')).toBeDefined()
      expect(e.commandHandlers?.get('mcp')).toBeDefined()
      expect(e.commandHandlers?.get('new')).toBeDefined()
      expect(e.commandGroups.get('skills')).toBe('tools')
      expect(e.commandGroups.get('mcp')).toBe('tools')
      expect(e.commandResolver?.('new')).toBe('new')
    } finally {
      disposeCommands()
      disposeSession()
    }
  })

  it('/skills replies unavailable when the skill registry is not composed', async () => {
    const { e, p, disposeSession, disposeCommands } = newFixture({})
    try {
      expect(e.dispatchCommand(p, cmdMsg('/skills'), '/skills')).toBe(true)
      await flush()
      expect(p.getSent().at(-1)).toBe(e.i18n.t(Msg.SkillsUnavailable))
    } finally {
      disposeCommands()
      disposeSession()
    }
  })

  it('/skills lists names, capped descriptions, and the command-only marker for the chat work dir', async () => {
    let seenCwd = ''
    const { e, p, disposeSession, disposeCommands } = newFixture({
      listSkills: async (cwd) => {
        seenCwd = cwd
        return [
          skill('alpha', 'Does alpha things'),
          skill('beta', 'x'.repeat(100)),
          skill('gamma', '', false),
        ]
      },
    })
    try {
      const msg = cmdMsg('/skills')
      expect(e.dispatchCommand(p, msg, '/skills')).toBe(true)
      await flush()
      expect(seenCwd).toBe(e.commandWorkDir(msg))
      const text = p.getSent().at(-1) ?? ''
      expect(text.startsWith(`**${e.i18n.tf(Msg.SkillsTitle, 3)}**\n\n📁 `)).toBe(true)
      expect(text).toContain('- `alpha` — Does alpha things')
      expect(text).toContain(`- \`beta\` — ${'x'.repeat(80)}…`)
      expect(text).toContain('- `gamma` (command-only)')
    } finally {
      disposeCommands()
      disposeSession()
    }
  })

  it('/skills <query> filters entries by case-insensitive name substring', async () => {
    const { e, p, disposeSession, disposeCommands } = newFixture({
      listSkills: async () => [
        skill('scholar', 'Reads papers'),
        skill('alpha', 'Does alpha things'),
        skill('lark-doc', 'Unrelated entirely'),
      ],
    })
    try {
      expect(e.dispatchCommand(p, cmdMsg('/skills SCHO'), '/skills SCHO')).toBe(true)
      await flush()
      const text = p.getSent().at(-1) ?? ''
      expect(text).toContain('- `scholar` — Reads papers')
      expect(text).not.toContain('`alpha`')
      expect(text).not.toContain('`lark-scho`')
    } finally {
      disposeCommands()
      disposeSession()
    }
  })

  it('/skills <query> also matches descriptions', async () => {
    const { e, p, disposeSession, disposeCommands } = newFixture({
      listSkills: async () => [
        skill('scholar', 'Reads academic papers'),
        skill('painter', 'Draws pictures'),
        skill('alpha', 'Does alpha things'),
      ],
    })
    try {
      expect(e.dispatchCommand(p, cmdMsg('/skills paper'), '/skills paper')).toBe(true)
      await flush()
      const text = p.getSent().at(-1) ?? ''
      expect(text).toContain('- `scholar` — Reads academic papers')
      expect(text).not.toContain('`alpha`')
      expect(text).not.toContain('`painter`')
    } finally {
      disposeCommands()
      disposeSession()
    }
  })

  it('/skills <query> requires every whitespace-separated token to match', async () => {
    const { e, p, disposeSession, disposeCommands } = newFixture({
      listSkills: async () => [
        skill('lark-im', 'Sends messages and documents'),
        skill('lark-doc', 'Edits docs'),
        skill('zread', 'Reads GitHub repositories'),
      ],
    })
    try {
      // "lark doc": lark-im hits lark (name) + doc (description);
      // lark-doc hits both in its name alone; zread hits neither.
      expect(e.dispatchCommand(p, cmdMsg('/skills lark doc'), '/skills lark doc')).toBe(true)
      await flush()
      const text = p.getSent().at(-1) ?? ''
      expect(text).toContain('- `lark-im`')
      expect(text).toContain('- `lark-doc`')
      expect(text).not.toContain('`zread`')

      expect(e.dispatchCommand(p, cmdMsg('/skills lark repository'), '/skills lark repository')).toBe(true)
      await flush()
      expect(p.getSent().at(-1) ?? '').not.toContain('`lark-im`')
    } finally {
      disposeCommands()
      disposeSession()
    }
  })

  it('/skills replies empty when the catalog has no entries', async () => {
    const { e, p, disposeSession, disposeCommands } = newFixture({ listSkills: async () => [] })
    try {
      expect(e.dispatchCommand(p, cmdMsg('/skills'), '/skills')).toBe(true)
      await flush()
      expect(p.getSent().at(-1)).toBe(e.i18n.t(Msg.SkillsEmpty))
    } finally {
      disposeCommands()
      disposeSession()
    }
  })

  it('/skills reports no matches distinctly from an empty catalog', async () => {
    const { e, p, disposeSession, disposeCommands } = newFixture({
      listSkills: async () => [skill('alpha', 'Does alpha things')],
    })
    try {
      expect(e.dispatchCommand(p, cmdMsg('/skills zzz'), '/skills zzz')).toBe(true)
      await flush()
      const text = p.getSent().at(-1) ?? ''
      expect(text).toBe(e.i18n.tf(Msg.SkillsNoMatch, 'zzz'))
      expect(text).not.toBe(e.i18n.t(Msg.SkillsEmpty))
    } finally {
      disposeCommands()
      disposeSession()
    }
  })

  it('/skills takes a trailing page number and renders that page of the listing', async () => {
    const entries = Array.from({ length: 20 }, (_, i) => skill(`skill-${String(i + 1).padStart(2, '0')}`, `Desc ${i + 1}`))
    const { e, p, disposeSession, disposeCommands } = newFixture({ listSkills: async () => entries })
    try {
      // No query: page 2 of the full catalog.
      expect(e.dispatchCommand(p, cmdMsg('/skills 2'), '/skills 2')).toBe(true)
      await flush()
      let text = p.getSent().at(-1) ?? ''
      expect(text.startsWith(`**${e.i18n.tf(Msg.SkillsTitlePaged, 20, 2, 2)}**`)).toBe(true)
      expect(text).toContain('`skill-16`')
      expect(text).toContain('`skill-20`')
      expect(text).not.toContain('`skill-01`')
      expect(text).not.toContain('`skill-15`')

      // Query + page: page 2 of the filtered set, with the query line.
      expect(e.dispatchCommand(p, cmdMsg('/skills skill 2'), '/skills skill 2')).toBe(true)
      await flush()
      text = p.getSent().at(-1) ?? ''
      expect(text).toContain(e.i18n.tf(Msg.SkillsQueryLine, 'skill', 20, 20))
      expect(text).toContain('`skill-16`')
      expect(text).not.toContain('`skill-01`')

      // Out-of-range page clamps to the last page.
      expect(e.dispatchCommand(p, cmdMsg('/skills 9'), '/skills 9')).toBe(true)
      await flush()
      text = p.getSent().at(-1) ?? ''
      expect(text).toContain('`skill-20`')
      expect(text).not.toContain('`skill-01`')
    } finally {
      disposeCommands()
      disposeSession()
    }
  })

  it('multi-page listings carry prev/next buttons and a page hint; single-page ones carry neither', async () => {
    const entries = Array.from({ length: 17 }, (_, i) => skill(`skill-${String(i + 1).padStart(2, '0')}`, `Desc ${i + 1}`))
    const cardP = createStubCardPlatform('test')
    const { e, p, disposeSession, disposeCommands } = newFixture({ listSkills: async () => entries }, cardP)
    try {
      expect(e.dispatchCommand(p, cmdMsg('/skills'), '/skills')).toBe(true)
      await flush()
      let card = cardP.sentCards.at(-1) as Card
      expect(card.header?.title).toBe(e.i18n.tf(Msg.SkillsTitlePaged, 17, 1, 2))
      expect(cardButtons(card)).toEqual([
        { text: e.i18n.t(Msg.CardNext), value: 'nav:/skills 2' },
      ])
      expect(cardNotes(card)).toBe(e.i18n.tf(Msg.SkillsPageHint, 1, 2))

      expect(e.dispatchCommand(p, cmdMsg('/skills 2'), '/skills 2')).toBe(true)
      await flush()
      card = cardP.sentCards.at(-1) as Card
      expect(cardButtons(card)).toEqual([
        { text: e.i18n.t(Msg.CardPrev), value: 'nav:/skills 1' },
      ])

      // A single-page listing renders no navigation and no hint.
      expect(e.dispatchCommand(p, cmdMsg('/skills skill-0'), '/skills skill-0')).toBe(true)
      await flush()
      card = cardP.sentCards.at(-1) as Card
      expect(card.header?.title).toBe(e.i18n.tf(Msg.SkillsTitle, 9))
      expect(cardButtons(card)).toEqual([])
      expect(cardNotes(card)).toBe('')
    } finally {
      disposeCommands()
      disposeSession()
    }
  })

  it('the nav:/skills card action PATCHes the pressed card to the requested page', async () => {
    const entries = Array.from({ length: 20 }, (_, i) => skill(`skill-${String(i + 1).padStart(2, '0')}`, `Desc ${i + 1}`))
    const cardP = createStubCardPlatform('test')
    const { e, p, disposeSession, disposeCommands } = newFixture({ listSkills: async () => entries }, cardP)
    const refreshed: Array<{ sessionKey: string; card: Card }> = []
    ;(cardP as StubCardPlatform & { refreshCard(sessionKey: string, card: unknown): Promise<void> }).refreshCard =
      async (sessionKey, card) => { refreshed.push({ sessionKey, card: card as Card }) }
    try {
      expect(e.dispatchCommand(p, cmdMsg('/skills'), '/skills')).toBe(true)
      await flush()
      expect(cardP.sentCards).toHaveLength(1)

      e.receiveMessage(p, cardActionMsg('test:ch1:u1', 'nav:/skills 2'))
      await flush()
      expect(refreshed).toHaveLength(1)
      expect(refreshed[0]?.sessionKey).toBe('test:ch1:u1')
      const card = refreshed[0]?.card
      expect(card?.header?.title).toBe(e.i18n.tf(Msg.SkillsTitlePaged, 20, 2, 2))
      expect(cardMarkdown(card)).toContain('`skill-16`')
      expect(cardMarkdown(card)).not.toContain('`skill-01`')
      // The PATCH path sends nothing new.
      expect(cardP.sentCards).toHaveLength(1)
      expect(p.getSent()).toEqual([])
    } finally {
      disposeCommands()
      disposeSession()
    }
  })

  it('page turns keep the query scope of the listing they page through', async () => {
    const entries = Array.from({ length: 20 }, (_, i) => skill(`lark-${String(i + 1).padStart(2, '0')}`, `Lark tool ${i + 1}`))
      .concat([skill('alpha', 'Unrelated')])
    const cardP = createStubCardPlatform('test')
    const { e, p, disposeSession, disposeCommands } = newFixture({ listSkills: async () => entries }, cardP)
    const refreshed: Card[] = []
    ;(cardP as StubCardPlatform & { refreshCard(sessionKey: string, card: unknown): Promise<void> }).refreshCard =
      async (_sessionKey, card) => { refreshed.push(card as Card) }
    try {
      expect(e.dispatchCommand(p, cmdMsg('/skills lark'), '/skills lark')).toBe(true)
      await flush()
      e.receiveMessage(p, cardActionMsg('test:ch1:u1', 'nav:/skills 2'))
      await flush()
      const card = refreshed.at(-1)
      expect(card?.header?.title).toBe(e.i18n.tf(Msg.SkillsTitlePaged, 20, 2, 2))
      expect(cardMarkdown(card)).toContain(e.i18n.tf(Msg.SkillsQueryLine, 'lark', 20, 21))
      expect(cardMarkdown(card)).toContain('`lark-16`')
      expect(cardMarkdown(card)).not.toContain('`lark-01`')
      expect(cardMarkdown(card)).not.toContain('`alpha`')
    } finally {
      disposeCommands()
      disposeSession()
    }
  })

  it('a card action with no snapshot (post-reload button) renders the stale notice', async () => {
    const cardP = createStubCardPlatform('test')
    const { e, p, disposeSession, disposeCommands } = newFixture({ listSkills: async () => [skill('alpha', 'Does alpha things')] }, cardP)
    const refreshed: Card[] = []
    ;(cardP as StubCardPlatform & { refreshCard(sessionKey: string, card: unknown): Promise<void> }).refreshCard =
      async (_sessionKey, card) => { refreshed.push(card as Card) }
    try {
      // No /skills ran for this chat: the snapshot map is empty.
      e.receiveMessage(p, cardActionMsg('test:ch1:u1', 'nav:/skills 2'))
      await flush()
      expect(refreshed).toHaveLength(1)
      expect(cardMarkdown(refreshed[0])).toBe(e.i18n.t(Msg.SkillsStale))
      expect(p.getSent()).toEqual([])
      expect(cardP.sentCards).toHaveLength(0)
    } finally {
      disposeCommands()
      disposeSession()
    }
  })

  it('/skills hides engine-denied skill names and reports empty when all are denied', async () => {
    const { e, p, disposeSession, disposeCommands } = newFixture({
      listSkills: async () => [
        skill('alpha', 'Does alpha things'),
        skill('feishu-bridge-chatroom-moderator', 'Runs chatrooms'),
      ],
      deniedSkills: () => ['feishu-bridge-chatroom-moderator'],
    })
    try {
      expect(e.dispatchCommand(p, cmdMsg('/skills'), '/skills')).toBe(true)
      await flush()
      const text = p.getSent().at(-1) ?? ''
      expect(text).toContain('- `alpha` — Does alpha things')
      expect(text).not.toContain('chatroom-moderator')
    } finally {
      disposeCommands()
      disposeSession()
    }

    const denied = newFixture({
      listSkills: async () => [skill('feishu-bridge-chatroom-moderator', 'Runs chatrooms')],
      deniedSkills: () => ['feishu-bridge-chatroom-moderator'],
    })
    try {
      expect(denied.e.dispatchCommand(denied.p, cmdMsg('/skills'), '/skills')).toBe(true)
      await flush()
      expect(denied.p.getSent().at(-1)).toBe(denied.e.i18n.t(Msg.SkillsEmpty))
    } finally {
      denied.disposeCommands()
      denied.disposeSession()
    }
  })

  it('/mcp groups live servers, caps tool names, and marks allowlist-masked servers', async () => {
    const tools = ['bash', 'mcp__weird', 'mcp__zread__read_file', 'mcp__web-reader__webReader']
    for (let i = 1; i <= 9; i++) tools.push(`mcp__fs__tool${i}`)
    const { e, p, disposeSession, disposeCommands } = newFixture({
      toolNames: () => tools,
      allowlist: ['web-reader'],
    })
    try {
      expect(e.dispatchCommand(p, cmdMsg('/mcp'), '/mcp')).toBe(true)
      await flush()
      const text = p.getSent().at(-1) ?? ''
      expect(text.startsWith(`**${e.i18n.tf(Msg.McpTitle, 3)}**\n\n`)).toBe(true)
      // Sorted by server; non-mcp__ names and a name without a server__tool
      // separator create no group.
      expect(text).toContain(`**fs**${e.i18n.tf(Msg.McpTools, 9)}${e.i18n.t(Msg.McpMasked)}`)
      expect(text).toContain('  tool1, tool2, tool3, tool4, tool5, tool6, tool7, tool8, +1')
      expect(text).toContain(`**web-reader**${e.i18n.tf(Msg.McpTools, 1)}`)
      expect(text).toContain('  webReader')
      expect(text).toContain(`**zread**${e.i18n.tf(Msg.McpTools, 1)}${e.i18n.t(Msg.McpMasked)}`)
      expect(text).not.toContain('weird')
    } finally {
      disposeCommands()
      disposeSession()
    }
  })

  it('/mcp marks health-watched servers with no live tools as degraded', async () => {
    const { e, p, disposeSession, disposeCommands } = newFixture({
      toolNames: () => ['mcp__web__ping'],
      healthServers: [{ serverName: 'agentichub' }],
    })
    try {
      expect(e.dispatchCommand(p, cmdMsg('/mcp'), '/mcp')).toBe(true)
      await flush()
      const text = p.getSent().at(-1) ?? ''
      expect(text.startsWith(`**${e.i18n.tf(Msg.McpTitle, 2)}**\n\n`)).toBe(true)
      expect(text).toContain(`**agentichub**${e.i18n.t(Msg.McpDegraded)}`)
      expect(text).toContain(`**web**${e.i18n.tf(Msg.McpTools, 1)}`)
    } finally {
      disposeCommands()
      disposeSession()
    }
  })

  it('/mcp replies empty when no server tools are registered and none are watched', async () => {
    const { e, p, disposeSession, disposeCommands } = newFixture({})
    try {
      expect(e.dispatchCommand(p, cmdMsg('/mcp'), '/mcp')).toBe(true)
      await flush()
      expect(p.getSent().at(-1)).toBe(e.i18n.t(Msg.McpEmpty))
    } finally {
      disposeCommands()
      disposeSession()
    }
  })

  it('resolves ≥2-char prefixes, the /skill alias, and ignores 1-char prefixes', async () => {
    const { e, p, disposeSession, disposeCommands } = newFixture({})
    try {
      expect(e.dispatchCommand(p, cmdMsg('/sk'), '/sk')).toBe(true)
      await flush()
      expect(p.getSent().at(-1)).toBe(e.i18n.t(Msg.SkillsUnavailable))
      // /skill is an explicit alias, not just a ≥2-char prefix of /skills.
      expect(e.commandResolver?.('skill')).toBe('skills')
      expect(e.dispatchCommand(p, cmdMsg('/skill'), '/skill')).toBe(true)
      await flush()
      expect(p.getSent().at(-1)).toBe(e.i18n.t(Msg.SkillsUnavailable))
      expect(e.dispatchCommand(p, cmdMsg('/mc'), '/mc')).toBe(true)
      await flush()
      expect(p.getSent().at(-1)).toBe(e.i18n.t(Msg.McpEmpty))
      expect(e.dispatchCommand(p, cmdMsg('/s'), '/s')).toBe(false)
      expect(e.dispatchCommand(p, cmdMsg('/m'), '/m')).toBe(false)
    } finally {
      disposeCommands()
      disposeSession()
    }
  })

  it('card platforms receive one card instead of the plain-text fallback', async () => {
    const cardP = createStubCardPlatform('test')
    const { e, p, disposeSession, disposeCommands } = newFixture({
      listSkills: async () => [skill('alpha', 'Does alpha things')],
    }, cardP)
    try {
      expect(e.dispatchCommand(p, cmdMsg('/skills'), '/skills')).toBe(true)
      await flush()
      expect(cardP.sentCards).toHaveLength(1)
      expect(p.getSent()).toEqual([])
    } finally {
      disposeCommands()
      disposeSession()
    }
  })

  it('dispose removes both commands and restores the resolver', () => {
    const { e, p, disposeSession, disposeCommands } = newFixture({})
    disposeCommands()
    try {
      expect(e.commandHandlers?.get('skills')).toBeUndefined()
      expect(e.commandHandlers?.get('mcp')).toBeUndefined()
      expect(e.dispatchCommand(p, cmdMsg('/skills'), '/skills')).toBe(false)
      expect(e.commandResolver?.('new')).toBe('new')
    } finally {
      disposeSession()
    }
  })

  it('dispose also removes the /skills card action and its snapshots', async () => {
    const cardP = createStubCardPlatform('test')
    const { e, p, disposeSession, disposeCommands } = newFixture({
      listSkills: async () => Array.from({ length: 20 }, (_, i) => skill(`skill-${String(i + 1).padStart(2, '0')}`, `Desc ${i + 1}`)),
    }, cardP)
    try {
      expect(e.dispatchCommand(p, cmdMsg('/skills'), '/skills')).toBe(true)
      await flush()
      expect(cardP.sentCards).toHaveLength(1)
      disposeCommands()
      // The registration is gone: the press falls through to the engine's
      // unhandled-action path — no refreshed card, no new card, no text.
      e.receiveMessage(p, cardActionMsg('test:ch1:u1', 'nav:/skills 2'))
      await flush()
      expect(cardP.sentCards).toHaveLength(1)
      expect(p.getSent()).toEqual([])
    } finally {
      disposeSession()
    }
  })
})
