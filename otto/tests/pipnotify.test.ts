import { test, expect, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { startTwin, phone, waitFor, type Twin } from './apptwin.ts'

let t: Twin
const clients: Awaited<ReturnType<typeof phone>>[] = []
afterEach(async () => { for (const c of clients.splice(0)) c.close(); await t?.stop() })
async function connect(other = false) {
  let token = t.token
  if (other) {
    const made = Bun.spawnSync(['bun', join(import.meta.dir, '..', 'apptokens.ts'), 'new', 'phone'], { env: { PATH: process.env.PATH!, OTTO_STATE_DIR: t.state } })
    token = String(made.stdout).match(/[A-Za-z0-9_-]{24,}/)![0]
  }
  const c = await phone({ ...t, token }); clients.push(c)
  await c.until(f => f.type === 'hello')
  return c
}
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'otto-pip-notify-'))
  const pushesFile = join(dir, 'pushes.jsonl'), clock = join(dir, 'clock'), preload = join(dir, 'capture.ts')
  writeFileSync(pushesFile, ''); writeFileSync(clock, '0')
  writeFileSync(preload, `
    import { appendFileSync, readFileSync } from 'fs'
    const now = Date.now
    Date.now = () => now() + Number(readFileSync(${JSON.stringify(clock)}, 'utf8'))
    const original = globalThis.fetch
    globalThis.fetch = ((url, init) => {
      if (String(url) === 'https://api.day.app/info') return Promise.resolve(Response.json({ version: 'v2.2.5' }))
      if (String(url).startsWith('https://api.day.app/')) {
        appendFileSync(${JSON.stringify(pushesFile)}, String(init?.body) + '\\n')
        return Promise.resolve(new Response('{}'))
      }
      return original(url, init)
    }) as typeof fetch
  `)
  t = await startTwin(undefined, { BARK_KEY: 'test-device-key', TZ: 'UTC' }, preload)
  const bin = join(dirname(dirname(t.state)), '.local', 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\nprintf '%s\\n' '{"type":"system","subtype":"init"}' '{"type":"result","subtype":"success","result":"Stub pip result"}'\n`, { mode: 0o755 })
  const post = async (path: string, body: unknown) => {
    const r = await fetch(t.url + path, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(r.ok).toBe(true)
    return r.status === 204 ? null : r.json() as Promise<any>
  }
  const pip = await post('/app/pips', { name: 'Helper', job: 'Research', instructions: 'Report', tools: ['WebSearch'], solid: 'gem', colour: '#123abc' })
  const group = await post('/app/groups', { name: 'Research', members: [pip.id] })
  const pushes = () => readFileSync(pushesFile, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s))
  const seen = new Set<string>()
  const run = async (conversation: string, op: string) => {
    await post(`/app/conversations/${conversation}/messages`, { id: op, text: '@Helper research' })
    const result = await waitFor(() => {
      const store = JSON.parse(readFileSync(join(t.state, 'pips.json'), 'utf8'))
      return store.messages.findLast((m: any) => m.conversation_id === conversation && m.sender === pip.id && m.text === 'Stub pip result' && !seen.has(m.id))
    }, 20000) as any
    expect(result).toBeTruthy(); seen.add(result.id)
    return result
  }
  return { pip, group, post, pushes, run, clock }
}
async function presence(c: Awaited<ReturnType<typeof phone>>, focused: boolean, op: string) {
  c.send({ type: 'presence', focused }); c.send({ type: 'ping', op })
  expect(await c.until(f => f.type === 'ack' && f.id === op)).toBeTruthy()
}

test('pip and group messages use Bark without a phone, and the receipt timeout falls back once', async () => {
  const r = await setup(), desk = await connect()
  await presence(desk, false, 'unfocused')
  const first = await r.run(r.pip.id, 'offline')
  expect(await waitFor(() => r.pushes().some(x => x.id === first.id))).toBe(true)
  expect(r.pushes().filter(x => x.id === first.id)).toHaveLength(1)
  // Status lines ("You asked Helper", "Otto added Helper") appear in the thread but never push.
  const status = JSON.parse(readFileSync(join(t.state, 'pips.json'), 'utf8')).messages.filter((m: any) => m.kind === 'system').map((m: any) => m.id)
  expect(status.length).toBeGreaterThan(0)
  expect(r.pushes().some(x => status.includes(x.id))).toBe(false)
  const p = await connect(true)
  p.send({ type: 'hello', messageAcks: true }); p.send({ type: 'ping', op: 'capable' })
  await p.until(f => f.type === 'ack' && f.id === 'capable')
  const second = await r.run(r.group.id, 'timeout')
  expect(await p.until(f => f.type === 'conversation_message' && f.message.id === second.id)).toBeTruthy()
  expect(await waitFor(() => r.pushes().some(x => x.id === second.id), 10000)).toBe(true)
  expect(r.pushes().filter(x => x.id === second.id)).toHaveLength(1)
  desk.send({ type: 'notifications_read', conversation_id: r.group.id, ids: [second.id], op: 'explicit-read' })
  expect(await p.until(f => f.type === 'notifications_read' && f.ids.includes(second.id))).toBeTruthy()
}, 60000)

test('a pip answering the user goes straight out through a snooze; unprompted group messages queue intact across restart', async () => {
  const r = await setup(), p = await connect()
  await r.post('/app/snooze', { minutes: 60 })
  const answer = await r.run(r.pip.id, 'asked-while-snoozed')
  expect(await p.until(f => f.type === 'conversation_message' && f.message.id === answer.id)).toBeTruthy()
  const file = join(t.state, 'access.json'), a = JSON.parse(readFileSync(file, 'utf8'))
  const hour = new Date().getUTCHours()
  a.quietHours = `${(hour + 23) % 24}:00-${(hour + 1) % 24}:00`
  writeFileSync(file, JSON.stringify(a))
  await r.post('/app/snooze', { clear: true })
  const res = await t.call('reply', { chat_id: 'app', conversation_id: r.group.id, text: 'unprompted', priority: 'normal' }) as any
  const m = JSON.parse(res.content[0].text)
  const queued = await waitFor(() => {
    const q = JSON.parse(readFileSync(join(t.state, 'queue.json'), 'utf8'))
    return q.find((entry: any) => entry.conversation?.id === m.id)
  }, 3000) as any
  expect(queued?.reason).toBe('quiet')
  expect(p.got.some(f => f.type === 'conversation_message' && f.message.id === m.id)).toBe(false)
  expect(r.pushes().some(x => x.id === m.id)).toBe(false)
  p.close(); t = await t.restart()
  await r.post('/app/snooze', { clear: true })
  expect(await waitFor(() => r.pushes().some(x => x.id === m.id))).toBe(true)
  expect(JSON.parse(readFileSync(join(t.state, 'queue.json'), 'utf8'))).toHaveLength(0)
}, 60000)

test('conversation replies honor normal holds, urgency, quiet, and successful phone receipts', async () => {
  const r = await setup(), p = await connect()
  p.send({ type: 'hello', messageAcks: true })
  await r.post('/app/snooze', { minutes: 60 })
  const reply = async (text: string, extra: Record<string, unknown>) => {
    const response = await t.call('reply', { chat_id: 'app', conversation_id: r.group.id, text, ...extra }) as any
    expect(response.isError).not.toBe(true)
    return JSON.parse(response.content[0].text)
  }
  const held = await reply('normal reply', { priority: 'normal' })
  expect(JSON.parse(readFileSync(join(t.state, 'queue.json'), 'utf8')).some((q: any) => q.id === held.id)).toBe(true)
  const urgent = await reply('urgent reply', { priority: 'urgent' })
  expect(await p.until(f => f.type === 'conversation_message' && f.message.id === urgent.id)).toBeTruthy()
  p.send({ type: 'ack', id: urgent.id })
  const silent = await reply('quiet reply', { priority: 'urgent', quiet: true })
  expect(await p.until(f => f.type === 'conversation_message' && f.message.id === silent.id)).toMatchObject({ message: { quiet: true } })
  // Let the real receipt timeout expire: an acknowledged or quiet message must never fall back.
  await Bun.sleep(5500)
  expect(r.pushes().filter(x => [held.id, urgent.id, silent.id].includes(x.id))).toHaveLength(0)
}, 30000)
