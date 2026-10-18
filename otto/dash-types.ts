/**
 * The dashboard API's wire types: every request and response under /app/dash/.
 *
 * Standalone on purpose — no imports — because otto-dash copies this file
 * verbatim to lib/types.ts and CI diffs the two. Each DTO is an explicit pick
 * of the store record it comes from; tests/dash-types.test.ts holds them
 * against the source types both ways, so a field added or renamed there fails
 * here instead of silently reaching a browser. Keys that must never leave the
 * Mac (undo, source, pnr, confirmation, seat, address, revert, scratchDir, pid,
 * hash, body on lists) have no slot in any of these.
 */

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** Every non-2xx body. */
export type DashError = { error: string }

export type Scope = 'read' | 'write'

// ---------------------------------------------------------------------------
// Reachability and pairing (unauthenticated)
// ---------------------------------------------------------------------------

/** GET ping — answers any origin, says only whether this one is allowlisted. */
export type Ping = { ok: true; origin: 'allowed' | 'blocked' }

export type PairStartRequest = { scope: Scope; label?: string }
/** `user_code` is shown as "XKQ4-7MPD"; seconds throughout. */
export type PairStart = { device_code: string; user_code: string; expires_in: number; interval: number }

export type PairPollRequest = { device_code: string }
/** `approved` is delivered once; the next poll says `expired`. */
export type PairPoll =
  | { status: 'pending' | 'denied' | 'expired' }
  | {
      status: 'approved'; token: string; scope: Scope; id: string; expires: string
      /** With a control (write) approval: a long-lived read token to fall back on once control lapses or the tab closes. */
      read?: { token: string; id: string; expires: string }
    }

// ---------------------------------------------------------------------------
// Tokens and devices
// ---------------------------------------------------------------------------

/** An app token without its hash. `scope`/`origin` are set only on dashboard tokens. */
export type Device = {
  id: string
  name: string
  created: string
  lastUsed?: string
  scope?: Scope
  origin?: string
  /** ISO; absent means it never expires (a native app token). */
  expires?: string
  ua?: string
}

export type Me = Pick<Device, 'id' | 'name' | 'scope' | 'origin' | 'created' | 'expires' | 'lastUsed'>
export type Devices = { devices: Device[] }
export type Revoked = { revoked: true }

// ---------------------------------------------------------------------------
// Status and brief
// ---------------------------------------------------------------------------

export type Verdict = 'up' | 'degraded' | 'down' | 'off' | 'unknown'

export type StatusRow = {
  id: string
  label: string
  verdict: Verdict
  /** Epoch ms of the evidence, when there is one. */
  at?: number
  detail: string
}

/** `now` is epoch ms; `repairs` are the watchdog's latest lines, newest last. */
export type DashStatus = { now: number; rows: StatusRow[]; repairs: string[] }

/** A null section is a source that failed, not an empty one. */
export type DashBrief = {
  asOf: string
  events: { title: string; start: string; minutes: number }[] | null
  inbox: { from: string; subject: string }[] | null
  /** Mail not worth naming, counted. */
  bulk: number
  loops: { id: string; title: string; due?: string }[]
  triggers: { title: string; next: string }[]
}

// ---------------------------------------------------------------------------
// Memory and people
// ---------------------------------------------------------------------------

/** A memory or note as the list shows it. The body comes from memory/item. */
export type MemoryItem = {
  id: string
  store: 'durable' | 'notes'
  kind: string
  scope: string
  name: string
  description: string
  updated: string
  status?: string
  due?: string
  tags?: string[]
  closedReason?: string
  /** Times recall returned it. */
  hits: number
  lastHitDays?: number
  badge?: 'never' | 'stale'
}

export type MemoryItemDetail = MemoryItem & { body: string }

export type MemoryCluster = { id: number; size: number; label: string; terms: string[]; x: number; y: number }

/** Edges index into `items`. */
export type MemoryGraph = {
  links: [number, number][]
  /** [i, j, cosine, mutual] */
  similar: [number, number, number, number][]
  floor?: number
  /** Cluster per item, -1 for none. */
  c?: number[]
  /** Items whose silhouette puts them between clusters; drawn faded. */
  noise?: number[]
  clusters?: MemoryCluster[]
  note: string
}

