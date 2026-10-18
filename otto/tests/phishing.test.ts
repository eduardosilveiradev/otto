import { test, expect } from 'bun:test'
import { scoreMail, lookalikeOf, type MailInput } from '../phishing.ts'
import { parseMime, rawFromGog, checkMessage } from '../phishingmail.ts'

const PASS = 'mx.example.net; spf=pass smtp.mailfrom=intesasanpaolo.com; dkim=pass header.d=intesasanpaolo.com; dmarc=pass header.from=intesasanpaolo.com'

function mail(over: Partial<MailInput> = {}): MailInput {
  return { headers: { 'Authentication-Results': PASS }, from: 'Intesa <info@intesasanpaolo.com>', subject: 'Il tuo estratto conto', text: 'Trovi l\'estratto conto in area riservata.', links: [], ...over }
}

test('legit bank mail with aligned DKIM pass is likely-legit', () => {
  const r = scoreMail(mail({ links: [{ href: 'https://www.intesasanpaolo.com/it', text: 'intesasanpaolo.com' }] }))
  expect(r.verdict).toBe('likely-legit')
  expect(r.score).toBe(0)
  expect(r.evidence.join('\n')).toContain('aligns with From')
})

test('lookalike domain with failing auth is likely-phishing', () => {
  const r = scoreMail(mail({
    headers: { 'authentication-results': 'mx.example.net; spf=fail; dkim=none; dmarc=fail' },
    from: 'Intesa <info@intesasanpaoIo.com>',
    subject: 'Verifica il tuo account entro 24 ore',
    text: 'Il tuo account sarà sospeso.',
  }))
  expect(r.verdict).toBe('likely-phishing')
  expect(r.evidence.join('\n')).toMatch(/lookalike of Intesa Sanpaolo/)
  expect(r.evidence).toContain('DMARC fail')
})

test('lookalike detection: distance, homoglyph, embedding, and no false hits', () => {
  expect(lookalikeOf('paypa1.com')?.brand).toBe('PayPal')
  expect(lookalikeOf('arnazon.it')?.brand).toBe('Amazon')
  expect(lookalikeOf('paypal-secure.com')?.brand).toBe('PayPal')
  expect(lookalikeOf('mail.paypal.com')).toBeNull()
  expect(lookalikeOf('example.com')).toBeNull()
  expect(lookalikeOf('gps.com')).toBeNull() // short brand label, no distance match
})

test('reply-to on another domain is flagged', () => {
  const r = scoreMail(mail({ replyTo: 'support@example.org', headers: {} }))
  expect(r.evidence.join('\n')).toContain('Reply-To example.org differs from From intesasanpaolo.com')
  expect(r.verdict).toBe('suspicious')
})

test('punycode domain is flagged', () => {
  const r = scoreMail(mail({ from: 'Apple <id@xn--pple-43d.example>', headers: {} }))
  expect(r.evidence.join('\n')).toContain('punycode domain: xn--pple-43d.example')
})

test('mixed-script domain is flagged', () => {
  const r = scoreMail(mail({ from: 'x <a@pаypal.example>', headers: {} })) // Cyrillic а
  expect(r.evidence.join('\n')).toContain('mixed-script')
})

test('link text that shows one domain while href goes elsewhere', () => {
  const r = scoreMail(mail({ links: [{ href: 'https://login.example.net/x', text: 'www.intesasanpaolo.com' }, { href: 'https://bit.ly/abc', text: 'qui' }] }))
  const e = r.evidence.join('\n')
  expect(e).toContain('link shows www.intesasanpaolo.com but goes to login.example.net')
  expect(e).toContain('link shortener: bit.ly')
})

test('clean newsletter stays low', () => {
  const r = scoreMail({
    headers: { 'authentication-results': 'mx.example.net; spf=pass; dkim=pass header.d=news.example.com; dmarc=pass' },
    from: 'Weekly <hello@news.example.com>', subject: 'This week in tech', text: 'Read the latest at https://news.example.com/week',
    links: [{ href: 'https://news.example.com/week', text: 'Read more' }],
  })
  expect(r.verdict).toBe('likely-legit')
})

test('language: urgency and credential bait in it/en/pt, and IBAN change', () => {
  for (const t of ['Verifica il tuo account entro 24 ore', 'Your account is suspended, verify your account', 'Sua conta bloqueada. Confirme seus dados']) {
    expect(scoreMail(mail({ text: t })).evidence.join('\n')).toMatch(/urgency|bait/)
  }
  const r = scoreMail(mail({ text: 'Attenzione: nuovo IBAN per il pagamento della fattura.' }))
  expect(r.evidence.join('\n')).toContain('payment-detail change')
})

