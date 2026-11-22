import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startTwin, phone, waitFor } from './apptwin.ts'

test('real server waits for negotiated receipts, pushes frozen phones, and leaves old clients unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'otto-receipts-'))
  const pushes = join(dir, 'pushes.jsonl'), preload = join(dir, 'capture.ts')
  writeFileSync(pushes, '')
  writeFileSync(preload, `
    import { appendFileSync } from 'fs'
    const realFetch = globalThis.fetch
    globalThis.fetch = ((url, init) => {
      if (String(url).startsWith('https://api.day.app/')) {
        appendFileSync(${JSON.stringify(pushes)}, String(init?.body) + '\\n')
        return Promise.resolve(new Response('{}'))
      }
      return realFetch(url, init)
    }) as typeof fetch
  `)
  let t = await startTwin(undefined, { BARK_KEY: 'placeholder' }, preload)
  try {
    const pushed = () => readFileSync(pushes, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s))
    const p = await phone(t)
    expect(await p.until(f => f.type === 'hello')).toMatchObject({ acks: true, messageAcks: true })
    p.send({ type: 'hello', messageAcks: true })
    // An operation ack is a round-trip barrier after the hello.
    p.send({ type: 'message', id: 'receipt-barrier', text: 'hello' })
    await p.until(f => f.type === 'ack' && f.id === 'receipt-barrier')
    await t.call('reply', { chat_id: 'app', text: 'accepted', verbatim: true })
    const accepted = await p.until(f => f.type === 'message' && f.text === 'accepted')
    expect(accepted).toBeTruthy()
    p.send({ type: 'ack', id: accepted.id })
    const made = Bun.spawnSync(['bun', join(import.meta.dir, '..', 'apptokens.ts'), 'new', 'desktop-device'], { env: { PATH: process.env.PATH!, OTTO_STATE_DIR: t.state } })
    const macToken = String(made.stdout).match(/[A-Za-z0-9_-]{24,}/)?.[0]
    expect(macToken).toBeTruthy()
    const mac = await phone({ ...t, token: macToken! })
    mac.send({ type: 'hello', messageAcks: true, desktop: true })
    expect(await mac.until(f => f.type === 'seen')).toBeTruthy()
    mac.send({ type: 'presence', focused: false })
    await t.call('reply', { chat_id: 'app', text: 'frozen', verbatim: true })
    const frozen = await p.until(f => f.type === 'message' && f.text === 'frozen')
    expect(pushed()).toHaveLength(0)
    expect(await waitFor(() => pushed().length === 1, 8_000)).toBe(true)
    expect(pushed()[0]).toMatchObject({ id: frozen.id, body: 'frozen' })
    p.close()
    const old = await phone(t)
    await old.until(f => f.type === 'hello')
    await t.call('reply', { chat_id: 'app', text: 'legacy', verbatim: true })
    await old.until(f => f.type === 'message' && f.text === 'legacy')
    await Bun.sleep(5_300)
    expect(pushed()).toHaveLength(1)
    old.close()
    const log = readFileSync(join(t.state, 'connection-log.jsonl'), 'utf8')
    expect(log).toContain('message.ack_timeout')
    expect(log).toContain('socket.open')
    mac.close()
    t = await t.restart()
    const rememberedMac = await phone({ ...t, token: macToken! })
    await rememberedMac.until(f => f.type === 'hello')
    // Before any new hello or presence, the remembered desktop cannot hide the phone push.
    await t.call('reply', { chat_id: 'app', text: 'desktop after restart', verbatim: true })
    expect(await waitFor(() => pushed().length === 2, 1_000)).toBe(true)
    rememberedMac.close()
  } finally { await t.stop(); rmSync(dir, { recursive: true }) }
}, 60_000)

