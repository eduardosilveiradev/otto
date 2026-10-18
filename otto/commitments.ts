/**
 * Promises made in sent mail.
 *
 * The inbox scan catches what other people ask of the user. It never sees the
 * other half: "I'll send it by Friday" is written by the user, goes out, and is
 * forgotten by everyone except the person waiting for it. That is the loop
 * that hurts most when it slips, because the user is the one who broke it.
 *
 * This reads one sent message and returns the first-person commitments in it,
 * in English, Italian and Portuguese, each with a due date when the sentence
 * names one. It is deliberately narrow:
 *
 *   Only the user's own words. Quoted replies, forwarded blocks and signatures
 *   are cut before anything is read — a promise the other side made, quoted
 *   back underneath, is theirs.
 *
 *   Only first person. "Marco will send it" and "ele te manda amanhã" are not
 *   the user's promise; neither is reported speech or anything in quotes.
 *
 *   Only firm ones. A question ("should I send it Friday?"), a conditional ("if
 *   you need it I'll send it") or a hedge ("maybe I'll call") is not a promise,
 *   and a loop built on one is a loop the user never agreed to carry.
 *
 * Missing a promise costs one forgotten email. Inventing one costs a nag about
 * something the user never said they would do, which is worse, so every rule
 * here errs toward silence.
 *
 * Due dates are resolved against the day the mail was sent, in the sender's own
 * offset — "tomorrow" written at 23:30 in one country is not tomorrow in UTC.
 * Pure: no clock, no files. Filing the results as loops is commitmentLoops().
 */

import { upsertNote, type Note } from './store.ts'

export type Lang = 'en' | 'it' | 'pt'

export type Commitment = {
  /** The promise in the user's own words, trimmed to its clause. */
  text: string
  /** YYYY-MM-DD, resolved relative to sentAt. Absent when no date was named. */
  due?: string
  /** Who it was made to — the recipient as the caller passed it. */
  to: string
}

export type MineOpts = {
  /** When the mail was sent. An explicit offset ("+02:00", "-0300") sets the
   * local day; without one the machine's zone does. */
  sentAt: string
  to: string
  /** Skip detection when the caller already knows. */
  lang?: Lang
}

// ---------------------------------------------------------------------------
// Words. \b is ASCII-only in JS, and half these words end in ã or ì, so every
// pattern is wrapped in letter-aware boundaries instead.
// ---------------------------------------------------------------------------

const L = '\\p{L}'
const word = (src: string, flags = 'iu') => new RegExp(`(?<![${L}'’])(?:${src})(?![${L}])`, flags)

// ---------------------------------------------------------------------------
// Stripping what the user did not write
// ---------------------------------------------------------------------------

/** Where a reply's quoted history starts. Everything from here down is theirs. */
const QUOTE_STARTS: RegExp[] = [
  /^[ \t]*On\b[^\n]*(?:\n[^\n]*)?\bwrote:[ \t]*$/im,
  /^[ \t]*Il giorno\b[^\n]*(?:\n[^\n]*)?\bha scritto:[ \t]*$/im,
  /^[ \t]*Em\b[^\n]*(?:\n[^\n]*)?\bescreveu:[ \t]*$/im,
  /^[ \t]*-{2,}\s*(?:Original Message|Messaggio originale|Mensagem original)\s*-{2,}/im,
  /^[ \t]*-{2,}\s*(?:Forwarded message|Messaggio inoltrato|Mensagem encaminhada)\s*-{2,}/im,
  /^[ \t]*(?:Begin forwarded message|Inizio messaggio inoltrato|Início da mensagem encaminhada):?/im,
  /^[ \t]*_{8,}[ \t]*$/m,
  /^[ \t]*(?:From|Da|De):[^\n]+\n[ \t]*(?:Sent|Date|Inviato|Data|Enviado|Enviada):/im,
]

/** A line that ends the user's own text: the signature marker, a mobile footer,
 * or a sign-off standing alone on its line. */
