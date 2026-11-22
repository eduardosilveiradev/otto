/**
 * The app channel end to end, against a throwaway server (apptwin.ts): nothing the phone
 * sends is lost or handled twice, and nothing Otto sends is lost, across acks that never
 * arrive, resends, restarts and held turns.
 */
import { test, expect, afterAll } from 'bun:test'
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startTwin, anotherDevice, phone, waitFor, type Twin } from './apptwin.ts'

const twins: Twin[] = []
// One test's servers are stopped before the next starts: left running, forty of them slow every boot.
async function twin(): Promise<Twin> {
  for (const old of twins.splice(0)) await old.stop().catch(() => {})
  const t = await startTwin(); twins.push(t); return t
}
afterAll(async () => { for (const t of twins) await t.stop().catch(() => {}) })
const journal = (t: Twin) => JSON.parse(readFileSync(join(t.state, 'inbound-journal.json'), 'utf8')) as any[]
const history = async (t: Twin, q = '') => (await fetch(`${t.url}/app/history${q}`, { headers: { authorization: `Bearer ${t.token}` } })).json() as Promise<any[]>
const post = (t: Twin, path: string, body: string) => fetch(`${t.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${t.token}` }, body })

test('the server says it acks, and acks a message once it is written down', async () => {
  const t = await twin()
  const p = await phone(t)
  expect(await p.until(f => f.type === 'hello')).toMatchObject({ acks: true })
  p.send({ type: 'message', id: 'M1', text: 'one' })
  expect(await p.until(f => f.type === 'ack' && f.id === 'M1')).toBeTruthy()
  expect(journal(t).some(e => e.message_id === 'M1')).toBe(true)
}, 60000)

test('app messages echo only to the other socket, with the history id, once across retries', async () => {
  const t = await twin()
  const sender = await phone(t)
  const other = await phone(t)
  sender.send({ type: 'message', id: 'echo-text', text: 'from desktop' })
  expect(await other.until(f => f.type === 'echo')).toMatchObject({ id: 'echo-text', text: 'from desktop', ts: expect.any(String) })
  expect((await history(t)).find(h => h.id === 'echo-text')).toMatchObject({ dir: 'in', text: 'from desktop' })
  sender.send({ type: 'message', id: 'echo-text', text: 'from desktop' })
  await waitFor(() => sender.got.filter(f => f.type === 'ack' && f.id === 'echo-text').length === 2)
  await Bun.sleep(200)
  expect(sender.got.filter(f => f.type === 'echo')).toHaveLength(0)
  expect(other.got.filter(f => f.type === 'echo')).toHaveLength(1)
}, 60000)

test('a tapback echoes to the other socket as a react frame, never back to its sender', async () => {
  const t = await twin()
  const sender = await phone(t)
  const other = await phone(t)
  sender.send({ type: 'react', op: 'RX-echo', id: 'some-message', emoji: '❤️' })
  expect(await other.until(f => f.type === 'react')).toMatchObject({ id: 'some-message', emoji: '❤️', from: 'user' })
  await waitFor(() => sender.got.some(f => f.type === 'ack' && f.id === 'RX-echo'))
  await Bun.sleep(200)
  expect(sender.got.filter(f => f.type === 'react')).toHaveLength(0)
}, 60000)

test('photo captions echo to other devices only, once across upload retries', async () => {
  const t = await twin()
  const sender = await phone(t)
  const made = Bun.spawnSync(['bun', join(import.meta.dir, '..', 'apptokens.ts'), 'new', 'other-device'], {
    env: { ...process.env, OTTO_STATE_DIR: t.state },
  })
  const token = String(made.stdout).match(/[A-Za-z0-9_-]{24,}/)?.[0]
  expect(token).toBeTruthy()
  const other = await phone({ ...t, token: token! })
  expect((await post(t, '/app/photo?id=echo-photo&text=photo%20caption', 'jpeg')).status).toBe(204)
  expect(await other.until(f => f.type === 'echo')).toMatchObject({ id: 'echo-photo', text: 'photo caption' })
  expect((await history(t)).find(h => h.id === 'echo-photo')).toMatchObject({ dir: 'in', text: 'photo caption' })
  expect((await post(t, '/app/photo?id=echo-photo&text=photo%20caption', 'jpeg')).status).toBe(204)
  await Bun.sleep(200)
  expect(sender.got.filter(f => f.type === 'echo')).toHaveLength(0)
  expect(other.got.filter(f => f.type === 'echo')).toHaveLength(1)
}, 60000)

test('a resent message (its ack was lost) is acked again but reaches the session once, even after a restart', async () => {
  let t = await twin()
  let p = await phone(t)
  p.send({ type: 'message', id: 'D1', text: 'only once' })
  await p.until(f => f.type === 'ack' && f.id === 'D1')
  p.send({ type: 'message', id: 'D1', text: 'only once' })
  expect(await p.until(f => f.type === 'ack' && f.id === 'D1' && p.got.filter(g => g.type === 'ack').length > 1)).toBeTruthy()
  t = await t.restart(); twins.push(t)
  p = await phone(t)
  p.send({ type: 'message', id: 'D1', text: 'only once' })
  expect(await p.until(f => f.type === 'ack' && f.id === 'D1')).toBeTruthy()
  await Bun.sleep(300)
  expect(t.delivered.filter(d => d.content === 'only once').length).toBe(0)   // the new process never re-handles it
}, 60000)

test('a tap resent after a lost ack is handled once', async () => {
  const t = await twin()
  const p = await phone(t)
  p.send({ type: 'tap', op: 'T1', data: 'send it', label: 'send ✓' })
  await p.until(f => f.type === 'ack' && f.id === 'T1')
  p.send({ type: 'tap', op: 'T1', data: 'send it', label: 'send ✓' })
  await waitFor(() => p.got.filter(f => f.type === 'ack' && f.id === 'T1').length === 2)
  await Bun.sleep(300)
  expect(t.delivered.filter(d => d.content.includes('send it')).length).toBe(1)
}, 60000)

test('a voice note or photo uploaded twice reaches the session once', async () => {
  const t = await twin()
  const a = await post(t, '/app/voice?id=V1', 'not really audio')
  const b = await post(t, '/app/voice?id=V1', 'not really audio')
  expect(a.ok && b.ok).toBe(true)
  expect(await b.json()).toEqual(await a.json())
  expect((await post(t, '/app/photo?id=P1', 'jpeg')).ok).toBe(true)
  expect((await post(t, '/app/photo?id=P1', 'jpeg')).ok).toBe(true)
  await Bun.sleep(500)
  expect(t.delivered.filter(d => d.meta.message_id === 'V1').length).toBe(1)
  expect(t.delivered.filter(d => d.meta.message_id === 'P1').length).toBe(1)
}, 60000)

