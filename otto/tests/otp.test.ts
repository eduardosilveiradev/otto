import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  extractOtp, extractOtps, findCode, cleanSender, senderFromAddress, formatOtp, otpSettings,
  emptyOtpState, otpVerdict, recordSent, scheduleDelete, dueDeletes, settleDelete, pruneOtp,
  loadOtp, saveOtp, otpKey, OTP_DEDUPE_MS, OTP_BURST_MAX, OTP_DELETE_GIVE_UP_MS,
} from '../otp.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-otp-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

/** One mail in the shape the Gmail push webhook delivers. */
function push(sender: string, subject: string, snippet: string): string {
  return `New mail (1) in you@example.com:\n- ${sender} — ${subject} — ${snippet} [id 18f2a9c0d1]`
}

const BANK = 'Bank <noreply@bank.example>'

// ---------------------------------------------------------------------------
// Real codes — English
// ---------------------------------------------------------------------------

test('en: the canonical push line', () => {
  expect(extractOtp(push(BANK, 'Your code', 'Your verification code is 482913'))).toEqual({ code: '482913', sender: 'Bank' })
})

test('en: code before the keyword', () => {
  expect(extractOtp(push('Shop <no-reply@shop.example>', 'Sign in', '482913 is your one-time passcode. It expires in 10 minutes.'))?.code).toBe('482913')
})

test('en: 2FA with a four-digit code', () => {
  expect(extractOtp(push('Forum <mail@forum.example>', '2FA', 'Use 7351 to finish signing in.'))?.code).toBe('7351')
})

test('en: OTP of eight digits', () => {
  expect(extractOtp(push(BANK, 'Login', 'Your OTP: 90817263. Never share it.'))?.code).toBe('90817263')
})

test('en: six-character alphanumeric code', () => {
  expect(extractOtp(push('Games <noreply@games.example>', 'Verify your email', 'Enter this code to verify: K7X2QP'))?.code).toBe('K7X2QP')
})

test('en: a code printed in halves', () => {
  expect(extractOtp(push('Cloud <account@cloud.example>', 'Security code', 'Your security code is 482 913'))?.code).toBe('482913')
})

test('en: a warning about phone calls does not hide the code', () => {
  expect(extractOtp(push(BANK, 'Your code', 'Your code is 551204. We will never call you to ask for it.'))?.code).toBe('551204')
})

test('en: a phone number after the code, in the next sentence, does not void it', () => {
  expect(extractOtp(push(BANK, 'Your code', 'Your code: 482913. Call 0800 123 4567 if this was not you.'))?.code).toBe('482913')
})

test('en: a date in the same mail is not the code', () => {
  expect(extractOtp(push(BANK, 'Verification', 'On 12/03/2026 at 10:45 you asked for a verification code: 663019'))?.code).toBe('663019')
})

// ---------------------------------------------------------------------------
// Real codes — Italian
// ---------------------------------------------------------------------------

test('it: codice di verifica', () => {
  expect(extractOtp(push('Banca <noreply@banca.example>', 'Codice di verifica', 'Il tuo codice di verifica è 739201'))).toEqual({ code: '739201', sender: 'Banca' })
})

test('it: codice di accesso before the code with a colon', () => {
  expect(extractOtp(push('Poste <info@poste.example>', 'Accesso', 'Codice di accesso: 5521. Valido per 5 minuti.'))?.code).toBe('5521')
})

test('it: password monouso', () => {
  expect(extractOtp(push('Servizio <no-reply@servizio.example>', 'OTP', 'La password monouso per l’operazione è 84021967'))?.code).toBe('84021967')
})

test('it: code first, verifica after', () => {
  expect(extractOtp(push('App <ciao@app.example>', 'Verifica', '208851 è il codice per verificare il tuo account'))?.code).toBe('208851')
})

// ---------------------------------------------------------------------------
// Real codes — Portuguese
// ---------------------------------------------------------------------------

test('pt: código de verificação with accents', () => {
  expect(extractOtp(push('Banco <naoresponda@banco.example>', 'Código de verificação', 'Seu código de verificação é 314159'))).toEqual({ code: '314159', sender: 'Banco' })
})

test('pt: codigo without accents', () => {
  expect(extractOtp(push('Loja <contato@loja.example>', 'Codigo de acesso', 'Seu codigo de acesso: 9021'))?.code).toBe('9021')
})

test('pt: senha temporária', () => {
  expect(extractOtp(push('App <app@app.example>', 'Senha', 'Sua senha temporária é 77120943'))?.code).toBe('77120943')
})

test('pt: alphanumeric código', () => {
  expect(extractOtp(push('Conta <seguranca@conta.example>', 'Verificação', 'Use o código Q4M8ZT para confirmar'))?.code).toBe('Q4M8ZT')
})

test('pt: a money amount in the same mail is skipped for the code', () => {
  expect(extractOtp(push('Banco <naoresponda@banco.example>', 'Compra', 'Compra de R$ 1500 aprovada? Código de autenticação: 662310'))?.code).toBe('662310')
})

// ---------------------------------------------------------------------------
// False-positive traps — English
// ---------------------------------------------------------------------------

