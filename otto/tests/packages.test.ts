import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  recordPackage, markDelivered, activePackages, loadPackages, trackingUrl, carrierName, carrierKey,
  formatPackage, parsePackageMail, splitMail, findDate, type PackageRecord,
} from '../packages.ts'

const tmp = mkdtempSync(join(tmpdir(), 'otto-packages-'))
afterAll(() => { try { rmSync(tmp, { recursive: true }) } catch {} })

const NOW = new Date('2026-10-14T09:00:00Z')
let n = 0
const fresh = () => join(tmp, `packages-${++n}.json`)

test('the same mail re-read on every scan is applied once', () => {
  const f = fresh()
  const a = recordPackage(f, { carrier: 'DHL', tracking: 'JD000000000000000000', status: 'shipped', source: 'email:m1' }, NOW)
  expect(a).toMatchObject({ created: true, applied: true })
  const b = recordPackage(f, { carrier: 'DHL', tracking: 'JD000000000000000000', status: 'shipped', source: 'email:m1' }, NOW)
  expect(b).toMatchObject({ created: false, applied: false })
  const [p] = loadPackages(f)
  expect(p.events.length).toBe(1)
  expect(p.sources).toEqual(['email:m1'])
})

test('tracking numbers match regardless of case and spacing', () => {
  const f = fresh()
  const a = recordPackage(f, { carrier: 'ups', tracking: '1z 999 aa1 0123456784', status: 'shipped', source: 'email:m1' }, NOW)
  const b = recordPackage(f, { carrier: 'UPS', tracking: '1Z999AA10123456784', status: 'in_transit', source: 'email:m2' }, NOW)
  expect(b.record.id).toBe(a.record.id)
  expect(b.record.tracking).toBe('1Z999AA10123456784')
  expect(loadPackages(f).length).toBe(1)
})

test('status never walks backwards, except into an exception, and resumes from there', () => {
  const f = fresh()
  const base = { carrier: 'BRT', tracking: '000000000000' }
  recordPackage(f, { ...base, status: 'out_for_delivery', source: 'email:m1', at: '2026-10-13T08:00:00Z' }, NOW)
  const late = recordPackage(f, { ...base, status: 'shipped', source: 'email:m0', at: '2026-10-11T08:00:00Z' }, NOW)
  expect(late.record.status).toBe('out_for_delivery')
  expect(late.record.events.map(e => e.status)).toEqual(['shipped', 'out_for_delivery']) // logged, in time order
  expect(recordPackage(f, { ...base, status: 'exception', text: 'Recipient absent', source: 'email:m2' }, NOW).record.status).toBe('exception')
  // Back on the van, but never back to "in transit".
  expect(recordPackage(f, { ...base, status: 'in_transit', source: 'email:m3' }, NOW).record.status).toBe('exception')
  const done = recordPackage(f, { ...base, status: 'delivered', source: 'email:m4', at: '2026-10-14T08:30:00Z' }, NOW).record
  expect(done.status).toBe('delivered')
  expect(done.deliveredAt).toBe('2026-10-14T08:30:00.000Z')
})

test('an order with no tracking picks up its dispatch notice by merchant and item', () => {
  const f = fresh()
  const o = recordPackage(f, { merchant: 'Example Shop', item: 'Desk lamp', status: 'ordered', source: 'email:m1' }, NOW)
  const s = recordPackage(f, { merchant: 'example shop', item: 'desk lamp', carrier: 'Poste Italiane', tracking: 'JD000000000000000000', status: 'shipped', eta: '2026-10-20', etaLatest: '2026-10-22', source: 'email:m2' }, NOW)
  expect(s.record.id).toBe(o.record.id)
  expect(s.record).toMatchObject({ carrier: 'poste', tracking: 'JD000000000000000000', status: 'shipped', eta: '2026-10-20', etaLatest: '2026-10-22' })
  // A new single-day estimate drops the old window.
  expect(recordPackage(f, { carrier: 'SDA', tracking: 'JD000000000000000000', status: 'in_transit', eta: '2026-10-19', source: 'email:m3' }, NOW).record.etaLatest).toBeUndefined()
  // A month later the same merchant and item is a new order.
  const later = new Date(NOW.getTime() + 31 * 86_400_000)
  expect(recordPackage(f, { merchant: 'Example Shop', item: 'Desk lamp', source: 'email:m9' }, later).created).toBe(true)
})