test('a message is in the journal by the time it is acked, before link previews and the front desk', async () => {
  const t = await twin()
  const p = await phone(t)
  p.send({ type: 'message', id: 'L1', text: 'look https://example.com/x' })
  expect(await p.until(f => f.type === 'ack' && f.id === 'L1', 1000)).toBeTruthy()
  expect(journal(t).some(e => e.message_id === 'L1')).toBe(true)
}, 60000)

test('a reply does not mark answered a message still waiting behind the turn', async () => {
  const t = await twin()
  const p = await phone(t)
  p.send({ type: 'message', id: 'R1', text: 'first' })
  await waitFor(() => t.delivered.find(d => d.meta.message_id === 'R1'))
  p.send({ type: 'message', id: 'R2', text: 'second' })
  await p.until(f => f.type === 'ack' && f.id === 'R2')
  // The session has read R1 (it is in the transcript), not R2, and replies.
  const dir = join(t.state, '..', '..', '.claude', 'projects', 'x')
  mkdirSync(dir, { recursive: true })
  const transcript = join(dir, 's.jsonl')
  writeFileSync(transcript, JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: '<channel source="plugin:otto:otto" chat_id="app" message_id="R1">first</channel>' } }) + '\n')
  await t.hook({ hook_event_name: 'PreToolUse', tool_name: 'reply', transcript_path: transcript })
  await t.call('reply', { chat_id: 'app', text: 'answer to first' })
  const j = journal(t)
  expect(j.find(e => e.message_id === 'R1').answered).toBe(true)
  expect(j.find(e => e.message_id === 'R2').answered).toBeFalsy()
  expect((await history(t)).find(h => h.id === 'R1')).toMatchObject({ read: true })
  expect((await history(t)).find(h => h.id === 'R2').read).toBeFalsy()
}, 60000)

test('every bubble of a reply is in history at once, so a restart mid-pacing loses none', async () => {
  const t = await twin()
  await t.call('reply', { chat_id: 'app', text: 'one\n\ntwo\n\nthree' })
  const texts = (await history(t)).filter(h => h.dir === 'out').map(h => h.text)
  expect(texts).toEqual(['one', 'two', 'three'])
}, 60000)

test('app job mentions are validated, delivered as ids, and retained in history after restart', async () => {
  let t = await twin()
  const p = await phone(t)
  writeFileSync(join(t.state, 'code-jobs.json'), JSON.stringify(['j61349d', 'j7389cc'].map(id => ({
    id, title: 'Fix it', brief: 'b', project: 'demo', agent: 'T3 Code', where: 'local',
    createdAt: new Date().toISOString(), tokenBudget: 1, steps: [],
  }))))
  p.send({ type: 'message', id: 'MENT1', text: 'how are these going', mentions: ['j61349d', 'j000000', 'j7389cc', 'j61349d', 1, { id: 'j7389cc' }, 'j61349d,j7389cc'] })
  expect(await p.until(f => f.type === 'ack' && f.id === 'MENT1')).toBeTruthy()
  expect(await waitFor(() => t.delivered.some(d => d.meta.message_id === 'MENT1'))).toBe(true)
  expect(t.delivered.find(d => d.meta.message_id === 'MENT1')!.meta.mentions).toBe('j61349d,j7389cc')
  expect((await history(t)).find(h => h.id === 'MENT1').mentions).toEqual(['j61349d', 'j7389cc'])
  for (const [id, mentions] of [['MENT2', ['j000000']], ['MENT3', 'j61349d'], ['MENT4', []], ['MENT5', undefined]] as const) {
    p.send({ type: 'message', id, text: 'plain message', mentions })
    expect(await p.until(f => f.type === 'ack' && f.id === id)).toBeTruthy()
    expect(await waitFor(() => t.delivered.some(d => d.meta.message_id === id))).toBe(true)
    expect(t.delivered.find(d => d.meta.message_id === id)!.meta.mentions).toBeUndefined()
    expect((await history(t)).find(h => h.id === id).mentions).toBeUndefined()
  }
  // A resend repairs missing history from the durable journal, preserving the validated ids.
  const historyFile = join(t.state, 'history.jsonl')
  const lines = readFileSync(historyFile, 'utf8').split('\n').filter(l => !l.includes('MENT1'))
  writeFileSync(historyFile, lines.join('\n'))
  t = await t.restart(); twins.push(t)
  const reconnected = await phone(t)
  reconnected.send({ type: 'message', id: 'MENT1', text: 'how are these going', mentions: ['j000000'] })
  expect(await reconnected.until(f => f.type === 'ack' && f.id === 'MENT1')).toBeTruthy()
  expect((await history(t)).find(h => h.id === 'MENT1').mentions).toEqual(['j61349d', 'j7389cc'])
  expect(journal(t).find(e => e.message_id === 'MENT1').meta.mentions).toBe('j61349d,j7389cc')
}, 60000)

test('a reply with job_id carries the job on its frame and its history row; one without has none', async () => {
  const t = await twin()
  writeFileSync(join(t.state, 'code-jobs.json'), JSON.stringify([{ id: 'jabc123', title: 'Fix it', brief: 'b', project: 'demo', agent: 'T3 Code', where: 'local', createdAt: new Date().toISOString(), tokenBudget: 1, steps: [] }]))
  const p = await phone(t)
  await t.call('reply', { chat_id: 'app', text: 'on it\n\nstarted', job_id: 'jabc123', verbatim: true })
  await t.call('reply', { chat_id: 'app', text: 'plain', verbatim: true })
  // The card rides on the last bubble, like buttons.
  expect(await p.until(f => f.type === 'message' && f.text === 'started')).toMatchObject({ job: 'jabc123', jobs: ['jabc123'] })
  expect((await p.until(f => f.type === 'message' && f.text === 'plain')).job).toBeUndefined()
  const h = (await history(t)).filter(r => r.dir === 'out')
  expect(h.map(r => [r.text, r.job])).toEqual([['on it', undefined], ['started', 'jabc123'], ['plain', undefined]])
  expect(h.map(r => r.jobs)).toEqual([undefined, ['jabc123'], undefined])
  // Unknown ids are dropped without losing the reply.
  const result = await t.call('reply', { chat_id: 'app', text: 'ghost', job_id: 'jnope00', verbatim: true })
  expect(JSON.stringify(result)).toContain('jobs dropped: jnope00')
  const ghost = await p.until(f => f.type === 'message' && f.text === 'ghost')
  expect(ghost.job).toBeUndefined()
  expect(ghost.jobs).toBeUndefined()
  expect((await history(t)).find(r => r.text === 'ghost').jobs).toBeUndefined()
}, 60000)