test('trap en: an order number near "code"', () => {
  expect(extractOtp(push('Store <orders@store.example>', 'Order 48291375 confirmed', 'Use promo code at checkout next time. Order 48291375 ships soon.'))).toBeNull()
})

test('trap en: a tracking code', () => {
  expect(extractOtp(push('Courier <track@courier.example>', 'Shipped', 'Your tracking code is 77120943'))).toBeNull()
})

test('trap en: a year next to "code of conduct"', () => {
  expect(extractOtp(push('Club <news@club.example>', 'Code of conduct', 'Updated code of conduct for 2026'))).toBeNull()
})

test('trap en: a phone number', () => {
  expect(extractOtp(push('Support <help@support.example>', 'Verify', 'To verify your identity call +44 20 7946 0132'))).toBeNull()
})

test('trap en: a money amount', () => {
  expect(extractOtp(push('Billing <bill@billing.example>', 'Verification of payment', 'We received $4500 for invoice 2213'))).toBeNull()
})

test('trap en: a time', () => {
  expect(extractOtp(push('Calendar <cal@calendar.example>', 'Verify attendance', 'Meeting moved to 1430 UTC, please verify'))).toBeNull()
})

test('trap en: a compact date', () => {
  expect(extractOtp(push('Bank <noreply@bank.example>', 'Statement', 'Your verification statement dated 20261013 is ready'))).toBeNull()
})

test('trap en: a postal code', () => {
  expect(extractOtp(push('Shop <shop@shop.example>', 'Address', 'Please verify your zip code 94105'))).toBeNull()
})

test('trap en: a booking reference', () => {
  expect(extractOtp(push('Airline <noreply@airline.example>', 'Your booking', 'Booking code X7K2PQ — check in opens 24h before'))).toBeNull()
})

test('trap en: the last digits of a card', () => {
  expect(extractOtp(push(BANK, 'Action needed', 'Your account ending 4821 requires verification'))).toBeNull()
})

test('trap en: no keyword at all', () => {
  expect(extractOtp(push('Friend <friend@mail.example>', 'Dinner', 'Room 4812 at 8, bring 3 bottles'))).toBeNull()
})

// ---------------------------------------------------------------------------
// False-positive traps — Italian
// ---------------------------------------------------------------------------

test('trap it: codice ordine', () => {
  expect(extractOtp(push('Negozio <ordini@negozio.example>', 'Ordine confermato', 'Il codice ordine è 551902'))).toBeNull()
})

test('trap it: codice di spedizione', () => {
  expect(extractOtp(push('Corriere <info@corriere.example>', 'Spedizione', 'Il tuo codice di spedizione è 99018273'))).toBeNull()
})

test('trap it: a date written out with the year', () => {
  expect(extractOtp(push('Banca <noreply@banca.example>', 'Accesso', 'Accesso effettuato il 12/03/2026 alle 10:45'))).toBeNull()
})

test('trap it: an amount in euro', () => {
  expect(extractOtp(push('Banca <noreply@banca.example>', 'Verifica pagamento', 'Pagamento di 1250 euro in verifica'))).toBeNull()
})

test('trap it: codice sconto', () => {
  expect(extractOtp(push('Negozio <promo@negozio.example>', 'Offerta', 'Codice sconto SALE20 e 2000 punti'))).toBeNull()
})

// ---------------------------------------------------------------------------
// False-positive traps — Portuguese
// ---------------------------------------------------------------------------

test('trap pt: código de rastreio', () => {
  expect(extractOtp(push('Correio <rastreio@correio.example>', 'Seu pedido', 'O código de rastreio é 88301274'))).toBeNull()
})

test('trap pt: número do pedido', () => {
  expect(extractOtp(push('Loja <contato@loja.example>', 'Código do pedido', 'Pedido 553201 confirmado'))).toBeNull()
})

test('trap pt: a phone number to ring', () => {
  expect(extractOtp(push('Banco <naoresponda@banco.example>', 'Verificação', 'Para verificação ligue 4004 0001'))).toBeNull()
})

test('trap pt: a money amount with decimals', () => {
  expect(extractOtp(push('Banco <naoresponda@banco.example>', 'Código de segurança', 'Compra de R$ 1.234,56 aprovada'))).toBeNull()
})

test('trap pt: a year after senha', () => {
  expect(extractOtp(push('Serviço <app@servico.example>', 'Senha', 'Sua senha expira em 2027'))).toBeNull()
})

test('trap pt: a CEP', () => {
  expect(extractOtp(push('Loja <contato@loja.example>', 'Verifique o endereço', 'Verifique o CEP 01310 do endereço'))).toBeNull()
})

// ---------------------------------------------------------------------------
// Shape of the push
// ---------------------------------------------------------------------------

test('the message id in brackets is never the code', () => {
  expect(extractOtp(`New mail (1) in you@example.com:\n- ${BANK} — Your code — Your code is below [id ABC123]`)).toBeNull()
})

