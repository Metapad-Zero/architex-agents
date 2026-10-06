import process from 'node:process'
import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createMcpServer } from '../index.js'

async function connected() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createMcpServer()
  const client = new Client({ name: 'protocol-verifier', version: '1.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { client, server }
}
test('actual MCP initialization/list tools exposes read/payment annotations and recovery tools', async () => {
  const { client, server } = await connected()
  try {
    const result = await client.listTools()
    expect(result.tools.find((tool) => tool.name === 'get_gate')?.annotations?.readOnlyHint).toBe(true)
    expect(result.tools.find((tool) => tool.name === 'launch_token')?.annotations?.destructiveHint).toBe(true)
    expect(result.tools.find((tool) => tool.name === 'retry_last_payment')?.annotations?.idempotentHint).toBe(true)
    expect(result.tools.some((tool) => tool.name === 'check_transaction')).toBe(true)
  } finally { await client.close(); await server.close() }
})
test('protocol call-tool rejects Unicode overflow, fractional slippage and rounded amounts before chain reads', async () => {
  const { client, server } = await connected()
  try {
    for (const arguments_ of [{ name: 'é'.repeat(17), symbol: 'BAD' }, { name: 'fine', symbol: 'OK', maxSlippageBps: 0.5 }]) {
      const result = await client.callTool({ name: 'launch_token', arguments: arguments_ })
      expect(result.isError).toBe(true)
    }
    const quote = await client.callTool({ name: 'quote_buy', arguments: { token: '0x3600000000000000000000000000000000000000', usdcAmount: '0.0000009' } })
    expect(quote.isError).toBe(true)
    expect(JSON.stringify(quote.content)).toContain('decimal places')
  } finally { await client.close(); await server.close() }
})
test('real stdio process initializes with mainnet and no key, rather than crashing on deployment configuration', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['run', 'src/index.ts'], cwd: new URL('../..', import.meta.url).pathname, env: { ARC_NETWORK: 'mainnet', AGENT_PRIVATE_KEY: '', RELAYER_PRIVATE_KEY: '' }, stderr: 'pipe' })
  const client = new Client({ name: 'stdio-verifier', version: '1.0.0' })
  try {
    await client.connect(transport)
    expect((await client.listTools()).tools.length).toBeGreaterThan(13)
    const wallet = await client.callTool({ name: 'get_agent_wallet', arguments: {} })
    expect(wallet.isError).toBe(true)
    expect(JSON.stringify(wallet.content)).toContain('read-only')
  } finally { await client.close() }
})
