/** Jobs overview: plain status text, worktree slot attribution and today's timeline. */
import { isAbsolute, relative } from 'path'
import type { JobSpan, SlotWait, MacLoad } from './dash-types.ts'
import type { SlotWaiter } from './slots.ts'

export function activityLine(text?: string): string | null {
  const plain = text?.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/<[^>]*>/g, '').replace(/[`*_#~]/g, '').replace(/\s+/g, ' ').trim()
  return plain ? [...(plain.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? plain)].slice(0, 140).join('').trim() : null
}

export function jobWaiters(waiters: SlotWaiter[], worktree?: string): SlotWaiter[] {
  if (!worktree) return []
  return waiters.filter(w => {
    const path = relative(worktree, w.cwd)
    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../'))
  })
}

export function currentSlotWait(waits: SlotWaiter[], all: SlotWaiter[], mac: MacLoad): SlotWait | null {
  const w = waits.find(w => !w.to)
  return w ? { since: w.since, position: all.filter(w => !w.to).findIndex(x => x.token === w.token) + 1, load: mac.load, limit: mac.limit } : null
}

export function jobSpans(j: { startedAt?: string | null; endedAt?: string | null; reviewAt?: string; mergedAt?: string; stoppedAt?: string; slotWaits?: SlotWaiter[] }, state: string, now = Date.now()): JobSpan[] {
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0)
  const floor = midnight.getTime()
  const out: JobSpan[] = []
  const add = (state: JobSpan['state'], from: number, to: number | null) => {
    if (!Number.isFinite(from) || from > now || (to !== null && to < floor)) return
    out.push({ state, from: new Date(Math.max(from, floor)).toISOString(), to: to === null ? null : new Date(Math.max(to, floor)).toISOString() })
  }
  const end = j.mergedAt ?? j.stoppedAt ?? (['done', 'failed', 'stopped', 'merged'].includes(state) ? j.endedAt : undefined)
  const stop = end ? Date.parse(end) : now
  const start = Date.parse(j.startedAt ?? '')
  const review = j.reviewAt ? Date.parse(j.reviewAt) : Infinity
  const waits = (j.slotWaits ?? []).map(w => ({ from: Date.parse(w.since), to: w.to ? Date.parse(w.to) : now }))
  const points = [...new Set([start, stop, review, ...waits.flatMap(w => [w.from, w.to])])]
    .filter(t => Number.isFinite(t) && t >= start && t <= stop).sort((a, b) => a - b)
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i]!, to = points[i + 1]!
    const state = waits.some(w => w.from <= from && w.to > from) ? 'wait' : from >= review ? 'review' : 'run'
    const until = to === stop && !end ? null : to
    const previous = out.at(-1)
    if (previous?.state === state && previous.to === new Date(Math.max(from, floor)).toISOString()) previous.to = until === null ? null : new Date(to).toISOString()
    else add(state, from, until)
  }
  if (start === stop && !end && review !== stop) add('run', start, null)
  if (review === stop && !end) add('review', review, null)
  if (end && ['merged', 'stopped', 'failed'].includes(state)) add(state as JobSpan['state'], stop, stop)
  return out
}