test('two mails in one push give two codes', () => {
  const text = 'New mail (2) in you@example.com:\n' +
    `- ${BANK} — Your code — Your verification code is 482913 [id a1]\n` +
    '- Shop <no-reply@shop.example> — Weekly deals — 30% off everything [id a2]\n' +
    '- noreply@accounts.cloud.example — Sign in — 771204 is your login code [id a3]'
  expect(extractOtps(text)).toEqual([
    { code: '482913', sender: 'Bank' },
    { code: '771204', sender: 'Cloud' },
  ])
})

test('the sender name is not searched for a code', () => {
  expect(extractOtp(push('Verify 2026 Team <team@team.example>', 'Hello', 'Nothing to see here'))).toBeNull()
})

test('free text without the push shape is scanned whole, with no sender', () => {
  expect(extractOtp('Your verification code is 482913')).toEqual({ code: '482913', sender: '' })
})

test('findCode prefers the code closest to its keyword', () => {
  expect(findCode('Order 112233 shipped. Separately, your verification code is 445566')).toBe('445566')
})

// ---------------------------------------------------------------------------
// Sender and formatting
// ---------------------------------------------------------------------------

test('a display name is stripped of markup, control characters and length', () => {
  expect(cleanSender('"Bank*_ \u0007Alerts"')).toBe('Bank Alerts')
  expect(cleanSender('x'.repeat(100)).length).toBe(40)
})

test('an address alone gives the organisation name', () => {
  expect(senderFromAddress('noreply@accounts.bank.example')).toBe('Bank')
  expect(senderFromAddress('no-reply@shop.co.uk')).toBe('Shop')
  expect(senderFromAddress('naoresponda@banco.com.br')).toBe('Banco')
})

test('formatOtp is sender: code, or the bare code', () => {
  expect(formatOtp({ code: '482913', sender: 'Bank' })).toBe('Bank: 482913')
  expect(formatOtp({ code: '482913', sender: '' })).toBe('482913')
})

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test('settings default to on and ten minutes', () => {
  expect(otpSettings(undefined)).toEqual({ enabled: true, deleteAfterMs: 600_000 })
  expect(otpSettings({ enabled: false })).toEqual({ enabled: false, deleteAfterMs: 600_000 })
  expect(otpSettings({ deleteAfterMinutes: 2 }).deleteAfterMs).toBe(120_000)
  expect(otpSettings({ deleteAfterMinutes: 0 }).deleteAfterMs).toBe(0)
  expect(otpSettings({ deleteAfterMinutes: -3 }).deleteAfterMs).toBe(600_000)
})

// ---------------------------------------------------------------------------
// Dedupe, burst cap and deletes
// ---------------------------------------------------------------------------

test('the same sender and code inside ten minutes goes once', () => {
  const s = emptyOtpState()
  const o = { code: '482913', sender: 'Bank' }
  expect(otpVerdict(s, o, 0)).toBe('send')
  recordSent(s, o, 0)
  expect(otpVerdict(s, o, OTP_DEDUPE_MS - 1)).toBe('duplicate')
  expect(otpVerdict(s, { ...o, sender: 'Other' }, 1000)).toBe('send')
  expect(otpVerdict(s, o, OTP_DEDUPE_MS)).toBe('send')
})

test('a burst of codes past the cap takes the slow path', () => {
  const s = emptyOtpState()
  for (let i = 0; i < OTP_BURST_MAX; i++) recordSent(s, { code: `10000${i}`, sender: 'X' }, i)
  expect(otpVerdict(s, { code: '999999', sender: 'Y' }, 10)).toBe('burst')
  // A repeat is still a repeat once the cap is spent: the user has that one.
  expect(otpVerdict(s, { code: '100000', sender: 'X' }, 10)).toBe('duplicate')
})

test('the stored key is a hash, not the code', () => {
  const key = otpKey({ code: '482913', sender: 'Bank' })
  expect(key).not.toContain('482913')
  expect(key).toHaveLength(16)
})

test('deletes come due, settle, and are given up after 48h', () => {
  const s = emptyOtpState()
  scheduleDelete(s, '1234567890', 11, 1000)
  scheduleDelete(s, '1234567890', 12, 5000)
  expect(dueDeletes(s, 2000).map(d => d.message_id)).toEqual([11])
  settleDelete(s, '1234567890', 11)
  expect(s.deletes.map(d => d.message_id)).toEqual([12])
  pruneOtp(s, 5000 + OTP_DELETE_GIVE_UP_MS)
  expect(s.deletes).toEqual([])
})

test('the store round-trips and moves a corrupt file aside', () => {
  const file = join(tmp, 'otp.json')
  const s = emptyOtpState()
  recordSent(s, { code: '482913', sender: 'Bank' }, 1)
  scheduleDelete(s, '1234567890', 42, 99)
  saveOtp(file, s)
  expect(loadOtp(file)).toEqual(s)
  expect(existsSync(file + '.tmp')).toBe(false)

  writeFileSync(file, '{not json')
  expect(loadOtp(file)).toEqual(emptyOtpState())
  expect(readdirSync(tmp).some(n => n.startsWith('otp.json.corrupt-'))).toBe(true)
  expect(loadOtp(join(tmp, 'missing.json'))).toEqual(emptyOtpState())
})
