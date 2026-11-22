/**
 * Reminders that reach the phone with the Mac off. A one-shot cron trigger with a `notify`
 * line is handed to the app ahead of time as a `reminders` frame (the full upcoming set); the
 * app schedules each as a local notification and acks the ones it has pending, by id and fire
 * time. When such a trigger fires, the phone already has the banner, so the reply that posts
 * it into the thread goes out quiet (server.ts). With no ack the reply alerts as before.
 */

export type Notify = {
  text: string
  /** epoch ms the phone confirmed it has a notification pending for; stale once the schedule moves. */
  ackedAt?: number
  /** Set when it fired: the phone posted this one itself, so the reply stays quiet. */
  onPhone?: true
}

type Reminder = { id: string; type: string; repeating: boolean; enabled: boolean; nextRun?: number; notify?: Notify }

export const NOTIFY_MAX = 200

/** `notify` from a tool call: undefined = not given, null = clear it. */
export function parseNotify(v: unknown): { text: string } | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  const text = String(typeof v === 'object' ? (v as { text?: unknown }).text ?? '' : v).trim()
  if (!text) return null
  if (text.length > NOTIFY_MAX) throw new Error(`notify.text is ${text.length} characters; keep it under ${NOTIFY_MAX}, it is a lock-screen line`)
  return { text }
}

/** Only one-shot cron triggers still to come, with a line to show. Never recurring ones, the brief or scans. */
export function reminderItems(ts: Reminder[], now: number): { id: string; at: string; text: string }[] {
  return ts
    .filter(t => t.type === 'cron' && !t.repeating && t.enabled && t.notify?.text && t.nextRun !== undefined && t.nextRun > now)
    .sort((a, b) => a.nextRun! - b.nextRun!)
    .map(t => ({ id: t.id, at: new Date(t.nextRun!).toISOString(), text: t.notify!.text }))
}

export function remindersFrame(ts: Reminder[], now: number): string {
  return JSON.stringify({ type: 'reminders', items: reminderItems(ts, now) })
}

/** `{type:"reminders_ack", items:[{id, at}]}` from the app, or null when the frame is something else. */
export function ackItems(raw: string): { id: string; at: number }[] | null {
  let f: { type?: unknown; items?: unknown }
  try { f = JSON.parse(raw) } catch { return null }
  if (!f || typeof f !== 'object' || f.type !== 'reminders_ack') return null
  if (!Array.isArray(f.items)) return []
  return f.items.flatMap(i => {
    const id = (i as { id?: unknown })?.id, at = Date.parse(String((i as { at?: unknown })?.at))
    return typeof id === 'string' && !Number.isNaN(at) ? [{ id, at }] : []
  })
}

/** Marks the ones the phone has pending for exactly their current fire time. True when anything changed. */
export function applyAck(ts: Reminder[], items: { id: string; at: number }[], now: number): boolean {
  let changed = false
  const upcoming = new Set(reminderItems(ts, now).map(r => r.id))
  for (const { id, at } of items) {
    const t = ts.find(x => x.id === id)
    if (!t?.notify || !upcoming.has(id) || t.nextRun !== at || t.notify.ackedAt === at) continue
    t.notify.ackedAt = at
    changed = true
  }
  return changed
}

/** Called as it fires, before nextRun is cleared: whether the phone posted it itself. */
export function markReminderFired(t: Reminder): void {
  if (!t.notify) return
  if (t.notify.ackedAt !== undefined && t.notify.ackedAt === t.nextRun && !t.repeating) t.notify.onPhone = true
  else delete t.notify.onPhone
}
