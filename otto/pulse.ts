/**
 * Pulse — overnight research on topics the user follows, delivered with the morning brief.
 *
 * Topics carry a weight. Once a night, inside quiet hours, the top-weighted ones go to one
 * delegated job with WebSearch and WebFetch only. Its answer comes back through the webhook
 * and is parsed here, never shown to the session: at most two items, each with a URL nobody
 * has seen before. The brief calls `pulse` (cards), which hands back one card with
 * [more like this] / [less] per item and clears them. A tap moves that topic's weight; under
 * the floor the topic is dropped.
 *
 * The job's output is internet text a model wrote, so it is only ever parsed into fixed
 * fields, length-capped and https-checked. Nothing in it is followed.
 */
import { randomBytes } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import { loadState, saveState } from './statefile.ts'
import type { Card } from './cards.ts'

export type Topic = { id: string; text: string; weight: number; addedAt: string }
export type PulseItem = { topicId: string; title: string; gist: string; url: string; date: string }
export type PulseState = {
  topics: Topic[]
  /** Normalised URLs already delivered, newest last. */
  seen: string[]
  /** Found overnight, waiting for the morning brief. */
  pending: PulseItem[]
  /** Machine-local YYYY-MM-DD of the last night a job was started. */
  lastRunDay?: string
  lastRunAt?: string
  /** The job in flight; its result is the only webhook this module claims. */
  jobId?: string
}

export const DEFAULT_WEIGHT = 3
export const MAX_WEIGHT = 10
/** Below this a topic is dropped. Three [less] taps from the default. */
export const FLOOR = 1
export const MAX_ITEMS = 2
export const TOPICS_PER_RUN = 4
const SEEN_CAP = 500

export const emptyPulse = (): PulseState => ({ topics: [], seen: [], pending: [] })

const STATE_DIR = process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state')
export const PULSE_FILE = join(STATE_DIR, 'pulse.json')

export function loadPulse(file = PULSE_FILE): PulseState {
  return loadState(file, emptyPulse, x => !!x && typeof x === 'object' && Array.isArray((x as PulseState).topics))
}
export function savePulse(s: PulseState, file = PULSE_FILE): void { saveState(file, s) }

/** Same article, different tracking: lowercase host, no hash, no utm_*, no trailing slash. */
export function normUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim())
    if (u.protocol !== 'https:') return null
    u.hash = ''
    for (const k of [...u.searchParams.keys()]) if (/^utm_|^fbclid$|^gclid$/i.test(k)) u.searchParams.delete(k)
    return u.toString().replace(/\/$/, '')
  } catch { return null }
}

const findTopic = (s: PulseState, key: string) => {
  const k = key.trim().toLowerCase()
  return s.topics.find(t => t.id === k || t.text.toLowerCase() === k)
}

export function addTopic(s: PulseState, text: string, now = new Date()): { state: PulseState; topic: Topic } {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 120)
  if (!clean) throw new Error('topic text is empty')
  const existing = findTopic(s, clean)
  if (existing) return { state: s, topic: existing }
  const topic = { id: randomBytes(3).toString('hex'), text: clean, weight: DEFAULT_WEIGHT, addedAt: now.toISOString() }
  return { state: { ...s, topics: [...s.topics, topic] }, topic }
}

export function dropTopic(s: PulseState, key: string): { state: PulseState; dropped?: Topic } {
  const t = findTopic(s, key)
  if (!t) return { state: s }
  return { state: { ...s, topics: s.topics.filter(x => x !== t), pending: s.pending.filter(p => p.topicId !== t.id) }, dropped: t }
}

export const TAP_RE = /^pulse (more|less) ([a-f0-9]{6})$/

/** A [more like this] / [less] tap. Null when the data is not a pulse tap. */
export function applyTap(s: PulseState, data: string): { state: PulseState; line: string } | null {
  const m = TAP_RE.exec(data)
  if (!m) return null
  const t = s.topics.find(x => x.id === m[2])
  if (!t) return { state: s, line: 'That topic is already gone.' }
  const weight = m[1] === 'more' ? Math.min(MAX_WEIGHT, t.weight + 1) : t.weight - 1
  if (weight < FLOOR) return { state: dropTopic(s, t.id).state, line: `Dropped “${t.text}” from the pulse.` }
  return {
    state: { ...s, topics: s.topics.map(x => x === t ? { ...x, weight } : x) },
    line: m[1] === 'more' ? `More on “${t.text}”.` : `Less on “${t.text}”.`,
  }
}

/** Heaviest first; ties go to the older topic. */
export function topTopics(s: PulseState, n = TOPICS_PER_RUN): Topic[] {
  return [...s.topics].sort((a, b) => b.weight - a.weight || a.addedAt.localeCompare(b.addedAt)).slice(0, n)
}

