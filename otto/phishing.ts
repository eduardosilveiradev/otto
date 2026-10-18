/**
 * Evidence-based phishing scorer. Pure: no I/O, no clock. Feed it a parsed mail
 * (see phishingmail.ts) and it returns a 0-100 score, a verdict and the lines
 * that justify it, so the warning to the user can say why.
 */

export type MailLink = { href: string; text: string }
export type MailInput = {
  headers: Record<string, string | string[]>
  from: string
  replyTo?: string
  subject: string
  text: string
  links: MailLink[]
}
export type Verdict = 'likely-legit' | 'suspicious' | 'likely-phishing'
export type PhishResult = { score: number; verdict: Verdict; evidence: string[] }

/** Every signal's weight, in one place. Positive adds risk, negative removes it. */
export const WEIGHTS = {
  spfFail: 12,
  dkimFail: 15,
  dmarcFail: 20,
  dkimMisaligned: 10, // DKIM passed but signed by a domain other than From
  noAuthResults: 8, // no Authentication-Results header at all
  allAuthAligned: -25, // spf+dkim+dmarc pass and DKIM d= aligns with From
  lookalike: 35,
  brandImpersonation: 25, // display name names a brand, sender domain isn't theirs
  punycode: 30,
  mixedScript: 30,
  replyToMismatch: 20,
  linkMismatch: 30, // link text shows one domain, href goes elsewhere
  shortener: 12,
  urgency: 12,
  credentialBait: 15,
  paymentChange: 30,
} as const

export const THRESHOLDS = { suspicious: 25, phishing: 55 }

/**
 * Commonly impersonated brands and the domains they really send from. A sender
 * whose registrable domain is in `domains` is that brand; one that is merely
 * close to it (or contains its name) is a lookalike. Add brands here.
 */
export const BRANDS: { name: string; domains: string[] }[] = [
  { name: 'Intesa Sanpaolo', domains: ['intesasanpaolo.com'] },
  { name: 'UniCredit', domains: ['unicredit.it', 'unicredit.eu', 'unicreditgroup.eu'] },
  { name: 'Poste Italiane', domains: ['poste.it', 'posteitaliane.it', 'postepay.it'] },
  { name: 'Nubank', domains: ['nubank.com.br'] },
  { name: 'Itau', domains: ['itau.com.br', 'itau.com'] },
  { name: 'Bradesco', domains: ['bradesco.com.br'] },
  { name: 'Banco do Brasil', domains: ['bancodobrasil.com.br', 'bb.com.br'] },
  { name: 'Revolut', domains: ['revolut.com'] },
  { name: 'N26', domains: ['n26.com'] },
  { name: 'PayPal', domains: ['paypal.com', 'paypal.it', 'paypal.com.br'] },
  { name: 'Amazon', domains: ['amazon.com', 'amazon.it', 'amazon.de', 'amazon.co.uk', 'amazon.com.br'] },
  { name: 'Apple', domains: ['apple.com', 'icloud.com'] },
  { name: 'Google', domains: ['google.com'] },
  { name: 'Microsoft', domains: ['microsoft.com', 'microsoftonline.com', 'live.com', 'outlook.com'] },
  { name: 'DHL', domains: ['dhl.com', 'dhl.it', 'dhl.de'] },
  { name: 'GLS', domains: ['gls-group.com', 'gls-italy.com', 'gls-group.eu'] },
  { name: 'Agenzia delle Entrate', domains: ['agenziaentrate.gov.it'] },
  { name: 'INPS', domains: ['inps.it'] },
]

const SHORTENERS = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'cutt.ly', 'rebrand.ly', 'shorturl.at', 'tiny.cc', 'rb.gy', 'lnkd.in',
])

// Two-label public suffixes we meet; everything else is treated as a single-label TLD.
const SLD_SUFFIXES = new Set(['co.uk', 'com.br', 'gov.it', 'gov.br', 'org.br', 'com.au', 'co.jp'])