test('two devices independently recover history after restart without socket replay', async () => {
  let t = await startTwin()
  try {
    await t.call('reply', { chat_id: 'app', text: 'kept across restart', verbatim: true })
    const made = Bun.spawnSync(['bun', join(import.meta.dir, '..', 'apptokens.ts'), 'new', 'second-device'], { env: { PATH: process.env.PATH!, OTTO_STATE_DIR: t.state } })
    const token = String(made.stdout).match(/[A-Za-z0-9_-]{24,}/)?.[0]
    expect(token).toBeTruthy()
    t = await t.restart()
    const a = await phone(t), b = await phone({ ...t, token: token! })
    await a.until(f => f.type === 'hello')
    await b.until(f => f.type === 'hello')
    const readHistory = async (credential: string) => (await fetch(`${t.url}/app/history`, { headers: { authorization: `Bearer ${credential}` } })).json() as Promise<any[]>
    const first = (await readHistory(t.token)).find(r => r.text === 'kept across restart')
    const second = (await readHistory(token!)).find(r => r.text === 'kept across restart')
    expect(first).toBeTruthy()
    expect(second).toMatchObject({ id: first.id })
    expect(first.quiet).toBeUndefined()
    expect(a.got.filter(f => f.type === 'message')).toHaveLength(0)
    expect(b.got.filter(f => f.type === 'message')).toHaveLength(0)
    a.close(); b.close()
  } finally { await t.stop() }
}, 60_000)