test('bad input is refused, not guessed', () => {
  const f = fresh()
  expect(() => recordPackage(f, { item: 'something' })).toThrow()
  expect(() => recordPackage(f, { merchant: 'Shop', status: 'lost' as any })).toThrow()
  expect(() => recordPackage(f, { merchant: 'Shop', eta: 'next week' })).toThrow()
})

test('done marks it delivered by hand, once', () => {
  const f = fresh()
  const { record } = recordPackage(f, { carrier: 'GLS', tracking: '00000000', status: 'in_transit' }, NOW)
  const d = markDelivered(f, record.id, NOW)!
  expect(d).toMatchObject({ status: 'delivered', deliveredAt: NOW.toISOString() })
  expect(markDelivered(f, record.id, NOW)!.events.length).toBe(2)
  expect(markDelivered(f, 'nope', NOW)).toBeUndefined()
})

test('listing: coming first by eta with none last, then delivered in the last 30 days, newest first', () => {
  const p = (id: string, over: Partial<PackageRecord>): PackageRecord => ({
    id, carrier: 'dhl', status: 'in_transit', events: [], sources: [], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...over,
  })
  const rows = activePackages([
    p('noeta', {}),
    p('late', { eta: '2026-10-25' }),
    p('soon', { eta: '2026-10-15' }),
    p('old', { status: 'delivered', deliveredAt: '2026-08-01T00:00:00Z' }),
    p('d1', { status: 'delivered', deliveredAt: '2026-10-10T00:00:00Z' }),
    p('d2', { status: 'delivered', deliveredAt: '2026-10-12T00:00:00Z' }),
    p('stuck', { status: 'exception', eta: '2026-10-14' }),
  ], NOW.getTime())
  expect(rows.map(r => r.id)).toEqual(['stuck', 'soon', 'late', 'noeta', 'd2', 'd1'])
})

test('tracking links per carrier; Amazon and unknown carriers have none', () => {
  expect(trackingUrl('DHL', 'jd 0000')).toBe('https://www.dhl.com/global-en/home/tracking.html?tracking-id=JD0000&submit=1')
  expect(trackingUrl('ups', '1Z0')).toBe('https://www.ups.com/track?tracknum=1Z0')
  expect(trackingUrl('FedEx', '0')).toContain('fedex.com')
  expect(trackingUrl('GLS', '0')).toContain('gls-group.com')
  expect(trackingUrl('Bartolini', '0')).toContain('brt.it')
  expect(trackingUrl('SDA', '0')).toContain('poste.it')
  expect(trackingUrl('Poste Italiane', '0')).toContain('poste.it')
  expect(trackingUrl('InPost', '0')).toContain('inpost')
  expect(trackingUrl('USPS', '0')).toContain('usps.com')
  expect(trackingUrl('Amazon', 'TBA000000000000')).toBeUndefined()
  expect(trackingUrl('Some Courier', '0')).toBeUndefined()
  expect(trackingUrl('DHL')).toBeUndefined()
  expect(trackingUrl('UPS', 'A&B')).toBe('https://www.ups.com/track?tracknum=A%26B')
})

test('carrier names are case-insensitive and display properly', () => {
  expect(carrierKey('Poste Italiane')).toBe('poste')
  expect(carrierName('fedex')).toBe('FedEx')
  expect(carrierName('poste')).toBe('Poste Italiane')
  expect(carrierName('Some Courier')).toBe('Some Courier')
  expect(formatPackage({
    id: 'p1', carrier: 'inpost', tracking: '0', item: 'Book', merchant: 'Shop', status: 'shipped', eta: '2026-10-20', etaLatest: '2026-10-21',
    events: [], sources: [], createdAt: '', updatedAt: '',
  })).toBe('p1 · Shipped · Book from Shop · InPost 0 · eta 2026-10-20–2026-10-21')
})

// ---------------------------------------------------------------------------
// Reading courier mail. Each fixture is in the carrier's house style; every
// tracking number is fake.
// ---------------------------------------------------------------------------