const SIGNATURE_LINE = new RegExp(
  '^(?:--\\s*' +
    '|(?:sent from|get outlook for|inviato da|enviado d[oe]|enviado a partir d[oe])\\b.*' +
    '|(?:best|best regards|kind regards|regards|warm regards|cheers|thanks|thank you|many thanks|all the best|talk soon' +
    '|saluti|cordiali saluti|un saluto|grazie|grazie mille|a presto|un abbraccio|baci' +
    '|abraço|abraços|abs|beijos|bjs|att|atenciosamente|obrigad[oa]|até mais|até logo)[,.!]*\\s*)$',
  'iu',
)

/** A thank-you is often a line of the message ("Thanks!\nI'll send it Friday."),
 * not its close, so it only ends the text when nothing, a name, or another
 * signature marker comes after it. */
const THANKS_LINE = /^(?:thanks|thank you|many thanks|grazie|grazie mille|obrigad[oa])[,.!]*\s*$/iu
const NAME_LINE = /^\p{Lu}[\p{L}'’.-]*(?:\s+\p{Lu}[\p{L}'’.-]*){0,3}$/u

function closesHere(lines: string[], i: number): boolean {
  const l = lines[i].trim()
  if (!SIGNATURE_LINE.test(l)) return false
  if (!THANKS_LINE.test(l)) return true
  const next = lines.slice(i + 1).map(x => x.trim()).find(Boolean)
  return next === undefined || NAME_LINE.test(next) || SIGNATURE_LINE.test(next)
}

/** The part of a sent message the user actually wrote. */
export function ownText(body: string): string {
  let text = body.replace(/\r\n?/g, '\n')
  let cut = text.length
  for (const re of QUOTE_STARTS) {
    const m = re.exec(text)
    if (m && m.index < cut) cut = m.index
  }
  text = text.slice(0, cut)
  const lines = text.split('\n').filter(l => !/^\s*>/.test(l))
  // A sign-off as the very first line is a one-word email, not a signature.
  const sig = lines.findIndex((_, i) => i > 0 && closesHere(lines, i))
  return (sig >= 0 ? lines.slice(0, sig) : lines).join('\n').trim()
}

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------

const LANG_HINTS: Record<Lang, RegExp> = {
  en: word("the|and|you|to|is|thanks|will|i'll|i’ll|tomorrow|let me|get back"),
  it: word('io|ci|ti|che|il|non|per|grazie|ciao|domani|entro|sono|della|perché|tutto|mando|penso'),
  pt: word('eu|você|voce|não|que|obrigad[oa]|amanhã|até|para|com|vou|falo|mando|deixa|pode'),
}
const LANG_MARKS: Record<Lang, RegExp> = {
  en: /(?!)/,
  it: /[èìò]/u,
  pt: /[ãõç]/u,
}

/** Best guess at the message's language, or undefined when it is too short or
 * too mixed to say — then every language is tried. */
export function guessLang(text: string): Lang | undefined {
  const score = (l: Lang) =>
    (text.match(new RegExp(LANG_HINTS[l].source, 'giu'))?.length ?? 0) +
    (text.match(new RegExp(LANG_MARKS[l].source, 'gu'))?.length ?? 0)
  const ranked = (['en', 'it', 'pt'] as Lang[])
    .map(l => ({ l, s: score(l) }))
    .sort((a, b) => b.s - a.s)
  if (!ranked[0].s || ranked[0].s === ranked[1].s) return undefined
  return ranked[0].l
}

// ---------------------------------------------------------------------------
// What a promise looks like
// ---------------------------------------------------------------------------

type Grammar = {
  /** Openings of a first-person commitment. The match start is where the
   * promise's clause starts. */
  promise: RegExp[]
  /** Anything that makes the sentence not a firm promise of the user's own. */
  conditional: RegExp
  hedge: RegExp
  /** Reported speech before the promise: someone else's words. */
  reported: RegExp
  /** "not" and friends right before the promise. */
  negation: RegExp
}

