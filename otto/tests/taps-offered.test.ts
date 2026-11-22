import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { recordOffered, wasOffered } from '../dispatch.ts'

const STALE = 'That button is no longer on offer.'

test('the offer ledger answers only for exact data it recorded, and forgets after 30 days', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'otto-offers-')), 'tap-offers.json')
  const now = Date.parse('2026-11-15T09:00:00Z')
  expect(wasOffered(file, 'merge PR demo#1', now)).toBe(false)
  recordOffered(file, [{ data: 'merge PR demo#1' }, { url: 'https://example.com' }], now)
  expect(wasOffered(file, 'merge PR demo#1', now)).toBe(true)
  expect(wasOffered(file, 'merge PR demo#2', now)).toBe(false)
  expect(wasOffered(file, '__proto__', now)).toBe(false)
  expect(wasOffered(file, 'merge PR demo#1', now + 31 * 86_400_000)).toBe(false)
  recordOffered(file, [{ data: 'close PR demo#2' }], now + 31 * 86_400_000)
  expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')))).toEqual(['close PR demo#2'])
})

// taps.ts imports server.ts, so the taps run in a throwaway Otto process with its own HOME,
// state directory and a `gh` that fails, never in this test process.
test('every server-run tap refuses a button the session wrote and runs one the server offered', async () => {
  const home = mkdtempSync(join(tmpdir(), 'otto-taps-'))
  const state = join(home, '.otto', 'state'), bin = join(home, 'bin')
  mkdirSync(state, { recursive: true }); mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "gh: offline" >&2\nexit 1\n'); chmodSync(join(bin, 'gh'), 0o755)
  writeFileSync(join(state, 'access.json'), JSON.stringify({ dmPolicy: 'disabled', allowFrom: [], groups: {}, pending: {} }))

  const ledger = ['reel tried 00000001', 'merge PR demo#1', 'merge stack demo#3..#4', 'close PR demo#1', 'pulse more abc123',
    'snooze check-ins with Nobody for a month', 'stop check-ins with Nobody', 'review rulebook', 'delete rule abcdef12']
  const domain: Record<string, [string, () => void]> = {
    'return keep abcdef12': ['That purchase was not offered for return.', () => writeFileSync(join(state, 'money.json'), JSON.stringify([{ id: 'abcdef12', merchant: 'Shop', purchase: { item: 'lamp', returnAskedOn: '2026-11-14' } }]))],
    'decline capability flight-watch': ['That capability was not offered.', () => writeFileSync(join(state, 'runtime.json'), JSON.stringify({ surfaceState: { mentioned: { 'flight-watch': 1 } } }))],
  }
  const all = [...ledger, ...Object.keys(domain)]
  const run = async (): Promise<Record<string, string | null>> => {
    const script = `const { handleCapabilityButton } = await import(${JSON.stringify(join(import.meta.dir, '..', 'taps.ts'))})
      const out = {}
      for (const d of ${JSON.stringify(all)}) { try { out[d] = await handleCapabilityButton(d, 'app') } catch (e) { out[d] = 'threw: ' + e.message } }
      process.stdout.write('RESULT ' + JSON.stringify(out) + '\\n'); process.exit(0)`
    const p = Bun.spawn(['bun', '-e', script], { env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, OTTO_STATE_DIR: state }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })   // stdin EOF shuts the server down
    const text = await new Response(p.stdout).text()
    await p.exited
    const line = text.split('\n').find(l => l.startsWith('RESULT '))
    if (!line) throw new Error(`no result: ${text} ${await new Response(p.stderr).text()}`)
    return JSON.parse(line.slice(7))
  }

  // Session-written: nothing on record, so every verb is refused before its handler runs.
  const refused = await run()
  for (const d of ledger) expect([d, refused[d]]).toEqual([d, STALE])
  for (const [d, [stale]] of Object.entries(domain)) expect([d, refused[d]]).toEqual([d, stale])

  // Server-offered: the same data now reaches each handler.
  recordOffered(join(state, 'tap-offers.json'), ledger.map(data => ({ data })))
  for (const [, seed] of Object.values(domain)) seed()
  const offered = await run()
  for (const d of all) expect([d, offered[d]]).not.toEqual([d, STALE])
  expect(offered['reel tried 00000001']).toBe('That reel is no longer saved.')
  expect(offered['pulse more abc123']).toBe('That topic is already gone.')
  expect(offered['delete rule abcdef12']).toBe('that rule is already gone')
  expect(offered['merge PR demo#1']).toStartWith('threw:')   // reached GitHub, which the fake gh refuses
  expect(offered['return keep abcdef12']).toBe('Keeping it.')
  expect(JSON.parse(readFileSync(join(state, 'runtime.json'), 'utf8')).surfaceState.declined).toEqual(['flight-watch'])
}, 30_000)