const MAIL_NOW = new Date('2026-10-13T09:00:00Z')
const parse = (from: string, subject: string, text: string) => parsePackageMail({ from, subject, text }, MAIL_NOW)

test('GLS: departure carries the date and window; transit; delivered has no eta', () => {
  expect(parse('GLS Italy <noreply@gls-italy.com>', 'GLS - Notifica partenza spedizione 123456789012',
    'Gentile cliente,\nla spedizione numero 123456789012 è partita per la consegna.\nData di consegna prevista: 15/10/2026 tra le 09:00 e le 13:00.\nMittente: Negozio Esempio Srl\n'))
    .toEqual({ carrier: 'gls', tracking: '123456789012', status: 'out_for_delivery', eta: '2026-10-15', merchant: 'Negozio Esempio Srl', text: 'Out for delivery, 09:00-13:00' })
  expect(parse('GLS Italy <noreply@gls-italy.com>', 'La tua spedizione GLS è in transito',
    'Il tuo pacco con Track ID 123456789012 è arrivato presso la filiale di Bologna ed è in transito.\n'))
    .toMatchObject({ carrier: 'gls', tracking: '123456789012', status: 'in_transit' })
  const done = parse('GLS <info@gls-italy.com>', 'Spedizione consegnata', 'La spedizione 123456789012 è stata consegnata il 15/10/2026 alle 11:42.\n')
  expect(done).toMatchObject({ carrier: 'gls', status: 'delivered' })
  expect(done!.eta).toBeUndefined()
})

test('Poste/SDA: giacenza names the office, a failed attempt, delivered', () => {
  expect(parse('Poste Italiane <noreply@poste.it>', 'Pacco RA123456789IT in giacenza',
    'Non siamo riusciti a consegnare il tuo pacco RA123456789IT. È in giacenza.\nPunto di ritiro: Ufficio Postale Torino 12, Via delle Rose 4\n'))
    .toMatchObject({ carrier: 'poste', tracking: 'RA123456789IT', status: 'exception', text: 'Ready for pickup at Ufficio Postale Torino 12, Via delle Rose 4' })
  expect(parse('SDA Express Courier <servizioclienti@sda.it>', 'SDA: tentativo di consegna non riuscito',
    'Il corriere ha effettuato un tentativo di consegna per la spedizione n. 123456789013 ma il destinatario era assente.\n'))
    .toMatchObject({ carrier: 'poste', tracking: '123456789013', status: 'exception', text: 'Delivery attempt failed' })
  expect(parse('Poste Italiane <noreply@poste.it>', 'Consegnato: RA123456789IT', 'Il tuo pacco RA123456789IT è stato consegnato.\n'))
    .toMatchObject({ carrier: 'poste', status: 'delivered' })
})

test('BRT: in consegna with an hours-only window; in viaggio with a date', () => {
  expect(parse('BRT Corriere Espresso <no-reply@brt.it>', 'BRT: la tua spedizione è in consegna oggi',
    'la spedizione numero 123456789012345 è in consegna. Consegna prevista il 14 ottobre 2026 dalle 14 alle 18.\n'))
    .toMatchObject({ carrier: 'brt', tracking: '123456789012345', status: 'out_for_delivery', eta: '2026-10-14', text: 'Out for delivery, 14:00-18:00' })
  expect(parse('BRT <no-reply@brt.it>', 'Aggiornamento spedizione Bartolini',
    'Numero spedizione 123456789012: partita dalla filiale di Napoli, in viaggio verso la filiale di destinazione.\nConsegna prevista 16/10/2026.\n'))
    .toMatchObject({ carrier: 'brt', status: 'in_transit', eta: '2026-10-16' })
})