// "I'll be away", "I'll need", "I'll think about it": first person and future,
// but a state or a wish, not something owed to anyone.
const EN_NOT_A_DEED =
  "be(?!\\s+there|\\s+in touch|\\s+sure)|need|miss|probably|likely|think|assume|guess|wait|see you|have to wait|never|not|let you down"
const EN_PROMISE = [
  new RegExp(`(?<![${L}'’])(?:i['’]ll|i will|i shall|i['’]m going to|i am going to|i['’]m gonna)\\s+(?!(?:${EN_NOT_A_DEED})(?![${L}]))(?=[${L}])`, 'iu'),
  // "Let me know" asks them; "let me check" commits the user.
  word('let me\\s+(?:check|look|see|confirm|find out|ask|dig|verify|get back|circle back|take care|sort|handle|follow up)'),
  word("(?:i['’]m on it|leave it with me|consider it done|will do|i promise)"),
]

const IT_VERBS =
  'mando|invio|spedisco|giro|inoltro|faccio sapere|scrivo|richiamo|chiamo|aggiorno|confermo|rispondo|preparo|porto|passo|dico|sistemo|controllo|verifico'
const IT_PROMISE = [
  // "ti mando", "te lo mando", "glielo giro", "vi faccio sapere"
  word(`(?:(?:ti|vi|le|gli|te|ve)\\s+(?:lo|la|li|le|ne)\\s+|glie(?:lo|la|li|le|ne)\\s+|(?:ti|vi|gli|le)\\s+)(?:${IT_VERBS})`),
  // Bare first person, said as a future: "domani mando tutto". Only the
  // verbs that are never nouns — "invio" is also "the sending".
  word('(?:io\\s+)?(?:mando|spedisco)'),
  // Future tense, first person singular: manderò, farò, ti dirò. Not "però"
  // (however) and not the ones that promise a state rather than a deed.
  new RegExp(`(?<![${L}])(?!(?:però|sarò|potrò|vorrò|dovrò)(?![${L}]))[${L}]+rò(?![${L}])`, 'iu'),
  word('ci penso io|me ne occupo(?:\\s+io)?|mi occupo|lo faccio io|provvedo(?:\\s+io)?|ci sto|vado a vedere|ti prometto'),
]

const PT_VERBS =
  'mando|envio|passo|falo|aviso|ligo|retorno|respondo|confirmo|digo|encaminho|escrevo|chamo|atualizo|levo|trago'
// "vou estar", "vou viajar": going somewhere or being something, not doing it.
const PT_NOT_A_DEED = 'estar|ser|viajar|ficar|precisar|sair|embora|para|pra|a|ao|à|na|no|em'
const PT_PROMISE = [
  word(`(?:te|lhe|lhes|vos)\\s+(?:${PT_VERBS})|(?:${PT_VERBS})-(?:te|lhe|lhes|vos)`),
  word(`(?:eu\\s+)?vou\\s+(?!(?:${PT_NOT_A_DEED})(?![${L}]))(?:te\\s+|lhe\\s+|me\\s+)?[${L}]+(?:ar|er|ir|or)`),
  word('eu\\s+(?:mando|envio|vejo|cuido|resolvo|faço|levo|trago|passo|verifico|confirmo)'),
  // Future tense, first person singular: mandarei, retornarei. Named, not
  // matched by ending: "farei" and "direi" are also Italian for "I would", so
  // those two count only with a subject or a pronoun in front.
  word('mandarei|enviarei|retornarei|ligarei|avisarei|passarei|responderei|escreverei|verei|resolverei|levarei|trarei|confirmarei|encaminharei|(?:eu|te|lhe)\\s+(?:farei|direi)'),
  word('deixa comigo|pode deixar|fica comigo|fico de|me comprometo|eu cuido disso|prometo'),
]

