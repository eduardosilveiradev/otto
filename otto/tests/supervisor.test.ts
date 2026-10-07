// The supervisor keeps one client connection across server restarts: a reload
// lands on the new code, a request caught mid-restart gets an error instead of
// hanging, the client hears tools/list_changed, and the replayed initialize
// reply never leaks out.
import { test, expect, afterAll } from 'bun:test'
import { spawn } from 'child_process'
import { createInterface } from 'readline'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const dir = mkdtempSync(join(tmpdir(), 'otto-sup-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const sdk = (p: string) => require.resolve(`@modelcontextprotocol/sdk/${p}`)
const versionFile = join(dir, 'version')
const mock = join(dir, 'mock.ts')
writeFileSync(versionFile, 'v1')
writeFileSync(mock, `
import { Server } from ${JSON.stringify(sdk('server/index.js'))}
import { StdioServerTransport } from ${JSON.stringify(sdk('server/stdio.js'))}
import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(sdk('types.js'))}
import { readFileSync } from 'fs'
const s = new Server({ name: 'mock', version: '1' }, { capabilities: { tools: { listChanged: true } } })
s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
s.setRequestHandler(CallToolRequestSchema, async r => {
  if (r.params.name === 'reload') { setTimeout(() => process.exit(0), 100); return { content: [{ type: 'text', text: 'ok' }] } }
  if (r.params.name === 'hang') await new Promise(() => {})
  return { content: [{ type: 'text', text: readFileSync(${JSON.stringify(versionFile)}, 'utf8') + ' ' + process.env.OTTO_SUPERVISED }] }
})
await s.connect(new StdioServerTransport())
process.stdin.on('end', () => process.exit(0))
`)

test('reload keeps the connection and lands on new code', async () => {
  const p = spawn('bun', [join(import.meta.dir, '..', 'supervisor.ts')], {
    stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, OTTO_SERVER_ENTRY: mock },
  })
  const got: any[] = []
  createInterface({ input: p.stdout! }).on('line', l => got.push(JSON.parse(l)))
  const send = (m: object) => p.stdin!.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
  const reply = async (id: number) => {
    for (let i = 0; i < 200; i++) { const m = got.find(g => g.id === id); if (m) return m; await Bun.sleep(25) }
    throw new Error(`no reply to ${id}`)
  }
  const call = (id: number, name: string) => send({ id, method: 'tools/call', params: { name, arguments: {} } })
  const text = (m: any) => m.result?.content?.[0]?.text

  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
  await reply(1)
  send({ method: 'notifications/initialized' })
  call(2, 'version'); expect(text(await reply(2))).toBe('v1 1')
  call(3, 'hang')
  writeFileSync(versionFile, 'v2')
  call(4, 'reload'); await reply(4)
  expect((await reply(3)).error?.code).toBe(-32000)
  call(5, 'version'); expect(text(await reply(5))).toBe('v2 1')
  expect(got.some(g => g.method === 'notifications/tools/list_changed')).toBe(true)
  expect(got.some(g => typeof g.id === 'string')).toBe(false)

  p.stdin!.end()
  expect(await new Promise(r => p.on('exit', r))).toBe(0)
}, 20_000)
