#!/usr/bin/env bun
/**
 * Read-only lookups for the front desk (otto/front.ts), as a tiny stdio MCP server its
 * headless session starts. It reads Otto's state files and runs `gog` reads directly, so it
 * never touches the channel server. Nothing here writes, sends or changes anything; mail
 * comes back as sender, subject and date only, never bodies.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { loadNotes, searchNotes, formatNote } from './store.ts'
import { loadMemories, searchMemories, formatHit } from './memory.ts'

const STATE = process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state')
const ACCOUNT = process.env.OTTO_GOOGLE_ACCOUNT ?? ''

const cap = (s: string, n = 4000) => (s.length > n ? s.slice(0, n) + '\n…' : s)

export function memory(query: string): string {
  const notes = searchNotes(loadNotes(join(STATE, 'notes.json')), { query, limit: 6 }).map(n => formatNote(n))
  const mems = searchMemories(loadMemories(), query, { limit: 4 }).map(h => formatHit(h, true))
  return cap([...notes, ...mems].join('\n\n')) || 'nothing found'
}

export function reminders(): string {
  try {
    const ts = JSON.parse(readFileSync(join(STATE, 'triggers.json'), 'utf8')) as { id: string; type: string; schedule?: string; tz?: string; condition?: string; action?: string; enabled?: boolean }[]
    return cap(ts.filter(t => t.enabled !== false).map(t =>
      `${t.id} ${t.type} ${t.schedule ?? t.condition ?? ''}${t.tz ? ` (${t.tz})` : ''}: ${(t.action ?? '').replace(/\s+/g, ' ').slice(0, 160)}`).join('\n')) || 'none'
  } catch { return 'none' }
}

export function history(query: string, limit = 20): string {
  let lines: string[] = []
  try { lines = readFileSync(join(STATE, 'history.jsonl'), 'utf8').trim().split('\n').slice(-5000) } catch { return 'none' }
  const q = query.toLowerCase()
  const hits = lines.flatMap(l => { try { const e = JSON.parse(l); return e.kind !== 'tap' && (!q || String(e.text ?? '').toLowerCase().includes(q)) ? [e] : [] } catch { return [] } })
  return cap(hits.slice(-limit).map(e => `${e.ts} ${e.dir === 'in' ? 'them' : 'you'} (${e.chat_id}): ${String(e.text ?? '').replace(/\s+/g, ' ').slice(0, 300)}`).join('\n')) || 'nothing found'
}

async function gog(args: string[]): Promise<string> {
  if (!ACCOUNT) return 'not set up'
  const p = Bun.spawn(['gog', ...args, '-a', ACCOUNT, '--json'], { stdout: 'pipe', stderr: 'ignore' })
  const timer = setTimeout(() => p.kill(), 12_000)
  try { return await new Response(p.stdout).text() } finally { clearTimeout(timer) }
}

export async function calendar(): Promise<string> {
  try {
    const j = JSON.parse(await gog(['calendar', 'events', '--max', '15']))
    const evs = (Array.isArray(j) ? j : j.events ?? j.items ?? []) as { summary?: string; start?: { dateTime?: string; date?: string }; location?: string }[]
    return cap(evs.map(e => `${e.start?.dateTime ?? e.start?.date ?? '?'} ${e.summary ?? '(no title)'}${e.location ? ` @ ${e.location}` : ''}`).join('\n')) || 'nothing upcoming'
  } catch { return 'calendar unavailable' }
}

export async function mail(query: string): Promise<string> {
  try {
    const j = JSON.parse(await gog(['gmail', 'search', query || 'newer_than:2d', '--max', '10']))
    const ms = (Array.isArray(j) ? j : j.threads ?? j.messages ?? []) as Record<string, unknown>[]
    // Headers only: a body is someone else's words, and this session answers the user directly.
    return cap(ms.map(m => `${m.date ?? ''} from ${m.from ?? '?'}: ${m.subject ?? '(no subject)'}`).join('\n')) || 'nothing found'
  } catch { return 'mail unavailable' }
}

const TOOLS = [
  { name: 'memory', description: 'Search what Otto remembers about the user: notes, open loops, saved things, durable memories.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'reminders', description: 'Every reminder and scheduled job Otto has set, with when it fires.', inputSchema: { type: 'object', properties: {} } },
  { name: 'calendar', description: "The user's upcoming calendar events.", inputSchema: { type: 'object', properties: {} } },
  { name: 'mail', description: 'Search the inbox; returns sender, subject and date only. Gmail search syntax.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'history', description: 'Search past chat messages with the user, newest last.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
]

if (import.meta.main) {
  const server = new Server({ name: 'front', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
  server.setRequestHandler(CallToolRequestSchema, async req => {
    const a = (req.params.arguments ?? {}) as Record<string, unknown>
    const q = typeof a.query === 'string' ? a.query : ''
    const text = req.params.name === 'memory' ? memory(q)
      : req.params.name === 'reminders' ? reminders()
      : req.params.name === 'calendar' ? await calendar()
      : req.params.name === 'mail' ? await mail(q)
      : req.params.name === 'history' ? history(q)
      : 'unknown tool'
    return { content: [{ type: 'text', text }] }
  })
  await server.connect(new StdioServerTransport())
}
