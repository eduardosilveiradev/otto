/** Sunday evening's app recap, from existing local stores. Quiet weeks stay quiet;
 * a durable Sunday stamp prevents repeats after a restart, including quiet weeks.
 */
import { join } from 'node:path'
import type { Card, Block } from './cards.ts'
import { loadCodeJobs } from './codejobs.ts'
import { loadMoney, totalsByCurrency, totalsByCategory, formatMoney } from './money.ts'
import { loadNotes, dueLoops } from './store.ts'
import { loadState, saveState } from './statefile.ts'
import { collectUsage, readPlanUsage, readJobCosts, formatTokens, priceTag, type UsageOptions } from './usage.ts'
import { liveWindows } from './spend.ts'
import { paceConfig } from './route.ts'

const clip = (s: string, max = 120) => Array.from(s).length > max ? Array.from(s).slice(0, max - 1).join('') + '…' : s
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Called by the existing scheduler. Stamp before delivery, as other weekly chores do. */
export function weekCardOffer(dir: string, now = Date.now(), enabled = true, usage: UsageOptions = {}): { text: string; card: Card } | null {
  const d = new Date(now)
  if (!enabled || d.getDay() !== 0 || d.getHours() < 20) return null
  const stamp = localDate(d), file = join(dir, 'week-card.json')
  const state = loadState(file, () => ({ sunday: '' }), x => typeof (x as any)?.sunday === 'string')
  if (state.sunday === stamp) return null
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 6)
  const start = monday.getTime(), from = localDate(monday)
  const end = new Date(d); end.setDate(end.getDate() + 7)
  const inWeek = (at?: string) => !!at && Date.parse(at) >= start && Date.parse(at) <= now
  const jobs = loadCodeJobs(join(dir, 'code-jobs.json'))
    .filter(j => inWeek(j.mergedAt ?? (j.prInfo?.state === 'MERGED' ? j.prInfo.mergedAt : undefined)))
  const money = loadMoney(join(dir, 'money.json')).filter(r => r.date >= from && r.date <= stamp && r.amount > 0)
  const loops = dueLoops(loadNotes(join(dir, 'notes.json')), now, end.getTime() - now)
    .filter(n => n.due! >= stamp) // date-only deadlines remain due through today
  saveState(file, { sunday: stamp })
  if (!jobs.length && !money.length && !loops.length) return null

  const blocks: Block[] = [], items: Extract<Block, { type: 'list' }>['items'] = []
  if (jobs.length) {
    const costs = new Map(readJobCosts(dir).map(c => [c.id, c]))
    const tokens = jobs.reduce((n, j) => n + (costs.get(j.id)?.tokens ?? j.tokensUsed ?? 0), 0)
    blocks.push({ type: 'stat', value: String(jobs.length), label: 'PRs merged this week', ...(tokens ? { delta: `${formatTokens(tokens)} tokens total` } : {}) })
    // Per-job plan shares overlap: show the recorded tags, never sum their percentages.
    items.push(...jobs.slice(0, 3).map(j => ({ title: clip(j.title), detail: clip(priceTag(costs.get(j.id)?.tokens ?? j.tokensUsed, j.model, costs.get(j.id)?.share ?? j.weekShare) ?? 'Merged') })))
  }
  const plan = readPlanUsage(dir)
  if (liveWindows(plan, now).includes('seven_day')) {
    const pace = paceConfig(dir)
    blocks.push({ type: 'stat', value: `${Math.round(plan!.seven_day!.used_percentage)}%`, label: 'Claude weekly plan used', ...(pace ? { delta: `${pace.byDay3}% target by day 3 after reset` } : {}) })
  }
  const gpt = collectUsage({ ...usage, now, weekStart: start, cacheFile: join(dir, 'usage-cache.json') }).gpt
  if (gpt) blocks.push({ type: 'stat', value: `${formatTokens(gpt.week ?? 0)}`, label: 'GPT tokens this week' })
  for (const total of totalsByCurrency(money)) {
    items.push({ title: 'Spent this week', trailing: formatMoney(total.total, total.currency), detail: clip(totalsByCategory(money, total.currency).slice(0, 3).map(c => `${c.category}: ${formatMoney(c.total, total.currency)}`).join(' · ')) })
  }
  const upcoming = [
    ...loops.map(n => ({ title: clip(n.text), detail: `Due ${n.due!.slice(0, 10)}` })),
  ].sort((a, b) => a.detail.localeCompare(b.detail))
  items.push(...upcoming.slice(0, 5))
  if (upcoming.length > 5) items.push({ title: `${upcoming.length - 5} more due in the next 7 days` })
  if (items.length) blocks.push({ type: 'list', items: items.slice(0, 20) })
  return { text: 'Your week', card: { title: `Week of ${from}`, blocks } }
}