const URGENCY = [
  /entro\s+(?:le\s+)?\d+\s*ore/i, /\bimmediatamente\b/i, /\bultimo avviso\b/i, /\bsospes[oa]\b/i, /\baccount (?:sar[aà] )?(?:bloccato|limitato|disattivato)\b/i,
  /\bwithin\s+\d+\s*hours?\b/i, /\bsuspended\b/i, /\bimmediate action\b/i, /\bfinal notice\b/i, /\baccount (?:has been |will be )?(?:locked|limited|closed)\b/i,
  /\bem\s+(?:at[eé]\s+)?\d+\s*horas\b/i, /\bconta (?:bloqueada|suspensa|ser[aá] bloqueada)\b/i, /\búltimo aviso\b/i, /\bimediatamente\b/i,
]
const BAIT = [
  /verifica (?:il tuo|i tuoi|la tua)/i, /conferma (?:il tuo|i tuoi|la tua)/i, /aggiorna (?:i tuoi dati|il tuo account|la tua carta)/i, /\baccedi (?:ora|subito|qui)\b/i, /inserisci (?:la )?(?:password|pin|codice)/i,
  /verify your (?:account|identity|password|payment)/i, /confirm your (?:account|identity|password|login)/i, /\bsign in to (?:restore|keep|avoid)/i, /update your (?:payment|billing|account)/i, /\bclick (?:here|below) to (?:verify|login|log in|confirm)/i,
  /verifique (?:sua|seu|seus|suas)/i, /confirme (?:sua|seu|seus|suas)/i, /atualize (?:seus dados|sua conta|seu cadastro)/i, /\bacesse (?:agora|sua conta)\b/i, /informe (?:sua )?senha/i,
]
const PAYMENT_CHANGE = [
  /\b(?:nuovo|cambio|modifica|variazione)\s+(?:del(?:l['’])?\s*)?iban\b/i, /\biban\b.{0,60}\b(?:cambiato|modificato|nuovo|aggiornato)\b/i, /\bnuove coordinate bancarie\b/i,
  /\b(?:new|changed|updated|change of)\s+(?:bank|iban|account)\s*(?:details|number|iban)?\b.{0,40}\b(?:payment|invoice|pay)/i, /\b(?:our|my)\s+(?:bank|iban)\s+(?:details|account)?\s*(?:has|have)\s+changed\b/i, /\biban\b.{0,60}\b(?:changed|has changed|new)\b/i,
  /\bnovos? dados banc[aá]rios\b/i, /\bmudan[cç]a de (?:conta|chave pix|dados banc[aá]rios)\b/i, /\bnova chave pix\b/i,
]

export function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]
}

/** Collapse look-alike characters onto the letters they imitate. */
export function deHomoglyph(s: string): string {
  const map: Record<string, string> = { '0': 'o', '1': 'l', '3': 'e', '5': 's', 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'ѕ': 's', 'і': 'i', 'ο': 'o', 'ν': 'v', 'ɩ': 'l' }
  return s.toLowerCase().replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/./gu, c => map[c] ?? c)
}

