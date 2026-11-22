import { findImage, shrinkScreenshot } from './livesteps.ts'
import { redactSecrets } from './redact.ts'

/**
 * The app's live browser tile: while Otto drives Chrome (the claude-in-chrome MCP tools), the
 * latest screenshot and a one-line caption. Fed by the PostToolUse hook; memory only.
 *
 *   { type: "browser", image: "data:image/jpeg;base64,…" | null, caption, url, ts }
 *   { type: "browser", done: true }
 *
 * Every frame is whole: `image` is the picture to show now, null when there is none or the page
 * is one not to mirror (sign-in, payment). At most one frame per `gap` ms; `done` after `idle` ms
 * without a browser call, or when the turn ends.
 *
 * Privacy: a hook can't see the DOM, so a page counts as sensitive by its path, its title, or
 * what a read of it (read_page, find, get_page_text, form_input) said; the flag sticks to the
 * tab until it leaves that page. A password page with a neutral URL and title that was never
 * read still gets through.
 */

export const PREFIX = 'mcp__claude-in-chrome__'
const MAX_BYTES = 80_000
const SENSITIVE_PATH = /log-?in|sign-?in|sign_in|checkout|payment|password|billing|\/pay(\/|$)/i
const SENSITIVE_TITLE = /log ?in|sign ?in|checkout|payment|password|billing|credit card/i
export const SENSITIVE_TEXT = /password|card number|credit card|\bcvc\b|\bcvv\b|security code|expiry|expiration/i
const READS = new Set(['read_page', 'find', 'get_page_text', 'form_input'])
const VERBS: Record<string, string> = {
  screenshot: 'looking', left_click: 'clicking', right_click: 'clicking', double_click: 'clicking', triple_click: 'clicking',
  type: 'typing', key: 'pressing keys', scroll: 'scrolling', scroll_to: 'scrolling', wait: 'waiting', hover: 'hovering',
  zoom: 'zooming in', left_click_drag: 'dragging', navigate: 'opening a page', find: 'reading', read_page: 'reading',
  get_page_text: 'reading', form_input: 'filling a form', javascript_tool: 'running a script', tabs_create_mcp: 'opening a tab',
  file_upload: 'uploading a file', upload_image: 'uploading a file',
}

type Tile = { image: string | null; caption: string; url: string; ts: number }
type Call = { name: string; input: Record<string, unknown> }

function texts(v: unknown): string[] {
  const list = Array.isArray(v) ? v : Array.isArray((v as { content?: unknown })?.content) ? (v as { content: unknown[] }).content : [v]
  return list.map(x => typeof x === 'string' ? x : typeof (x as { text?: unknown })?.text === 'string' ? (x as { text: string }).text : '').filter(Boolean)
}

/** The tab a call ran on, from the "Tab Context" block Chrome appends to every result. */
export function tabOf(response: unknown): { id: string; title: string; url: string } | null {
  const all = texts(response).join('\n')
  const id = [...all.matchAll(/Executed on tabId: (\d+)/g)].pop()?.[1]
  if (!id) return null
  // Anchored on the trailing ("url"): titles can hold quotes, URLs can't.
  const row = all.match(new RegExp(`tabId ${id}: "(.*)" \\("([^"\\s]*)"\\)\\s*$`, 'm'))
  return row ? { id, title: row[1], url: row[2] } : null
}

/** origin + path: the query and hash can carry tokens. Empty when it isn't a URL. */
export function cleanUrl(u: string): string {
  try { const x = new URL(u); return x.origin === 'null' ? '' : x.origin + x.pathname } catch { return '' }
}

/** The calls a tool call made: itself, or each action of a browser_batch. */
function calls(tool: string, input: Record<string, unknown>): Call[] {
  const name = tool.slice(PREFIX.length)
  if (name !== 'browser_batch' || !Array.isArray(input.actions)) return [{ name, input }]
  return input.actions.map(a => ({ name: String(a?.name ?? ''), input: (a?.input ?? {}) as Record<string, unknown> }))
}