test('DHL customs, DHL out for delivery, UPS shipped and delivered', () => {
  expect(parse('DHL Express <noreply@dhl.com>', 'Your DHL shipment is held at customs',
    'Waybill 1234567890: your shipment is being held by customs. Please provide an import tax payment to release it.\n'))
    .toMatchObject({ carrier: 'dhl', tracking: '1234567890', status: 'exception', text: 'Held at customs' })
  expect(parse('DHL Express <noreply@dhl.com>', 'DHL Express: out for delivery today',
    'Your shipment with tracking JJD014600006123456789 is out for delivery.\nEstimated delivery: October 14 between 10:00 and 14:00.\n'))
    .toMatchObject({ carrier: 'dhl', tracking: 'JJD014600006123456789', status: 'out_for_delivery', eta: '2026-10-14' })
  expect(parse('UPS <pkginfo@ups.com>', 'UPS Update: Package Shipped',
    'Your package has shipped.\nTracking Number: 1Z999AA10123456784\nScheduled for delivery: Friday, October 16, 2026\n'))
    .toMatchObject({ carrier: 'ups', tracking: '1Z999AA10123456784', status: 'shipped', eta: '2026-10-16' })
  expect(parse('UPS <pkginfo@ups.com>', 'UPS Update: Package Delivered', 'Your package was delivered. Tracking Number: 1Z999AA10123456784.\n'))
    .toMatchObject({ carrier: 'ups', status: 'delivered' })
})

test('the DHL Express footer slogan "Simply delivered." is not a delivery', () => {
  const mail = parse('DHL EXPRESS <noreply@dhl.com>', 'DHL On Demand Delivery',
    'Your DHL Express shipment with waybill number 1234567890 is on its way. The current estimated delivery is 16 Oct 2026 by end of day.\nShipper\'s Reference N/A\nDHL Express - Excellence. Simply delivered.\n')
  expect(mail).toMatchObject({ carrier: 'dhl', tracking: '1234567890', status: 'shipped', eta: '2026-10-16' })
  expect(mail).not.toHaveProperty('merchant')
})

test('Amazon: the order mail has an order number and no tracking; the dispatch has both', () => {
  const ordered = parse('Amazon.it <order-update@amazon.it>', 'Ordinato: "Cavo USB-C"',
    'Grazie per il tuo ordine.\nNumero ordine: 123-4567890-1234567\nConsegna prevista: giovedì 15 ottobre\n')
  expect(ordered).toMatchObject({ carrier: 'amazon', orderRef: '123-4567890-1234567', status: 'ordered', merchant: 'Amazon', eta: '2026-10-15' })
  expect(ordered!.tracking).toBeUndefined()
  expect(parse('Amazon.it <shipment-tracking@amazon.it>', 'Spedito: "Cavo USB-C"',
    'Il tuo pacco è stato spedito.\nOrdine 123-4567890-1234567\nCodice di tracciabilità: TBA123456789012\nConsegna prevista: 16 ottobre\n'))
    .toMatchObject({ status: 'shipped', tracking: 'TBA123456789012', orderRef: '123-4567890-1234567' })
})

test('InPost locker and Correios in Portuguese', () => {
  expect(parse('InPost <no-reply@inpost.it>', 'Il tuo pacco è pronto per il ritiro',
    'Il pacco 123456789012345678901234 è nel Locker: MIL01M, Via Esempio 1, Napoli.\n'))
    .toMatchObject({ carrier: 'inpost', tracking: '123456789012345678901234', status: 'exception', text: 'Ready for pickup at MIL01M, Via Esempio 1, Napoli' })
  expect(parse('Correios <rastreamento@correios.com.br>', 'Objeto saiu para entrega ao destinatário',
    'Seu objeto AB123456789BR saiu para entrega.\nEntrega prevista para 14/10/2026.\n'))
    .toMatchObject({ carrier: 'correios', tracking: 'AB123456789BR', status: 'out_for_delivery', eta: '2026-10-14' })
  expect(parse('Correios <rastreamento@correios.com.br>', 'Objeto retido pela fiscalização aduaneira', 'Seu objeto AB123456789BR aguarda taxação.\n'))
    .toMatchObject({ status: 'exception', text: 'Held at customs' })
  expect(carrierName('correios')).toBe('Correios')
})

test('unknown senders, future clauses, handoffs, and mail that is not a parcel', () => {
  expect(parse('shop@example.com', 'Your order is out for delivery', 'Tracking number 998877665544 is out for delivery.'))
    .toMatchObject({ status: 'out_for_delivery', tracking: '998877665544' })
  expect(parse('shop@example.com', 'Your order has shipped', 'Tracking number 998877665544. We will email you when it is delivered.'))
    .toMatchObject({ status: 'shipped' })
  expect(parse('shop@example.com', 'Ordine spedito', 'Ordine consegnato al corriere. Spedizione 998877665544.'))
    .toMatchObject({ status: 'shipped' })
  expect(parse('news@example.com', 'Weekly newsletter', 'Ten tips for gardening.')).toBeNull()
  expect(parse('bank@example.com', 'Your statement', 'Balance 1234.56')).toBeNull()
})

