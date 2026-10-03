import { test, expect } from 'bun:test'
import {
  mineRepetitions,
  inferCron,
  isRequest,
  alreadyArmed,
  tokenize,
  literals,
  formatOffer,
  persistPayload,
  declinedIds,
  type HistoryLine,
} from '../repetition.ts'

const TZ = 'America/Argentina/Buenos_Aires' // ART, UTC−3 — where the user actually is
const OPTS = { tz: TZ, chatId: '1234567890' }

/** ART wall-clock helper: 08:15 ART on day N is 11:15Z. */
function at(day: number, hh: number, mm = 0): string {
  return new Date(Date.UTC(2026, 6, day, hh + 3, mm)).toISOString()
}
function inb(ts: string, text: string): HistoryLine {
  return { ts, dir: 'in', text, kind: 'text' }
}
function outb(ts: string, text: string): HistoryLine {
  return { ts, dir: 'out', text, kind: 'text' }
}

test('acknowledgements and reactions are not asks', () => {
  for (const t of ['ok', '👍', 'thanks', 'yep', 'done', '!']) {
    expect(isRequest(inb(at(1, 9), t))).toBe(false)
  }
  expect(isRequest(inb(at(1, 9), 'what happened with the nocturne build'))).toBe(true)
})

test("Otto's own messages never count as the user’s requests", () => {
  expect(isRequest(outb(at(1, 9), 'check the nocturne ci status please'))).toBe(false)
})

test('chatter is stripped, content survives', () => {
  expect(tokenize('hey can you please check the nocturne CI again')).toEqual(['check', 'nocturne', 'ci'])
})

test('URLs and quoted phrases are kept verbatim as parameters', () => {
  expect(literals('watch https://shop.example/x-1 for me')).toEqual(['https://shop.example/x-1'])
  expect(literals('search for "series A fintech" today')).toEqual(['series A fintech'])
})

test('three same-shape asks become one candidate', () => {
  const lines = [
    inb(at(1, 8, 20), 'any news on the nocturne CI build?'),
    inb(at(2, 8, 25), 'whats the nocturne CI build doing'),
    inb(at(3, 8, 30), 'check nocturne CI build for me'),
  ]
  const [c] = mineRepetitions(lines, OPTS)
  expect(c.count).toBe(3)
  expect(c.shape).toContain('nocturne')
  expect(c.shape).toContain('ci')
  expect(c.examples).toHaveLength(3)
})

test('two asks are not a pattern', () => {
  const lines = [
    inb(at(1, 8, 20), 'any news on the nocturne CI build?'),
    inb(at(2, 8, 25), 'whats the nocturne CI build doing'),
  ]
  expect(mineRepetitions(lines, OPTS)).toEqual([])
})

// The failure this guards: three unrelated messages clustering on "the" and
// arming a trigger about nothing.
test('unrelated messages do not cluster', () => {
  const lines = [
    inb(at(1, 8), 'whats the weather in florianopolis'),
    inb(at(2, 14), 'did marco reply about the contract'),
    inb(at(3, 19), 'play something by caetano'),
  ]
  expect(mineRepetitions(lines, OPTS)).toEqual([])
})

test('the shape is what every instance shares, not most of them', () => {
  const lines = [
    inb(at(1, 8, 10), 'nocturne CI build status and the swiftpm step'),
    inb(at(2, 8, 15), 'nocturne CI build status'),
    inb(at(3, 8, 20), 'nocturne CI build status please'),
  ]
  const [c] = mineRepetitions(lines, OPTS)
  expect(c.shape).not.toContain('swiftpm')
  expect(c.shape).toEqual(['build', 'ci', 'nocturne', 'statu'])
})

test('the cron fires a little before the earliest time the user asked', () => {
  // 08:20, 08:25, 08:30 ART on 1–3 July 2026 (Wed/Thu/Fri) → 08:10, weekdays.
  const cron = inferCron([at(1, 8, 20), at(2, 8, 25), at(3, 8, 30)].map(Date.parse), TZ)
  expect(cron).toBe('10 8 * * 1-5')
})