export function caption(host: string, cs: Call[]): string {
  const last = cs[cs.length - 1]
  const said = [...cs].reverse().map(c => c.input.action_summary).find(s => typeof s === 'string' && s.trim()) as string | undefined
  const what = said
    ? said.trim().replace(/[.\s]+$/, '').replace(/^./, c => c.toLowerCase())
    : VERBS[String(last?.input.action ?? '')] ?? VERBS[last?.name ?? ''] ?? 'browsing'
  return redactSecrets(`${host} · ${what}`.replace(/\s+/g, ' ')).text.slice(0, 100)
}

export class BrowserTile {
  private tile: Tile | null = null
  private tabs = new Map<string, { page: string; sensitive: boolean }>()
  private shot = 0
  private lastSent = -Infinity
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private send: (frame: string) => void,
    private opts: { gap?: number; idle?: number; now?: () => number; shrink?: (b64: string) => Promise<string | null> } = {},
  ) {}

  /**
   * A finished claude-in-chrome call. Returns whether its screenshot may be mirrored anywhere
   * (the steps frame asks too): false on a sensitive page or when the tab can't be told.
   */
  event(tool: string, input: Record<string, unknown>, response: unknown): boolean {
    const tab = tabOf(response)
    if (!tab) return false
    const page = cleanUrl(tab.url)
    const cs = calls(tool, input)
    const before = this.tabs.get(tab.id)
    const said = texts(response).join('\n').split('\n\nTab Context:')[0]
    const visited = cs.map(c => typeof c.input.url === 'string' ? c.input.url : '').concat(tab.url)
    const sensitiveNow = !page
      || visited.some(u => { try { return SENSITIVE_PATH.test(new URL(u, tab.url).pathname) } catch { return false } })
      || SENSITIVE_TITLE.test(tab.title)
      || (cs.some(c => READS.has(c.name)) && SENSITIVE_TEXT.test(said))
      || (before?.page === page && before.sensitive)
    this.tabs.set(tab.id, { page, sensitive: sensitiveNow })
    if (this.tabs.size > 50) this.tabs.delete(this.tabs.keys().next().value!)
    // A batch can screenshot the old page and then move on: the state before the call counts too.
    const sensitive = sensitiveNow || !!before?.sensitive
    const host = page ? new URL(page).host : 'browser'
    const seq = ++this.shot
    this.tile = { image: sensitive ? null : this.tile?.image ?? null, caption: caption(host, cs), url: page, ts: this.now() }
    this.changed()
    this.armIdle()
    const img = sensitive ? null : findImage(response)
    if (img) {
      void (this.opts.shrink ?? (b => shrinkScreenshot(b, 600)))(img).then(jpeg => {
        // A newer call, a sensitive page or the end of the tile since: this picture is stale.
        if (!jpeg || seq !== this.shot || !this.tile || jpeg.length * 0.75 > MAX_BYTES) return
        this.tile.image = `data:image/jpeg;base64,${jpeg}`
        this.changed()
      })
    }
    return !sensitive
  }

  finish(): void {
    if (!this.tile) return
    this.tile = null
    this.shot++
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.flushTimer = this.idleTimer = null
    this.send(JSON.stringify({ type: 'browser', done: true }))
  }

  /** The live tile, for a socket that just connected; null when there is none. */
  snapshot(): string | null {
    return this.tile ? JSON.stringify({ type: 'browser', ...this.tile }) : null
  }

  private now(): number { return (this.opts.now ?? Date.now)() }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.finish(), this.opts.idle ?? 20_000)
  }

  private changed(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      const frame = this.snapshot()
      if (!frame) return
      this.lastSent = this.now()
      this.send(frame)
    }, Math.max(0, this.lastSent + (this.opts.gap ?? 1000) - this.now()))
  }
}
