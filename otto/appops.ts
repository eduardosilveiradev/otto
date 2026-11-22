/**
 * What the phone already handed over, by the id it gave each operation (a message, a tap,
 * a tapback, an approval). The phone keeps an operation until the server acks it, so a frame
 * that got through but whose ack died in a frozen socket comes back on the next connect; this
 * is how the second copy is acked without being handled twice. On disk, because the resend
 * can straddle a restart, and a "send ✓" tap handled twice sends the email twice.
 */
import { loadState, saveState } from './statefile.ts'

export class SeenOps {
  private ids: string[]
  private set: Set<string>
  constructor(private file: string, private cap = 2000) {
    this.ids = loadState<string[]>(file, () => [], x => Array.isArray(x) && x.every(i => typeof i === 'string'))
    this.set = new Set(this.ids)
  }
  has(id: string): boolean { return this.set.has(id) }
  /** True once it is on disk, already or now; false when the write failed. */
  keep(id: string): boolean {
    if (this.set.has(id)) return true
    this.ids.push(id)
    this.set.add(id)
    try { saveState(this.file, this.ids); return true } catch (err) {
      this.ids.pop(); this.set.delete(id)
      process.stderr.write(`otto channel: app ops write failed: ${err}\n`)
      return false
    }
  }
  /** False when it was already there. */
  add(id: string): boolean {
    if (this.set.has(id)) return false
    this.ids.push(id)
    this.set.add(id)
    if (this.ids.length > this.cap) for (const old of this.ids.splice(0, this.ids.length - this.cap)) this.set.delete(old)
    try { saveState(this.file, this.ids) } catch (err) { process.stderr.write(`otto channel: app ops write failed: ${err}\n`) }
    return true
  }
}
