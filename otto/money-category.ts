import type { MoneyRecord } from './money.ts'
import { upsertNote, type Note } from './store.ts'

const OFFER = 'money-category-offer'
const SKIP_MS = 90 * 24 * 60 * 60 * 1000

// One offer covers the whole batch; offers made before that carry a single `merchant`.
type Choice = { merchant?: string; merchants?: string[]; categories: string[]; skippedAt?: number }
const merchantsOf = (c: Choice): string[] => c.merchants ?? (c.merchant ? [c.merchant] : [])
const merchantKey = (merchant: string): string => merchant.trim().toLowerCase().replace(/\s+/g, ' ')

export function categorySweepDue(now: Date, lastDay?: string): boolean {
  return now.getDay() === 0 && now.getHours() >= 10 && lastDay !== localDay(now)
}

export function localDay(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function fileCategory(records: MoneyRecord[], notes: Note[], merchant: string, category: string, automatic: boolean, ids?: Set<string>): number {
  const changes = records.filter(r => merchantKey(r.merchant) === merchant && r.category == null && (!ids || ids.has(r.id)))
  if (!changes.length) return 0
  upsertNote(notes, {
    kind: 'write',
    text: `${automatic ? 'Automatically filed' : 'Filed'} ${changes.length} charges at ${merchant} under ${category}.`,
    tags: ['money-category'],
    undo: `In money.json, remove category ${JSON.stringify(category)} only from charge IDs ${JSON.stringify(changes.map(r => r.id))} whose category is still ${JSON.stringify(category)}. Leave every other charge untouched.`,
  })
  for (const r of changes) r.category = category
  return changes.length
}

export function sweepCategories(records: MoneyRecord[], notes: Note[], now = Date.now()): {
  text: string; buttons: { label: string; data: string }[]
} {
  const groups = new Map<string, MoneyRecord[]>()
  const counts = new Map<string, number>()
  for (const r of records) {
    const key = merchantKey(r.merchant)
    const group = groups.get(key) ?? []
    group.push(r)
    groups.set(key, group)
    if (r.category) counts.set(r.category, (counts.get(r.category) ?? 0) + 1)
  }
  const categories = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([category]) => category)
  const filed: string[] = []
  const remaining: { merchant: string; count: number }[] = []
  for (const [merchant, group] of groups) {
    const uncategorised = group.filter(r => r.category == null)
    if (!uncategorised.length) continue
    const prior = group.filter(r => r.category != null)
    if (prior.length >= 2 && new Set(prior.map(r => r.category)).size === 1) {
      const eligible = uncategorised.filter(r => prior.filter(p => p.date < r.date).length >= 2)
      const count = fileCategory(records, notes, merchant, prior[0].category!, true, new Set(eligible.map(r => r.id)))
      if (count) filed.push(`${merchant}: ${count} → ${prior[0].category}`)
    }
    const count = group.filter(r => r.category == null).length
    if (!count) continue
    const skipped = notes.some(n => {
      if (!n.tags.includes(OFFER)) return false
      const choice = JSON.parse(n.text) as Choice
      return merchantsOf(choice).includes(merchant) && choice.skippedAt !== undefined && now < choice.skippedAt + SKIP_MS
    })
    if (!skipped) remaining.push({ merchant, count })
  }
  const lines = filed.length ? [`Filed: ${filed.join('; ')}.`] : []
  // One question for the batch: a button per category files every merchant listed, a typed reply covers a mix.
  // Per-merchant buttons ran to 20 long chips and broke the phone's layout.
  const batch = remaining.sort((a, b) => b.count - a.count || a.merchant.localeCompare(b.merchant)).slice(0, 5)
  const buttons: { label: string; data: string }[] = []
  if (batch.length) {
    const { note } = upsertNote(notes, { kind: 'saved', text: JSON.stringify({ merchants: batch.map(b => b.merchant), categories }), tags: [OFFER] })
    lines.push('uncategorised charges:', ...batch.map(({ merchant, count }) => `${merchant} · ${count}`))
    if (batch.length > 1) lines.push('a button files them all; reply with what each is if they differ')
    for (const [i, category] of categories.entries()) buttons.push({ label: batch.length > 1 ? `all ${category}` : category, data: `money category ${note.id} ${i}` })
    buttons.push({ label: 'skip', data: `money category ${note.id} skip` })
  }
  return { text: lines.join('\n'), buttons }
}

/** null belongs to another handler; old choices remain usable after a restart. */
export function applyCategoryTap(records: MoneyRecord[], notes: Note[], instruction: string, now = Date.now()): string | null {
  const match = /^money category ([a-f0-9]{8}) (skip|[0-2])$/.exec(instruction)
  if (!match) return null
  const note = notes.find(n => n.id === match[1] && n.tags.includes(OFFER))
  if (!note) return 'That category choice has expired.'
  const choice = JSON.parse(note.text) as Choice
  if (match[2] === 'skip') {
    choice.skippedAt = now
    note.text = JSON.stringify(choice)
    return `Skipped ${merchantsOf(choice).join(', ')} for 90 days.`
  }
  const category = choice.categories[Number(match[2])]
  if (!category) return 'That category choice has expired.'
  const merchants = merchantsOf(choice)
  const count = merchants.reduce((n, m) => n + fileCategory(records, notes, m, category, false), 0)
  return `Filed ${count} charges at ${merchants.join(', ')} under ${category}.`
}
