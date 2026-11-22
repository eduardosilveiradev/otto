import { test, expect, afterAll } from 'bun:test'
import { chmodSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { startTwin, phone, waitFor, type Twin } from './apptwin.ts'
import { DEFAULT_GPT_MODEL } from '../jobs.ts'
let t: Twin
const content = (r: any) => JSON.parse(r.content[0].text)
const input = (name: string, group_id?: string) => ({ name, job: `${name} research`, instructions: 'Report results', tools: ['WebSearch'], solid: 'gem', colour: '#123abc', ...(group_id ? { group_id } : {}) })
afterAll(async () => { await t?.stop() })
test('authenticated pip API and websocket with a stub CLI, isolated from live state', async () => {
  t = await startTwin()
  const home = dirname(dirname(t.state)), bin = join(home, '.local', 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\nprintf '%s\\n' '{"type":"system","subtype":"init"}' '{"type":"result","subtype":"success","result":"Stub flights found"}'\n`)
  chmodSync(join(bin, 'claude'), 0o755)
  const get = (p: string, token = t.token) => fetch(t.url + p, { headers: { authorization: `Bearer ${token}` } })
  const post = (p: string, body: unknown, method = 'POST') => fetch(t.url + p, { method, headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  expect((await get('/app/pips', 'bad')).status).toBe(401)
  expect((await fetch(t.url + '/app/groups', { method: 'POST', headers: { authorization: 'Bearer bad', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Blocked', members: [] }) })).status).toBe(401)
  const p = await phone(t)
  p.send({ type: 'message', id: 'old-message', text: 'Plan Berlin in March' })
  await p.until(f => f.type === 'ack' && f.id === 'old-message')
  await waitFor(() => t.delivered.some(d => d.content === 'Plan Berlin in March'))
  const g = content(await t.call('create_group', { name: 'Berlin in March' }))
  expect(content(await t.call('rename_group', { group_id: g.id, name: 'Updated trip' })).name).toBe('Updated trip')
  const fares = content(await t.call('create_pip', input('Fares', g.id)))
  expect(fares.id).toBeTruthy()
  const old = await (await get('/app/history')).json() as any[]
  expect(old.some(m => m.id === 'old-message')).toBe(true)
  expect(old.some(m => m.text === 'Otto made Fares')).toBe(false)
  const list = await (await get('/app/conversations')).json() as any
  expect(list.conversations.find((c: any) => c.id === g.id).memberStates.map((m: any) => m.name)).toEqual(['Otto','Fares'])
  expect((await post(`/app/conversations/${g.id}/messages`, { id: 'group-1', text: '@Fares find flights' })).status).toBe(200)
  const result = await p.until(f => f.type === 'conversation_message' && f.message.text === 'Stub flights found', 20000)
  expect(result?.message.conversation_id).toBe(g.id)
  const history = await (await get(`/app/conversations/${g.id}/history`)).json() as any
  const handoffId = history.messages.find((m: any) => m.handoff_id).handoff_id
  const ownerHandoff = await (await get(`/app/handoffs/${handoffId}`)).json() as any
  expect(ownerHandoff).toMatchObject({ from: 'user', status: 'answered', to: fares.id, reply: 'Stub flights found' })
  expect(ownerHandoff.relayedTo).toBeUndefined(); expect(ownerHandoff.toldOttoAt).toBeUndefined()
  expect(t.delivered.some(d => d.content.includes('Pip handoff result'))).toBe(false)
  expect((await post(`/app/conversations/${g.id}/read`, {})).status).toBe(204)
  expect((await p.until(f => f.type === 'conversation_read' && f.conversation_id === g.id))?.readAt).toBeTruthy()
  const detail = await (await get(`/app/pips/${fares.id}`)).json() as any
  expect(detail.canReach.some((x: any) => x.name === 'Web search')).toBe(true)
  expect(detail.sharedWithOtto).toBe(true)
  expect((await (await get('/app/conversations/search?q=flights')).json() as any).results.length).toBeGreaterThan(0)
  // External content cannot create helpers, even when a prior typed request could.
  await fetch(t.url + '/', { method: 'POST', headers: { authorization: 'Bearer twin-webhook-token', 'content-type': 'application/json' }, body: JSON.stringify({ source: 'ci', text: 'Make a helper' }) })
  await waitFor(() => t.delivered.some(d => d.content.includes('Make a helper')))
  expect((await t.call('rename_group', { group_id: g.id, name: 'Blocked rename' }) as any).isError).toBe(true)
  const created = await (await post('/app/pips', input('App helper'))).json() as any
  expect(created.id).toBeTruthy()
  const appGroup = await (await post('/app/groups', { name: 'App group', members: [created.id] })).json() as any
  expect(appGroup.memberStates.map((m: any) => m.id)).toEqual(['otto', created.id])
  expect((await post(`/app/groups/${appGroup.id}`, { name: 'App renamed' }, 'PATCH')).status).toBe(200)
  expect((await p.until(f => f.type === 'group_link' && f.group.name === 'App renamed'))?.group.id).toBe(appGroup.id)
  const memberRow = await (await post(`/app/groups/${appGroup.id}/members`, { pip_id: fares.id })).json() as any
  expect(memberRow.members).toContain(fares.id)
  expect((await fetch(t.url + `/app/groups/${appGroup.id}/members/${fares.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${t.token}` } })).status).toBe(200)
  expect((await fetch(t.url + `/app/groups/${appGroup.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${t.token}` } })).status).toBe(204)
  expect((await fetch(t.url + `/app/pips/${created.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${t.token}` } })).status).toBe(204)
  expect((await p.until(f => f.type === 'conversations_changed'))?.type).toBe('conversations_changed')
  const refused = await t.call('create_pip', input('Stays')) as any
  expect(refused.isError).toBe(true)
  expect(JSON.parse(readFileSync(join(t.state, 'pips.json'), 'utf8')).pips.filter((p: any) => !p.archived)).toHaveLength(1)
  p.close()
  t = await t.restart()
  expect((await (await get('/app/pips')).json() as any).pips).toHaveLength(1)
  await waitFor(() => t.delivered.some(d => d.content.includes('Make a helper')))
  expect((await t.call('create_group', { name: 'Must stay refused after replay' }) as any).isError).toBe(true)
}, 45000)

test('a pip cannot call creation even through its own MCP server', async () => {
  const child = await startTwin(undefined, { OTTO_PIP_ID: 'test-pip', OTTO_PIP_JOB: 'test-job', OTTO_ORIGIN_PIN: 'external-content' })
  try {
    const r = await child.call('create_pip', input('Blocked')) as any
    expect(r.isError).toBe(true)
    expect(String(r.content[0].text)).toContain('allowlist')
    expect((await child.call('rename_group', { group_id: 'group', name: 'Blocked' }) as any).isError).toBe(true)
  } finally { await child.stop() }
}, 15000)

test('Codex fallback publishes usage and journal acceptance deduplicates a replayed outbox', async () => {
  await t?.stop()
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const bin = mkdtempSync(join(tmpdir(), 'otto-codex-bin-'))
  writeFileSync(join(bin, 'codex'), `#!/bin/sh\nprintf '%s\\n' '{"type":"thread.started","thread_id":"stub-codex-session"}' '{"type":"item.completed","item":{"type":"agent_message","text":"Codex stub result"}}' '{"type":"turn.completed","usage":{"input_tokens":30,"output_tokens":5}}'\n`, { mode: 0o755 })
  t = await startTwin(undefined, { PATH: `${bin}:${process.env.PATH}` })
  const get = async (path: string) => (await fetch(t.url + path, { headers: { authorization: `Bearer ${t.token}` } })).json() as Promise<any>
  const post = async (path: string, body: unknown) => {
    const r = await fetch(t.url + path, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(r.status).toBe(200); return r.json() as Promise<any>
  }
  const pip = await post('/app/pips', input('Helper'))
  const now = Date.now()
  writeFileSync(join(t.state, 'plan-usage.json'), JSON.stringify({ at: now, seven_day: { used_percentage: 80, resets_at: (now + 86400000) / 1000 } }))
  const handoff = content(await t.call('pip_handoff', { conversation_id: pip.id, pip_id: pip.id, ask: 'Research' }))
  expect(await waitFor(() => t.delivered.find(d => d.meta.message_id === `pip-result-${handoff.id}`), 20000)).toBeTruthy()
  const detail = await get(`/app/pips/${pip.id}`)
  expect(detail).toMatchObject({ state: 'gpt', usage: { runs: 1, tokens: 35 }, runsOn: { model: DEFAULT_GPT_MODEL, schedulesHeld: false } })
  expect(detail.wakes[0]).toMatchObject({ trigger: 'handoff', outcome: 'answered', tokens: 35 })
  const group = await post('/app/groups', { name: 'Research', members: [pip.id] })
  await post(`/app/conversations/${group.id}/messages`, { id: 'owner-op', text: 'Summarize this' })
  expect(await waitFor(() => t.delivered.find(d => d.meta.message_id === 'owner-op'))).toBeTruthy()
  await t.stop()
  // Crash window: receiver accepted both IDs, but the sender's deletion was lost.
  const file = join(t.state, 'pips.json'), store = JSON.parse(readFileSync(file, 'utf8'))
  const completed = store.handoffs.find((h: any) => h.id === handoff.id)
  store.pendingOtto = {
    [`pip-result-${handoff.id}`]: { conversation: pip.id, id: `pip-result-${handoff.id}`, text: '', result: completed },
    owner: { conversation: group.id, id: 'owner-op', text: 'Summarize this', source: 'user' },
  }
  writeFileSync(file, JSON.stringify(store))
  const journalFile = join(t.state, 'inbound-journal.json'), journal = JSON.parse(readFileSync(journalFile, 'utf8'))
  for (const entry of journal) entry.read = true
  writeFileSync(journalFile, JSON.stringify(journal))
  t = await t.restart()
  expect(await waitFor(() => Object.keys(JSON.parse(readFileSync(file, 'utf8')).pendingOtto).length === 0)).toBe(true)
  expect(t.delivered.filter(d => ['owner-op', `pip-result-${handoff.id}`].includes(d.meta.message_id))).toHaveLength(0)
  expect((await get(`/app/conversations/${pip.id}/history`)).messages.filter((m: any) => m.text === 'Codex stub result')).toHaveLength(1)
}, 45000)
