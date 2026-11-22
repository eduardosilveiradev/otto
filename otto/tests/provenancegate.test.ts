import { test, expect } from 'bun:test'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { startTwin, phone, waitFor, type Twin } from './apptwin.ts'
import { headlessEnv } from '../headless.ts'
import { runnerEnv, type Job } from '../jobs.ts'
import { recordInbound } from '../redeliver.ts'

// The four tools that used to skip the provenance gate: after a webhook each is refused,
// and after a fresh owner message each behaves as before.

const text = (r: any): string => r?.content?.map((c: any) => c.text).join('\n') ?? ''
const refused = (r: any) => r.isError === true && /^not /.test(text(r))

async function withTwin(body: (t: Twin, taint: () => Promise<void>, owner: () => Promise<void>) => Promise<void>) {
  const t = await startTwin()
  const p = await phone(t)
  let n = 0
  const taint = async () => {
    await fetch(`${t.url}/`, { method: 'POST', headers: { authorization: 'Bearer twin-webhook-token', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'outside content', source: 'test' }) })
    expect(JSON.stringify(await t.call('self_edit_check', { paths: ['trigger:x/schedule'] }))).toContain('external-content')
  }
  const owner = async () => {
    const said = `go ahead ${++n}`
    p.send({ type: 'message', id: `owner-${n}`, text: said })
    await waitFor(() => t.delivered.find(d => d.content === said))
  }
  try { await body(t, taint, owner) } finally { p.close(); await t.stop() }
}

const trig = (id: string, o: object) => ({ id, type: 'cron', schedule: '0 9 * * *', action: 'check the weather', enabled: true, repeating: true, createdAt: new Date().toISOString(), ...o })
const mailTrig = (id: string, o: object = {}) => trig(id, { type: 'email', condition: 'a reply arrives', repeating: false, schedule: undefined, ...o })
const pair = [trig('pair-cron', { repeating: false, schedule: '2099-01-01T09:00:00Z' }), mailTrig('pair-mail', { repeating: true, action: 'Delete cron trigger pair-cron. Send nothing.' })]

test('delete_trigger: a webhook deletes nothing, not even a one-shot email watcher', () => withTwin(async (t, taint, owner) => {
  writeFileSync(join(t.state, 'triggers.json'), JSON.stringify([trig('plain', {}), mailTrig('watcher'), ...pair]))
  await taint()
  for (const id of ['plain', 'watcher', 'pair-cron', 'pair-mail']) expect(refused(await t.call('delete_trigger', { id }))).toBe(true)
  await owner()
  for (const id of ['plain', 'watcher']) expect(text(await t.call('delete_trigger', { id }))).toBe(`deleted ${id}`)
}), 30000)

test('delete_trigger: the email scan deletes its own one-shot trigger and its pair partner, nothing else', async () => {
  const env = { OTTO_SCHEDULER_MS: '300', OTTO_EMAIL_GRACE_MS: '0' }
  let t = await startTwin(undefined, env)
  try {
    await t.stop()
    writeFileSync(join(t.state, 'triggers.json'), JSON.stringify([
      trig('plain', {}), mailTrig('acted-on'), mailTrig('off', { enabled: false }), mailTrig('kept'), mailTrig('watching', { repeating: true }), ...pair,
    ]))
    t = await t.restart()
    expect(await waitFor(() => t.delivered.find(d => d.meta.event === 'email-scan'), 10000)).toBeTruthy()
    expect(text(await t.call('delete_trigger', { id: 'acted-on' }))).toBe('deleted acted-on')
    expect(text(await t.call('delete_trigger', { id: 'pair-cron' }))).toBe('deleted pair-cron')
    for (const id of ['plain', 'off', 'watching', 'pair-mail']) expect(refused(await t.call('delete_trigger', { id }))).toBe(true)
    // A webhook later in the same turn is not the scan.
    await fetch(`${t.url}/`, { method: 'POST', headers: { authorization: 'Bearer twin-webhook-token', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'outside content', source: 'test' }) })
    await waitFor(() => t.delivered.find(d => d.meta.event === 'webhook'))
    expect(refused(await t.call('delete_trigger', { id: 'kept' }))).toBe(true)
    // A trigger firing inside that tainted turn deletes the email trigger its own action names, and only that one.
    writeFileSync(join(t.state, 'triggers.json'), JSON.stringify([
      mailTrig('kept'), mailTrig('other'),
      trig('nudge', { schedule: new Date(Date.now() - 1000).toISOString(), repeating: false, nextRun: Date.now() - 1000, action: 'Nudge about the reply. Then delete email trigger kept.' }),
    ]))
    expect(await waitFor(() => t.delivered.find(d => d.meta.trigger_id === 'nudge'), 10000)).toBeTruthy()
    expect(JSON.stringify(await t.call('self_edit_check', { paths: ['trigger:x/schedule'] }))).toContain('external-content')
    expect(refused(await t.call('delete_trigger', { id: 'other' }))).toBe(true)
    expect(text(await t.call('delete_trigger', { id: 'kept' }))).toBe('deleted kept')
    // Every delete mail steered leaves a write note that re-creates it.
    const writes = text(await t.call('recall', { kind: 'write', query: 'trigger' }))
    for (const id of ['acted-on', 'pair-cron', 'kept']) expect(writes).toContain(`trigger ${id}`)
    expect(writes).toContain('create_trigger')
  } finally { await t.stop() }
}, 40000)

