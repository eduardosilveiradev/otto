/**
 * Show-off mode: the user demos Otto on a shared screen (a classroom projector) without
 * putting their private life on it. A client turns it on through /app/showoff; it ends by
 * itself after SHOWOFF_MINUTES. While it is live the app clients see only the thread since
 * it began, the personal reads (money, people, places, mail-derived, memory) come back empty
 * with `hidden: true`, and every inbound message carries showoff="1" so the session keeps its
 * replies generic. Pushes to the phone are untouched. Nothing is deleted: once it is off or
 * past `until`, every read is whole again. The state is `showoff` in access.json.
 */
export const SHOWOFF_MINUTES = 60

export type Showoff = { since: string; until: string }

/** The live mode, or null when it is off or has run out. */
export function showoffLive(a: { showoff?: Showoff } | null | undefined, now = Date.now()): Showoff | null {
  const s = a?.showoff
  return s && Date.parse(s.until) > now ? s : null
}

const brief = () => ({ asOf: new Date().toISOString(), events: null, inbox: null, bulk: 0, loops: [], triggers: [] })

/** What a hidden read answers instead, by route ("GET money" under /app/dash/, "/app/brief" outside it):
 *  the empty shape the client already decodes, plus hidden: true. */
export const HIDDEN: Record<string, () => object> = {
  'GET money': () => ({ records: [], byCurrency: [], byMonth: [], byCategory: [] }),
  'GET people': () => ({ cards: [] }),
  'GET places': () => ({ places: [], cities: [] }),
  'GET memory': () => ({ items: [], summary: { text: '', note: '' }, generatedAt: '', graph: { links: [], similar: [] }, scopes: {} }),
  'GET memory/item': () => ({}),
  'GET memory/search': () => ({ results: [] }),
  'GET loops': () => ({ open: [], plan: { close: [], propose: [], avoidance: [] }, recent: [] }),
  'GET brief': brief,
  'GET trips': () => ({ trips: [], current: null, problems: {} }),
  'GET packages': () => ({ packages: [] }),
  '/app/brief': brief,
  '/app/stamps': () => ({ stamps: [] }),
  '/app/gate': () => ({ card: null }),
}

export const hidden = (route: string): object | null => HIDDEN[route] ? { ...HIDDEN[route](), hidden: true } : null