test('WhatsApp journal failure holds the offset; exhausted media retries tell the user; restart skips accepted ids', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'otto-wa-delivery-'))
  const ready = join(dir, 'ready'), wire = join(dir, 'wire.jsonl'), preload = join(dir, 'capture.ts')
  writeFileSync(wire, '')
  writeFileSync(preload, `
    import { appendFileSync, existsSync, readFileSync } from 'fs'
    const realFetch = globalThis.fetch
    globalThis.fetch = ((url, init) => {
      const u = String(url)
      if (!u.startsWith('https://api.whatsapp.com/agent/v1')) return realFetch(url, init)
      appendFileSync(${JSON.stringify(wire)}, JSON.stringify({url:u, body:init?.body}) + '\\n')
      if (u.includes('/updates?')) {
        if (!existsSync(${JSON.stringify(ready)})) return Promise.resolve(new Response(null, {status:204}))
        const pick = readFileSync(${JSON.stringify(ready)}, 'utf8')
        if (pick.startsWith('{')) return Promise.resolve(Response.json({next_offset:43, entry:[{changes:[{value:{messages:[JSON.parse(pick)]}}]}]}))
        const timestamp = String(Math.floor(Date.now()/1000))
        return Promise.resolve(Response.json({next_offset:42, entry:[{changes:[{value:{messages:[
          {from:'user:1234567890', id:'wa-text', timestamp, type:'text', text:{body:'durable inbound'}},
          {from:'user:1234567890', id:'wa-media', timestamp, type:'image', image:{id:'attachment',mime_type:'image/jpeg'}}
        ]}}]}]}))
      }
      if (u.includes('/media/')) return Promise.resolve(new Response('{}', {status:503}))
      if (u.endsWith('/messages') && String(init?.body).includes('Please send it again')) return Promise.resolve(new Response('{}', {status:500}))
      return Promise.resolve(Response.json({messages:[{id:'sent-placeholder'}]}))
    }) as typeof fetch
  `)
  let t = await startTwin(undefined, { WHATSAPP_AGENT_TOKEN: 'placeholder' }, preload)
  try {
    const block = join(t.state, 'inbound-journal.json.tmp')
    mkdirSync(block)
    writeFileSync(ready, 'ready')
    const rows = () => readFileSync(wire, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s))
    expect(await waitFor(() => {
      try { return readFileSync(join(t.state, 'connection-log.jsonl'), 'utf8').includes('whatsapp.poll.failed') } catch { return false }
    }, 10_000)).toBe(true)
    expect(() => readFileSync(join(t.state, 'whatsapp.json'), 'utf8')).toThrow()
    expect(t.delivered.some(d => d.meta.message_id === 'wa-text')).toBe(false)
    rmSync(block, { recursive: true })
    expect(await waitFor(() => {
      try { return JSON.parse(readFileSync(join(t.state, 'whatsapp.json'), 'utf8')).offset === 42 } catch { return false }
    }, 10_000)).toBe(true)
    expect(rows().filter(r => r.url.includes('/media/'))).toHaveLength(2)
    expect(rows().filter(r => String(r.body).includes('Please send it again'))).toHaveLength(1)
    expect(t.delivered.filter(d => d.meta.message_id === 'wa-text')).toHaveLength(1)
    expect(await waitFor(() => t.delivered.find(d => d.meta.message_id === 'wa-media'))).toBeTruthy()
    expect(t.delivered.find(d => d.meta.message_id === 'wa-media')?.content).toContain('resend notice could not be delivered')
    const h = readFileSync(join(t.state, 'history.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(h.filter(e => e.message_id === 'wa-text' && e.dir === 'in')).toHaveLength(1)
    t = await t.restart()
    await Bun.sleep(500)
    // The inbound journal deliberately replays unread work; the poll must not enqueue it again.
    expect(t.delivered.filter(d => d.meta.chat_id === 'whatsapp').every(d => d.meta.redelivered === '1')).toBe(true)
    const journal = JSON.parse(readFileSync(join(t.state, 'inbound-journal.json'), 'utf8'))
    expect(journal.filter((e: { message_id: string }) => e.message_id === 'wa-text')).toHaveLength(1)
    expect(rows().filter(r => r.url.includes('/media/'))).toHaveLength(2)
    const choice = (id: string) => JSON.stringify({ from: 'user:1234567890', id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: '1' } })
    // A server-run tap: the session may only send one the server composed (pulse cards hand theirs over to relay).
    writeFileSync(join(t.state, 'pulse.json'), JSON.stringify({ topics: [{ id: 'abc123', text: 'Topic', weight: 3, addedAt: '2026-11-01T00:00:00Z' }], seen: [], pending: [{ topicId: 'abc123', title: 'A', gist: 'g', url: 'https://example.com/a', date: '2026-11-14' }] }))
    const cards = JSON.parse((await t.call('pulse', { action: 'cards' }) as { content: { text: string }[] }).content[0].text)
    await t.call('reply', { chat_id: 'whatsapp', text: 'choose', buttons: cards.buttons.slice(0, 1) })
    writeFileSync(ready, choice('wa-handled'))
    expect(await waitFor(() => {
      const j = JSON.parse(readFileSync(join(t.state, 'inbound-journal.json'), 'utf8'))
      return j.some((e: any) => e.message_id === 'wa-handled' && e.answered && e.meta.channel === 'done')
    }, 10_000)).toBe(true)
    t = await t.restart()
    await Bun.sleep(600)
    expect(t.delivered.some(d => d.meta.message_id === 'wa-handled')).toBe(false)
    await t.call('reply', { chat_id: 'whatsapp', text: 'choose again', buttons: [{ label: 'ask', data: 'do this once' }] })
    writeFileSync(ready, choice('wa-model'))
    expect(await waitFor(() => t.delivered.some(d => d.meta.message_id === 'wa-model' && d.meta.event === 'button'), 10_000)).toBe(true)
    t = await t.restart()
    expect(await waitFor(() => t.delivered.some(d => d.meta.message_id === 'wa-model' && d.meta.redelivered === '1'))).toBe(true)
    expect(t.delivered.some(d => d.meta.event === 'button' && !d.meta.message_id)).toBe(false)
    writeFileSync(ready, JSON.stringify({ from: 'user:1234567890', id: 'wa-reaction', timestamp: String(Math.floor(Date.now() / 1000)), type: 'reaction', reaction: { message_id: 'sent-placeholder', emoji: '👍' } }))
    expect(await waitFor(() => JSON.parse(readFileSync(join(t.state, 'inbound-journal.json'), 'utf8')).some((e: any) => e.message_id === 'wa-reaction' && e.answered), 10_000)).toBe(true)
    t = await t.restart()
    await Bun.sleep(600)
    expect(t.delivered.some(d => d.meta.message_id === 'wa-reaction')).toBe(false)
    const journalFile = join(t.state, 'inbound-journal.json')
    const unfinished = { chat_id: 'whatsapp', message_id: 'wa-running', text: 'revoke stale device deadbeef', ts: new Date().toISOString(), read: true, meta: { chat_id: 'whatsapp', event: 'button', channel: 'running', button_label: 'retry' } }
    writeFileSync(journalFile, JSON.stringify([...JSON.parse(readFileSync(journalFile, 'utf8')), unfinished]))
    writeFileSync(ready, choice('wa-running'))
    t = await t.restart()
    expect(await waitFor(() => JSON.parse(readFileSync(journalFile, 'utf8')).some((e: any) => e.message_id === 'wa-running' && e.answered && e.meta.channel === 'done'), 10_000)).toBe(true)
    const noticeCount = () => rows().filter(r => String(r.body).includes('That device was not offered')).length
    const completedCount = noticeCount()
    t = await t.restart()
    await Bun.sleep(600)
    expect(noticeCount()).toBe(completedCount)
    expect(t.delivered.some(d => d.meta.message_id === 'wa-running')).toBe(false)
    await t.call('reply', { chat_id: 'whatsapp', text: 'recover a choice', buttons: [{ label: 'retry', data: 'finish queued model choice' }] })
    writeFileSync(journalFile, JSON.stringify([...JSON.parse(readFileSync(journalFile, 'utf8')), { ...unfinished, message_id: 'wa-running-model', text: 'finish queued model choice' }]))
    writeFileSync(ready, choice('wa-running-model'))
    expect(await waitFor(() => t.delivered.some(d => d.meta.message_id === 'wa-running-model' && d.meta.event === 'button'), 10_000)).toBe(true)
    writeFileSync(ready, choice('wa-after-running'))
    expect(await waitFor(() => t.delivered.some(d => d.meta.message_id === 'wa-after-running' && d.content === '1' && !d.meta.event), 10_000)).toBe(true)
    writeFileSync(journalFile, JSON.stringify([...JSON.parse(readFileSync(journalFile, 'utf8')), { ...unfinished, message_id: 'wa-handover', text: 'queued handover', read: false, meta: { ...unfinished.meta, message_id: 'wa-handover' } }]))
    writeFileSync(ready, choice('wa-handover'))
    t = await t.restart()
    expect(await waitFor(() => t.delivered.some(d => d.meta.message_id === 'wa-handover' && d.meta.redelivered === '1'))).toBe(true)
    expect(t.delivered.filter(d => d.meta.message_id === 'wa-handover')).toHaveLength(1)
    const accepted = JSON.parse(readFileSync(journalFile, 'utf8')).map((e: any) => e.message_id === 'wa-handover' ? { ...e, read: true, answered: true } : e)
    writeFileSync(journalFile, JSON.stringify(accepted))
    const polls = rows().filter(r => r.url.includes('/updates?')).length
    expect(await waitFor(() => rows().filter(r => r.url.includes('/updates?')).length > polls, 10_000)).toBe(true)
    expect(t.delivered.filter(d => d.meta.message_id === 'wa-handover')).toHaveLength(1)
  } finally { await t.stop(); rmSync(dir, { recursive: true }) }
}, 60_000)