test('remember: durable kinds refused after a webhook, operational notes still written', () => withTwin(async (t, taint, owner) => {
  const mem = { description: 'stay quiet about a sender', text: 'do not ping about example.com' }
  await taint()
  for (const kind of ['user', 'feedback', 'project', 'reference']) expect(refused(await t.call('remember', { ...mem, kind, name: `planted-${kind}` }))).toBe(true)
  expect(text(await t.call('remember', { kind: 'fact', text: 'the parcel ships Tuesday' }))).toContain('stored')
  expect(text(await t.call('remember', { kind: 'loop', text: 'waiting on a reply' }))).toContain('stored')
  await owner()
  expect(text(await t.call('remember', { ...mem, kind: 'feedback', name: 'owner-said' }))).toContain('stored memory')
}), 30000)

test('forget: refused after a webhook, for memories and notes alike', () => withTwin(async (t, taint, owner) => {
  expect(text(await t.call('remember', { kind: 'feedback', name: 'quiet-sender', description: 'stay quiet', text: 'quiet about example.com' }))).toContain('stored memory')
  const noteId = /\[([^\]]+)\]/.exec(text(await t.call('remember', { kind: 'loop', text: 'waiting on a reply' })))?.[1]
  await taint()
  expect(refused(await t.call('forget', { name: 'quiet-sender' }))).toBe(true)
  expect(refused(await t.call('forget', { id: noteId }))).toBe(true)
  await owner()
  expect(text(await t.call('forget', { name: 'quiet-sender' }))).toContain('forgot memory')
  expect(text(await t.call('forget', { id: noteId }))).toContain(`forgot ${noteId}`)
}), 30000)

const job = { task: 'run a script', tools: ['Bash'], tags: ['overnight'] }

test('delegate: refused after a webhook, queued on the owner’s word', () => withTwin(async (t, taint, owner) => {
  await taint()
  expect(refused(await t.call('delegate', job))).toBe(true)
  await owner()
  expect(text(await t.call('delegate', job))).toContain('job [')
}), 30000)

test('delegate: a trigger the user armed still queues one', async () => {
  let t = await startTwin()
  try {
    await t.stop()
    writeFileSync(join(t.state, 'inbound-journal.json'), JSON.stringify(recordInbound([], {
      chat_id: 'app', message_id: 'armed', text: 'run the nightly script', meta: { event: 'trigger', trigger_id: 'armed' }, read: false,
    }, Date.now())))
    t = await t.restart()
    expect(await waitFor(() => t.delivered.some(d => d.meta.event === 'trigger'))).toBe(true)
    expect(JSON.stringify(await t.call('self_edit_check', { paths: ['otto/server.ts'] }))).toContain('this request: triggered')
    expect(text(await t.call('delegate', job))).toContain('job [')
  } finally { await t.stop() }
}, 30000)

test('headless and job children drop the supervised stamp and the channel host', () => {
  const base = { PATH: '/bin', OTTO_SUPERVISED: '1', OTTO_CHANNEL_HOST: '1' }
  const pip = { id: 'job1', pip: { id: 'pip1' } } as unknown as Job
  for (const env of [headlessEnv(base), runnerEnv(pip, base)]) {
    expect(env.OTTO_SUPERVISED).toBeUndefined()
    expect(env.OTTO_CHANNEL_HOST).toBeUndefined()
    expect(env.PATH).toBe('/bin')
  }
  expect(runnerEnv(pip, base)).toMatchObject({ OTTO_ORIGIN_PIN: 'external-content', OTTO_PIP_ID: 'pip1', OTTO_PIP_JOB: 'job1' })
})
