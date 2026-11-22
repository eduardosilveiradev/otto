import { InlineKeyboard } from 'grammy'
import { carriesPairingCode } from './pairing.ts'

export type ReplyButton = { label: string; data?: string; url?: string; copy?: string }

// callback_data hard limit is 64 bytes and "btn:" takes 4, so data gets 60.
// Riding the instruction inside callback_data keeps taps stateless: they
// survive server restarts and session compaction with no pending-map.
const BUTTON_DATA_MAX = 60

/**
 * Data only the server writes: a pairing nonce, and the stale-PR sweep's merges and
 * closes. A session-written button or card action carrying it is refused outright.
 * (taps.ts also checks every server-run tap against what the server offered.)
 */
export const RESERVED_DATA = /^\s*(pair|merge stack|merge PR|close PR)\s/i

export function validateButtons(raw: unknown): ReplyButton[] {
  const buttons = (raw as ReplyButton[] | undefined) ?? []
  if (buttons.length > 6) throw new Error('too many buttons (max 6)')
  for (const b of buttons) {
    if (!b?.label?.trim() || (b.data?.trim() ? 1 : 0) + (b.url ? 1 : 0) + (b.copy ? 1 : 0) !== 1) throw new Error('each button needs a label and exactly one of data, url or copy')
    if (b.copy != null && !(b.copy.length >= 1 && b.copy.length <= 256)) throw new Error('button copy text must be 1–256 characters')
    if (b.url != null && !(/^https:\/\//.test(b.url) && b.url.length <= 1024)) throw new Error('button url must be https:// (max 1024 chars)')
    if (b.data != null) {
      // appTap trims before dispatch, so " pair ok …" would still reach pairingButton.
      if (RESERVED_DATA.test(b.data)) throw new Error('reserved button')
      const bytes = Buffer.byteLength(b.data, 'utf8')
      if (bytes > BUTTON_DATA_MAX) {
        throw new Error(`button data is ${bytes} bytes (max ${BUTTON_DATA_MAX}): "${b.data}" — shorten it into a self-contained instruction`)
      }
    }
  }
  return buttons
}

/** A dashboard pairing code reaches the user from the dashboard's screen, never from the session, whatever it read. */
export function assertNoPairingCode(...texts: string[]): void {
  if (texts.some(carriesPairingCode)) throw new Error('refused: this text carries a dashboard pairing code — the user reads those off the dashboard, never from a message')
}

export function buttonKeyboard(buttons: ReplyButton[]): InlineKeyboard {
  const kb = new InlineKeyboard()
  buttons.forEach((b, i) => {
    if (i > 0 && i % 3 === 0) kb.row()
    if (b.url) kb.url(b.label, b.url)
    else if (b.copy) kb.copyText(b.label, b.copy)
    else kb.text(b.label, `btn:${b.data}`)
  })
  return kb
}
