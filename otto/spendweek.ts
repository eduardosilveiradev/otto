/**
 * Spend the week: the Claude weekly window is about to reset with plenty unused, so offer
 * the owner's own backlog to fill it. Inside the last 24h of the window, with more than 40%
 * left, one card on the app lists the backlog ideas that fit; its one button queues them as
 * coding jobs chained with `after`, so they run one after another.
 *
 * The ideas come only from `<state>/backlog.json`, a list the owner writes by hand:
 *   [{ "title": "…", "project": "my-app", "brief": "…", "size": "S" | "M" }]
 * Missing, empty or unreadable means no card. Nothing is ever scraped to fill it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Card } from './cards.ts'
import type { ReplyButton } from './buttons.ts'
import { liveWindows, type PlanUsage } from './spend.ts'
import { loadState, saveState } from './statefile.ts'
import { formatTokens } from './usage.ts'

export type Idea = { title: string; project: string; brief: string; size: 'S' | 'M' }
type State = { resetsAt: number; picks: Idea[]; started: string[]; queued: string[] }

export const MIN_LEFT = 40
export const MARGIN = 15 // points of the week kept back, on top of the picks
export const LEAD_MS = 24 * 3_600_000
export const TAP = 'queue backlog for tonight'
export const MODEL = 'claude-opus-5-5' // the point is the Claude window: never let routing pick GPT
// ponytail: guesses, not readings: a flat cost per size and ~700K tokens per 1% of the week.
// Derive both from job-costs.jsonl (tokens and share per finished job) once it has some history.
export const SIZE_TOKENS = { S: 2_000_000, M: 6_000_000 }
export const TOKENS_PER_PCT = 700_000
const MAX_PICKS = 5

const stateFile = (dir: string) => join(dir, 'spend-week.json')
const empty = (): State => ({ resetsAt: 0, picks: [], started: [], queued: [] })
const valid = (x: any) => typeof x?.resetsAt === 'number' && Array.isArray(x.picks) && Array.isArray(x.started) && Array.isArray(x.queued)
const pct = (i: Idea) => SIZE_TOKENS[i.size] / TOKENS_PER_PCT

export function readBacklog(dir: string): Idea[] {
  let raw: unknown
  try { raw = JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8')) } catch { return [] }
  const str = (v: unknown) => typeof v === 'string' && v.trim() !== ''
  return Array.isArray(raw) ? raw.filter((i): i is Idea => str(i?.title) && str(i?.project) && str(i?.brief) && (i.size === 'S' || i.size === 'M')) : []
}

/** Smallest first, while the running cost stays inside `budget` points of the week. */
export function fit(ideas: Idea[], budget: number): Idea[] {
  let used = 0
  return [...ideas].sort((a, b) => pct(a) - pct(b)).filter(i => used + pct(i) <= budget && (used += pct(i), true)).slice(0, MAX_PICKS)
}

const clip = (s: string) => Array.from(s).length > 120 ? Array.from(s).slice(0, 119).join('') + '…' : s
const firstSentence = (s: string) => clip(s.split(/(?<=[.!?])\s|\n/)[0]!.trim())

/** The card, once per window; the picks are stamped before it goes out so the tap queues exactly them. */
export function spendWeekOffer(dir: string, plan: PlanUsage | null, now: number): { text: string; card: Card; buttons: ReplyButton[] } | null {
  if (!liveWindows(plan, now).includes('seven_day')) return null
  const { used_percentage, resets_at } = plan!.seven_day!
  const left = 100 - used_percentage
  if (left <= MIN_LEFT || resets_at * 1000 - now > LEAD_MS) return null
  const s = loadState(stateFile(dir), empty, valid)
  if (Math.abs(s.resetsAt - resets_at) < 3600) return null // readings drift; same window, already offered
  const picks = fit(readBacklog(dir).filter(i => !s.queued.includes(i.title)), left - MARGIN)
  if (!picks.length) return null
  saveState(stateFile(dir), { ...s, resetsAt: resets_at, picks, started: [] })
  const when = new Date(resets_at * 1000).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })
  return {
    text: 'the claude week resets soon with room to spare',
    card: { title: 'Spend the week', blocks: [
      { type: 'keyvalue', items: [{ key: 'left', value: `${Math.round(left)}% of the week` }, { key: 'resets', value: when }] },
      { type: 'list', items: picks.map(i => ({ title: clip(i.title), detail: firstSentence(i.brief), trailing: `${i.size} · ~${formatTokens(SIZE_TOKENS[i.size])}` })) },
      { type: 'text', style: 'caption', text: 'queued one after another, each starting once the last one merges' },
    ] },
    buttons: [{ label: 'queue them tonight', data: TAP }],
  }
}

export type Start = (input: { project: string; title: string; brief: string; model: string; after?: string; origin: 'user-typed' }) => Promise<{ id: string }>

let busy = false
/** The tap: starts the stamped picks as one chain. A repeat tap resumes after the last job that started. */
export async function queueBacklog(dir: string, start: Start, now: number): Promise<string> {
  if (busy) return 'already queuing those'
  busy = true
  try {
    const s = loadState(stateFile(dir), empty, valid)
    if (!s.picks.length) return 'nothing from the backlog is waiting'
    if (now >= s.resetsAt * 1000) return 'that week already reset'
    if (s.started.length >= s.picks.length) return 'already queued'
    for (let i = s.started.length; i < s.picks.length; i++) {
      const p = s.picks[i]!
      try {
        const job = await start({ project: p.project, title: p.title, brief: p.brief, model: MODEL, origin: 'user-typed', ...(i ? { after: s.started[i - 1] } : {}) })
        s.started.push(job.id); s.queued.push(p.title)
        saveState(stateFile(dir), s)
      } catch (err) {
        return `${i ? `queued ${i}; ` : ''}stopped at "${p.title}": ${String(err instanceof Error ? err.message : err).split('\n')[0]}`
      }
    }
    return `queued ${s.picks.length}: the first starts now, the rest follow as each merges`
  } finally { busy = false }
}