test('reply merges job_id and job_ids in order on the frame and persisted history', async () => {
  let t = await twin()
  const ids = ['jabc123', 'jdef456', 'jghi789', 'jkl0123', 'jmno456', 'jpqr789']
  writeFileSync(join(t.state, 'code-jobs.json'), JSON.stringify(ids.map(id => ({ id, title: 'Fix it', brief: 'b', project: 'demo', agent: 'T3 Code', where: 'local', createdAt: new Date().toISOString(), tokenBudget: 1, steps: [] }))))
  const p = await phone(t)
  const result = await t.call('reply', { chat_id: 'app', text: 'started together', job_id: ids[0], job_ids: [ids[1], ids[0], 'junknown', ids[2], ids[1]], verbatim: true })
  expect(JSON.stringify(result)).toContain('jobs dropped: junknown')
  const expected = { job: ids[0], jobs: ids.slice(0, 3) }
  expect(await p.until(f => f.type === 'message' && f.text === 'started together')).toMatchObject(expected)
  expect((await history(t)).find(r => r.text === 'started together')).toMatchObject(expected)
  await t.call('reply', { chat_id: 'app', text: 'all six', job_ids: ids, verbatim: true })
  expect(await p.until(f => f.type === 'message' && f.text === 'all six')).toMatchObject({ job: ids[0], jobs: ids })
  for (const job_ids of [[...ids, 'jextra'], 'jabc123', [123]]) {
    expect(await t.call('reply', { chat_id: 'app', text: 'invalid', job_ids, verbatim: true })).toMatchObject({ isError: true })
  }
  expect((await history(t)).some(r => r.text === 'invalid')).toBe(false)
  t = await t.restart(); twins.push(t)
  expect((await history(t)).find(r => r.text === 'started together')).toMatchObject(expected)
}, 60000)

test("the share sheet's one-shot socket doesn't take frames waiting for the app", async () => {
  // Replies wait in history (#99), so the app's catch-up is the delivery; the share socket isn't the app.
  const t = await twin()
  const share = await phone(t, '?share=1')
  await t.call('reply', { chat_id: 'app', text: 'waiting for you', verbatim: true })
  share.send({ type: 'message', id: 'S1', text: 'shared', shared: true })
  await share.until(f => f.type === 'ack' && f.id === 'S1')
  expect(share.got.some(f => f.type === 'message' && f.text === 'waiting for you')).toBe(false)
  share.close()
  expect((await history(t)).some(h => h.dir === 'out' && h.text === 'waiting for you')).toBe(true)
}, 60000)

test('history goes further back on request', async () => {
  const t = await twin()
  for (let i = 0; i < 60; i++) await post(t, `/app/photo?id=H${i}`, 'x')
  expect((await history(t)).length).toBe(50)
  expect((await history(t, '?limit=500')).length).toBe(60)
}, 60000)

test('a long reply caught up from history is whole, not cut at 1500 characters', async () => {
  const t = await twin()
  const long = 'word '.repeat(700).trim()
  await t.call('reply', { chat_id: 'app', text: long, verbatim: true })
  expect((await history(t)).find(h => h.dir === 'out').text).toBe(long)
}, 60000)

test('a tap gets a read receipt once the session has taken it in', async () => {
  const t = await twin()
  const p = await phone(t)
  p.send({ type: 'tap', op: 'TR1', data: 'tap read check', label: 'ok' })
  const ev = await waitFor(() => t.delivered.find(d => d.content.includes('tap read check')), 10000)
  expect(ev!.meta.message_id).toBe('TR1')
  const dir = join(t.state, '..', '..', '.claude', 'projects', 'x')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 't.jsonl'), JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: '<channel source="plugin:otto:otto" chat_id="app" message_id="TR1">ok</channel>' } }) + '\n')
  await t.hook({ hook_event_name: 'PreToolUse', tool_name: 'reply', transcript_path: join(dir, 't.jsonl') })
  expect(await p.until(f => f.type === 'read' && f.ids.includes('TR1'))).toBeTruthy()
}, 60000)

test('a Wallet payment queued offline on the phone is filed once, whichever way it arrives', async () => {
  const t = await twin()
  await post(t, '/app/ask', JSON.stringify({ id: 'W1', text: '', via: 'wallet', amount: '€4.20', merchant: 'Bar' }))
  const p = await phone(t)
  p.send({ type: 'wallet', op: 'W1', amount: '€4.20', merchant: 'Bar' })
  p.send({ type: 'wallet', op: 'W2', amount: '€9.00', merchant: 'Shop' })
  expect(await p.until(f => f.type === 'ack' && f.id === 'W2')).toBeTruthy()
  expect(await p.until(f => f.type === 'ack' && f.id === 'W1')).toBeTruthy()
  await Bun.sleep(300)
  expect(t.delivered.filter(d => d.meta.message_id === 'W1').length).toBe(1)
  expect(t.delivered.find(d => d.meta.message_id === 'W2')?.meta.wallet_merchant).toBe('Shop')
}, 60000)

test('read state survives a restart: an unread message is not reported read', async () => {
  let t = await twin()
  const p = await phone(t)
  p.send({ type: 'message', id: 'U1', text: 'still unread' })
  await p.until(f => f.type === 'ack' && f.id === 'U1')
  t = await t.restart(); twins.push(t)
  expect((await history(t)).find(h => h.id === 'U1').read).toBeFalsy()
}, 60000)

test('a tap is journaled before it is acked, so a restart before the session reads it replays it', async () => {
  const t = await twin()
  const p = await phone(t)
  p.send({ type: 'tap', op: 'TJ1', data: 'pay the bill', label: 'pay' })
  await p.until(f => f.type === 'ack' && f.id === 'TJ1')
  const e = journal(t).find(x => x.message_id === 'TJ1')
  expect(e).toMatchObject({ chat_id: 'app', read: false })
  expect(e.meta.event).toBe('button')
}, 60000)