test('an ask that lands on a weekend widens the day spec rather than narrowing it', () => {
  // 3, 4, 6 July 2026 are Fri, Sat, Mon.
  const cron = inferCron([at(3, 8, 20), at(4, 8, 25), at(6, 8, 30)].map(Date.parse), TZ)
  expect(cron).toBe('10 8 * * *')
})

test('same-weekday asks become a weekly cron', () => {
  // 5, 12, 19 July 2026 are all Sundays.
  const cron = inferCron([at(5, 19, 0), at(12, 19, 10), at(19, 19, 5)].map(Date.parse), TZ)
  expect(cron).toBe('50 18 * * 0')
})

test('weekday-only asks become a weekday cron', () => {
  // 6, 8, 10 July 2026 are Mon, Wed, Fri.
  const cron = inferCron([at(6, 9, 30), at(8, 9, 40), at(10, 9, 35)].map(Date.parse), TZ)
  expect(cron).toBe('20 9 * * 1-5')
})

test('asks scattered across the day produce no cron rather than a guess', () => {
  expect(inferCron([at(1, 7), at(2, 14), at(3, 21)].map(Date.parse), TZ)).toBeUndefined()
})

test('parameters come from the user’s words, not a paraphrase', () => {
  const lines = [
    inb(at(1, 10, 0), 'check https://shop.example/x-1 price'),
    inb(at(2, 10, 5), 'price check on https://shop.example/x-1'),
    inb(at(3, 10, 10), 'is https://shop.example/x-1 price down yet'),
  ]
  const [c] = mineRepetitions(lines, OPTS)
  expect(c.literals).toEqual(['https://shop.example/x-1'])
  expect(c.draftAction).toContain('https://shop.example/x-1')
  expect(c.draftAction).toContain('1234567890')
  expect(c.draftAction).toContain('send nothing')
})

test('a pattern the user already armed is not offered again', () => {
  const lines = [
    inb(at(1, 8, 20), 'any news on the nocturne CI build?'),
    inb(at(2, 8, 25), 'whats the nocturne CI build doing'),
    inb(at(3, 8, 30), 'check nocturne CI build for me'),
  ]
  const armed = ['Check the nocturne CI build status and report failures']
  expect(mineRepetitions(lines, { ...OPTS, armed })).toEqual([])
  expect(alreadyArmed(['nocturne', 'ci', 'build'], armed)).toBe(true)
  expect(alreadyArmed(['landlord', 'contract'], armed)).toBe(false)
})

test('the since window drops habits the user has moved on from', () => {
  const lines = [
    inb(at(1, 8, 20), 'nocturne CI build status'),
    inb(at(2, 8, 25), 'nocturne CI build status'),
    inb(at(3, 8, 30), 'nocturne CI build status'),
  ]
  expect(mineRepetitions(lines, { ...OPTS, since: Date.parse(at(3, 0)) })).toEqual([])
})

test('clustering is deterministic under reordering of the input', () => {
  const lines = [
    inb(at(3, 8, 30), 'check nocturne CI build for me'),
    inb(at(1, 8, 20), 'any news on the nocturne CI build?'),
    inb(at(2, 8, 25), 'whats the nocturne CI build doing'),
  ]
  const a = mineRepetitions(lines, OPTS)
  const b = mineRepetitions([...lines].reverse(), OPTS)
  expect(a.map(c => c.key)).toEqual(b.map(c => c.key))
  expect(a[0].askedAt).toEqual(b[0].askedAt)
})