export type DashMemory = {
  items: MemoryItem[]
  summary: { text: string; note: string }
  generatedAt: string
  graph: MemoryGraph
  /** Every scope in `items`, label → label: items already carry the readable label, never the cwd slug. */
  scopes: Record<string, string>
}

/** [index into DashMemory.items, score], best first. */
export type MemorySearch = { results: [number, number][] }
export type MemoryRebuild = { started: true }

/** Someone the user explained, in their words. No addresses, phones or handles. */
export type PersonCard = {
  name: string
  relationship?: string
  city?: string
  timezone?: string
  org?: string
  notes: { at: string; text: string }[]
  inbound: number
  outbound: number
  lastContact?: string
  /** Indexes into DashMemory.items: the memories that name them. */
  mentions: number[]
}

export type People = { cards: PersonCard[] }

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

export type PlaceKind = 'restaurant' | 'cafe' | 'bar' | 'shop' | 'sight' | 'other'
export type PlaceStatus = 'want' | 'been' | 'loved' | 'avoid'

/** A place the user told Otto about, in their words. The recommender by name only, never their id. */
export type PlaceRow = {
  id: string
  name: string
  city: string
  kind: PlaceKind
  status: PlaceStatus
  recommendedBy?: string
  tags: string[]
  notes: { at: string; text: string }[]
  createdAt: string
  updatedAt: string
}

/** `cities` is every city with a count, unfiltered, so the app has something to pick from. */
export type DashPlaces = { places: PlaceRow[]; cities: { city: string; count: number }[] }

// ---------------------------------------------------------------------------
// Settings, triggers, snooze, loops
// ---------------------------------------------------------------------------

export type ToggleSection = 'otto' | 'recurring' | 'connectors'

export type Toggle = {
  /** Stable; what settings POST takes back as `id`. */
  id: string
  label: string
  on: boolean
  section: ToggleSection
}

export type TriggerRow = {
  id: string
  type: 'cron' | 'email'
  /** cron only: a 5-field expression or an ISO datetime. */
  schedule?: string
  /** One line of the action, never the whole of it. */
  gist: string
  repeating: boolean
  enabled: boolean
  /** Epoch ms; cron only. */
  nextRun?: number
  lastFired?: string
}

export type Triggers = { triggers: TriggerRow[] }

export type DashSettings = { speakReplies: boolean; toggles: Toggle[]; triggers: TriggerRow[]; note?: string }
export type SettingsRequest = { id: string } | { speakReplies: boolean }

export type Snooze = { until: string | null; since: string | null; held: { text: string; at: string }[] }
/** `minutes` snoozes, or extends a live snooze by that much (max 1440). */
export type SnoozeRequest = { minutes: number } | { clear: true }

export type LoopRequest = { id: string; done: boolean }
export type LoopResult = LoopRequest

export type LoopRow = {
  id: string
  text: string
  tags: string[]
  createdAt: string
  updatedAt?: string
  due?: string
  status?: 'open' | 'done' | 'dropped'
  closedReason?: string
  closedBy?: 'hygiene'
  closedAt?: string
  reopenedAt?: string
  /** When the due date was pushed later, newest last. */
  deferrals?: string[]
}

/** What tonight's hygiene pass would do, computed without doing it. */
export type HygienePlan = {
  close: { id: string; status: 'done' | 'dropped'; reason: string }[]
  propose: { id: string; text: string; reason: string }[]
  avoidance: { id: string; text: string; deferrals: number; dues: string[] }[]
}

/** `recent` is what the pass closed lately, newest first, with `closedReason` set. */
export type DashLoops = { open: LoopRow[]; plan: HygienePlan; recent: LoopRow[] }

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export type MoneyRow = {
  id: string
  merchant: string
  /** As charged, in major units. Never converted. */
  amount: number
  /** ISO 4217. */
  currency: string
  /** YYYY-MM-DD, the date on the receipt. */
  date: string
  category?: string
  method?: string
  note?: string
  createdAt: string
}

export type CurrencyTotal = { currency: string; total: number; count: number }
export type MonthTotals = { month: string; totals: CurrencyTotal[] }
export type CategoryTotal = { category: string; total: number; count: number }

