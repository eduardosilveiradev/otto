import { loadMoney, parseAmount, recordMoney, saveMoney, type MoneyRecord } from './money.js'

/** Runs synchronously on arrival, using record_money's ledger and source dedupe. */
export function recordWalletPayment(
  file: string, messageId: string, meta: Record<string, string>, date: string,
): MoneyRecord | undefined {
  const raw = meta.wallet_amount?.trim() ?? ''
  // The whole field must be a price, not a number embedded in arbitrary prose.
  const number = String.raw`\d+(?:(?:[.,]\d{3})*(?:[.,]\d{2})?)`
  const currency = String.raw`(?:R\$|US\$|[€£$]|EUR|BRL|USD|GBP|CHF)`
  if (!new RegExp(`^(?:${currency}\\s*${number}|${number}\\s*${currency})$`, 'i').test(raw)) return
  const parsed = parseAmount(raw)
  const merchant = meta.wallet_merchant?.trim()
  if (!parsed?.currency || !merchant) return
  const records = loadMoney(file)
  const result = recordMoney(records, {
    ...parsed, currency: parsed.currency, merchant, date,
    source: `wallet:${messageId}`,
    ...(meta.wallet_card ? { method: meta.wallet_card } : {}),
  })
  if (result.created) saveMoney(file, records)
  return result.record
}
