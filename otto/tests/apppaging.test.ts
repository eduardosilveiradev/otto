import { test, expect } from 'bun:test'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { startTwin } from './apptwin.ts'
test('default history stays unchanged and older pages fold across rotations', async () => {
  const t = await startTwin()
  const get = async (q = '') => (await fetch(`${t.url}/app/history${q}`, { headers: { authorization: `Bearer ${t.token}` } })).json() as Promise<any[]>
  const entries = Array.from({ length: 180 }, (_, i) => ({ ts: new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(i / 3))).toISOString(), chat_id: 'app', dir: i % 2 ? 'in' : 'out', kind: 'text', message_id: `m${String(i - i % 3 + (2 - i % 3)).padStart(3, '0')}`, text: `message ${i}` }))
  try {
    const jsonl = (rows: any[]) => rows.map(e => JSON.stringify(e)).join('\n') + '\n'
    writeFileSync(join(t.state, 'history.26.jsonl'), jsonl(entries.slice(0, 80)))
    writeFileSync(join(t.state, 'history.jsonl'), jsonl(entries.slice(80)))
    const invalid = await fetch(`${t.url}/app/history?before=invalid`, { headers: { authorization: `Bearer ${t.token}` } })
    expect(invalid.status).toBe(400)
    const newest = entries.slice(-50).map(e => ({ dir: e.dir, text: e.text, ts: e.ts, id: e.message_id, ...(e.dir === 'in' ? { read: true } : {}) }))
    expect(await get()).toEqual(newest); expect(await get('?limit=50')).toEqual(newest)
    const preceding = await get(`?before=${encodeURIComponent(`${newest[0].ts}|${newest[0].id}`)}&limit=500`)
    expect([...preceding, ...newest].map(e => e.id)).toEqual(entries.map(e => e.message_id))
    const mutations = [{ ...entries[179], kind: 'edit', message_id: 'm001', text: 'changed' }, { ...entries[179], kind: 'reaction', dir: 'out', message_id: 'm001', text: '👍' }, { ...entries[179], kind: 'delete', message_id: 'm002' }]
    writeFileSync(join(t.state, 'history.jsonl'), jsonl([...entries.slice(80), ...mutations]))
    let before = '2027-01-01T00:00:00.000Z', rows: any[] = []
    for (;;) {
      const page = await get(`?limit=13&before=${encodeURIComponent(before)}`)
      if (!page.length) break
      rows = [...page, ...rows]; before = `${page[0].ts}|${page[0].id}`
    }
    expect(rows.map(e => e.id)).toEqual(entries.filter(e => e.message_id !== 'm002').map(e => e.message_id))
    expect(rows.find(e => e.id === 'm001')).toMatchObject({ text: 'changed', reaction: '👍', read: true })
    await t.call('burn', { chat_id: 'app', message_id: 'm001' })
    expect((await get('?before=2027-01-01T00:00:00.000Z&limit=500')).find(e => e.id === 'm001').text).toBe('[burned]')
  } finally { await t.stop() }
}, 60000)