/** Start tonight's job? Only inside quiet hours, once a day, never two at once, never with nothing to research. */
export function shouldRun(s: PulseState, o: { today: string; quiet: boolean; jobActive: boolean }): boolean {
  return o.quiet && s.topics.length > 0 && s.lastRunDay !== o.today && !o.jobActive
}

export function researchTask(s: PulseState, now = new Date()): string {
  const since = s.lastRunAt ? s.lastRunAt.slice(0, 10) : new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10)
  const topics = topTopics(s).map(t => `- [${t.id}] ${t.text}`).join('\n')
  const seen = s.seen.slice(-40).map(u => `- ${u}`).join('\n')
  return [
    `Research what is genuinely new since ${since} (today is ${now.toISOString().slice(0, 10)}) on these topics, heaviest first:`,
    topics,
    '',
    'Find at most 2 items worth a busy person\'s morning: a release, a rule change, a deadline, a real finding. Skip opinion pieces, listicles, rumours and anything dated before ' + since + '.',
    'Each needs a primary or reputable source URL (https) that you actually opened, and the date the news itself happened.',
    seen ? `Already delivered, do not repeat:\n${seen}` : '',
    '',
    'Answer with JSON only, no prose: [{"topic":"<id in brackets>","title":"<= 80 chars","gist":"2-3 plain sentences","url":"https://...","date":"YYYY-MM-DD"}]',
    'Nothing new is a fine answer: [].',
  ].filter(s => s !== '').join('\n')
}

const JOB_RE = /^Background job \[([a-z0-9-]+)\]/i

/** The job id a webhook result is for, if it is a job result at all. */
export function resultJobId(text: string): string | null {
  return JOB_RE.exec(text.trim())?.[1] ?? null
}

/**
 * Parse the job's answer into at most MAX_ITEMS new items. Anything malformed, off-topic,
 * non-https or already seen is dropped silently. Replaces whatever was pending: an item the
 * brief never picked up is a day old and goes.
 */
export function ingest(s: PulseState, output: string): { state: PulseState; added: PulseItem[] } {
  const ids = new Set(s.topics.map(t => t.id))
  const seen = new Set(s.seen)
  const added: PulseItem[] = []
  let raw: unknown = []
  const start = output.search(/\[\s*[{\]]/), end = output.lastIndexOf(']')
  if (start >= 0 && end > start) try { raw = JSON.parse(output.slice(start, end + 1)) } catch {}
  const str = (v: unknown, max: number) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''
  for (const r of Array.isArray(raw) ? raw : []) {
    if (added.length >= MAX_ITEMS || !r || typeof r !== 'object') break
    const o = r as Record<string, unknown>
    const url = typeof o.url === 'string' ? normUrl(o.url) : null
    const topicId = str(o.topic, 12)
    const title = str(o.title, 80), gist = str(o.gist, 360), date = str(o.date, 10)
    if (!url || seen.has(url) || !ids.has(topicId) || !title || !gist || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    seen.add(url)
    added.push({ topicId, title, gist, url, date })
  }
  return {
    state: { ...s, pending: added, seen: [...seen].slice(-SEEN_CAP), jobId: undefined },
    added,
  }
}

/** What the morning brief appends: plain lines that stand alone, the app card, and the same taps as buttons. */
export function takeCards(s: PulseState): { state: PulseState; text: string; card: Card; buttons: { label: string; data: string }[] } | null {
  if (!s.pending.length) return null
  const items = s.pending.slice(0, MAX_ITEMS)
  const many = items.length > 1
  const buttons = items.flatMap((p, i) => [
    { label: many ? `more like ${i + 1}` : 'more like this', data: `pulse more ${p.topicId}` },
    { label: many ? `less like ${i + 1}` : 'less', data: `pulse less ${p.topicId}` },
  ])
  const text = items.map((p, i) => `${many ? `${i + 1}. ` : ''}${p.title} (${p.date}): ${p.gist} ${p.url}`).join('\n')
  const card: Card = {
    title: 'Overnight',
    blocks: items.flatMap((p, i) => [
      { type: 'text' as const, text: `${many ? `${i + 1}. ` : ''}${p.title}` },
      { type: 'text' as const, text: p.gist },
      { type: 'text' as const, text: `${p.date} · ${p.url}`.slice(0, 400), style: 'caption' as const },
    ]),
    actions: buttons,
  }
  return { state: { ...s, pending: [] }, text, card, buttons }
}

export function formatTopics(s: PulseState): string {
  if (!s.topics.length) return '(no pulse topics)'
  return topTopics(s, s.topics.length).map(t => `[${t.id}] ${t.text} — weight ${t.weight}`).join('\n')
}
