/**
 * Registration, dispatch, and rendering tests for registerSkillsMcpCommands
 * (TS-native /skills + /mcp): both commands merge into an existing
 * session-command table without clobbering it, resolve ≥2-char prefixes,
 * render their listings from the injected deps (populated, empty,
 * unavailable, degraded, masked, capped), and dispose cleanly.
 *
 * @module dsh-feishu-bridge/tests-engine-skills-mcp-commands
 */

import { describe, expect, it } from 'vitest'
import { Engine } from '../../src/engine/engine.ts'
import { registerSessionCommands } from '../../src/engine/commands.ts'
import { registerSkillsMcpCommands } from '../../src/engine/skills-mcp-commands.ts'
import type { SkillsMcpCommandDeps } from '../../src/engine/skills-mcp-commands.ts'
import { createStubAgent, createStubCardPlatform, createStubPlatform, newStubMessage } from '../stubs/engine-stubs.ts'
import type { StubPlatform } from '../stubs/engine-stubs.ts'
import { Msg } from '../../src/i18n/index.ts'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'

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

  it('resolves ≥2-char prefixes and ignores 1-char prefixes', async () => {
    const { e, p, disposeSession, disposeCommands } = newFixture({})
    try {
      expect(e.dispatchCommand(p, cmdMsg('/sk'), '/sk')).toBe(true)
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
})
