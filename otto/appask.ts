/**
 * Siri's door into the conversation.
 *
 * Siri gets one turn to answer. The app sends what was said over HTTP instead
 * of the socket, and the response waits up to ASK_WAIT_MS for Otto's first
 * conversational reply, which Siri then reads out. A reply with buttons is
 * waiting on a tap, so the app opens on it. server.ts does the wiring.
 */

// ponytail: one fixed wait, the calibration knob; lower it if Siri cuts the intent off before Otto answers.
export const ASK_WAIT_MS = 20_000

/** Same shape as server.ts's ReplyButton, so appSend's buttons pass straight in. */
export type AskReply = { id: string; text: string; buttons: { label: string; data?: string; url?: string }[] }
export type Ask = { id: string; text: string; meta: Record<string, string> }

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : undefined)
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Validates the body of POST /app/ask; undefined means refuse it. */
export function parseAsk(body: unknown): Ask | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const b = body as Record<string, unknown>
  if (typeof b.id !== 'string' || !/^[\w-]{1,64}$/.test(b.id)) return undefined
  const id = b.id
  const text = typeof b.text === 'string' ? b.text.trim().slice(0, 2000) : ''
  if (b.via === 'siri') return text ? { id, text, meta: { via: 'siri' } } : undefined
  if (b.via === 'keyboard') {
    // The Otto keyboard, inside another app: what they asked, plus the field's text up to the cursor.
    const field = typeof b.field === 'string' ? b.field.trim().slice(-2000) : ''
    if (!text && !field) return undefined
    return { id, text: (text || '(continue this)') + (field ? `\n\nText in the field:\n${field}` : ''), meta: { via: 'keyboard' } }
  }
  if (b.via === 'wallet') {
    // A Wallet payment from the Shortcuts "Transaction" automation, fields as the phone gives them.
    const amount = str(b.amount), merchant = str(b.merchant), card = str(b.card)
    if (!amount) return undefined
    const meta: Record<string, string> = { via: 'wallet', wallet_amount: amount }
    if (merchant) meta.wallet_merchant = merchant
    if (card) meta.wallet_card = card
    return { id, text: `paid ${amount}${merchant ? ` at ${merchant}` : ''}${card ? ` with ${card}` : ''}`, meta }
  }
  if (b.via !== 'here') return undefined
  const p = b.place
  if (!p || typeof p !== 'object' || Array.isArray(p)) return undefined
  const q = p as Record<string, unknown>
  const { lat, lon, accuracy } = q
  if (!num(lat) || !num(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined
  const name = str(q.name), address = str(q.address), city = str(q.city), country = str(q.country)
  const meta: Record<string, string> = { via: 'here', here_lat: lat.toFixed(5), here_lon: lon.toFixed(5) }
  if (num(accuracy) && accuracy >= 0) meta.here_accuracy = String(Math.round(accuracy))
  if (name) meta.here_name = name
  if (address) meta.here_address = address
  if (city) meta.here_city = city
  if (country) meta.here_country = country
  return { id, text: text || '(save this place)', meta }
}

/** Asks waiting on their answer, oldest first. `ready`: whether the session has read that ask
 *  yet; a reply before then answers something else. */
const waiting: { done: (r?: AskReply) => void; ready: () => boolean }[] = []

export function waitForReply(ms = ASK_WAIT_MS, ready: () => boolean = () => true): Promise<AskReply | undefined> {
  return new Promise(resolve => {
    const w = {
      ready,
      done: (r?: AskReply) => { clearTimeout(timer); const i = waiting.indexOf(w); if (i >= 0) waiting.splice(i, 1); resolve(r) },
    }
    const timer = setTimeout(() => w.done(), ms)
    waiting.push(w)
  })
}

/** One conversational reply answers one ask: the oldest the session has already read. */
export function settleReply(r: AskReply): void {
  waiting.find(w => w.ready())?.done(r)
}