test('unread-after-answer excludes events and samples the final paced bubble', async () => {
  const t = await startTwin()
  try {
    const p = await phone(t)
    await p.until(f => f.type === 'hello')
    writeFileSync(join(t.state, 'inbound-journal.json'), JSON.stringify([{ chat_id: 'trigger', message_id: 'unrelated', text: 'event', ts: new Date().toISOString(), meta: { event: 'trigger' }, read: false }]))
    await fetch(`${t.url}/app/health`, { method: 'POST', headers: { authorization: `Bearer ${t.token}` }, body: JSON.stringify({ notifications: 'authorized', backgroundRefresh: 'available', keepAwake: true, shareConfigured: true, build: '1', version: '1', ios: '26' }) })
    const count = () => Object.values(JSON.parse(readFileSync(join(t.state, 'app-health.json'), 'utf8')) as Record<string, { unreadAfterAnswer: number }>)[0].unreadAfterAnswer
    // The final bubble's sample counts a message that landed during the pause. Frames on one socket
    // arrive in order and the server journals and acks a message in the same tick, so whether the ack
    // came before the final bubble says exactly what the sample must be. A machine too starved to land
    // the message inside two capped pauses (~4.4 s) just tries again.
    const middle = 'A middle bubble long enough to hold the typing dots up for their full capped pause.'
    let landedFirst = false
    for (let attempt = 0; attempt < 3 && !landedFirst; attempt++) {
      const final = `A final bubble long enough to leave time for another incoming message during pacing (${attempt}).`
      await t.call('reply', { chat_id: 'app', text: `first ${attempt}\n\n${middle}\n\n${final}`, verbatim: true })
      const before = count()   // sampled by the first bubble, before the tool returned
      p.send({ type: 'message', id: `during-pacing-${attempt}`, text: 'new question' })
      await p.until(f => f.type === 'ack' && f.id === `during-pacing-${attempt}`)
      await p.until(f => f.type === 'message' && f.text === final)
      const at = (pred: (f: any) => boolean) => p.got.findIndex(pred)
      landedFirst = at(f => f.type === 'ack' && f.id === `during-pacing-${attempt}`) < at(f => f.type === 'message' && f.text === final)
      expect(count()).toBe(before + (landedFirst ? 1 : 0))
      if (attempt === 0) expect(before).toBe(0)
    }
    expect(landedFirst).toBe(true)
    p.close()
  } finally { await t.stop() }
}, 60_000)