test('the offer quotes the count and the times, and carries two buttons', () => {
  const lines = [
    inb(at(1, 8, 20), 'any news on the nocturne CI build?'),
    inb(at(2, 8, 25), 'whats the nocturne CI build doing'),
    inb(at(3, 8, 30), 'check nocturne CI build for me'),
  ]
  const c = mineRepetitions(lines, OPTS)[0]
  const offer = formatOffer(c)
  expect(offer.text).toContain('3 times')
  expect(offer.text).toContain('08:20')
  expect(offer.buttons).toHaveLength(2)
  // Telegram callback data is capped at 60 UTF-8 bytes. A truncated payload is
  // a button that does something *different* when tapped three weeks later, so
  // the data carries a key and the draft is persisted alongside it.
  for (const b of offer.buttons) {
    expect(Buffer.byteLength(b.data, 'utf8')).toBeLessThanOrEqual(60)
    expect(b.data).toContain(c.id)
  }
  expect(persistPayload(c).text).toContain(c.draftAction)
  expect(persistPayload(c).tags).toContain(c.id)
})

test('the candidate id is stable across runs', () => {
  const lines = [
    inb(at(1, 8, 20), 'any news on the nocturne CI build?'),
    inb(at(2, 8, 25), 'whats the nocturne CI build doing'),
    inb(at(3, 8, 30), 'check nocturne CI build for me'),
  ]
  expect(mineRepetitions(lines, OPTS)[0].id).toBe(mineRepetitions(lines, OPTS)[0].id)
  expect(mineRepetitions(lines, OPTS)[0].id).toMatch(/^[0-9a-f]{8}$/)
})

test('more-repeated candidates are offered first', () => {
  const lines = [
    inb(at(1, 8, 20), 'nocturne CI build status'),
    inb(at(2, 8, 25), 'nocturne CI build status'),
    inb(at(3, 8, 30), 'nocturne CI build status'),
    inb(at(4, 8, 22), 'nocturne CI build status'),
    inb(at(1, 15, 0), 'marco landlord contract signed'),
    inb(at(2, 15, 5), 'marco landlord contract signed'),
    inb(at(3, 15, 10), 'marco landlord contract signed'),
  ]
  const out = mineRepetitions(lines, OPTS)
  expect(out).toHaveLength(2)
  expect(out[0].count).toBe(4)
})

test('a pattern the user declined is never offered again', () => {
  const lines = [
    inb(at(1, 8, 20), 'any news on the nocturne CI build?'),
    inb(at(2, 8, 25), 'whats the nocturne CI build doing'),
    inb(at(3, 8, 30), 'check nocturne CI build for me'),
  ]
  const [c] = mineRepetitions(lines, OPTS)
  expect(c).toBeDefined()
  expect(mineRepetitions(lines, { ...OPTS, declined: [c.id] })).toEqual([])
  // Someone else's decline is not theirs.
  expect(mineRepetitions(lines, { ...OPTS, declined: ['deadbeef'] })).toHaveLength(1)
})

test('the offer note is tagged the way the button handler looks it up', () => {
  const lines = [
    inb(at(1, 8, 20), 'any news on the nocturne CI build?'),
    inb(at(2, 8, 25), 'whats the nocturne CI build doing'),
    inb(at(3, 8, 30), 'check nocturne CI build for me'),
  ]
  const [c] = mineRepetitions(lines, OPTS)
  expect(persistPayload(c).tags).toContain(`repetition:${c.id}`)
  // formatOffer's buttons carry that same id, or the tap resolves to nothing.
  expect(formatOffer(c).buttons.map(b => b.data).join(' ')).toContain(c.id)
})

test('a decline is recognised however it was written down', () => {
  // The button handler's fact.
  expect(declinedIds([{ tags: ['repetition-declined', 'repetition:aaaaaaaa'] }])).toEqual(['aaaaaaaa'])
  // A hand-written session note under the old tag scheme.
  expect(declinedIds([{ tags: ['repetition', 'bbbbbbbb', 'declined'] }])).toEqual(['bbbbbbbb'])
  // The offer note itself, closed as dropped.
  expect(declinedIds([{ tags: ['repetition', 'repetition:cccccccc', 'cccccccc'], status: 'dropped' }]))
    .toEqual(['cccccccc'])
  // An offer still open is not a decline.
  expect(declinedIds([{ tags: ['repetition', 'dddddddd'], status: 'open' }])).toEqual([])
  // Notes about anything else are left alone.
  expect(declinedIds([{ tags: ['landlord', 'declined'] }])).toEqual([])
})