const GRAMMARS: Record<Lang, Grammar> = {
  en: {
    promise: EN_PROMISE,
    // "check if" and "see if" are a question the user will answer, not a condition.
    conditional: word('(?<!(?:check|see|ask|know|confirm|find out|verify)\\s+)(?:if|unless|in case|provided|as long as|should you)'),
    hedge: word("maybe|perhaps|might|may(?!\\s+\\d)|probably|possibly|could|would|i['’]d|hopefully|i hope|i think i['’]ll|not sure"),
    reported: word("(?!i(?![\\p{L}]))[\\p{L}]+\\s+(?:said|says|told (?:me|us|them|him|her)|promised|mentioned)"),
    negation: /(?:not|never|n['’]t)\s+$/iu,
  },
  it: {
    promise: IT_PROMISE,
    conditional: word('(?<!(?:vedo|vedere|controllo|controllare|verifico|verificare|sapere|so|chiedo|capire|capisco)\\s+)(?:se|qualora|nel caso|casomai|caso mai|a meno che|purché)'),
    // Conditional mood (-rei, -resti) is a wish, not a promise.
    hedge: word(`forse|magari|probabilmente|potrei|dovrei|vorrei|spero|penso di|credo di|[${L}]+(?:erei|irei|arei)`),
    reported: word('(?:ha|hanno)\\s+detto|dice\\s+che|dicono\\s+che|ha\\s+promesso|secondo\\s+(?:lui|lei|loro)'),
    negation: /(?:non|mai)\s+$/iu,
  },
  pt: {
    promise: PT_PROMISE,
    conditional: word('(?<!(?:ver|vejo|verificar|verifico|checar|checo|saber|perguntar|pergunto|confirmar|confirmo)\\s+)(?:se|caso|a menos que|desde que|contanto que)'),
    // The conditional mood is a wish: mandaria, faria. Listed rather than
    // matched on -ria, which would also catch Maria.
    hedge: word('talvez|provavelmente|acho que|espero|quem sabe|possivelmente|poderia|gostaria|deveria|mandaria|enviaria|faria|seria|teria|iria|daria|diria|veria'),
    reported: word('(?:ele|ela|eles|elas)\\s+(?:disse|disseram|falou|falaram|prometeu)|(?:diz|disseram|falou|falaram)\\s+que'),
    negation: /(?:não|nao|nunca|jamais)\s+$/iu,
  },
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

type Day = { y: number; m: number; d: number }

const dayOf = (y: number, m: number, d: number): Day => {
  const t = new Date(Date.UTC(y, m - 1, d))
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }
}
const addDays = (b: Day, n: number) => dayOf(b.y, b.m, b.d + n)
const weekday = (b: Day) => new Date(Date.UTC(b.y, b.m - 1, b.d)).getUTCDay()
const iso = (b: Day) => `${b.y}-${String(b.m).padStart(2, '0')}-${String(b.d).padStart(2, '0')}`
const before = (a: Day, b: Day) => iso(a) < iso(b)

/** The calendar day the mail was sent on, in the sender's offset. */
export function sentDay(sentAt: string): Day {
  const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(sentAt.trim())
  if (bare) return { y: Number(bare[1]), m: Number(bare[2]), d: Number(bare[3]) }
  const t = Date.parse(sentAt)
  if (Number.isNaN(t)) throw new Error(`sentAt is not a date: ${sentAt}`)
  const off = /(?:([+-])(\d{2}):?(\d{2})|(Z|GMT|UTC))\s*(?:\([^)]*\))?\s*$/i.exec(sentAt.trim())
  if (off) {
    const mins = off[4] ? 0 : (off[1] === '-' ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3]))
    const local = new Date(t + mins * 60_000)
    return { y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, d: local.getUTCDate() }
  }
  // No offset written: the machine's zone is the user's zone.
  const local = new Date(t)
  return { y: local.getFullYear(), m: local.getMonth() + 1, d: local.getDate() }
}

/** The next given weekday strictly after base. */
function nextWeekday(base: Day, wd: number): Day {
  const delta = (wd - weekday(base) + 7) % 7 || 7
  return addDays(base, delta)
}

