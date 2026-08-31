/**
 * Unit tests for `.mcp.json` parsing: format mapping (Claude Code compatible),
 * misconfiguration skips, duplicate server-name detection, and `${VAR}`
 * expansion. `parseWorkspaceMcp` is a pure function of (text, env).
 *
 * @module dsh-mcp-workspace/tests-parse
 */
import { describe, expect, it } from 'vitest'
import { parseWorkspaceMcp } from '../src/parse.ts'

describe('parseWorkspaceMcp: misconfigured entries are skipped with problems', () => {
  it('skips a url entry without type, mirroring the Claude Code configuration error', () => {
    const outcome = parseWorkspaceMcp(JSON.stringify({
      mcpServers: { web: { url: 'https://example.com/mcp' } },
    }), '/ws', {})

    expect(outcome.servers).toEqual([])
    expect(outcome.problems).toHaveLength(1)
    expect(outcome.problems[0]!.level).toBe('error')
    expect(outcome.problems[0]!.message).toContain('has a "url" but no "type"')
  })

  it('skips type sse instead of mis-mapping it to streamable-http', () => {
    const outcome = parseWorkspaceMcp(JSON.stringify({
      mcpServers: { legacy: { type: 'sse', url: 'https://example.com/sse' } },
    }), '/ws', {})

    expect(outcome.servers).toEqual([])
    expect(outcome.problems[0]!.message).toContain('"type": "sse"')
  })

  it('skips ws and unknown types, and entries with neither command nor url', () => {
    const outcome = parseWorkspaceMcp(JSON.stringify({
      mcpServers: {
        a: { type: 'ws', url: 'wss://example.com' },
        b: { type: 'carrier-pigeon' },
        c: {},
      },
    }), '/ws', {})

    expect(outcome.servers).toEqual([])
    expect(outcome.problems.map(p => p.message).join('\n')).toContain('unsupported type')
    expect(outcome.problems.map(p => p.message).join('\n')).toContain('neither "command" nor "url"')
  })

  it('skips an entry declaring both command and url', () => {
    const outcome = parseWorkspaceMcp(JSON.stringify({
      mcpServers: { both: { type: 'stdio', command: 'echo', url: 'https://example.com' } },
    }), '/ws', {})

    expect(outcome.servers).toEqual([])
    expect(outcome.problems[0]!.message).toContain('both "command" and "url"')
  })

  it('skips a stdio-typed entry that carries a url but no command', () => {
    const outcome = parseWorkspaceMcp(JSON.stringify({
      mcpServers: { confused: { type: 'stdio', url: 'https://example.com' } },
    }), '/ws', {})

    expect(outcome.servers).toEqual([])
    expect(outcome.problems[0]!.message).toContain('with a "url" but no "command"')
  })

  it('skips an invalid server name and non-object entries, keeping valid siblings', () => {
    const outcome = parseWorkspaceMcp(JSON.stringify({
      mcpServers: {
        'bad name!': { command: 'echo' },
        notObject: 'nope',
        ok: { command: 'echo' },
      },
    }), '/ws', {})

    expect(outcome.servers).toHaveLength(1)
    expect(outcome.servers[0]!.name).toBe('ok')
    expect(outcome.problems).toHaveLength(2)
  })

  it('reports a non-JSON body or a non-object mcpServers as a file-level failure', () => {
    expect(parseWorkspaceMcp('not json', '/ws', {}).servers).toEqual([])
    expect(parseWorkspaceMcp('{"mcpServers": []}', '/ws', {}).problems).toHaveLength(1)
    expect(parseWorkspaceMcp('{"mcpServers": []}', '/ws', {}).problems[0]!.message).toContain('mcpServers must contain a JSON object')
  })

  it('treats a body without mcpServers as an empty but valid file', () => {
    const outcome = parseWorkspaceMcp('{"other": 1}', '/ws', {})
    expect(outcome.servers).toEqual([])
    expect(outcome.problems).toEqual([])
  })
})

describe('parseWorkspaceMcp: duplicate server names are a file-level failure', () => {
  it('skips the whole file when a server name appears twice', () => {
    const outcome = parseWorkspaceMcp([
      '{"mcpServers":{',
      '"srv":{"command":"echo"},',
      '"srv":{"command":"cat"}',
      '}}',
    ].join('\n'), '/ws', {})

    expect(outcome.servers).toEqual([])
    expect(outcome.problems).toHaveLength(1)
    expect(outcome.problems[0]!.message).toContain('duplicate server name(s): srv')
  })

  it('does not mistake keys of sibling objects or nested entry fields for server names', () => {
    const outcome = parseWorkspaceMcp(JSON.stringify({
      other: { name: 'x', env: { name: 'y' } },
      mcpServers: {
        srv: { command: 'echo', env: { PATH_TOOLS: 'x' } },
      },
      more: { srv: 1 },
    }), '/ws', {})

    expect(outcome.problems).toEqual([])
    expect(outcome.servers).toHaveLength(1)
    expect(outcome.servers[0]!.name).toBe('srv')
  })

  it('detects a duplicated mcpServers key itself', () => {
    const outcome = parseWorkspaceMcp('{"mcpServers":{"a":{"command":"echo"}},"mcpServers":{"b":{"command":"echo"}}}', '/ws', {})
    expect(outcome.servers).toEqual([])
    expect(outcome.problems[0]!.message).toContain('mcpServers')
  })
})