test('missing Authentication-Results is evidence, not a pass', () => {
  expect(scoreMail(mail({ headers: {} })).evidence[0]).toContain('no Authentication-Results')
})

const b64 = (s: string) => Buffer.from(s).toString('base64').replace(/(.{60})/g, '$1\r\n')

test('MIME: multipart with base64 html and quoted-printable plain', () => {
  const html = '<p>Ciao <a href="https://evil.example.net/a?x=1&amp;y=2">www.paypal.com</a></p>'
  const raw = [
    'From: =?utf-8?B?UGF5UGFs?= <service@paypa1.example>',
    'Reply-To: x@example.org',
    'Subject: =?utf-8?Q?Verifica_il_tuo_account?=',
    'Authentication-Results: mx; spf=fail',
    'Content-Type: multipart/alternative; boundary="BB"',
    '',
    '--BB',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Il tuo account =C3=A8 sospeso. Vai su https://evil.example.net/a=',
    '?x=1',
    '--BB',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(html),
    '--BB--',
    '',
  ].join('\r\n')
  const m = parseMime(raw)
  expect(m.from).toBe('PayPal <service@paypa1.example>')
  expect(m.subject).toBe('Verifica il tuo account')
  expect(m.replyTo).toBe('x@example.org')
  expect(m.text).toContain('Il tuo account è sospeso.')
  expect(m.text).toContain('https://evil.example.net/a?x=1')
  expect(m.links[0]).toEqual({ href: 'https://evil.example.net/a?x=1&y=2', text: 'www.paypal.com' })
  const r = scoreMail(m)
  expect(r.verdict).toBe('likely-phishing')
})

test('MIME: html-only mail falls back to stripped text; nested multipart and attachments', () => {
  const raw = [
    'From: a@example.com', 'Subject: hi', 'Content-Type: multipart/mixed; boundary="O"', '',
    '--O', 'Content-Type: multipart/alternative; boundary="I"', '',
    '--I', 'Content-Type: text/html', '', '<b>Hello</b> <style>x{}</style>world', '--I--',
    '--O', 'Content-Type: text/plain', 'Content-Disposition: attachment; filename=a.txt', '', 'secret attachment', '--O--', '',
  ].join('\n')
  const m = parseMime(raw)
  expect(m.text).toBe('Hello world')
})

test('gog json wrapper is unwrapped and checkMessage runs end to end', async () => {
  const raw = `From: Bank <a@intesasanpaolo.com>\r\nAuthentication-Results: ${PASS}\r\nSubject: hi\r\n\r\nciao`
  const json = JSON.stringify({ raw: Buffer.from(raw).toString('base64url') })
  expect(rawFromGog(json)).toBe(raw)
  let seen: string[] = []
  const r = await checkMessage('abc123', 'you@example.com', async c => { seen = c; return json })
  expect(seen).toEqual(['gog', 'gmail', 'get', 'abc123', '-a', 'you@example.com', '--format', 'raw', '--json'])
  expect(r.verdict).toBe('likely-legit')
  await expect(checkMessage('a;b', 'you@example.com', async () => json)).rejects.toThrow('bad message id')
})

test('only the receiving server\'s topmost Authentication-Results counts, not one the sender added below it', () => {
  const raw = [
    'Authentication-Results: mx.google.com; spf=fail smtp.mailfrom=intesasanpaoIo.com; dkim=none; dmarc=fail header.from=intesasanpaolo.com',
    'Authentication-Results: mx.google.com; spf=pass smtp.mailfrom=intesasanpaolo.com; dkim=pass header.d=intesasanpaolo.com; dmarc=pass header.from=intesasanpaolo.com',
    'From: Intesa <info@intesasanpaolo.com>',
    'Subject: Il tuo estratto conto',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Trovi l\'estratto conto in area riservata.',
  ].join('\r\n')
  const r = scoreMail(parseMime(raw))
  expect(r.evidence).toContain('DMARC fail')
  expect(r.evidence).toContain('SPF fail')
  expect(r.evidence.join('\n')).not.toContain('aligns with From')
  expect(r.evidence.join('\n')).toContain('1 further Authentication-Results header ignored')
  expect(r.score).toBeGreaterThan(scoreMail(mail()).score)
})

test('an out-of-range numeric entity in HTML leaves the scorer standing', () => {
  const raw = 'From: a@example.com\r\nSubject: hi\r\nContent-Type: text/html\r\n\r\n<p>pay &#99999999; now</p>'
  expect(parseMime(raw).text).toBe('pay &#99999999; now')
})