/** "next Friday": the Friday of next week, not the one three days away. */
function weekdayNextWeek(base: Day, wd: number): Day {
  const monday = addDays(base, -((weekday(base) + 6) % 7))
  return addDays(monday, 7 + ((wd + 6) % 7))
}

function fridayThisWeek(base: Day): Day {
  const back = (weekday(base) + 6) % 7 // days since Monday
  return back > 4 ? base : addDays(base, 4 - back)
}

function endOfMonth(base: Day): Day {
  return dayOf(base.y, base.m + 1, 0)
}

/** A month/day with no year is the next one on or after the sent day. */
function upcoming(base: Day, m: number, d: number, y?: number): Day | undefined {
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined
  if (y !== undefined) return dayOf(y < 100 ? 2000 + y : y, m, d)
  const guess = dayOf(base.y, m, d)
  return before(guess, base) ? dayOf(base.y + 1, m, d) : guess
}

type Vocab = {
  weekdays: string[] // Sunday first, regex sources
  months: string[] // January first
  today: string
  tomorrow: string
  afterTomorrow: string
  nextWeek: string
  endOfWeek: string
  endOfMonth: string
  inDays: RegExp // group 1: count
  nextWeekdayBefore: string // "next", "prossimo", "próxima"
  nextWeekdayAfter: string // "prossimo", "que vem"
  /** dd/mm is the default reading of 20/10 */
  dayFirst: boolean
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, couple: 2, 'a couple of': 2, few: 3, 'a few': 3,
  un: 1, uno: 1, due: 2, tre: 3, quattro: 4, cinque: 5, paio: 2, 'un paio di': 2,
  um: 1, uma: 1, dois: 2, duas: 2, 'três': 3, tres: 3, quatro: 4, cinco: 5,
}