test('a message the server cannot write down is neither acked nor handed over, so the phone keeps it', async () => {
  const t = await twin()
  const p = await phone(t)
  const { rmSync } = await import('fs')
  mkdirSync(join(t.state, 'inbound-journal.json.tmp'))   // the journal's atomic write now fails
  p.send({ type: 'message', id: 'F1', text: 'disk is full' })
  expect(await p.until(f => f.type === 'ack' && f.id === 'F1', 1500)).toBeUndefined()
  expect(t.delivered.some(d => d.meta.message_id === 'F1')).toBe(false)
  rmSync(join(t.state, 'inbound-journal.json.tmp'), { recursive: true })
  p.send({ type: 'message', id: 'F1', text: 'disk is full' })
  expect(await p.until(f => f.type === 'ack' && f.id === 'F1')).toBeTruthy()
  await Bun.sleep(300)
  expect(t.delivered.filter(d => d.meta.message_id === 'F1').length).toBe(1)
}, 60000)

test('after a restart, a reply before redelivery does not retire a message still waiting to be read', async () => {
  let t = await twin()
  const p = await phone(t)
  p.send({ type: 'message', id: 'Q1', text: 'queued behind a long turn' })
  await p.until(f => f.type === 'ack' && f.id === 'Q1')
  t = await t.restart(); twins.push(t)
  await t.call('reply', { chat_id: 'app', text: 'answer to something else' })
  expect(journal(t).find(e => e.message_id === 'Q1').answered).toBeFalsy()
}, 60000)

test('after a restart every unread message is replayed whole, even past a batch of ten', async () => {
  let t = await twin()
  const p = await phone(t)
  const long = 'start ' + 'x'.repeat(3000) + ' and the question at the very end?'
  p.send({ type: 'message', id: 'B0', text: long })
  for (let i = 1; i <= 11; i++) p.send({ type: 'message', id: `B${i}`, text: `queued ${i}` })
  expect(await waitFor(() => p.got.filter(f => f.type === 'ack').length === 12, 15000)).toBe(true)
  t = await t.restart(); twins.push(t)
  const all = await waitFor(() => t.delivered.filter(d => d.meta.redelivered === '1').length === 12, 20000)
  expect(all).toBe(true)
  expect(t.delivered.find(d => d.meta.message_id === 'B0')!.content).toBe(long)
}, 60000)

test('a tapback is journaled under its op before it is acked', async () => {
  const t = await twin()
  const p = await phone(t)
  p.send({ type: 'react', op: 'RX1', id: 'some-message', emoji: '👍' })
  await p.until(f => f.type === 'ack' && f.id === 'RX1')
  expect(journal(t).find(e => e.message_id === 'RX1')).toMatchObject({ text: '👍', read: false })
}, 60000)

test('a reminder that fired is replayed after a restart if the session never read it, and not after it did', async () => {
  let t = await twin()
  writeFileSync(join(t.state, 'triggers.json'), JSON.stringify([{ id: 'rem1', type: 'cron', schedule: new Date(Date.now() - 1000).toISOString(), action: 'remind them about the dentist', enabled: true, repeating: false, nextRun: Date.now() - 1000 }]))
  const fired = await waitFor(() => t.delivered.find(d => d.meta.event === 'trigger'), 70000)
  expect(fired).toBeTruthy()
  t = await t.restart(); twins.push(t)
  expect(await waitFor(() => t.delivered.find(d => d.meta.event === 'trigger' && d.meta.redelivered === '1'), 5000)).toBeTruthy()
  // Now it is read: a further restart leaves it alone.
  const dir = join(t.state, '..', '..', '.claude', 'projects', 'x')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'tr.jsonl'), JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: `<channel source="plugin:otto:otto" message_id="${fired!.meta.message_id}">reminder</channel>` } }) + '\n')
  await t.hook({ hook_event_name: 'Stop', transcript_path: join(dir, 'tr.jsonl') })
  t = await t.restart(); twins.push(t)
  await Bun.sleep(2000)
  expect(t.delivered.some(d => d.meta.event === 'trigger')).toBe(false)
}, 120000)

test('a voice upload retried while the first is still in progress reaches the session once', async () => {
  const t = await twin()
  const [a, b] = await Promise.all([post(t, '/app/voice?id=VV1&via=talk', 'audio'), post(t, '/app/voice?id=VV1&via=talk', 'audio')])
  expect(a.ok && b.ok).toBe(true)
  await Bun.sleep(300)
  const delivered = t.delivered.filter(d => d.meta.message_id === 'VV1')
  expect(delivered).toHaveLength(1)
  expect(delivered[0].meta.via).toBe('talk')
  expect(journal(t).find(e => e.message_id === 'VV1')?.meta.via).toBe('talk')
}, 60000)

test('a decision on an approval the server no longer has is acked as gone, every time it is asked', async () => {
  const t = await twin()
  const p = await phone(t)
  p.send({ type: 'approval', op: 'approval-X1', id: 'X1', decision: 'approve' })
  expect(await p.until(f => f.type === 'ack' && f.id === 'approval-X1')).toMatchObject({ gone: true })
  expect(await p.until(f => f.type === 'message' && /expired/.test(f.text))).toBeTruthy()
  p.got.length = 0
  p.send({ type: 'approval', op: 'approval-X1', id: 'X1', decision: 'approve' })
  expect(await p.until(f => f.type === 'ack' && f.id === 'approval-X1')).toMatchObject({ gone: true })
  expect((await history(t)).some(h => /expired/.test(h.text))).toBe(true)   // in history, for a closed phone
}, 60000)

test('a resend is recognised from the journal even when the dedupe file could not be written', async () => {
  let t = await twin()
  const p = await phone(t)
  mkdirSync(join(t.state, 'app-ops.json.tmp'))   // app-ops.json writes now fail
  p.send({ type: 'tap', op: 'J1', data: 'send the email', label: 'send ✓' })
  await p.until(f => f.type === 'ack' && f.id === 'J1')
  t = await t.restart(); twins.push(t)
  const q = await phone(t)
  q.send({ type: 'tap', op: 'J1', data: 'send the email', label: 'send ✓' })
  expect(await q.until(f => f.type === 'ack' && f.id === 'J1')).toBeTruthy()
  await Bun.sleep(500)
  expect(t.delivered.filter(d => d.content.includes('send the email') && d.meta.redelivered !== '1').length).toBe(0)
}, 60000)

