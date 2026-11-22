import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { Toolbox, configSchema, toolboxServer } from '../toolbox.ts'

async function fixture(failed = false) {
  const configs = configSchema.parse([{ name: 'alpha', command: 'fake' }, { name: 'beta', url: 'https://example.com/mcp', tools: ['lookup', 'destroy'] }])
  const lists = { alpha: 0, beta: 0 }, calls: unknown[] = []
  const toolbox = new Toolbox(configs, async config => {
    if (failed && config.name === 'beta') throw new Error('secret header must not escape')
    const backend = new Server({ name: config.name, version: '1' }, { capabilities: { tools: {} } })
    const tools: Tool[] = [
      { name: 'lookup', description: 'Find deployments', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: 'deployments', description: 'List resources', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: 'write', inputSchema: { type: 'object' } },
      { name: 'destroy', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, destructiveHint: true } },
    ]
    backend.setRequestHandler(ListToolsRequestSchema, async () => { lists[config.name as keyof typeof lists]++; return { tools } })
    backend.setRequestHandler(CallToolRequestSchema, async r => { calls.push(r.params); return { content: [{ type: 'text', text: JSON.stringify(r.params.arguments) }], structuredContent: { ok: true } } })
    const [a, b] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '1' })
    await backend.connect(b); await client.connect(a)
    return client
  })
  return { toolbox, configs, lists, calls }
}
test('search ranks names above descriptions across two backends and filters tools', async () => {
  const { toolbox } = await fixture()
  try {
    const result = await toolbox.search('deployments')
    expect(result.matches.map(t => [t.server, t.tool])).toEqual([['alpha', 'deployments'], ['alpha', 'lookup'], ['beta', 'lookup']])
    expect(result.matches[0]).toMatchObject({ writes: false, inputSchema: { type: 'object' } })
  } finally { await toolbox.close() }
})
test('call forwards arguments and preserves the result through the two-tool server', async () => {
  const { toolbox, calls } = await fixture()
  const server = toolboxServer(toolbox), client = new Client({ name: 'test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b); await client.connect(a)
  try {
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['toolbox_search', 'toolbox_call'])
    const result = await client.callTool({ name: 'toolbox_call', arguments: { server: 'beta', tool: 'lookup', args: { nested: [1, 'two'] } } })
    expect(result).toEqual({ content: [{ type: 'text', text: '{"nested":[1,"two"]}' }], structuredContent: { ok: true } })
    expect(calls).toEqual([{ name: 'lookup', arguments: { nested: [1, 'two'] } }])
  } finally { await client.close(); await toolbox.close() }
})
test('writes and destructive reads require exact allowlisting; tool exclusions still apply', async () => {
  const { toolbox, configs, calls } = await fixture()
  try {
    for (const name of ['write', 'destroy']) {
      await expect(toolbox.call('alpha', name, {})).rejects.toThrow('allowWrites')
      configs[0]!.allowWrites.push(name)
      await toolbox.call('alpha', name, {})
    }
    configs[1]!.allowWrites.push('write')
    await expect(toolbox.call('beta', 'write', {})).rejects.toThrow('excluded')
    expect(calls).toHaveLength(2)
  } finally { await toolbox.close() }
})
test('a failed backend leaves healthy results and calls usable without leaking errors', async () => {
  const { toolbox } = await fixture(true)
  try {
    expect(await toolbox.search('lookup')).toMatchObject({ matches: [{ server: 'alpha' }], errors: [{ server: 'beta', error: 'Backend unavailable' }] })
    await expect(toolbox.call('beta', 'lookup', {})).rejects.toThrow('Backend unavailable')
    expect((await toolbox.call('alpha', 'lookup', {})).content).toBeDefined()
  } finally { await toolbox.close() }
})
test('concurrent searches and calls reuse connections and tool cache', async () => {
  const { toolbox, lists } = await fixture()
  try {
    await Promise.all([toolbox.search('lookup'), toolbox.search('deployments'), toolbox.call('alpha', 'lookup', {})])
    await toolbox.search('lookup')
    expect(lists).toEqual({ alpha: 1, beta: 1 })
  } finally { await toolbox.close() }
})