test('paced late-voice intent is durable before its text bubble and resumes after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'otto-paced-voice-'))
  const calls = join(dir, 'tts.txt'), preload = join(dir, 'capture.ts')
  writeFileSync(preload, `
    import { writeFileSync } from 'fs'
    const realFetch = globalThis.fetch
    globalThis.fetch = ((url, init) => {
      const u = String(url)
      if (!u.startsWith('http://127.0.0.1:19999/')) return realFetch(url, init)
      if (u.endsWith('/tts')) { writeFileSync(${JSON.stringify(calls)}, String(init.body)); return new Promise(() => {}) }
      return Promise.resolve(Response.json({engine:'qwen3'}))
    }) as typeof fetch
  `)
  let t = await startTwin(undefined, {}, preload)
  try {
    const access = join(t.state, 'access.json')
    writeFileSync(access, JSON.stringify({ ...JSON.parse(readFileSync(access, 'utf8')), voice: { enabled: true, python: process.execPath } }))
    writeFileSync(join(t.state, 'voice-daemon.json'), JSON.stringify({ port: 19999, token: 'placeholder' }))
    const p = await phone(t, '?voiceLater=1')
    await p.until(f => f.type === 'hello')
    const final = 'The final spoken bubble waits behind pacing while its synthesis intent is already safe.'
    await t.call('reply', { chat_id: 'app', text: `first\n\n${final}`, verbatim: true, voice: true })
    await p.until(f => f.type === 'message' && f.text === 'first')
    const state = JSON.parse(readFileSync(join(t.state, 'app-voice.json'), 'utf8'))
    expect(state.pending).toHaveLength(1)
    expect(state.pending[0][1]).toContain(final)
    expect(p.got.some(f => f.type === 'message' && f.text === final)).toBe(false)
    t = await t.restart()
    expect(await waitFor(() => { try { return readFileSync(calls, 'utf8').includes(final) } catch { return false } })).toBe(true)
  } finally { await t.stop(); rmSync(dir, { recursive: true }) }
}, 60_000)


test('non-app conversation replies succeed after persistence without app voice variables', async () => {
  const t = await startTwin()
  try {
    const groupResponse = await fetch(`${t.url}/app/groups`, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Reply regression', members: [] }) })
    expect(groupResponse.status).toBe(200)
    const group = await groupResponse.json() as { id: string }
    const result = await t.call('reply', { conversation_id: group.id, text: 'group reply' }) as any
    expect(result.isError).not.toBe(true)
    const message = JSON.parse(result.content[0].text)
    expect(message.text).toBe('group reply')
    const history = await (await fetch(`${t.url}/app/conversations/${group.id}/history`, { headers: { authorization: `Bearer ${t.token}` } })).json() as any
    expect(history.messages.filter((m: any) => m.text === 'group reply')).toHaveLength(1)
  } finally { await t.stop() }
}, 60_000)