export function domainOf(addr: string): string {
  const m = addr.match(/@([^\s>;,"')]+)/)
  return (m ? m[1] : '').toLowerCase().replace(/\.$/, '')
}

export function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase() } catch { return '' }
}

export function registrable(host: string): string {
  const p = host.split('.').filter(Boolean)
  if (p.length <= 2) return p.join('.')
  return p.slice(SLD_SUFFIXES.has(p.slice(-2).join('.')) ? -3 : -2).join('.')
}

const labelOf = (host: string) => registrable(host).split('.')[0]

const brandOwns = (b: (typeof BRANDS)[number], host: string) => b.domains.includes(registrable(host))

function headerVals(h: MailInput['headers'], name: string): string[] {
  for (const k of Object.keys(h)) if (k.toLowerCase() === name) return ([] as string[]).concat(h[k])
  return []
}

/** The brand a host imitates (but is not), with why; null when it is clean or genuinely theirs. */
export function lookalikeOf(host: string): { brand: string; why: string } | null {
  if (!host) return null
  const reg = registrable(host)
  if (BRANDS.some(b => brandOwns(b, host))) return null
  const label = labelOf(host)
  const flat = deHomoglyph(label)
  for (const b of BRANDS) {
    for (const d of b.domains) {
      const bl = d.split('.')[0]
      if (bl.length < 3) continue
      if (flat === bl && label !== bl) return { brand: b.name, why: `${reg} swaps look-alike characters for ${d}` }
      // short labels (n26, gls, inps) false-positive on distance, so they only get distance 1 from 4 chars up
      const max = bl.length >= 5 ? 2 : bl.length >= 4 ? 1 : 0
      for (const cand of [label, flat]) {
        const dist = levenshtein(cand, bl)
        if (dist > 0 && dist <= max) return { brand: b.name, why: `${reg} is ${dist} edit${dist > 1 ? 's' : ''} from ${d}` }
      }
      if (bl.length >= 4 && label.split('-').includes(bl)) return { brand: b.name, why: `${reg} embeds "${bl}" but is not ${d}` }
    }
  }
  return null
}

const CYR_GREEK = /[Ͱ-ϿЀ-ӿ]/
const LATIN = /[a-z]/i

function dkimResults(auth: string): { result: string; d: string }[] {
  return auth.split(';').flatMap(seg => {
    const m = seg.match(/\bdkim=(\w+)/i)
    return m ? [{ result: m[1].toLowerCase(), d: (seg.match(/header\.d=([^\s;]+)/i)?.[1] ?? '').toLowerCase() }] : []
  })
}

export function scoreMail(m: MailInput): PhishResult {
  const evidence: string[] = []
  let score = 0
  const add = (w: number, line: string) => { score += w; evidence.push(line) }

  const fromHost = domainOf(m.from)
  const fromReg = registrable(fromHost)

  // Authentication-Results: only the topmost one counts. The receiving MTA
  // (mx.google.com for Gmail) prepends its own above everything it was handed;
  // any further down travelled with the message, so the sender could have
  // written "dkim=pass" into it.
  const allAuth = headerVals(m.headers, 'authentication-results')
  const auth = allAuth[0] ?? ''
  if (allAuth.length > 1) evidence.push(`${allAuth.length - 1} further Authentication-Results header${allAuth.length > 2 ? 's' : ''} ignored (not added by the receiving server)`)
  if (!auth) add(WEIGHTS.noAuthResults, 'no Authentication-Results header, so SPF/DKIM/DMARC cannot be confirmed')
  else {
    const res = (k: string) => auth.match(new RegExp(`\\b${k}=(\\w+)`, 'i'))?.[1]?.toLowerCase()
    const spf = res('spf'), dmarc = res('dmarc')
    const dk = dkimResults(auth)
    const dkimPass = dk.find(x => x.result === 'pass')
    const dkim = dkimPass ? 'pass' : dk[0]?.result
    for (const [name, v, w] of [['SPF', spf, WEIGHTS.spfFail], ['DKIM', dkim, WEIGHTS.dkimFail], ['DMARC', dmarc, WEIGHTS.dmarcFail]] as const) {
      if (v === undefined) evidence.push(`${name} result missing`)
      else if (v === 'pass') evidence.push(`${name} pass`)
      else add(w, `${name} ${v}`)
    }
    const aligned = !!dkimPass && !!fromReg && registrable(dkimPass.d) === fromReg
    if (dkimPass) {
      if (aligned) evidence.push(`DKIM d=${dkimPass.d} aligns with From ${fromHost}`)
      else add(WEIGHTS.dkimMisaligned, `DKIM passed for d=${dkimPass.d || '(none)'}, which does not align with From ${fromHost}`)
    }
    if (spf === 'pass' && dkim === 'pass' && dmarc === 'pass' && aligned) add(WEIGHTS.allAuthAligned, 'SPF, DKIM and DMARC all pass with aligned DKIM')
  }

  // Domains in play: sender, reply-to, link targets
  const rtHost = m.replyTo ? domainOf(m.replyTo) : ''
  const linkHosts = [...new Set(m.links.map(l => hostOf(l.href)).filter(Boolean))]
  const hosts = [...new Set([fromHost, rtHost, ...linkHosts].filter(Boolean))]

  const puny = hosts.filter(h => h.split('.').some(l => l.startsWith('xn--')))
  if (puny.length) add(WEIGHTS.punycode, `punycode domain: ${puny.join(', ')}`)
  const mixed = hosts.filter(h => CYR_GREEK.test(h) && LATIN.test(h))
  if (mixed.length) add(WEIGHTS.mixedScript, `mixed-script domain: ${mixed.join(', ')}`)

  const lookBrands = new Set<string>()
  for (const h of hosts) {
    const l = lookalikeOf(h)
    if (l) { lookBrands.add(l.brand); add(WEIGHTS.lookalike, `lookalike of ${l.brand}: ${l.why}`) }
  }

  // Display name claims a brand the sender domain does not own
  const display = m.from.replace(/<[^>]*>/, '')
  const claimed = BRANDS.find(b => new RegExp(`\\b${b.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(display))
  if (claimed && fromHost && !brandOwns(claimed, fromHost) && !lookBrands.has(claimed.name)) {
    add(WEIGHTS.brandImpersonation, `display name claims ${claimed.name} but mail comes from ${fromHost}`)
  }

  if (rtHost && fromReg && registrable(rtHost) !== fromReg) add(WEIGHTS.replyToMismatch, `Reply-To ${rtHost} differs from From ${fromHost}`)

  // Links
  const shown = /^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/:?#]|$)/i
  const mismatches = new Set<string>()
  for (const l of m.links) {
    const th = l.text.trim().match(shown)?.[1]?.toLowerCase()
    const hh = hostOf(l.href)
    if (th && hh && registrable(th) !== registrable(hh)) mismatches.add(`link shows ${th} but goes to ${hh}`)
  }
  if (mismatches.size) add(WEIGHTS.linkMismatch, [...mismatches].slice(0, 3).join('; '))
  const short = linkHosts.filter(h => SHORTENERS.has(h))
  if (short.length) add(WEIGHTS.shortener, `link shortener: ${short.join(', ')}`)

  // Language
  const body = `${m.subject}\n${m.text}`
  const u = URGENCY.find(r => r.test(body))
  if (u) add(WEIGHTS.urgency, `urgency language: "${body.match(u)![0]}"`)
  const b = BAIT.find(r => r.test(body))
  if (b) add(WEIGHTS.credentialBait, `credential or login bait: "${body.match(b)![0]}"`)
  const p = PAYMENT_CHANGE.find(r => r.test(body))
  if (p) add(WEIGHTS.paymentChange, `payment-detail change: "${body.match(p)![0]}"`)

  score = Math.max(0, Math.min(100, score))
  const verdict: Verdict = score >= THRESHOLDS.phishing ? 'likely-phishing' : score >= THRESHOLDS.suspicious ? 'suspicious' : 'likely-legit'
  return { score, verdict, evidence }
}
