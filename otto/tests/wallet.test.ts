import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordWalletPayment } from '../wallet'
import { loadMoney } from '../money'

test('wallet prices are recorded once per delivery id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'otto-wallet-'))
  const file = join(dir, 'money.json')
  try {
    for (const [i, [raw, amount, currency]] of [
      ['€12,50', 12.5, 'EUR'], ['12.50 EUR', 12.5, 'EUR'],
      ['R$ 30,00', 30, 'BRL'], ['$4.99', 4.99, 'USD'],
    ].entries()) {
      const meta = { wallet_amount: String(raw), wallet_merchant: 'Example shop', wallet_card: 'Example card' }
      const first = recordWalletPayment(file, `payment-${i}`, meta, '2026-11-07')!
      expect(first).toMatchObject({ amount, currency, merchant: 'Example shop', method: 'Example card', source: `wallet:payment-${i}` })
      expect(recordWalletPayment(file, `payment-${i}`, meta, '2026-11-07')?.id).toBe(first.id)
    }
    expect(loadMoney(file)).toHaveLength(4)
    for (const raw of ['garbage', 'paid $4.99 maybe', '€12,,50', '12.50', '']) {
      expect(recordWalletPayment(file, 'bad', { wallet_amount: raw, wallet_merchant: 'Example shop' }, '2026-11-07')).toBeUndefined()
    }
    expect(loadMoney(file)).toHaveLength(4)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
