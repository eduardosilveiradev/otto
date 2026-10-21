/**
 * One JSON file per concern, the way every store here already does it: read it
 * whole, write it atomically (tmp + rename, 0600), move a corrupt file aside
 * rather than crash on it. `peek` is the otto_status read: no side effects.
 */
import { readFileSync, writeFileSync, renameSync } from 'fs'
import { basename } from 'path'

export function loadState<T>(file: string, empty: () => T, valid: (x: unknown) => boolean, o: { peek?: boolean } = {}): T {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return valid(parsed) ? parsed as T : empty()
  } catch (err) {
    if (!o.peek && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
      process.stderr.write(`otto channel: ${basename(file)} corrupt, moved aside.\n`)
    }
    return empty()
  }
}

export function saveState(file: string, value: unknown): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}