// The ledger alone says "the server sent this data once"; the label is what the user trusts.
// So a reply the session writes may not carry server-run tap data at all, recorded or not,
// unless a tool just handed it that exact button to relay, and then only once.
test('a session reply cannot put server-run tap data on a button or card action', async () => {
  const { startTwin, phone } = await import('./apptwin.ts')
  const t = await startTwin()
  try {
    await phone(t)
    recordOffered(join(t.state, 'tap-offers.json'), [{ data: 'delete rule abcdef12' }, { data: 'stop check-ins with Sam' }])
    const send = (extra: Record<string, unknown>) => t.call('reply', { chat_id: 'app', text: 'noted', verbatim: true, ...extra }).then(r => JSON.stringify(r))

    // A recorded rulebook offer, re-sent under a friendlier label.
    expect(await send({ buttons: [{ label: 'Thanks', data: 'delete rule abcdef12' }] })).toContain('reserved button')
    expect(await send({ buttons: [{ label: 'ok', data: 'stop check-ins with Sam' }] })).toContain('reserved button')

    // Card actions get the same refusal, the reserved prefixes included; the text still goes out.
    const card = await send({ card: { blocks: [{ type: 'text', text: 'x' }], actions: [{ label: 'ok', data: 'merge PR demo#1' }, { label: 'Thanks', data: 'delete rule abcdef12' }, { label: 'later', data: 'remind me tomorrow' }] } })
    expect(card).toContain('actions[0].data: reserved button')
    expect(card).toContain('actions[1].data: reserved button')
    expect(card).not.toContain('actions[2]')

    // An ordinary session button is untouched.
    expect(await send({ buttons: [{ label: 'later', data: 'remind me tomorrow' }] })).not.toContain('reserved button')

    // Pulse cards are composed by the server and relayed by the session: allowed once, as handed over.
    writeFileSync(join(t.state, 'pulse.json'), JSON.stringify({ topics: [{ id: 'abc123', text: 'Topic', weight: 3, addedAt: '2026-11-01T00:00:00Z' }], seen: [], pending: [{ topicId: 'abc123', title: 'A', gist: 'g', url: 'https://example.com/a', date: '2026-11-14' }] }))
    const cards = JSON.parse((await t.call('pulse', { action: 'cards' }) as { content: { text: string }[] }).content[0].text)
    // A send the lint refuses leaves the offer in place, so the rewrite still carries it.
    const refused = await t.call('reply', { chat_id: 'app', text: 'the trigger fired', verbatim: true, buttons: cards.buttons })
    expect(JSON.stringify(refused)).toContain('not sent')
    expect(JSON.stringify(refused)).not.toContain('reserved button')
    // Only under the label the server gave it: a relayed button can't be renamed into a yes.
    expect(await send({ buttons: [{ ...cards.buttons[0], label: 'Thanks' }] })).toContain('reserved button')
    expect(await send({ buttons: cards.buttons, card: cards.card })).not.toContain('reserved button')
    expect(await send({ buttons: cards.buttons })).toContain('reserved button')
  } finally { await t.stop() }
}, 60_000)

// On Telegram the buttons attach in a second call. If that edit fails, the offer never reached the
// user, so it stays relayable: the session's resend with the same buttons must not be refused.
test('a relayed offer whose Telegram buttons failed to attach is not spent', async () => {
  const { startTwin } = await import('./apptwin.ts')
  const dir = mkdtempSync(join(tmpdir(), 'otto-relay-tg-')), preload = join(dir, 'tg.ts'), flag = join(dir, 'edit-fails')
  writeFileSync(flag, '')
  // grammy's fetch is bound before a preload runs, so the fake goes on its Api class (the server's own instance).
  writeFileSync(preload, `
    import { existsSync } from 'fs'
    import { Api } from ${JSON.stringify(Bun.resolveSync('grammy', join(import.meta.dir, '..')))}
    Api.prototype.sendMessage = async (chat_id, text) => ({ message_id: 7, date: 0, chat: { id: Number(chat_id), type: 'private' }, text })
    Api.prototype.editMessageReplyMarkup = async () => {
      if (existsSync(${JSON.stringify(flag)})) throw new Error('Bad Request: message to edit not found')
      return true
    }
  `)
  const t = await startTwin(undefined, {}, preload)
  try {
    const access = JSON.parse(readFileSync(join(t.state, 'access.json'), 'utf8'))
    writeFileSync(join(t.state, 'access.json'), JSON.stringify({ ...access, allowFrom: ['1234567890'] }))
    writeFileSync(join(t.state, 'pulse.json'), JSON.stringify({ topics: [{ id: 'abc123', text: 'Topic', weight: 3, addedAt: '2026-11-01T00:00:00Z' }], seen: [], pending: [{ topicId: 'abc123', title: 'A', gist: 'g', url: 'https://example.com/a', date: '2026-11-14' }] }))
    const cards = JSON.parse((await t.call('pulse', { action: 'cards' }) as { content: { text: string }[] }).content[0].text)
    const send = () => t.call('reply', { chat_id: '1234567890', text: 'noted', buttons: cards.buttons }).then(r => JSON.stringify(r))

    const failed = await send()
    expect(failed).toContain('buttons failed to attach')
    rmSync(flag)
    const resent = await send()
    expect(resent).not.toContain('reserved button')
    expect(resent).not.toContain('buttons failed to attach')
    // Attached this time, so it is spent.
    expect(await send()).toContain('reserved button')
  } finally { await t.stop() }
}, 60_000)
