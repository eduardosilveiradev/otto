/** IDs, not body text: two messages saying the same thing are still two notifications. */
export class BarkPushes {
  private sent = new Map<string, number>()
  constructor(private fetchFn: typeof fetch = fetch, private report: (status: number | 'network', attempt: number) => void = () => {}) {}
  async send(url: string, body: Record<string, unknown>): Promise<void> {
    const id = typeof body.id === 'string' ? body.id : undefined
    const now = Date.now()
    for (const [key, at] of this.sent) if (now - at >= 10_000) this.sent.delete(key)
    if (id && this.sent.has(id)) return
    if (id) this.sent.set(id, Infinity)
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        let r: Response
        try {
          r = await this.fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) })
        } catch (err) {
          this.report('network', attempt)
          if (attempt === 0) continue
          throw err
        }
        this.report(r.status, attempt)
        if (r.ok) { if (id) this.sent.set(id, Date.now()); return }
        if (r.status >= 500 && attempt === 0) continue
        throw new Error(`Bark HTTP ${r.status}`)
      }
    } catch (err) { if (id) this.sent.delete(id); throw err }
  }
}
