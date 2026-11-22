/** Optional server-to-client receipts. Operation acks in the other direction are separate. */
export type DeliverySocket = { data: { tokenId: string; desk?: { focused: boolean; at: number; activeAt: number } }; send(frame: string): unknown }
export class DeliveryAcks {
  private capable = new WeakSet<DeliverySocket>()
  private pending = new Map<string, { sockets: Set<DeliverySocket>; received: Set<DeliverySocket>; timer: ReturnType<typeof setTimeout> }>()
  constructor(private waitMs = 5_000) {}

  frame(ws: DeliverySocket, raw: string): boolean {
    let f: { type?: string; messageAcks?: unknown; desktop?: unknown; id?: unknown }
    try { f = JSON.parse(raw) } catch { return false }
    if (!f || typeof f !== 'object' || Array.isArray(f)) return false
    if (f.type === 'hello') {
      if (f.desktop === true) ws.data.desk = { focused: false, at: 0, activeAt: 0 }
      if (f.messageAcks === true) this.capable.add(ws)
      return true
    }
    if (f.type !== 'ack') return false
    if (typeof f.id === 'string' && this.capable.has(ws) && !ws.data.desk) {
      const p = this.pending.get(f.id)
      if (p?.sockets.has(ws)) p.received.add(ws)
    }
    return true
  }

  watch(id: string, sockets: Iterable<DeliverySocket>, fallback: () => void): void {
    const phones = [...sockets].filter(s => !s.data.desk)
    // Legacy phones retain socket-is-live behavior until they explicitly opt in.
    if (!phones.length || this.pending.has(id)) return
    const received = new Set<DeliverySocket>()
    const timer = setTimeout(() => {
      this.pending.delete(id)
      const currentPhones = phones.filter(s => !s.data.desk)
      if (!currentPhones.length || (currentPhones.every(s => this.capable.has(s)) && !currentPhones.some(s => received.has(s)))) fallback()
    }, this.waitMs)
    timer.unref()
    this.pending.set(id, { sockets: new Set(phones), received, timer })
  }
}