const VOCAB: Record<Lang, Vocab> = {
  en: {
    weekdays: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
    months: ['jan(?:uary)?', 'feb(?:ruary)?', 'mar(?:ch)?', 'apr(?:il)?', 'may', 'june?', 'july?', 'aug(?:ust)?', 'sep(?:t(?:ember)?)?', 'oct(?:ober)?', 'nov(?:ember)?', 'dec(?:ember)?'],
    today: 'today|tonight|this evening|(?:the )?end of (?:the )?day|eod|cob',
    tomorrow: 'tomorrow',
    afterTomorrow: 'the day after tomorrow',
    nextWeek: 'next week',
    endOfWeek: '(?:the )?end of (?:the |this )?week|this week|eow',
    endOfMonth: '(?:the )?end of (?:the |this )?month',
    inDays: /(?<![\p{L}])in\s+(\d+|a couple of|a few|two|three|four|five)\s+days?(?![\p{L}])/iu,
    nextWeekdayBefore: 'next',
    nextWeekdayAfter: '(?!)',
    dayFirst: false,
  },
  it: {
    weekdays: ['domenica', 'luned[iì]', 'marted[iì]', 'mercoled[iì]', 'gioved[iì]', 'venerd[iì]', 'sabato'],
    months: ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'],
    today: 'oggi|stasera|stanotte|entro sera|(?:in|a) giornata|fine giornata',
    tomorrow: 'domani',
    afterTomorrow: 'dopodomani|dopo domani',
    nextWeek: '(?:la )?settimana prossima|(?:la )?prossima settimana',
    endOfWeek: '(?:la )?fine (?:della |di questa )?settimana|questa settimana|in settimana',
    endOfMonth: '(?:la )?fine (?:del )?mese',
    inDays: /(?<![\p{L}])(?:tra|fra)\s+(\d+|un paio di|due|tre|quattro|cinque)\s+giorni(?![\p{L}])/iu,
    nextWeekdayBefore: '(?:il |la )?prossim[oa]',
    nextWeekdayAfter: 'prossim[oa]',
    dayFirst: true,
  },
  pt: {
    weekdays: ['domingo', 'segunda(?:-feira)?', 'ter[çc]a(?:-feira)?', 'quarta(?:-feira)?', 'quinta(?:-feira)?', 'sexta(?:-feira)?', 's[áa]bado'],
    months: ['janeiro', 'fevereiro', 'mar[çc]o', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'],
    today: 'hoje(?: (?:à|a) noite)?|esta noite|(?:o )?fim do dia|(?:o )?final do dia',
    tomorrow: 'amanhã|amanha',
    afterTomorrow: 'depois de amanhã|depois de amanha',
    nextWeek: '(?:a )?semana que vem|(?:a )?próxima semana|(?:a )?proxima semana',
    endOfWeek: '(?:o )?(?:fim|final) da semana|essa semana|esta semana',
    endOfMonth: '(?:o )?(?:fim|final) do mês|(?:o )?(?:fim|final) do mes',
    inDays: /(?<![\p{L}])(?:em|daqui a)\s+(\d+|um|uns|dois|duas|três|tres|quatro|cinco)\s+dias(?![\p{L}])/iu,
    nextWeekdayBefore: '(?:a |o )?pr[óo]xim[oa]',
    nextWeekdayAfter: 'que vem',
    dayFirst: true,
  },
}

type Hit = { at: number; day: Day }

/** The date a sentence names, resolved against the day it was sent. */
export function resolveDue(sentence: string, lang: Lang, base: Day): string | undefined {
  const v = VOCAB[lang]
  const hits: Hit[] = []
  const add = (re: RegExp, fn: (m: RegExpExecArray) => Day | undefined) => {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
    for (const m of sentence.matchAll(g)) {
      const day = fn(m as RegExpExecArray)
      if (day) hits.push({ at: m.index ?? 0, day })
    }
  }

  // Longer phrases first: "the day after tomorrow" starts before its own
  // "tomorrow", and at the same spot the earlier-added reading wins.
  add(word(v.afterTomorrow), () => addDays(base, 2))
  add(word(v.tomorrow), () => addDays(base, 1))
  add(word(v.today), () => base)
  add(word(v.nextWeek), () => nextWeekday(base, 1))
  add(word(v.endOfWeek), () => fridayThisWeek(base))
  add(word(v.endOfMonth), () => endOfMonth(base))
  add(v.inDays, m => {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1].toLowerCase()]
    return n ? addDays(base, n) : undefined
  })

  v.weekdays.forEach((wd, i) => {
    add(word(`(?:${v.nextWeekdayBefore})\\s+(?:${wd})|(?:${wd})\\s+(?:${v.nextWeekdayAfter})`), () => weekdayNextWeek(base, i))
    add(word(wd), () => nextWeekday(base, i))
  })

  v.months.forEach((mo, i) => {
    const day = '(\\d{1,2})(?:st|nd|rd|th|º|°)?'
    const yr = '(?:,?\\s+(\\d{4}))?'
    add(word(`${day}\\s+(?:de\\s+)?(?:${mo})\\.?${yr}`), m => upcoming(base, i + 1, Number(m[1]), m[2] ? Number(m[2]) : undefined))
    if (lang === 'en') add(word(`(?:${mo})\\.?\\s+${day}${yr}`), m => upcoming(base, i + 1, Number(m[1]), m[2] ? Number(m[2]) : undefined))
  })

  add(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g, m => upcoming(base, Number(m[2]), Number(m[3]), Number(m[1])))
  add(/(?<![\d/.])(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?(?![\d/.])/g, m => {
    const a = Number(m[1]), b = Number(m[2])
    const y = m[3] ? Number(m[3]) : undefined
    // English mail is written to both sides of the Atlantic; 03/04 is
    // unreadable there, so only a day over 12 settles it.
    if (lang === 'en') {
      if (a > 12 && b <= 12) return upcoming(base, b, a, y)
      if (b > 12 && a <= 12) return upcoming(base, a, b, y)
      return undefined
    }
    return v.dayFirst ? upcoming(base, b, a, y) : upcoming(base, a, b, y)
  })

  if (!hits.length) return undefined
  // Earliest in the sentence wins; at the same spot, the longer phrase was
  // added first.
  hits.sort((a, b) => a.at - b.at)
  return iso(hits[0].day)
}

