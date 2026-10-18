// Local harness for otto-dash: handleDash on a port of its own, no session needed.
//
//   bun otto/dash-dev.ts [--port 4592]
//   cd otto-dash && bun dev -p 3001     server URL http://127.0.0.1:4592
//
// Reads are real, from the state dir (OTTO_STATE_DIR, else ~/.otto/state).
// Chat reads for real and goes live as the real Otto writes history; sending answers 501.
// Writes are not: settings and snooze read for real but can't change; loop and memory rebuild
// answer 501. Tokens and the allowlist live in a temp dir, so
// pairing here never touches the real app-tokens.json or dash.json: the real
// allowlist is copied in, plus the dashboard's dev origins for 24 h.
//
// stdin stands in for Telegram: `pair <code>` prints the approval Otto would
// send, and 1/2/3 taps one of its buttons.

import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, watchFile } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { parseArgs } from 'util'
import { configPath, handleDash, loadDashConfig, saveDashConfig, type DashDeps, type DashTrigger } from './dash.ts'
import { pairingButton, pairingCommand } from './pairing.ts'
import { accessToggles, connectorToggles, readConnectorSources, triggerToggles } from './settings.ts'
import { defaultStatusDeps } from './status.ts'
import { gatherBrief, type BriefData } from './brief.ts'
import { readNotes } from './memviewer.ts'
import { ChatFeed, type ChatEntry } from './chatfeed.ts'

const { values: flags } = parseArgs({ args: process.argv.slice(2), strict: false, options: { port: { type: 'string', default: '4592' } } })
const port = Number(flags.port)
const stateDir = process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state')
const DEV_ORIGINS = ['http://localhost:3001', 'http://127.0.0.1:3001']

// OTTO_DASH_DEV_DIR keeps the temp tokens across restarts, so editing the harness doesn't mean pairing again.
const keep = process.env.OTTO_DASH_DEV_DIR
const tmp = keep ? (mkdirSync(keep, { recursive: true, mode: 0o700 }), keep) : mkdtempSync(join(tmpdir(), 'otto-dash-dev-'))
const cfg = loadDashConfig(configPath(stateDir))
for (const o of DEV_ORIGINS) cfg.origins[o] = { until: new Date(Date.now() + 24 * 3600_000).toISOString() }
process.env.OTTO_DASH_CONFIG = join(tmp, 'dash.json')
saveDashConfig(cfg)
// apptokens.ts resolves its file on every call, so from here on every token is a temp one.
// Everything else reads stateDir, which dash.ts is handed explicitly.
process.env.OTTO_STATE_DIR = tmp
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { if (!keep) rmSync(tmp, { recursive: true, force: true }); process.exit(0) })

const readJson = <T>(file: string): T | null => { try { return JSON.parse(readFileSync(file, 'utf8')) as T } catch { return null } }
const loadTriggers = () => readJson<DashTrigger[]>(join(stateDir, 'triggers.json')) ?? []

/** server.ts's readHistory, minus the bounded tail: this is a dev tool. */
function readHistory(chat_id: string | undefined, limit: number): ChatEntry[] {
  const lines = ['history.1.jsonl', 'history.jsonl'].flatMap(f => { try { return readFileSync(join(stateDir, f), 'utf8').split('\n') } catch { return [] } })
  const entries = lines.flatMap(l => { try { return l ? [JSON.parse(l) as ChatEntry] : [] } catch { return [] } })
  return entries.filter(e => !chat_id || e.chat_id === chat_id).sort((a, b) => a.ts.localeCompare(b.ts)).slice(-limit)
}

