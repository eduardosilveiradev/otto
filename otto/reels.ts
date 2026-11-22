import { isExpired, type Note } from './store.ts'

export function pendingReels(notes: Note[]): Note[] {
  return notes.filter(n => n.kind === 'saved' && n.tags.includes('reel') && n.tags.includes('try')
    && !n.tags.includes('tried') && n.status !== 'dropped' && n.status !== 'done' && !isExpired(n))
}

export function markReelTried(notes: Note[], id: string, now = new Date()): boolean {
  const note = notes.find(n => n.id === id && n.kind === 'saved' && n.tags.includes('reel'))
  if (!note) return false
  if (!note.tags.includes('tried')) {
    note.tags.push('tried')
    note.updatedAt = now.toISOString()
  }
  return true
}

/** Sunday from 10:00, catching up on a same-day restart. Local date survives DST. */
export function reelDigestKey(now: Date, last?: string): string | undefined {
  const key = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
  return now.getDay() === 0 && now.getHours() >= 10 && last !== key ? key : undefined
}

export function formatReelDigest(notes: Note[]) {
  return {
    text: 'Reels to try\n\n' + notes.map((n, i) => `${i + 1}. ${n.text}`).join('\n\n'),
    buttons: notes.map((n, i) => ({ label: `${i + 1}. tried it`, data: `reel tried ${n.id}` })),
  }
}