// ---------------------------------------------------------------------------
// Mining
// ---------------------------------------------------------------------------

/** Split into sentences. A line break ends one: mail is written in lines. */
function sentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?…;])\s+/u)
    .map(s => s.trim())
    .filter(Boolean)
}

/** True when position `at` sits inside quotation marks — someone's words. */
function quoted(s: string, at: number): boolean {
  const pre = s.slice(0, at)
  const straight = (pre.match(/"/g)?.length ?? 0) % 2 === 1
  const curly = pre.lastIndexOf('“') > pre.lastIndexOf('”')
  const angle = pre.lastIndexOf('«') > pre.lastIndexOf('»')
  return straight || curly || angle
}

function firstPromise(s: string, g: Grammar): number | undefined {
  let best: number | undefined
  for (const re of g.promise) {
    const m = re.exec(s)
    if (!m) continue
    if (g.negation.test(s.slice(0, m.index))) continue
    if (quoted(s, m.index)) continue
    if (best === undefined || m.index < best) best = m.index
  }
  return best
}

/** The promise's own clause: from the last break before it to the end. */
function clause(s: string, at: number): string {
  const head = s.slice(0, at)
  const cut = Math.max(head.lastIndexOf(','), head.lastIndexOf(':'), head.lastIndexOf(' - '), head.lastIndexOf(' — '))
  const text = (cut >= 0 ? s.slice(cut + 1) : s).trim().replace(/[\s.!;…]+$/u, '')
  const capped = text.length > 200 ? text.slice(0, 199).trimEnd() + '…' : text
  return capped.charAt(0).toUpperCase() + capped.slice(1)
}

/**
 * Every promise the user made in one sent message.
 *
 * One per sentence at most — "I'll check and I'll send it" is one thing owed,
 * and a sentence that both promises and hedges is read as the hedge.
 */
export function minePromises(text: string, opts: MineOpts): Commitment[] {
  const base = sentDay(opts.sentAt)
  const own = ownText(text)
  const order: Lang[] = opts.lang ? [opts.lang] : (() => {
    const g = guessLang(own)
    return g ? [g] : ['en', 'it', 'pt']
  })()

  const out: Commitment[] = []
  for (const s of sentences(own)) {
    if (/\?\s*$/.test(s)) continue
    for (const lang of order) {
      const g = GRAMMARS[lang]
      const at = firstPromise(s, g)
      if (at === undefined) continue
      // The whole sentence is judged, not just the clause: "if you want, I'll
      // send it" carries its condition in front.
      if (g.conditional.test(s) || g.hedge.test(s)) break
      if (g.reported.test(s.slice(0, at))) break
      const due = resolveDue(s, lang, base)
      out.push({ text: clause(s, at), ...(due ? { due } : {}), to: opts.to })
      break
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Filing
// ---------------------------------------------------------------------------

export const PROMISE_TAG = 'promise'

/**
 * Turn mined promises into open loops, once per message.
 *
 * The scan re-reads the same sent mail every hour, so the message is the unit
 * of dedupe: if any promise loop already carries this source, the message has
 * been mined, and nothing is filed again — not even after the user closes,
 * drops or rewords one, which is them telling Otto what it is.
 */
export function commitmentLoops(
  notes: Note[],
  messageId: string,
  found: Commitment[],
): { notes: Note[]; added: Note[]; already: boolean } {
  const source = `email:${messageId}`
  const already = notes.some(n => n.source === source && n.tags.includes(PROMISE_TAG))
  if (already) return { notes, added: [], already: true }
  const added: Note[] = []
  for (const c of found) {
    const { note } = upsertNote(notes, {
      kind: 'loop',
      text: c.to ? `${c.text} (promised to ${c.to})` : c.text,
      tags: [PROMISE_TAG],
      source,
      ...(c.due ? { due: c.due } : {}),
    })
    added.push(note)
  }
  return { notes, added, already: false }
}
