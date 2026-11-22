/**
 * A throwaway Otto for the app transport tests: its own HOME and state directory, a fake
 * Telegram token (so it takes the channel-host path that opens /app, and can reach nobody),
 * and only PATH from the real environment. The test plays Claude Code on its stdio, so every
 * notification the server would hand the session lands in `delivered`.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, dirname, join } from 'path'
import type { Subprocess } from 'bun'

export type Twin = {
  url: string; token: string; state: string; port: number
  delivered: { content: string; meta: Record<string, string> }[]
  stop: () => Promise<void>
  restart: () => Promise<Twin>
  /** A tool call as the session would make it (reply, react…). */
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>
  hook: (body: Record<string, unknown>) => Promise<void>
}

const SERVER = join(import.meta.dir, '..', 'server.ts')

/** Environment and optional test preload survive restart (fake T3, gh, or captured network requests). */
export async function startTwin(prev?: { home: string; state: string; port: number; token: string }, env: Record<string, string> = {}, preload?: string): Promise<Twin> {
  const home = prev?.home ?? mkdtempSync(join(tmpdir(), 'otto-twin-'))
  const state = prev?.state ?? join(home, '.otto', 'state')
  // A port the OS says is free, not a random guess that can land on something already listening.
  const port = prev?.port ?? (() => { const probe = Bun.serve({ port: 0, fetch: () => new Response() }); const p = probe.port!; probe.stop(true); return p })()
  let token = prev?.token ?? ''
  if (!prev) {
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'access.json'), JSON.stringify({
      dmPolicy: 'disabled', allowFrom: [], groups: {}, pending: {},
      webhook: { token: 'twin-webhook-token', host: '127.0.0.1', port },
      redeliverHours: 6,
    }))
    const p = Bun.spawnSync(['bun', join(import.meta.dir, '..', 'apptokens.ts'), 'new', 'twin'], { env: { PATH: process.env.PATH!, HOME: home, OTTO_STATE_DIR: state } })
    token = String(p.stdout).match(/[A-Za-z0-9_-]{24,}/)?.[0] ?? ''
    if (!token) throw new Error(`no app token: ${p.stdout} ${p.stderr}`)
  }
  const proc: Subprocess<'pipe', 'pipe', 'pipe'> = Bun.spawn(['bun', ...(preload ? ['--preload', preload] : []), SERVER], {
    // The home's own bin first: claudeBin() takes the first claude on PATH, and tests stub it there.
    env: { PATH: `${join(home, '.local', 'bin')}${delimiter}${process.env.PATH}`, HOME: home, OTTO_STATE_DIR: state, OTTO_CHANNEL_HOST: '1', TELEGRAM_BOT_TOKEN: '0:twin', OTTO_REDELIVER_SETTLE_MS: '400', ...env },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  })
  const delivered: Twin['delivered'] = []
  const waiting = new Map<number, (v: unknown) => void>()
  let nextId = 1
  const send = (m: unknown) => { proc.stdin.write(JSON.stringify(m) + '\n'); proc.stdin.flush() }
  ;(async () => {
    let buf = ''
    for await (const chunk of proc.stdout) {
      buf += new TextDecoder().decode(chunk)
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        try {
          const m = JSON.parse(line)
          if (m.method === 'notifications/claude/channel') delivered.push(m.params)
          if (m.id != null && waiting.has(m.id)) { waiting.get(m.id)!(m.result ?? m.error); waiting.delete(m.id) }
        } catch {}
      }
    }
  })()
  if (process.env.TWIN_LOG) (async () => { for await (const c of proc.stderr) process.stderr.write(c) })()
  const request = (method: string, params: unknown) => new Promise<unknown>(r => { const id = nextId++; waiting.set(id, r); send({ jsonrpc: '2.0', id, method, params }) })
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'twin', version: '0' } })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const url = `http://127.0.0.1:${port}`
  // Under the full suite a boot can take a while; a twin that never comes up fails loudly here.
  let up = false
  for (let i = 0; i < 300 && !up; i++) {
    up = await fetch(`${url}/app/history`, { headers: { authorization: `Bearer ${token}` } }).then(r => r.ok).catch(() => false)
    if (!up) await Bun.sleep(100)
  }
  if (!up) throw new Error('twin server did not come up in 30 s')
  const twin: Twin = {
    url, token, state, port, delivered,
    stop: async () => { proc.kill('SIGTERM'); await proc.exited },
    restart: async () => { await twin.stop(); return startTwin({ home, state, port, token }, env, preload) },
    call: (name, args) => request('tools/call', { name, arguments: args }),
    hook: async body => {
      await fetch(`${url}/status`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-claude-pid': String(process.pid) }, body: JSON.stringify(body) })
    },
  }
  return twin
}

/** Mint a distinct device against this twin's isolated token store. */
export function anotherDevice(t: Twin): Twin {
  const made = Bun.spawnSync(['bun', join(import.meta.dir, '..', 'apptokens.ts'), 'new', 'twin-second'], {
    env: { PATH: process.env.PATH!, HOME: dirname(dirname(t.state)), OTTO_STATE_DIR: t.state },
  })
  const token = String(made.stdout).match(/[A-Za-z0-9_-]{24,}/)?.[0]
  if (!token) throw new Error('could not mint a second twin device')
  return { ...t, token }
}

/** A phone: one websocket, every frame it got, and a way to freeze it (frames sent after go nowhere). */
export async function phone(t: Twin, query = ''): Promise<{ ws: WebSocket; got: any[]; send: (f: unknown) => void; close: () => void; until: (p: (f: any) => boolean, ms?: number) => Promise<any> }> {
  const ws = new WebSocket(`${t.url.replace('http', 'ws')}/app${query}`, { headers: { authorization: `Bearer ${t.token}` } } as any)
  const got: any[] = []
  ws.onmessage = e => got.push(JSON.parse(String(e.data)))
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no })
  const until = async (p: (f: any) => boolean, ms = 15000) => {
    const end = Date.now() + ms
    while (Date.now() < end) { const f = got.find(p); if (f) return f; await Bun.sleep(20) }
    return undefined
  }
  return { ws, got, send: f => ws.send(JSON.stringify(f)), close: () => ws.close(), until }
}

export async function waitFor<T>(fn: () => T | undefined | false, ms = 15000): Promise<T | undefined> {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = fn(); if (v) return v; await Bun.sleep(20) }
  return undefined
}

/** Turn self-edit on in a twin's access.json (it ships off); read per call, so no restart is needed. */
export function selfEditOn(t: Twin): void {
  const file = join(t.state, 'access.json')
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), selfEdit: true }))
}
