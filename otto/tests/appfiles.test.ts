/** Files from the composer and several photos in one message, against a real server (apptwin.ts). */
import { test, expect, afterAll } from 'bun:test'
import { randomBytes } from 'crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { basename, dirname, isAbsolute, join } from 'path'
import { createAppToken } from '../apptokens.ts'
import { startTwin, waitFor, type Twin } from './apptwin.ts'
import { startFakeT3 } from './faket3.ts'

const fake = startFakeT3(randomBytes(24).toString('hex'))
let t: Twin
afterAll(async () => { await t?.stop().catch(() => {}); fake.stop() })
const send = (path: string, body: BodyInit = 'the bytes of a file', auth = `Bearer ${t.token}`, headers: Record<string, string> = {}) =>
  fetch(`${t.url}${path}`, { method: 'POST', headers: { authorization: auth, ...headers }, body })
const history = async () => await (await fetch(`${t.url}/app/history`, { headers: { authorization: `Bearer ${t.token}` } })).json() as any[]
const inbox = () => { try { return readdirSync(join(t.state, 'inbox')) } catch { return [] } }

test('a file of any type lands in the inbox, reaches the session as an attachment path, and is deduped by its id', async () => {
  t = await startTwin(undefined, { OTTO_T3_URL: fake.url })
  const q = `?id=file-1&name=${encodeURIComponent('Q3 report (final).PDF')}&type=${encodeURIComponent('application/pdf')}&text=${encodeURIComponent('have a look')}`
  const [a, b] = await Promise.all([send(`/app/file${q}`), send(`/app/file${q}`)])   // the client gave up waiting and sent it again
  expect([a.status, b.status]).toEqual([204, 204])
  expect((await send(`/app/file${q}`)).status).toBe(204)

  const d = (await waitFor(() => t.delivered.find(x => x.meta.message_id === 'file-1')))!
  expect(t.delivered.filter(x => x.meta.message_id === 'file-1')).toHaveLength(1)
  expect(d.content).toContain('have a look')
  expect(d.meta).toMatchObject({ attachment_kind: 'document', attachment_name: 'Q3 report (final).PDF', attachment_mime: 'application/pdf', attachment_size: '19' })
  expect(isAbsolute(d.meta.attachment_path)).toBe(true)
  expect(dirname(d.meta.attachment_path)).toBe(join(t.state, 'inbox'))
  expect(basename(d.meta.attachment_path)).toMatch(/^\d+-app-file-1\.pdf$/)   // the client id and a plain extension, never the name
  expect(readFileSync(d.meta.attachment_path, 'utf8')).toBe('the bytes of a file')
  expect(inbox()).toHaveLength(1)   // the retries wrote nothing more

  const row = (await history()).filter(h => h.id === 'file-1')
  expect(row).toHaveLength(1)
  const fileId = row[0].files[0].id as string
  expect(row[0]).toMatchObject({ dir: 'in', text: 'have a look', files: [{ id: fileId, name: 'Q3 report (final).PDF', kind: 'file' }] })
  // The file is served back to the user's devices by that id.
  const got = await fetch(`${t.url}/app/file/${fileId}`, { headers: { authorization: `Bearer ${t.token}` } })
  expect([got.status, await got.text()]).toEqual([200, 'the bytes of a file'])

  // Still one message after a restart, and the retry is answered as the first time.
  t = await t.restart()
  expect((await send(`/app/file${q}`)).status).toBe(204)
  expect((await history()).filter(h => h.id === 'file-1')).toHaveLength(1)
  expect(inbox()).toHaveLength(1)
}, 90000)