/** There is deliberately no grand total across currencies. `byCategory` is for the requested currency. */
export type DashMoney = { records: MoneyRow[]; byCurrency: CurrencyTotal[]; byMonth: MonthTotals[]; byCategory: CategoryTotal[] }

// ---------------------------------------------------------------------------
// Activity: proactivity, capability log, jobs
// ---------------------------------------------------------------------------

export type SourceStats = {
  src: string
  sent: number
  engaged: number
  /** Sends since the last one that drew a reply. */
  silentStreak: number
  lastSent?: string
  lastEngaged?: string
}

export type Proactivity = { stats: SourceStats[] }

export type CapRow = {
  id: string
  at: string
  /** One line, written for the user. */
  what: string
  sha?: string
  paths: string[]
  tier: 'unattended' | 'confirmed' | 'guarded'
  origin: 'user-typed' | 'model-authored' | 'triggered' | 'external-content'
  /** Which module installed it. */
  by: string
  revertedAt?: string
}

export type Capabilities = { entries: CapRow[] }

export type JobState = 'queued' | 'running' | 'parked' | 'done' | 'failed' | 'killed'

export type JobRow = {
  id: string
  task: string
  state: JobState
  createdAt: string
  startedAt?: string
  endedAt?: string
  tools: string[]
  wallClockMs: number
  tokenBudget: number
  tokensUsed: number
  costUsd?: number
  tags: string[]
  result?: string
  /** true when `result` is what it had when it was stopped. */
  partial?: boolean
  error?: string
  /** A parked job does not start before this. */
  notBefore?: string
}

export type Jobs = { jobs: JobRow[] }

// ---------------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------------

export type ZonedTime = {
  /** Wall clock where it happens: "2026-08-12T14:35". Never UTC. */
  local: string
  zone?: string
  offsetMinutes?: number
  /** The instant, only when the zone or offset is known. */
  utc?: string
}

export type FlightRow = { kind: 'flight'; flight: string; carrier: string; from?: string; to?: string; depart: ZonedTime; arrive?: ZonedTime }
/** Dates are YYYY-MM-DD: hotels are booked by night. */
export type StayRow = { kind: 'stay'; name: string; city?: string; checkIn: string; checkOut: string }

export type TripRow = { id: string; start: string; end: string; segments: (FlightRow | StayRow)[]; updatedAt: string }

/** `current` is the trip under way, or failing that the next one soon. `problems` is keyed by trip id. */
export type DashTrips = {
  trips: TripRow[]
  current: { id: string; mode: 'current' | 'next' } | null
  problems: Record<string, string[]>
}

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

export type PackageStatus = 'ordered' | 'shipped' | 'in_transit' | 'out_for_delivery' | 'delivered' | 'exception'

/** Dates are YYYY-MM-DD; `eta`..`etaLatest` is a window when both are set. `events` newest first. */
export type PackageRow = {
  id: string
  carrier: string
  carrierName: string
  tracking?: string
  /** The carrier's own page; absent when it has none (Amazon). */
  trackingUrl?: string
  merchant?: string
  item?: string
  status: PackageStatus
  eta?: string
  etaLatest?: string
  updatedAt: string
  deliveredAt?: string
  events: { at: string; status: PackageStatus; text: string }[]
}

/** Still coming first, by eta; then delivered in the last 30 days, newest first. */
export type DashPackages = { packages: PackageRow[] }
export type PackageDoneRequest = { id: string }

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export type ChatThread = 'app' | 'telegram'

/** One bubble. `kind` is the history kind: text, photo, voice, voice-note, document, edit. An edit carries the id of the message it rewrites. */
export type ChatMessage = {
  id: string
  dir: 'in' | 'out'
  kind: string
  text: string
  ts: string
}

/**
 * Without `after`: the last 100 messages and the live cursor. With `after=<cursor>`: what arrived
 * since, held up to 25 s for something to arrive. `reset` means the cursor predates this server:
 * reload without `after`. `typing` is the app thread only.
 */
export type DashChat = { thread: ChatThread; messages: ChatMessage[]; cursor: number; typing: boolean; reset?: true }

/** `id` is a client UUID; sending the same id twice delivers once. Only the app thread takes sends. */
export type ChatSendRequest = { thread: 'app'; id: string; text: string }
export type ChatSent = { id: string; duplicate?: true }