test('history: ?since= reaches back past 500, a tap shows with its op and read state, long replies are whole', async () => {
  const t = await twin()
  const p = await phone(t)
  const long = 'y'.repeat(9000)
  await t.call('reply', { chat_id: 'app', text: long, verbatim: true })
  p.send({ type: 'tap', op: 'HT1', data: 'tap in history', label: 'yes' })
  await p.until(f => f.type === 'ack' && f.id === 'HT1')
  const since = new Date(Date.now() - 60_000).toISOString()
  const rows = await history(t, `?since=${encodeURIComponent(since)}`)
  expect(rows.find(h => h.dir === 'out')!.text.length).toBe(9000)
  expect(rows.find(h => h.id === 'HT1')).toMatchObject({ dir: 'in', text: 'yes' })
  expect(rows.find(h => h.id === 'HT1').read).toBeFalsy()
  expect((await history(t, `?since=${encodeURIComponent(new Date().toISOString())}`)).length).toBe(0)
}, 60000)

const hook = (t: Twin, body: unknown, headers: Record<string, string> = {}) => fetch(`${t.url}/`, {
  method: 'POST', headers: { authorization: 'Bearer twin-webhook-token', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
})

test('a webhook is journaled before its 2xx, and a 503 when it cannot be', async () => {
  const t = await twin()
  expect((await hook(t, { text: 'build failed on main', source: 'ci' })).status).toBe(204)
  expect(journal(t).find(e => e.chat_id === 'webhook')).toMatchObject({ read: false })
  mkdirSync(join(t.state, 'inbound-journal.json.tmp'))
  expect((await hook(t, { text: 'second one', source: 'ci' })).status).toBe(503)
}, 60000)

test('a recurring trigger run is journaled until the session reads it', async () => {
  const t = await twin()
  writeFileSync(join(t.state, 'triggers.json'), JSON.stringify([{ id: 'daily1', type: 'cron', schedule: '* * * * *', action: 'the daily check', enabled: true, repeating: true, nextRun: Date.now() - 1000 }]))
  expect(await waitFor(() => t.delivered.find(d => d.meta.event === 'trigger'), 70000)).toBeTruthy()
  expect(journal(t).find(e => e.chat_id === 'trigger' && e.meta.trigger_id === 'daily1')).toMatchObject({ read: false })
}, 90000)

test('the hook endpoints refuse anything forwarded in from outside, even over loopback', async () => {
  const t = await twin()
  const r = await fetch(`${t.url}/status`, { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9', 'content-type': 'application/json' }, body: '{}' })
  expect(r.status).toBe(403)
  const u = await fetch(`${t.url}/plan-usage`, { method: 'POST', headers: { 'x-forwarded-host': 'example.ts.net', 'content-type': 'application/json' }, body: '{}' })
  expect(u.status).toBe(403)
}, 60000)

test('an edit or tapback on a message older than the page still reaches the phone', async () => {
  const t = await twin()
  await t.call('reply', { chat_id: 'app', text: 'old line to fix', verbatim: true })
  let old: any
  for (let i = 0; i < 50 && !old; i++) { old = (await history(t).catch(() => [])).find(h => h.text === 'old line to fix'); if (!old) await Bun.sleep(100) }
  for (let i = 0; i < 55; i++) await t.call('reply', { chat_id: 'app', text: `filler ${i}`, verbatim: true })
  await t.call('edit_message', { chat_id: 'app', message_id: old.id, text: 'old line, fixed' })
  await t.call('react', { chat_id: 'app', message_id: old.id, emoji: '👍' })
  const rows = await history(t)
  expect(rows.find(h => h.id === old.id && h.kind === 'edit')?.text).toBe('old line, fixed')
  expect(rows.find(h => h.id === old.id && h.kind === 'reaction')?.reaction).toBe('👍')
}, 60000)

test('delete_message takes back an app bubble live and in history, and refuses the user\'s messages and WhatsApp', async () => {
  const t = await twin()
  await t.call('reply', { chat_id: 'app', text: 'stale status line', verbatim: true })
  let mine: any
  for (let i = 0; i < 50 && !mine; i++) { mine = (await history(t).catch(() => [])).find(h => h.text === 'stale status line'); if (!mine) await Bun.sleep(100) }
  const p = await phone(t)
  expect(JSON.stringify(await t.call('delete_message', { chat_id: 'app', message_id: mine.id }))).toContain('deleted')
  expect(await p.until(f => f.type === 'delete')).toEqual({ type: 'delete', id: mine.id })
  const r = await fetch(`${t.url}/app/history`, { headers: { authorization: `Bearer ${t.token}` } })
  expect(r.headers.get('X-Otto-Deleted')).toBe(mine.id)
  expect((await r.json() as any[]).some(h => h.id === mine.id)).toBe(false)
  expect(readFileSync(join(t.state, 'history.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(e => e.kind === 'delete')).toMatchObject({ dir: 'out', chat_id: 'app', message_id: mine.id })

  p.send({ type: 'message', id: 'U-DEL', text: 'my own words' })
  for (let i = 0; i < 50 && !(await history(t)).some(h => h.id === 'U-DEL'); i++) await Bun.sleep(100)
  expect(JSON.stringify(await t.call('delete_message', { chat_id: 'app', message_id: 'U-DEL' }))).toMatch(/user's message.*burn/)
  expect(JSON.stringify(await t.call('delete_message', { chat_id: 'whatsapp', message_id: 'w1' }))).toMatch(/WhatsApp messages cannot be deleted/)
  p.close()
}, 60000)

test('update_trigger: moving to cron makes it recurring, and a past time is refused', async () => {
  const t = await twin()
  const made: any = await t.call('create_trigger', { type: 'cron', schedule: new Date(Date.now() + 3_600_000).toISOString(), action: 'stand up' })
  const id = JSON.stringify(made).match(/\[?([a-f0-9]{6,})\]?/)![1]
  await t.call('update_trigger', { id, schedule: '0 9 * * 1-5' })
  const trig = JSON.parse(readFileSync(join(t.state, 'triggers.json'), 'utf8')).find((x: any) => x.id === id)
  expect(trig.repeating).toBe(true)
  const past: any = await t.call('update_trigger', { id, schedule: new Date(Date.now() - 3_600_000).toISOString() })
  expect(JSON.stringify(past)).toMatch(/already in the past/)
}, 60000)

test('a channel tap cut off mid-run (journaled "running") runs on its resend, and once done is never run again', async () => {
  let t = await twin()
  // As a crash would leave it: written down as running, never finished.
  writeFileSync(join(t.state, 'inbound-journal.json'), JSON.stringify([{ chat_id: 'app', message_id: 'CR1', text: 'run me', ts: new Date().toISOString(),
    meta: { chat_id: 'app', event: 'button', channel: 'running' }, read: true, redelivered: true }]))
  t = await t.restart(); twins.push(t)
  const p = await phone(t)
  p.send({ type: 'tap', op: 'CR1', data: 'run me', label: 'go' })
  expect(await p.until(f => f.type === 'ack' && f.id === 'CR1')).toBeTruthy()
  expect(await waitFor(() => t.delivered.find(d => d.content.includes('run me')))).toBeTruthy()
  p.send({ type: 'tap', op: 'CR1', data: 'run me', label: 'go' })
  await waitFor(() => p.got.filter(f => f.type === 'ack' && f.id === 'CR1').length === 2)
  await Bun.sleep(300)
  expect(t.delivered.filter(d => d.content.includes('run me')).length).toBe(1)
}, 60000)

test('a trigger occurrence already in the journal is not fired again from the schedule', async () => {
  let t = await twin()
  const due = Date.now() - 1000
  writeFileSync(join(t.state, 'triggers.json'), JSON.stringify([{ id: 'occ1', type: 'cron', schedule: new Date(due).toISOString(), action: 'only once', enabled: true, repeating: false, nextRun: due }]))
  // As a crash after the journal write and before the schedule save would leave it (and already read).
  writeFileSync(join(t.state, 'inbound-journal.json'), JSON.stringify([{ chat_id: 'trigger', message_id: `trigger-occ1-${due}`, text: 'only once', ts: new Date().toISOString(),
    meta: { event: 'trigger', trigger_id: 'occ1' }, read: true, answered: true }]))
  t = await t.restart(); twins.push(t)
  await waitFor(() => !JSON.parse(readFileSync(join(t.state, 'triggers.json'), 'utf8'))[0].enabled, 70000)
  expect(JSON.parse(readFileSync(join(t.state, 'triggers.json'), 'utf8'))[0].enabled).toBe(false)   // the tick did reach it
  expect(t.delivered.some(d => d.meta.event === 'trigger')).toBe(false)
}, 90000)

test('update_trigger: a new schedule on a reminder that already fired switches it back on', async () => {
  const t = await twin()
  writeFileSync(join(t.state, 'triggers.json'), JSON.stringify([{ id: 'fired1', type: 'cron', action: 'call mum', enabled: false, repeating: false, lastFired: new Date().toISOString() }]))
  await t.call('update_trigger', { id: 'fired1', schedule: new Date(Date.now() + 3_600_000).toISOString() })
  expect(JSON.parse(readFileSync(join(t.state, 'triggers.json'), 'utf8'))[0].enabled).toBe(true)
}, 60000)

test('a reply carrying a file is refused, not sent, when the file link cannot be written down', async () => {
  const t = await twin()
  const f = join(t.state, '..', 'note.txt'); writeFileSync(f, 'hello')
  mkdirSync(join(t.state, 'app-files.json.tmp'))
  const r: any = await t.call('reply', { chat_id: 'app', text: 'here it is', files: [f] })
  expect(JSON.stringify(r)).toMatch(/couldn't record the file/)
  expect((await history(t)).some(h => h.text === 'here it is')).toBe(false)
}, 60000)

test('a reply after a line some earlier failure left unfinished is still in history', async () => {
  const t = await twin()
  const { appendFileSync } = await import('fs')
  appendFileSync(join(t.state, 'history.jsonl'), '{"ts":"2026-01-01T00:00:00.000Z","dir":"out","chat_id":"app","kind":"text","text":"cut of')
  await t.call('reply', { chat_id: 'app', text: 'after the cut line', verbatim: true })
  expect((await history(t)).some(h => h.text === 'after the cut line')).toBe(true)
}, 60000)

test('a share whose history row could not be written is not acked; its resend writes the row, then acks', async () => {
  const t = await twin()
  const p = await phone(t)
  const { rmSync, renameSync, existsSync } = await import('fs')
  const hist = join(t.state, 'history.jsonl')
  if (existsSync(hist)) renameSync(hist, hist + '.bak')
  mkdirSync(hist)   // history appends now fail
  p.send({ type: 'message', id: 'SH1', text: 'shared link', shared: true })
  expect(await p.until(f => f.type === 'ack' && f.id === 'SH1', 2000)).toBeUndefined()
  expect(journal(t).some(e => e.message_id === 'SH1')).toBe(true)
  rmSync(hist, { recursive: true })
  p.send({ type: 'message', id: 'SH1', text: 'shared link', shared: true })
  expect(await p.until(f => f.type === 'ack' && f.id === 'SH1')).toBeTruthy()
  expect((await history(t)).find(h => h.id === 'SH1')).toMatchObject({ dir: 'in', text: 'shared link', shared: true })
  await Bun.sleep(300)
  expect(t.delivered.filter(d => d.meta.message_id === 'SH1').length).toBe(1)
}, 60000)

test('an unread message past 48 h is named and stays unread, even when a new arrival prunes first', async () => {
  let t = await twin()
  const old = new Date(Date.now() - 49 * 3_600_000).toISOString()
  writeFileSync(join(t.state, 'inbound-journal.json'), JSON.stringify([{ chat_id: 'app', message_id: 'OLD1', text: 'from two days ago', ts: old, meta: { chat_id: 'app' }, read: false }]))
  const { appendFileSync } = await import('fs')
  appendFileSync(join(t.state, 'history.jsonl'), JSON.stringify({ ts: old, dir: 'in', chat_id: 'app', message_id: 'OLD1', kind: 'text', text: 'from two days ago' }) + '\n')
  t = await t.restart(); twins.push(t)
  const p = await phone(t)
  p.send({ type: 'message', id: 'NEW1', text: 'a new one' })   // its journal write prunes
  await p.until(f => f.type === 'ack' && f.id === 'NEW1')
  let named = false
  for (let i = 0; i < 100 && !named; i++) { named = (await history(t)).some(h => /lost track of/.test(h.text)); if (!named) await Bun.sleep(100) }
  expect(named).toBe(true)
  expect((await history(t)).find(h => h.id === 'OLD1').read).toBeFalsy()
}, 60000)

test('a message given up on stays unread in history after two thousand more ops', async () => {
  let t = await twin()
  const old = new Date(Date.now() - 47.5 * 3_600_000).toISOString()
  writeFileSync(join(t.state, 'inbound-journal.json'), JSON.stringify([{ chat_id: 'app', message_id: 'GONE1', text: 'never read', ts: old, meta: { chat_id: 'app' }, read: false }]))
  const { appendFileSync } = await import('fs')
  appendFileSync(join(t.state, 'history.jsonl'), JSON.stringify({ ts: old, dir: 'in', chat_id: 'app', message_id: 'GONE1', kind: 'text', text: 'never read' }) + '\n')
  t = await t.restart(); twins.push(t)
  let named = false
  for (let i = 0; i < 100 && !named; i++) { named = (await history(t)).some(h => /lost track of/.test(h.text)); if (!named) await Bun.sleep(100) }
  expect(named).toBe(true)
  // Two thousand ops later (as weeks of use would leave app-ops), with the journal entry pruned.
  writeFileSync(join(t.state, 'app-ops.json'), JSON.stringify(Array.from({ length: 2000 }, (_, i) => `op${i}`)))
  writeFileSync(join(t.state, 'inbound-journal.json'), '[]')
  t = await t.restart(); twins.push(t)
  expect((await history(t, '?limit=500')).find(h => h.id === 'GONE1').read).toBeFalsy()
}, 90000)

test('a give-up notice already in history is not said again while its tombstone write keeps failing', async () => {
  let t = await twin()
  const old = new Date(Date.now() - 47.5 * 3_600_000).toISOString()
  writeFileSync(join(t.state, 'inbound-journal.json'), JSON.stringify([{ chat_id: 'app', message_id: 'TOMB1', text: 'never read', ts: old, meta: { chat_id: 'app' }, read: false }]))
  mkdirSync(join(t.state, 'app-unread.json.tmp'))   // the tombstone write now fails
  t = await t.restart(); twins.push(t)
  let rows: any[] = []
  for (let i = 0; i < 100 && !rows.length; i++) { rows = (await history(t)).filter(h => /lost track of/.test(h.text)); if (!rows.length) await Bun.sleep(100) }
  expect(rows.length).toBe(1)
  t = await t.restart(); twins.push(t)   // the next pass, still unable to write the tombstone
  await Bun.sleep(2000)
  expect((await history(t)).filter(h => /lost track of/.test(h.text)).length).toBe(1)
  expect(journal(t).find(e => e.message_id === 'TOMB1').abandoned).toBeFalsy()   // retried, not marked
}, 90000)

test('wallet is saved and reacted to on arrival, and the session sees it already recorded', async () => {
  const t = await twin()
  const p = await phone(t)
  p.send({ type: 'wallet', op: 'wallet-1', amount: '€12,50', merchant: 'Example shop', card: 'Example card' })
  expect(await p.until(f => f.type === 'react' && f.id === 'wallet-1', 2000)).toMatchObject({ emoji: '👍' })
  const money = () => JSON.parse(readFileSync(join(t.state, 'money.json'), 'utf8'))
  expect(money()).toMatchObject([{ amount: 12.5, currency: 'EUR', source: 'wallet:wallet-1' }])
  await waitFor(() => t.delivered.find(d => d.meta.message_id === 'wallet-1'))
  expect(t.delivered.find(d => d.meta.message_id === 'wallet-1')?.meta.wallet_recorded).toBe('1')
  p.send({ type: 'wallet', op: 'wallet-1', amount: '€12,50', merchant: 'Example shop' })
  await p.until(f => f.type === 'ack' && f.id === 'wallet-1')
  expect(money()).toHaveLength(1)
}, 60000)

test('app inbound from any device carries the shared route and no per-device tag', async () => {
  const t = await twin()
  const made = Bun.spawnSync(['bun', join(import.meta.dir, '..', 'apptokens.ts'), 'new', 'test-desktop'], {
    env: { ...process.env, OTTO_STATE_DIR: t.state },
  })
  const token = String(made.stdout).match(/[A-Za-z0-9_-]{24,}/)?.[0]
  expect(token).toBeTruthy()
  for (const desktop of [false, true]) {
    const device = desktop ? { ...t, token: token! } : t
    const p = await phone(device)
    if (desktop) p.send({ type: 'presence', focused: false })
    const prefix = desktop ? 'desktop' : 'phone'
    p.send({ type: 'message', id: `${prefix}-text`, text: prefix })
    p.send({ type: 'react', op: `${prefix}-react`, id: 'target', emoji: '👍' })
    p.send({ type: 'wallet', op: `${prefix}-wallet`, amount: '4.56' })
    p.send({ type: 'tap', op: `${prefix}-tap`, data: 'test device attribution', label: 'test' })
    expect((await post(device, `/app/photo?id=${prefix}-photo`, 'jpeg')).ok).toBe(true)
    expect((await post(device, `/app/voice?id=${prefix}-voice`, 'audio')).ok).toBe(true)
    // Wallet asks return immediately rather than waiting for a conversational reply.
    const ask = await post(device, '/app/ask', JSON.stringify({ id: `${prefix}-ask`, amount: '12.34', via: 'wallet' }))
    expect(ask.ok).toBe(true)
    for (const kind of ['text', 'react', 'tap', 'photo', 'voice', 'ask', 'wallet']) {
      const id = `${prefix}-${kind}`
      await waitFor(() => t.delivered.find(d => d.meta.message_id === id))
      const meta = t.delivered.find(d => d.meta.message_id === id)?.meta
      expect(meta).toMatchObject({ chat_id: 'app' })
      // No per-device tag on this install; user and user_id only repeated chat_id.
      expect(meta).not.toHaveProperty('device')
      expect(meta).not.toHaveProperty('user')
      expect(meta).not.toHaveProperty('user_id')
    }
  }
}, 60000)

test('restart reconciles a mid-turn receipt without a hook and still replays a queued message', async () => {
  let t = await twin()
  const p = await phone(t)
  p.send({ type: 'message', id: 'seen-before-restart', text: 'first' })
  p.send({ type: 'message', id: 'lost-before-restart', text: 'second' })
  await p.until(f => f.type === 'ack' && f.id === 'lost-before-restart')
  const dir = join(t.state, '..', '..', '.claude', 'projects', 'x')
  mkdirSync(dir, { recursive: true })
  const seen = '<channel source="plugin:otto:otto" message_id="seen-before-restart">first</channel>'
  const lost = '<channel source="plugin:otto:otto" message_id="lost-before-restart">second</channel>'
  writeFileSync(join(dir, 'receipt.jsonl'), [
    { type: 'attachment', attachment: { type: 'queued_command', prompt: seen } },
    { type: 'queue-operation', operation: 'enqueue', content: lost },
  ].map(r => JSON.stringify(r)).join('\n') + '\n')
  t = await t.restart(); twins.push(t)
  expect(await waitFor(() => t.delivered.some(d => d.meta.message_id === 'lost-before-restart'), 5000)).toBe(true)
  expect(t.delivered.some(d => d.meta.message_id === 'seen-before-restart')).toBe(false)
  expect(journal(t).find(e => e.message_id === 'seen-before-restart').read).toBe(true)
}, 60000)

test('reacting to an unread-marked message prevents its replay after restart', async () => {
  let t = await twin()
  const p = await phone(t)
  p.send({ type: 'message', id: 'reaction-handled', text: 'thanks' })
  await p.until(f => f.type === 'ack' && f.id === 'reaction-handled')
  await t.call('react', { chat_id: 'app', message_id: 'reaction-handled', emoji: '👍' })
  expect(journal(t).find(e => e.message_id === 'reaction-handled').answered).toBe(true)
  t = await t.restart(); twins.push(t)
  await Bun.sleep(1000)
  expect(t.delivered.some(d => d.meta.message_id === 'reaction-handled')).toBe(false)
}, 60000)

test('a reply keeps the steps that led to it, and history serves them to a device that was not watching', async () => {
  const t = await twin()
  const p = await phone(t)
  p.send({ type: 'message', id: 'steps-1', text: 'look into it' })
  await waitFor(() => t.delivered.length === 1)
  const tool = (description: string, agent?: string) => t.hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'true', description }, ...(agent ? { agent_id: agent, agent_type: 'Explore' } : {}) })
  await tool('Reading the logs')
  const key = ['sk', 'ant', 'api03', 'x'.repeat(40)].join('-')   // built here so no key-shaped literal sits in the repo
  await tool(`Searching with key ${key}`, 'sub1')
  await p.until(f => f.type === 'steps' && f.steps.length === 2)
  await t.call('reply', { chat_id: 'app', text: 'first part\n\nsecond part', verbatim: true })
  await tool('Checking once more')
  await t.call('reply', { chat_id: 'app', text: 'and done', verbatim: true })
  await t.call('reply', { chat_id: 'app', text: 'nothing happened before this one', verbatim: true })

  const rows = (await history(t)).filter(h => h.dir === 'out')
  const by = (text: string) => rows.find(h => h.text === text)
  expect(by('first part').steps).toEqual([
    { label: expect.any(String), ts: expect.any(String) },
    { label: expect.any(String), ts: expect.any(String), subagent: { id: 'sub1', label: 'Explore' } },
  ])
  expect(by('second part').steps).toBeUndefined()   // one reply, one list: on its first bubble
  expect(by('and done').steps).toHaveLength(1)
  expect(by('nothing happened before this one').steps).toBeUndefined()
  expect(JSON.stringify(rows)).not.toContain(key)
  expect(JSON.stringify(rows)).not.toContain('x'.repeat(40))   // what reaches disk is redacted
  // A phone that was never connected reads the same rows after a restart.
  const again = await t.restart(); twins.push(again)
  expect((await history(again)).find(h => h.text === 'first part').steps).toHaveLength(2)
}, 60000)

for (const device of ['phone', 'desktop']) for (const input of ['message', 'tap', 'synced', 'card']) {
  test(`${device} ${input} turns show typing and tool status until Stop`, async () => {
    const t = await twin()
    const p = await phone(t)
    if (device === 'desktop') p.send({ type: 'presence', focused: false })
    await p.until(f => f.type === 'typing')
    if (input === 'card') await t.call('remember', { kind: 'reference', name: 'test-note', description: 'a test note', text: 'Check it.' })
    await t.call('reply', { chat_id: 'app', text: 'choose an action', verbatim: true,
      buttons: [{ label: 'go', data: 'perform this action' }],
    })
    const message = (await history(t)).find(h => h.dir === 'out')
    const recorded = message.recorded?.find((c: any) => c.action)
    if (input === 'card') expect(recorded).toBeTruthy()
    p.got.length = 0
    const id = `status-${device}-${input}`
    p.send(input === 'message' ? { type: 'message', id, text: 'perform this action' }
      : { type: 'tap', op: id, label: 'go', data: input === 'card' ? recorded.action.data : 'perform this action',
          ...(input === 'synced' || input === 'card' ? { id: message.id } : {}),
          ...(input === 'card' ? { card: recorded.id } : {}) })
    expect(await waitFor(() => t.delivered.find(d => d.meta.message_id === id))).toBeTruthy()
    expect(await p.until(f => f.type === 'typing' && f.on, 1000)).toBeTruthy()
    const dir = join(t.state, '..', '..', '.claude', 'projects', 'status')
    mkdirSync(dir, { recursive: true })
    const transcript = join(dir, 'transcript.jsonl')
    writeFileSync(transcript, JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command',
      prompt: `<channel source="plugin:otto:otto" chat_id="app" message_id="${id}">go</channel>` } }) + '\n')
    const tool = () => t.hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'true', description: 'Check the result' }, transcript_path: transcript })
    await tool()
    expect(await p.until(f => f.type === 'status')).toEqual({ type: 'status', text: 'Checking the result' })
    expect(await p.until(f => f.type === 'steps' && !f.done)).toMatchObject({ steps: [{ label: 'Checking the result', ts: expect.any(String) }] })
    await t.call('reply', { chat_id: 'app', text: 'done', verbatim: true })
    await t.hook({ hook_event_name: 'Stop', transcript_path: transcript })
    expect(await p.until(f => f.type === 'typing' && !f.on)).toBeTruthy()
    expect(await p.until(f => f.type === 'steps' && f.done)).toBeTruthy()
    p.got.length = 0
    await tool()
    await Bun.sleep(100)
    expect(p.got.filter(f => ['status', 'steps', 'typing'].includes(f.type))).toEqual([])
  }, 60000)
}
