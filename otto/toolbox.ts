#!/usr/bin/env bun
import { homedir } from 'os'
import { join } from 'path'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'

const entry = z.object({
  name: z.string().min(1),
  command: z.string().min(1).optional(), args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.url().optional(), headers: z.record(z.string(), z.string()).optional(),
  tools: z.array(z.string()).optional(), allowWrites: z.array(z.string()).default([]),
}).refine(v => Boolean(v.command) !== Boolean(v.url), 'Use command or url')
export const configSchema = z.array(entry).refine(v => new Set(v.map(x => x.name)).size === v.length, 'Duplicate server name')
export type Backend = z.infer<typeof entry>
type Connection = Pick<Client, 'listTools' | 'callTool' | 'close'>
export async function connectBackend(config: Backend): Promise<Connection> {
  const client = new Client({ name: 'otto-toolbox', version: '0.1.0' })
  const transport = config.command
    ? new StdioClientTransport({ command: config.command, args: config.args, env: config.env, stderr: 'ignore' })
    : new StreamableHTTPClientTransport(new URL(config.url!), { requestInit: { headers: config.headers } })
  try { await client.connect(transport); return client }
  catch { await transport.close().catch(() => {}); throw new Error('Backend connection failed') }
}
const writes = (tool: Tool) => tool.annotations?.readOnlyHint !== true || tool.annotations?.destructiveHint === true

export class Toolbox {
  private cache = new Map<string, Promise<{ client: Connection, tools: Tool[] }>>()
  constructor(private backends: Backend[], private connect = connectBackend) {}
  private load(config: Backend) {
    let pending = this.cache.get(config.name)
    if (!pending) {
      pending = (async () => {
        const client = await this.connect(config)
        try {
          const tools: Tool[] = []
          let cursor: string | undefined
          do {
            const page = await client.listTools({ cursor })
            tools.push(...page.tools.filter(t => !config.tools || config.tools.includes(t.name)))
            cursor = page.nextCursor
          } while (cursor)
          return { client, tools }
        } catch { await client.close().catch(() => {}); throw new Error('Backend discovery failed') }
      })()
      this.cache.set(config.name, pending)
      pending.catch(() => this.cache.delete(config.name))
    }
    return pending
  }
  async search(query: string) {
    const terms = query.toLowerCase().split(/\W+/).filter(Boolean)
    const errors: { server: string, error: string }[] = []
    const matches = (await Promise.all(this.backends.map(async config => {
      try {
        const { tools } = await this.load(config)
        return tools.map(tool => {
          const name = tool.name.toLowerCase(), description = (tool.description ?? '').toLowerCase()
          const score = terms.reduce((n, term) => n + (name.includes(term) ? 4 : 0) + (description.includes(term) ? 1 : 0), 0)
          return { server: config.name, tool: tool.name, description: (tool.description ?? '').slice(0, 240), inputSchema: tool.inputSchema, writes: writes(tool), score }
        }).filter(t => t.score > 0)
      } catch { errors.push({ server: config.name, error: 'Backend unavailable' }); return [] }
    }))).flat().sort((a, b) => b.score - a.score || a.server.localeCompare(b.server) || a.tool.localeCompare(b.tool))
    return { matches: matches.slice(0, 10).map(({ score, ...match }) => match), errors }
  }
  async call(server: string, name: string, args: Record<string, unknown>) {
    const config = this.backends.find(c => c.name === server)
    if (!config) throw new Error('Unknown backend')
    const { client, tools } = await this.load(config).catch(() => { throw new Error('Backend unavailable') })
    const tool = tools.find(t => t.name === name)
    if (!tool) throw new Error('Unknown or excluded tool')
    if (writes(tool) && !config.allowWrites.includes(name)) throw new Error('Write tool requires allowWrites')
    try { return await client.callTool({ name, arguments: args }) }
    catch { throw new Error('Backend call failed') }
  }
  async close() {
    await Promise.allSettled([...this.cache.values()].map(async p => (await p).client.close()))
    this.cache.clear()
  }
}
export function toolboxServer(toolbox: Toolbox) {
  const server = new Server({ name: 'otto-toolbox', version: '0.1.0' }, {
    capabilities: { tools: {} },
    instructions: 'Search here for Vercel deployments, logs and analytics; domain search; Clerk; Google Sheets and Drive; engineering services.',
  })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: 'toolbox_search', description: 'Find backend tools and schemas.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false }, annotations: { readOnlyHint: true } },
    { name: 'toolbox_call', description: 'Call a discovered tool. Writes require local allowlisting.', inputSchema: { type: 'object', properties: { server: { type: 'string' }, tool: { type: 'string' }, args: { type: 'object', additionalProperties: true } }, required: ['server', 'tool', 'args'], additionalProperties: false } },
  ] }))
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      if (request.params.name === 'toolbox_search') {
        const { query } = z.object({ query: z.string().min(1) }).parse(request.params.arguments)
        return { content: [{ type: 'text', text: JSON.stringify(await toolbox.search(query)) }] }
      }
      if (request.params.name !== 'toolbox_call') throw new Error('Unknown tool')
      const args = z.object({ server: z.string(), tool: z.string(), args: z.record(z.string(), z.unknown()) }).parse(request.params.arguments)
      return await toolbox.call(args.server, args.tool, args.args)
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof z.ZodError ? 'Invalid arguments' : (error as Error).message }] }
    }
  })
  return server
}
if (import.meta.main) {
  try {
    const toolbox = new Toolbox(configSchema.parse(await Bun.file(join(homedir(), '.otto', 'state', 'toolbox.json')).json()))
    const server = toolboxServer(toolbox)
    server.onclose = () => { void toolbox.close() }
    await server.connect(new StdioServerTransport())
  } catch { console.error('Toolbox startup failed; check local config'); process.exitCode = 1 }
}
