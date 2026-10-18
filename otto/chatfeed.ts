// The dashboard's live view of the two threads: every line recordHistory writes,
// kept in memory with a sequence number, so a long-poll can ask "anything after N".
// In memory only; a restart sets seq back to 0 and the client reloads history.

/** One history line, as server.ts's recordHistory writes it (its private HistoryEntry is a superset). */
export type ChatEntry = {
  ts: string
  dir: 'in' | 'out'
  chat_id: string
  message_id?: string
  kind: string
  text: string
  src?: string
}

const RING = 200       // ponytail: in memory; a client further behind than this reloads history
const CLAIMED = 500
export const CHAT_WAIT_MS = 25_000

export class ChatFeed {
  seq = 0
  typing = false
  private ring: { seq: number; e: ChatEntry }[] = []
  private claimed: string[] = []
  private waiters = new Set<() => void>()

  push(e: ChatEntry): void {
    this.ring.push({ seq: ++this.seq, e })
    if (this.ring.length > RING) this.ring.shift()
    this.wake()
  }

  /** The app's typing state, mirrored from setAppTyping; a change wakes waiting polls. */
  setTyping(on: boolean): void {
    if (on === this.typing) return
    this.typing = on
    this.wake()
  }

  /** Entries of `chat_id` with seq > after, oldest first. */
  since(after: number, chat_id: string): ChatEntry[] {
    return this.ring.filter(r => r.seq > after && r.e.chat_id === chat_id).map(r => r.e)
  }

  /** Resolves on the next push or typing change, after `ms`, or when `signal` aborts. */
  wait(ms = CHAT_WAIT_MS, signal?: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const done = () => { this.waiters.delete(done); clearTimeout(t); signal?.removeEventListener('abort', done); resolve() }
      const t = setTimeout(done, ms)
      this.waiters.add(done)
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  /** True the first time an id is seen. A retry of the same id is false, so a message is delivered once. */
  claim(id: string): boolean {
    if (this.claimed.includes(id)) return false
    this.claimed.push(id)
    if (this.claimed.length > CLAIMED) this.claimed.shift()
    return true
  }

  /** Overwrite a message's text in the ring (burn.ts). Seq numbers stay, so no poll skips or repeats. */
  burn(message_id: string, chat_id: string | undefined, text: string): number {
    let n = 0
    for (const r of this.ring) {
      if (r.e.message_id !== message_id || (chat_id && r.e.chat_id !== chat_id)) continue
      r.e = { ...r.e, text }
      n++
    }
    return n
  }

  private wake(): void { for (const w of [...this.waiters]) w() }
}
