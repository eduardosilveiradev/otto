import { test, expect } from 'bun:test'
import {
  minePromises, ownText, guessLang, resolveDue, sentDay, commitmentLoops, PROMISE_TAG,
  type Commitment, type Lang,
} from '../commitments.ts'
import { upsertNote, type Note } from '../store.ts'

// A Tuesday. Friday is the 16th, next Monday the 19th.
const SENT = '2026-10-13T10:00:00+02:00'
const TO = 'you@example.com'

function mine(text: string, lang?: Lang): Commitment[] {
  return minePromises(text, { sentAt: SENT, to: TO, ...(lang ? { lang } : {}) })
}

// ---------------------------------------------------------------------------
// Promises — each should come back exactly once, with this due date
// ---------------------------------------------------------------------------

const PROMISES: [string, Lang | undefined, string | undefined, string?][] = [
  // [body, lang, due, text the clause should contain]
  ["I'll send it by Friday.", undefined, '2026-10-16', "I'll send it by Friday"],
  ['Let me check and get back to you.', undefined, undefined, 'Let me check'],
  ["Thanks for the call, I'll send the deck tomorrow.", undefined, '2026-10-14', "I'll send the deck tomorrow"],
  ['I will forward the contract next week.', 'en', '2026-10-19'],
  ["I'm going to review the draft by the end of the week.", 'en', '2026-10-16'],
  ["I'll have the numbers to you on 20 October.", 'en', '2026-10-20'],
  ["I'll call you the day after tomorrow.", 'en', '2026-10-15'],
  ["Leave it with me, I'll sort the invoice in 3 days.", 'en', '2026-10-16'],
  ["I'll send the slides next Friday.", 'en', '2026-10-23'],
  ['Ti mando tutto entro venerdì.', undefined, '2026-10-16', 'Ti mando tutto entro venerdì'],
  ['Ci penso io.', undefined, undefined, 'Ci penso io'],
  ['Domani ti giro il preventivo.', 'it', '2026-10-14'],
  ['Controllo e ti faccio sapere dopodomani.', 'it', '2026-10-15'],
  ['Te lo mando la settimana prossima, promesso.', 'it', '2026-10-19'],
  ['Ok, me ne occupo io entro fine mese.', 'it', '2026-10-31', 'Me ne occupo io'],
  ['Manderò il file tra 2 giorni.', 'it', '2026-10-15'],
  ['Te mando amanhã.', undefined, '2026-10-14', 'Te mando amanhã'],
  ['Vou ver e te falo.', undefined, undefined, 'Vou ver e te falo'],
  ['Pode deixar, envio o contrato até sexta.', 'pt', '2026-10-16'],
  ['Te passo os dados semana que vem.', 'pt', '2026-10-19'],
  ['Vou mandar o orçamento hoje à noite.', 'pt', '2026-10-13'],
  ['Retornarei a ligação depois de amanhã.', 'pt', '2026-10-15'],
  ['Te envio o relatório até 25 de outubro.', 'pt', '2026-10-25'],
]

for (const [body, lang, due, contains] of PROMISES) {
  test(`promise: ${body}`, () => {
    const got = mine(body, lang)
    expect(got).toHaveLength(1)
    expect(got[0].to).toBe(TO)
    if (due) expect(got[0].due).toBe(due)
    else expect(got[0].due).toBeUndefined()
    if (contains) expect(got[0].text).toContain(contains)
  })
}

// ---------------------------------------------------------------------------
// Not promises — nothing should come back
// ---------------------------------------------------------------------------

const NOT_PROMISES: [string, string, Lang?][] = [
  ['question', 'Should I send it by Friday?'],
  ['question with a promise verb', "Shall I send it tomorrow? I'll wait for your answer."],
  ['conditional in front', "If you need it, I'll send it tomorrow."],
  ['conditional behind', "I'll send the deck unless Marco already did."],
  ['hedge', "Maybe I'll call you on Monday."],
  ['someone else', 'Marco will send it by Friday.'],
  ['reported speech', "He promised I'll have it by Monday."],
  ['let me know asks them', 'Let me know when you are free.'],
  ['a state, not a deed', "I'll be away next week."],
  ['quoted words', 'She wrote "I\'ll send the invoice tomorrow" in her last mail.'],
  ['it: question', 'Vuoi che te lo mandi venerdì?'],
  ['it: conditional', 'Se ti serve, ti mando tutto domani.'],
  ['it: someone else', 'Marco ha detto che ti manda tutto domani.'],
  ['it: conditional mood', 'Forse lo manderei lunedì.'],
  ['it: however is not a future', 'Però il file non è pronto.'],
  ['pt: question', 'Quer que eu te mande amanhã?'],
  ['pt: conditional', 'Se precisar, te mando amanhã.'],
  ['pt: someone else', 'Ele disse que vai te mandar amanhã.'],
  ['pt: negated', 'Não vou conseguir mandar hoje.'],
  ['pt: travel, not a promise', 'Vou para Lisboa amanhã.'],
]

for (const [why, body, lang] of NOT_PROMISES) {
  test(`not a promise (${why}): ${body}`, () => {
    expect(mine(body, lang)).toEqual([])
  })
}

// ---------------------------------------------------------------------------
// Only the user's own words
// ---------------------------------------------------------------------------

test('a promise in the quoted reply below is the other side\'s, not the user\'s', () => {
  const body = [
    'Sounds good, thanks.',
    '',
    'On Mon, 12 Oct 2026 at 18:02, Someone <someone@example.com> wrote:',
    "> I'll send you the signed copy tomorrow.",
  ].join('\n')
  expect(mine(body)).toEqual([])
  expect(ownText(body)).toBe('Sounds good, thanks.')
})