test('dates in it/en/pt, with a missing year rolled forward', () => {
  expect(findDate('arriva il 5 mar', MAIL_NOW)?.date).toBe('2027-03-05')
  expect(findDate('arriva il 15 ottobre 2026', MAIL_NOW)?.date).toBe('2026-10-15')
  expect(findDate('on Oct 20th', MAIL_NOW)?.date).toBe('2026-10-20')
  expect(findDate('entrega 20 de outubro', MAIL_NOW)?.date).toBe('2026-10-20')
  expect(findDate('no date here', MAIL_NOW)).toBeUndefined()
})

test('splitMail reads From/Subject lines, and plain text is all body', () => {
  expect(splitMail('From: GLS <a@gls-italy.com>\nSubject: Spedizione consegnata\n\nbody')).toEqual({ from: 'GLS <a@gls-italy.com>', subject: 'Spedizione consegnata', text: 'body' })
  expect(splitMail('just a body')).toEqual({ text: 'just a body' })
})

// ---------------------------------------------------------------------------
// notify: a message only for a step worth one
// ---------------------------------------------------------------------------

test('the happy path notifies on out for delivery and on delivery', () => {
  const f = fresh()
  const steps = ['ordered', 'shipped', 'in_transit', 'out_for_delivery', 'delivered'] as const
  const notifies = steps.map((status, i) =>
    recordPackage(f, { carrier: 'gls', tracking: '123456789012', status, source: `email:h${i}`, at: `2026-10-1${i}T08:00:00Z` }, NOW).notify)
  expect(notifies).toEqual([false, false, false, true, true])
})

test('a re-read or a late mail repeating old news never notifies; a problem and a later eta do', () => {
  const f = fresh()
  const base = { carrier: 'brt', tracking: '000000000001' }
  recordPackage(f, { ...base, status: 'out_for_delivery', eta: '2026-10-14', source: 'email:a', at: '2026-10-14T07:00:00Z' }, NOW)
  expect(recordPackage(f, { ...base, status: 'out_for_delivery', source: 'email:a' }, NOW).notify).toBe(false)
  expect(recordPackage(f, { ...base, status: 'in_transit', eta: '2026-10-12', source: 'email:old', at: '2026-10-11T07:00:00Z' }, NOW))
    .toMatchObject({ notify: false })
  expect(loadPackages(f)[0].eta).toBe('2026-10-14')
  const fail = recordPackage(f, { ...base, status: 'exception', text: 'Delivery attempt failed', eta: '2026-10-16', source: 'email:b', at: '2026-10-14T15:00:00Z' }, NOW)
  expect(fail.notify).toBe(true)
  expect(fail.why).toContain('eta 2026-10-14 → 2026-10-16')
  const hold = recordPackage(f, { ...base, status: 'exception', text: 'Ready for pickup at Filiale Napoli', source: 'email:c', at: '2026-10-15T09:00:00Z' }, NOW)
  expect(hold).toMatchObject({ notify: true, why: 'Ready for pickup at Filiale Napoli' })
})

test('the order mail and the courier mail with the same order number are one package', () => {
  const f = fresh()
  const a = recordPackage(f, { carrier: 'amazon', merchant: 'Amazon', orderRef: '123-4567890-1234567', status: 'ordered', source: 'email:o1' }, NOW)
  const b = recordPackage(f, { carrier: 'amazon', tracking: 'TBA123456789012', orderRef: '1234567890 1234567', status: 'shipped', source: 'email:o2' }, NOW)
  expect(b.record.id).toBe(a.record.id)
  expect(loadPackages(f)).toHaveLength(1)
  expect(loadPackages(f)[0]).toMatchObject({ tracking: 'TBA123456789012', orderRef: '123-4567890-1234567', status: 'shipped' })
})
