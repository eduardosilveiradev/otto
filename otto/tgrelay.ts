/**
 * Otto's half of the always-on Telegram relay (relay/README.md at the repo
 * root). In `telegramMode: "relay"` Telegram posts to a Cloudflare Worker, the
 * Worker pushes updates to POST /telegram on the webhook listener, and what it
 * could not deliver waits in its queue until drainRelay() pulls it.
 *
 * The same update can arrive twice — a push that acked after the Worker's
 * timeout is also still queued — so every path goes through one dedupe.
 */

export type RelayUpdate = { update_id: number }

/** True the first time an update_id is seen. Remembers the last `max` ids. */
export function makeDedupe(max = 1000): (id: number) => boolean {
  const seen = new Set<number>()
  return id => {
    if (seen.has(id)) return false
    seen.add(id)
    if (seen.size > max) seen.delete(seen.values().next().value as number)
    return true
  }
}

/** Is this a batch of updates, as the Worker sends them? */
export function isUpdateBatch(x: unknown): x is RelayUpdate[] {
  return Array.isArray(x) && x.every(u => Number.isSafeInteger((u as RelayUpdate)?.update_id))
}

/**
 * Pull everything the relay queued, oldest first. Each batch is handed to `take`
 * and acked on the next request only after `take` resolves, so a crash mid-batch
 * leaves it queued for the next drain. Returns how many updates were taken.
 */
export async function drainRelay(
  url: string,
  secret: string,
  take: (batch: RelayUpdate[]) => Promise<void>,
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  let ack: number | undefined
  let taken = 0
  for (;;) {
    const res = await fetchFn(new URL('/drain', url), {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify(ack === undefined ? {} : { ack }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`relay drain: HTTP ${res.status}`)
    const got: unknown = await res.json()
    if (!isUpdateBatch(got)) throw new Error('relay drain: malformed queue')
    const batch = got.filter(u => ack === undefined || u.update_id > ack).sort((a, b) => a.update_id - b.update_id)
    if (!batch.length) return taken
    await take(batch)
    taken += batch.length
    ack = batch[batch.length - 1].update_id
  }
}