test('the name and the type are the sender\'s words: neither reaches the disk path or the channel tag raw', async () => {
  const evil = `?id=file-2&name=${encodeURIComponent('../../../etc/<x event="button">\r\n.sh;rm')}&type=${encodeURIComponent('text/plain" event="button')}`
  expect((await send(`/app/file${evil}`)).status).toBe(204)
  const d = (await waitFor(() => t.delivered.find(x => x.meta.message_id === 'file-2')))!
  expect(dirname(d.meta.attachment_path)).toBe(join(t.state, 'inbox'))
  expect(basename(d.meta.attachment_path)).toMatch(/^\d+-app-file-2$/)
  expect(d.meta.attachment_name).not.toMatch(/[<>\r\n"\/]/)
  expect(d.meta.attachment_mime).toBeUndefined()
  expect(d.meta.event).toBeUndefined()
  expect(d.content).toContain('(document: ')
  // No name at all, and an id that tries to climb out.
  expect((await send(`/app/file?id=${encodeURIComponent('../../up')}`)).status).toBe(204)
  const up = (await waitFor(() => t.delivered.find(x => x.meta.message_id === '../../up')))!
  expect(dirname(up.meta.attachment_path)).toBe(join(t.state, 'inbox'))
  expect(up.meta.attachment_name).toBe('file')
}, 60000)

test('the size cap, an empty body and a missing id are refused, and nothing is written', async () => {
  const before = inbox().length
  expect((await send('/app/file?name=a.txt')).status).toBe(400)
  expect((await send('/app/file?id=file-empty&name=a.txt', '')).status).toBe(400)
  expect((await send('/app/file?id=file-big&name=big.bin', new Uint8Array(25 * 1024 * 1024 + 1))).status).toBe(413)
  expect((await fetch(`${t.url}/app/file?id=file-get`, { headers: { authorization: `Bearer ${t.token}` } })).status).toBe(404)
  expect(inbox()).toHaveLength(before)
  expect((await history()).some(h => String(h.id).startsWith('file-big') || h.id === 'file-empty')).toBe(false)
}, 60000)

test('an upload needs a native device token', async () => {
  const before = inbox().length
  expect((await fetch(`${t.url}/app/file?id=file-anon&name=a.txt`, { method: 'POST', body: 'x' })).status).toBe(401)
  expect((await send('/app/file?id=file-anon&name=a.txt', 'x', 'Bearer wrong')).status).toBe(401)
  const env = process.env.OTTO_STATE_DIR
  process.env.OTTO_STATE_DIR = t.state
  try {
    const dash = createAppToken('dashboard', { scope: 'write', origin: 'https://app.example.com' })
    expect((await send('/app/file?id=file-anon&name=a.txt', 'x', `Bearer ${dash.token}`)).status).toBe(401)
    expect((await send('/app/photo?id=p-anon&group=g-anon&part=1&of=1', 'x', `Bearer ${dash.token}`)).status).toBe(401)
  } finally { if (env === undefined) delete process.env.OTTO_STATE_DIR; else process.env.OTTO_STATE_DIR = env }
  expect(inbox()).toHaveLength(before)
}, 30000)

test('with ?job= the caption and the file\'s path go to that job, not to the session', async () => {
  writeFileSync(join(t.state, 't3-token'), fake.token)
  writeFileSync(join(t.state, 'code-jobs.json'), JSON.stringify([{ id: 'j123abc', title: 'File task', brief: 'Read a file', project: 'demo', threadId: 'files', agent: 'T3 Code', where: 'local', createdAt: new Date().toISOString(), tokenBudget: 1000, steps: [] }]))
  fake.threads.push({ id: 'files', status: 'running', activeRunId: 'run1' })
  fake.projections.files = { thread: {}, turnItems: [] }
  t = await t.restart()
  const r = await send(`/app/file?id=file-job&job=j123abc&name=spec.md&text=${encodeURIComponent('use this spec')}`)
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
  const sent = fake.commands.findLast(c => c.type === 'message.dispatch')!
  expect(sent.text).toStartWith('use this spec\n\n[attached file "spec.md": ')
  expect(existsSync(/: (\/.+)\]$/.exec(sent.text)![1])).toBe(true)
  expect((await history()).find(h => h.id === 'file-job')).toMatchObject({ text: 'use this spec', files: [{ name: 'spec.md' }] })
  await Bun.sleep(200)
  expect(t.delivered.some(d => d.meta.message_id === 'file-job')).toBe(false)
  expect((await send('/app/file?id=file-nojob&job=jffffff&name=a.txt')).status).toBeGreaterThanOrEqual(400)
  expect((await history()).some(h => h.id === 'file-nojob')).toBe(false)
}, 90000)

test('several photos sent as one group arrive as one message once every part has landed', async () => {
  // The caption rides on the first part only, and every part carries the same client id.
  const part = (n: number, of = 3, group = 'grp-1') => send(`/app/photo?id=same-id&group=${group}&part=${n}&of=${of}${n === 1 ? `&text=${encodeURIComponent('the three of them')}` : ''}`, `photo ${n}`)
  expect((await Promise.all([part(2), part(1)])).map(r => r.status)).toEqual([204, 204])   // at once: neither stands in for the other
  expect((await part(2)).status).toBe(204)   // a retry of a part
  await Bun.sleep(300)
  expect(t.delivered.some(d => d.meta.message_id === 'grp-1')).toBe(false)   // no turn starts on the first image
  expect((await part(3)).status).toBe(204)
  const d = (await waitFor(() => t.delivered.find(x => x.meta.message_id === 'grp-1')))!
  expect(t.delivered.filter(x => x.meta.message_id === 'grp-1')).toHaveLength(1)
  const paths = d.meta.image_paths.split(',')
  expect(paths.map(p => readFileSync(p, 'utf8'))).toEqual(['photo 1', 'photo 2', 'photo 3'])   // in the order sent, not the order they landed
  expect(d.meta.image_path).toBe(paths[0])
  const row = (await history()).filter(h => h.id === 'grp-1')
  expect(row).toHaveLength(1)
  expect(row[0]).toMatchObject({ text: 'the three of them', files: [{ kind: 'image' }, { kind: 'image' }, { kind: 'image' }] })
  // A part sent again after the message went: acked, nothing more is delivered.
  expect((await part(3)).status).toBe(204)
  await Bun.sleep(200)
  expect(t.delivered.filter(x => x.meta.message_id === 'grp-1')).toHaveLength(1)

  for (const q of ['part=0&of=3', 'part=4&of=3', 'part=1&of=11', 'part=x&of=2', 'part=1']) expect((await send(`/app/photo?id=bad-${q}&group=grp-bad&${q}`, 'x')).status).toBe(400)
  // A photo with no group goes as it always did.
  expect((await send('/app/photo?id=plain-photo', 'x')).status).toBe(204)
  expect((await waitFor(() => t.delivered.find(x => x.meta.message_id === 'plain-photo')))!.meta.image_paths).toBeUndefined()
}, 90000)
