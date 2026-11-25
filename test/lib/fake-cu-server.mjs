/**
 * A stand-in for the vendored computer-use server: newline-framed JSON-RPC on
 * stdio, two tools, and failure modes chosen by FAKE_CU_MODE:
 *   normal         every call echoes its name and arguments
 *   crash-on-call  the process exits during tools/call
 *   hang           tools/call never answers
 *   tool-error     tools/call answers isError
 * FAKE_CU_LOG, when set, receives one line per received method.
 */
import { appendFileSync } from 'node:fs'

const mode = process.env.FAKE_CU_MODE || 'normal'
const TOOLS = [
  { name: 'windows_computer_use_click', description: 'Click.', inputSchema: { type: 'object', properties: { elementId: { type: 'string' } } } },
  { name: 'windows_computer_use_health', description: 'Health.', inputSchema: { type: 'object', properties: {} } },
  { name: 'not_a_cu_tool', description: 'Ignored by the row.', inputSchema: { type: 'object' } },
]
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) handle(JSON.parse(line))
  }
})
process.stdin.on('end', () => process.exit(0))

function handle(message) {
  if (process.env.FAKE_CU_LOG) appendFileSync(process.env.FAKE_CU_LOG, `${message.method}\n`)
  if (message.id === undefined) return
  if (message.method === 'initialize') return send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } } })
  if (message.method === 'tools/list') return send({ id: message.id, result: { tools: TOOLS } })
  if (message.method === 'tools/call') {
    if (mode === 'crash-on-call') process.exit(3)
    if (mode === 'hang') return
    const text = `${message.params.name} ${JSON.stringify(message.params.arguments)} pid=${process.pid}`
    return send({ id: message.id, result: { isError: mode === 'tool-error', content: [{ type: 'text', text }] } })
  }
  send({ id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } })
}
