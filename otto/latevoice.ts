import { loadState, saveState } from './statefile.ts'

/** Pending lines survive restart so text-first replies can finish their spoken half. */
export class LateVoice<T> {
  readonly voices: Map<string, T>
  readonly pending: Map<string, string>
  constructor(private file: string) {
    const pairs = (x: unknown): x is [string, unknown][] => Array.isArray(x) && x.every(e => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string')
    const s = loadState<{ voices: [string, T][]; pending: [string, string][] }>(file, () => ({ voices: [], pending: [] }), x => {
      if (!x || typeof x !== 'object') return false
      const row = x as { voices?: unknown; pending?: unknown }
      return pairs(row.voices) && pairs(row.pending) && row.pending.every(e => typeof e[1] === 'string')
    })
    this.voices = new Map(s.voices)
    this.pending = new Map(s.pending)
  }
  start(id: string, line: string): void { this.pending.set(id, line); this.save() }
  finish(id: string, voice: T | null): void {
    this.pending.delete(id)
    if (voice) this.voices.set(id, voice)
    this.save()
  }
  private save(): void { saveState(this.file, { voices: [...this.voices], pending: [...this.pending] }) }
}
