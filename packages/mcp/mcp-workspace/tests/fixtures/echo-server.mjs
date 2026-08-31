/**
 * Minimal stdio MCP echo server for tests: newline-delimited JSON-RPC over
 * stdin/stdout, answering `initialize`, `notifications/initialized`, `ping`,
 * `tools/list`, and `tools/call`. The reply text is the first CLI argument,
 * so one file serves several distinguishable servers.
 */
import { createInterface } from 'node:readline'

const replyText = process.argv[2] ?? 'echo'

const rl = createInterface({ input: process.stdin })
const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

rl.on('line', (line) => {
  if (line.trim() === '') return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.method === undefined) return
  if (message.id === undefined) return // client notification; no response
  switch (message.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'echo-fixture', version: '0.0.0' },
        },
      })
      break
    case 'ping':
      send({ jsonrpc: '2.0', id: message.id, result: {} })
      break
    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [{
            name: 'echo',
            description: 'Echo its text argument back',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          }],
          nextCursor: undefined,
        },
      })
      break
    case 'tools/call':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: `${replyText}:${String(message.params?.arguments?.text ?? '')}` }],
          isError: false,
        },
      })
      break
    default:
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method: ${String(message.method)}` } })
  }
})
