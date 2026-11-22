import { appendFileSync } from 'fs'

/** No bodies, credentials or raw errors: only transport events and numeric status codes. */
export function connectionLog(file: string, event: string, fields: { code?: number; status?: number | 'network'; attempt?: number; device?: string } = {}): void {
  try { appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + '\n', { mode: 0o600 }) }
  catch { process.stderr.write('otto channel: could not append connection log\n') }
}