// Live for the preview: the real Otto appends to history.jsonl, and each new line feeds the chat long-poll.
const chat = new ChatFeed()
const historyFile = join(stateDir, 'history.jsonl')
watchFile(historyFile, { interval: 1000 }, (curr, prev) => {
  const from = curr.size < prev.size ? 0 : prev.size // smaller means it rotated
  if (curr.size <= from) return
  const buf = Buffer.alloc(curr.size - from)
  const fd = openSync(historyFile, 'r')
  try { readSync(fd, buf, 0, buf.length, from) } finally { closeSync(fd) }
  for (const line of buf.toString('utf8').split('\n')) { try { if (line) chat.push(JSON.parse(line) as ChatEntry) } catch {} }
})

const statusDeps = () => defaultStatusDeps({ stateDir })

// The live server keeps its brief warm; here one is gathered at start, from the same sources.
let brief: BriefData | null = null
void gatherBrief({
  account: statusDeps().account ?? '',
  notes: readNotes(join(stateDir, 'notes.json')),
  triggers: loadTriggers().filter(t => t.enabled && t.nextRun).map(t => ({ id: t.id, gist: t.action, nextRun: t.nextRun })),
  history: [],
}).then(b => { brief = b.data }).catch(err => console.error(`brief: ${err}`))

const notHere = async () => new Response(null, { status: 501 })
// Settings read for real, from the same builders server.ts uses; flipping one still needs the live Otto.
const project = process.env.CLAUDE_PROJECT_DIR ?? join(homedir(), '.otto', 'repo')
const settings = async (req: Request) => {
  if (req.method !== 'GET') return Response.json({ error: 'preview' }, { status: 501 })
  const access = readJson<Record<string, any>>(join(stateDir, 'access.json')) ?? {}
  const src = readConnectorSources(homedir(), project)
  return Response.json({
    speakReplies: access.appSpeakReplies !== false,
    toggles: [...accessToggles(access as any), ...triggerToggles(loadTriggers() as any), ...(src ? connectorToggles(src) : [])],
  })
}
// The hold state and held messages read for real (server.ts's GET); snoozing still needs the live Otto.
const snooze = async (req: Request) => {
  if (req.method !== 'GET') return Response.json({ error: 'preview' }, { status: 501 })
  const access = readJson<{ snoozeUntil?: string; snoozeSince?: string }>(join(stateDir, 'access.json')) ?? {}
  const live = !!access.snoozeUntil && Date.parse(access.snoozeUntil) > Date.now()
  const queue = readJson<{ text: string; queuedAt: string }[]>(join(stateDir, 'queue.json')) ?? []
  return Response.json({
    until: live ? access.snoozeUntil : null,
    since: live ? (access.snoozeSince ?? null) : null,
    held: queue.map(m => ({ text: m.text, at: m.queuedAt })),
  })
}
const deps: DashDeps = {
  stateDir, brief: () => brief, statusDeps, loadTriggers, readHistory, chat,
  appSettings: settings, appSnooze: snooze, appLoop: notHere,
  rebuild: () => ({ exited: Promise.resolve() }),
}

Bun.serve({
  hostname: '127.0.0.1', port,
  fetch: (req, server) => handleDash(req, server, deps) ?? new Response('not found', { status: 404 }),
})
console.log(`dash-dev on http://127.0.0.1:${port}/app/dash/ — reading ${stateDir}, tokens and allowlist in ${tmp}`)
console.log(`allowed: ${Object.keys(cfg.origins).join(', ')}`)
console.log('type: pair <code>, then 1/2/3 to tap')

let buttons: { label: string; data: string }[] = []
for await (const line of console) {
  const n = Number(line.trim())
  if (buttons.length && Number.isInteger(n) && n >= 1 && n <= buttons.length) {
    console.log(pairingButton(buttons[n - 1].data))
    buttons = []
    continue
  }
  const handled = await pairingCommand(line, (text, b) => {
    console.log(text)
    b.forEach((x, i) => console.log(`  ${i + 1}. ${x.label}`)) // labels only: the data carries the nonce
    buttons = b
  })
  if (!handled) console.log('type: pair <code>, then 1/2/3 to tap')
}