describe('parseWorkspaceMcp: environment variable expansion', () => {
  it('expands ${VAR} and ${VAR:-default} in command, args, env, url, and headers', () => {
    const outcome = parseWorkspaceMcp(JSON.stringify({
      mcpServers: {
        a: { command: '${BIN}', args: ['--opt', '${FLAG:-quiet}'], env: { TOKEN: '${TOK}' } },
        b: { type: 'http', url: 'https://${HOST}/mcp', headers: { Authorization: 'Bearer ${TOK}' } },
      },
    }), '/ws', { BIN: '/usr/bin/echo', TOK: 'secret', HOST: 'example.com' })

    expect(outcome.problems).toEqual([])
    const a = outcome.servers[0]!
    const b = outcome.servers[1]!
    if (a.config.transport !== 'stdio' || b.config.transport !== 'streamable-http') throw new Error('unreachable')
    expect(a.config.command).toBe('/usr/bin/echo')
    expect(a.config.args).toEqual(['--opt', 'quiet'])
    expect(a.config.env).toEqual({ TOKEN: 'secret' })
    expect(b.config.url).toBe('https://example.com/mcp')
    expect(b.config.headers).toEqual({ Authorization: 'Bearer secret' })
  })

  it('keeps an unset reference literally and warns, like Claude Code', () => {
    const outcome = parseWorkspaceMcp(JSON.stringify({
      mcpServers: { a: { command: 'echo', env: { TOKEN: '${MISSING}' } } },
    }), '/ws', {})

    expect(outcome.problems).toHaveLength(1)
    expect(outcome.problems[0]!.level).toBe('warn')
    expect(outcome.problems[0]!.message).toContain('${MISSING}')
    const a = outcome.servers[0]!
    if (a.config.transport !== 'stdio') throw new Error('unreachable')
    expect(a.config.env).toEqual({ TOKEN: '${MISSING}' })
  })
})

describe('parseWorkspaceMcp: stdio entries', () => {
  it('maps an untyped command entry to stdio with the file directory as cwd', () => {
    const outcome = parseWorkspaceMcp(JSON.stringify({
      mcpServers: {
        playwright: { command: 'npx', args: ['@playwright/mcp@latest'], env: { HEADLESS: '1' } },
      },
    }), '/ws/dida', {})

    expect(outcome.problems).toEqual([])
    expect(outcome.servers).toHaveLength(1)
    const server = outcome.servers[0]!
    expect(server.name).toBe('playwright')
    expect(server.config.transport).toBe('stdio')
    if (server.config.transport !== 'stdio') throw new Error('unreachable')
    expect(server.config.command).toBe('npx')
    expect(server.config.args).toEqual(['@playwright/mcp@latest'])
    expect(server.config.env).toEqual({ HEADLESS: '1' })
    expect(server.config.cwd).toBe('/ws/dida')
    expect(server.config.failOnStartupError).toBe(false)
  })

  it('maps an explicit type: stdio entry like an untyped one', () => {
    const outcome = parseWorkspaceMcp(JSON.stringify({
      mcpServers: { srv: { type: 'stdio', command: 'echo' } },
    }), '/ws', {})

    expect(outcome.problems).toEqual([])
    expect(outcome.servers[0]!.config.transport).toBe('stdio')
  })
})

describe('parseWorkspaceMcp: http entries', () => {
  it('maps type http with url and headers to streamable-http', () => {
    const outcome = parseWorkspaceMcp(JSON.stringify({
      mcpServers: {
        dida365: { type: 'http', url: 'https://mcp.dida365.com/mcp', headers: { Authorization: 'Bearer t' } },
      },
    }), '/ws/dida', {})

    expect(outcome.problems).toEqual([])
    const server = outcome.servers[0]!
    expect(server.name).toBe('dida365')
    expect(server.config.transport).toBe('streamable-http')
    if (server.config.transport !== 'streamable-http') throw new Error('unreachable')
    expect(server.config.url).toBe('https://mcp.dida365.com/mcp')
    expect(server.config.headers).toEqual({ Authorization: 'Bearer t' })
  })

  it('accepts type streamable-http as the http alias', () => {
    const outcome = parseWorkspaceMcp(JSON.stringify({
      mcpServers: { web: { type: 'streamable-http', url: 'https://example.com/mcp' } },
    }), '/ws', {})

    expect(outcome.problems).toEqual([])
    expect(outcome.servers[0]!.config.transport).toBe('streamable-http')
  })
})