// ---------------------------------------------------------------------------
// Calls (callbot's live view)
// ---------------------------------------------------------------------------

/** One side's speech: `assistant` is the bot, `user` the person it called. */
export type CallLine = { role: 'assistant' | 'user'; text: string }

/** A call placed by callbot, live or ended in the last two hours. Times are epoch ms. */
export type DashCall = {
  id: string
  to: string
  task: string
  /** Vapi's: queued, ringing, in-progress, forwarding, ended. */
  status: string
  /** Bumped on every change; pass it back as `after` to wait for the next one. */
  seq: number
  createdAt: number
  startedAt?: number
  endedAt?: number
  endedReason?: string
  lines: CallLine[]
  /** What each side is saying right now, before it settles into a line. */
  partial: Partial<Record<CallLine['role'], string>>
  /** False when the Mac has no number to transfer to. */
  takeover: boolean
}
export type DashCalls = { calls: DashCall[] }
export type CallAction = 'say' | 'tell' | 'end' | 'takeover'
export type CallControlRequest = { id: string; action: CallAction; text?: string }
export type CallControlResult = { ok: boolean; error?: string }
/** A one-time wss:// URL for the call's audio: 16-bit PCM, sample rate and channels in its first text frame. */
export type CallListen = { url: string }

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

/** "METHOD path" (under /app/dash/) → body and response. `scope` is what the token needs. */
export type DashRoutes = {
  'GET ping': { scope: null; res: Ping }
  'POST pair/start': { scope: null; req: PairStartRequest; res: PairStart }
  'POST pair/poll': { scope: null; req: PairPollRequest; res: PairPoll }
  'GET me': { scope: 'read'; res: Me }
  'GET devices': { scope: 'read'; res: Devices }
  /** A read token may revoke only itself. */
  'DELETE devices/:id': { scope: 'write'; res: Revoked }
  'POST signout': { scope: 'read'; res: Revoked }
  'GET status': { scope: 'read'; res: DashStatus }
  'GET brief': { scope: 'read'; res: DashBrief }
  'GET memory': { scope: 'read'; res: DashMemory }
  'GET memory/item': { scope: 'read'; query: { id: string }; res: MemoryItemDetail }
  'POST memory/rebuild': { scope: 'write'; res: MemoryRebuild }
  'GET memory/search': { scope: 'read'; query: { q: string }; res: MemorySearch }
  'GET people': { scope: 'read'; res: People }
  'GET settings': { scope: 'read'; res: DashSettings }
  'POST settings': { scope: 'write'; req: SettingsRequest; res: DashSettings }
  'GET snooze': { scope: 'read'; res: Snooze }
  'POST snooze': { scope: 'write'; req: SnoozeRequest; res: Snooze }
  'POST loop': { scope: 'write'; req: LoopRequest; res: LoopResult }
  'GET loops': { scope: 'read'; res: DashLoops }
  'GET money': { scope: 'read'; query: { month?: string; currency?: string; category?: string }; res: DashMoney }
  'GET proactivity': { scope: 'read'; query: { days?: string }; res: Proactivity }
  'GET trips': { scope: 'read'; res: DashTrips }
  'GET packages': { scope: 'read'; res: DashPackages }
  /** Marks it delivered by hand; answers the row as it now is. */
  'POST packages/done': { scope: 'write'; req: PackageDoneRequest; res: PackageRow }
  'GET capabilities': { scope: 'read'; query: { days?: string }; res: Capabilities }
  'GET jobs': { scope: 'read'; res: Jobs }
  'GET triggers': { scope: 'read'; res: Triggers }
  'GET chat': { scope: 'read'; query: { thread: ChatThread; after?: string }; res: DashChat }
  'POST chat': { scope: 'write'; req: ChatSendRequest; res: ChatSent }
  /** Without `id`, every call; with it, that call once `seq` passes `after` (long-poll, about 25 s). */
  'GET calls': { scope: 'read'; query: { id?: string; after?: string }; res: DashCalls | DashCall }
  'POST calls/control': { scope: 'write'; req: CallControlRequest; res: CallControlResult }
  'POST calls/listen': { scope: 'read'; req: { id: string }; res: CallListen }
}
