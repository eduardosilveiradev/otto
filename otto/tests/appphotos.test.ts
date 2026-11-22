import { test, expect, afterAll } from 'bun:test'
import { randomBytes } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { join, isAbsolute } from 'path'
import { startTwin, waitFor, type Twin } from './apptwin.ts'
import { startFakeT3 } from './faket3.ts'

const fake = startFakeT3(randomBytes(24).toString('hex'))
let t: Twin
const id = 'j123abc'
const jobs = () => JSON.parse(readFileSync(join(t.state, 'code-jobs.json'), 'utf8'))
const upload = (messageId: string, query = '') => fetch(`${t.url}/app/photo?id=${messageId}${query}`, {
  method: 'POST', headers: { authorization: `Bearer ${t.token}` }, body: 'fake image bytes',
})
const history = async () => await (await fetch(`${t.url}/app/history`, { headers: { authorization: `Bearer ${t.token}` } })).json() as any[]
afterAll(async () => { await t?.stop(); fake.stop() })

test('photos validate mentions, preserve client ids, and answer or steer jobs exactly once', async () => {
  t = await startTwin(undefined, { OTTO_T3_URL: fake.url })
  writeFileSync(join(t.state, 't3-token'), fake.token)
  writeFileSync(join(t.state, 'code-jobs.json'), JSON.stringify([{ id, title: 'Photo task', brief: 'Inspect a photo', project: 'demo', threadId: 'photos', agent: 'T3 Code', where: 'local', createdAt: new Date().toISOString(), tokenBudget: 1000, steps: [] }]))
  fake.threads.push({ id: 'photos', status: 'running', activeRunId: 'run1', pendingRuntimeRequest: { id: 'req1', kind: 'user_input' } })
  fake.projections.photos = { thread: {}, turnItems: [{ type: 'user_input_request', requestId: 'req1', status: 'waiting', questions: [{ id: 'q1', question: 'Which photo?', options: [] }] }] }

  const mentions = `&mentions=${encodeURIComponent(JSON.stringify([id, id, 'jffffff', '<bad>', 7]))}`
  expect((await upload('mention-photo', mentions)).status).toBe(204)
  await waitFor(() => t.delivered.some(d => d.meta.message_id === 'mention-photo'))
  const delivered = t.delivered.find(d => d.meta.message_id === 'mention-photo')!
  expect(delivered.meta.mentions).toBe(id)
  expect(isAbsolute(delivered.meta.image_path!)).toBe(true)
  expect((await history()).find(h => h.id === 'mention-photo')).toMatchObject({ id: 'mention-photo', mentions: [id] })
  for (const [suffix, value] of [['bad', '{'], ['object', '{}'], ['unknown', '["jffffff"]']]) {
    expect((await upload(`mentions-${suffix}`, `&mentions=${encodeURIComponent(value!)}`)).status).toBe(204)
    await waitFor(() => t.delivered.some(d => d.meta.message_id === `mentions-${suffix}`))
    expect(t.delivered.find(d => d.meta.message_id === `mentions-${suffix}`)!.meta.mentions).toBeUndefined()
  }

  const query = `&job=${id}&text=${encodeURIComponent('Use this one')}${mentions}`
  const before = fake.commands.length
  const responses = await Promise.all([upload('answer-photo', query), upload('answer-photo', query)])
  for (const r of responses) if (!r.ok) throw new Error(await r.text())
  expect(responses.map(r => r.status)).toEqual([204, 204])
  expect((await upload('answer-photo', query)).status).toBe(204)
  const commands = fake.commands.slice(before)
  expect(commands.filter(c => c.type === 'runtime-request.respond')).toEqual([expect.objectContaining({ requestId: 'req1', answers: { q1: 'Use this one' } })])
  expect(commands.filter(c => c.type === 'message.dispatch')).toEqual([expect.objectContaining({ text: 'Use this one', attachments: [{ type: 'image', name: expect.any(String), mimeType: 'image/jpeg', sizeBytes: 16, dataUrl: `data:image/jpeg;base64,${Buffer.from('fake image bytes').toString('base64')}` }] })])
  expect(jobs()[0].steps.filter((s: any) => s.text === 'You answered it (photo)')).toHaveLength(1)
  expect((await history()).filter(h => h.id === 'answer-photo')).toEqual([expect.objectContaining({ text: 'Use this one', mentions: [id] })])
  expect(t.delivered.some(d => d.meta.message_id === 'answer-photo')).toBe(false)

  t = await t.restart()
  const after = fake.commands.length
  expect((await upload('answer-photo', query)).status).toBe(204)
  expect(fake.commands.slice(after).filter(c => c.type === 'runtime-request.respond' || c.type === 'message.dispatch')).toHaveLength(0)
  fake.threads[0]!.pendingRuntimeRequest = null
  fake.projections.photos = { thread: {}, turnItems: [] }
  expect((await upload('steer-photo', `&job=${id}`)).status).toBe(204)
  expect(fake.commands.at(-1)).toMatchObject({ type: 'message.dispatch', text: '(photo)', attachments: [expect.objectContaining({ type: 'image' })] })
  expect(jobs()[0].steps.at(-1).text).toBe('You steered it (photo)')
  Object.assign(fake.threads[0]!, { status: 'idle', activeRunId: null, latestVisibleMessage: { text: 'Which photo should I use?' } })
  expect((await upload('question-photo', `&job=${id}&text=Here`)).status).toBe(204)
  expect(jobs()[0].steps.at(-1).text).toBe('You answered it (photo)')
  expect((await upload('invalid-job', '&job=jffffff')).status).toBe(404)
}, 90000)