test('italian and portuguese reply headers cut the quote too', () => {
  const it = 'Perfetto.\n\nIl giorno lun 12 ott 2026 alle 18:02 Someone ha scritto:\nTi mando tutto domani.'
  const pt = 'Beleza.\n\nEm seg., 12 de out. de 2026 às 18:02, Someone escreveu:\nTe mando amanhã.'
  expect(mine(it)).toEqual([])
  expect(mine(pt)).toEqual([])
})

test('a signature is cut at the sign-off, and its tagline promises nothing', () => {
  const body = "Ti mando il contratto domani.\n\nUn saluto\nSomeone\nWe'll get back to you within 24 hours."
  const got = mine(body)
  expect(got).toHaveLength(1)
  expect(got[0].text).toBe('Ti mando il contratto domani')
  expect(ownText('Thanks!\nSent from my iPhone')).toBe('Thanks!')
})

test('two promises in one message come back separately, a question between them does not', () => {
  const body = "I'll send the deck tomorrow. Does Thursday work for the call? Let me check the budget and get back to you by Friday."
  const got = mine(body)
  expect(got.map(c => c.due)).toEqual(['2026-10-14', '2026-10-16'])
})

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

test('the sent day is the sender\'s own, not UTC', () => {
  // 23:30 in Buenos Aires is already the next day in UTC; "amanhã" is the 14th.
  const late = minePromises('Te mando amanhã.', { sentAt: '2026-10-13T23:30:00-03:00', to: TO })
  expect(late[0].due).toBe('2026-10-14')
  expect(sentDay('Tue, 13 Oct 2026 23:30:00 -0300')).toEqual({ y: 2026, m: 10, d: 13 })
  expect(sentDay('2026-10-13')).toEqual({ y: 2026, m: 10, d: 13 })
})

test('a weekday named on that same weekday means next week', () => {
  const base = { y: 2026, m: 10, d: 13 }
  expect(resolveDue('by Tuesday', 'en', base)).toBe('2026-10-20')
  expect(resolveDue('entro venerdì prossimo', 'it', base)).toBe('2026-10-23')
  expect(resolveDue('até a próxima sexta', 'pt', base)).toBe('2026-10-23')
})

test('a month and day already past roll into next year', () => {
  expect(resolveDue('by 5 January', 'en', { y: 2026, m: 12, d: 28 })).toBe('2027-01-05')
})

test('03/04 is unreadable in english, and dd/mm in italian', () => {
  const base = { y: 2026, m: 10, d: 13 }
  expect(resolveDue('by 03/04', 'en', base)).toBeUndefined()
  expect(resolveDue('entro il 20/10', 'it', base)).toBe('2026-10-20')
})

test('an invalid sentAt throws instead of inventing a date', () => {
  expect(() => minePromises("I'll send it.", { sentAt: 'yesterday-ish', to: TO })).toThrow()
})

test('language guess', () => {
  expect(guessLang('Grazie, ti mando tutto domani')).toBe('it')
  expect(guessLang('Obrigado, te mando amanhã')).toBe('pt')
  expect(guessLang("Thanks, I'll send it tomorrow")).toBe('en')
  expect(guessLang('ok')).toBeUndefined()
})

// ---------------------------------------------------------------------------
// Filing
// ---------------------------------------------------------------------------

test('promises become open loops sourced to the message', () => {
  const notes: Note[] = []
  const found = mine("I'll send the deck tomorrow. Let me check the budget.")
  const { added, already } = commitmentLoops(notes, 'msg-1', found)
  expect(already).toBe(false)
  expect(added).toHaveLength(2)
  expect(notes).toHaveLength(2)
  for (const n of notes) {
    expect(n.kind).toBe('loop')
    expect(n.status).toBe('open')
    expect(n.source).toBe('email:msg-1')
    expect(n.tags).toContain(PROMISE_TAG)
    expect(n.text).toContain(`promised to ${TO}`)
  }
  expect(notes[0].due).toBe('2026-10-14')
  expect(notes[1].due).toBeUndefined()
})

test('re-reading the same message files nothing, even after a loop was closed', () => {
  const notes: Note[] = []
  const found = mine('Ti mando tutto entro venerdì.')
  commitmentLoops(notes, 'msg-2', found)
  upsertNote(notes, { id: notes[0].id, status: 'done' })
  const again = commitmentLoops(notes, 'msg-2', found)
  expect(again.already).toBe(true)
  expect(again.added).toEqual([])
  expect(notes).toHaveLength(1)
})

test('a loop from the same message that is not a promise does not block mining', () => {
  const notes: Note[] = []
  upsertNote(notes, { kind: 'loop', text: 'reply to the thread', source: 'email:msg-3', tags: [] })
  const { added } = commitmentLoops(notes, 'msg-3', mine('Te mando amanhã.'))
  expect(added).toHaveLength(1)
})

test('a "Thanks!" line mid-message is not the signature', () => {
  expect(ownText("Hi Marco,\nThanks!\nI'll send it tomorrow.")).toBe("Hi Marco,\nThanks!\nI'll send it tomorrow.")
  expect(ownText('Ciao,\ngrazie.\nTi mando tutto entro venerdì.\n\nGrazie\nLuca')).toBe('Ciao,\ngrazie.\nTi mando tutto entro venerdì.')
  // Followed by a name, or by nothing, it still closes the message.
  expect(ownText("I'll call you Monday.\nThanks!\nAlex Doe\nSome Company, Ltd.")).toBe("I'll call you Monday.")
  expect(ownText("I'll call you Monday.\n\nThanks!")).toBe("I'll call you Monday.")
  expect(minePromises("Hi Marco,\nThanks!\nI'll send it tomorrow.", { sentAt: 'Wed, 14 Oct 2026 10:00:00 +0200', to: 'Marco' }).length).toBe(1)
})
