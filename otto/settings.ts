/**
 * The `/settings` page: Otto's own switches, its recurring triggers, and the MCP
 * servers Claude Code knows for this session, each one tap from flipped.
 *
 * What is on the page is the whole of what a tap can change. Every switch here
 * names one field it writes, and a field that is not named cannot be reached —
 * not the allowlist, not pairing, not a secret, not a tier. `flipAccess` copies
 * the object and touches exactly the field its id names, so a bug elsewhere in
 * the access file cannot be laundered through a toggle.
 *
 * Each toggle's id is also its `classify()` pseudo-path (`setting:…`,
 * `connector:…`), so a tap goes through the same door as every other write.
 *
 * Connector state lives where `/mcp` keeps it: `projects[<dir>].disabledMcpServers`
 * in `~/.claude.json`, an opt-out list for user, plugin and claude.ai servers.
 * Claude Code does not document picking up an outside edit to that file live,
 * so the page says a connector change applies from the next session.
 */

import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'

export type Section = 'otto' | 'recurring' | 'connectors'

export type Toggle = {
  /** Stable, and the pseudo-path handed to classify(). */
  id: string
  label: string
  on: boolean
  section: Section
}

/** The access.json fields a switch may write. Nothing else is in reach. */
export type Switchable = {
  emailScanMinutes?: number
  quietHours?: string
  /** Where a switched-off quiet window waits, so switching it back on restores it. */
  quietHoursOff?: string
  busySuppression?: boolean
  voice?: { enabled?: boolean; autoReply?: 'mirror' | 'always' | 'never' }
}

const DEFAULT_SCAN_MIN = 60

export function accessToggles(a: Switchable): Toggle[] {
  const scan = a.emailScanMinutes ?? DEFAULT_SCAN_MIN
  const out: Toggle[] = [
    { id: 'setting:scan', label: scan > 0 ? `email scans · every ${scan} min` : 'email scans', on: scan > 0, section: 'otto' },
  ]
  // Only offered when there is a window to restore — a default invented here
  // would be a quiet window the user never chose.
  const window = a.quietHours ?? a.quietHoursOff
  if (window) out.push({ id: 'setting:quiet', label: `quiet hours ${window}`, on: !!a.quietHours, section: 'otto' })
  out.push(
    { id: 'setting:voice', label: 'voice replies', on: a.voice?.enabled !== false && a.voice?.autoReply !== 'never', section: 'otto' },
    { id: 'setting:busy', label: 'hold nudges during meetings', on: a.busySuppression !== false, section: 'otto' },
  )
  return out
}

/**
 * Flip one switch on a copy. Switching on deletes the off-marker rather than
 * writing a default, so the server's own default keeps applying.
 */
export function flipAccess<T extends Switchable>(a: T, id: string): T {
  const t = accessToggles(a).find(x => x.id === id)
  if (!t) throw new Error(`no such setting: ${id}`)
  const b: T = structuredClone(a)
  switch (id) {
    case 'setting:scan':
      if (t.on) b.emailScanMinutes = 0
      else delete b.emailScanMinutes
      break
    case 'setting:quiet':
      if (t.on) { b.quietHoursOff = b.quietHours; delete b.quietHours }
      else { b.quietHours = b.quietHoursOff; delete b.quietHoursOff }
      break
    case 'setting:voice': {
      const v = { ...b.voice }
      if (t.on) v.autoReply = 'never'
      else { delete v.autoReply; if (v.enabled === false) delete v.enabled }
      b.voice = v
      break
    }
    case 'setting:busy':
      if (t.on) b.busySuppression = false
      else delete b.busySuppression
      break
  }
  return b
}

/**
 * Set the quiet window to a new value on a copy — the `setting:quiet` write when
 * the value comes from somewhere other than the toggle (the sleep offer in
 * sleep.ts). Like a flip it touches only the field the id names; the off-marker
 * goes, since a window just chosen is on.
 */
export function setQuietWindow<T extends Switchable>(a: T, window: string): T {
  if (!/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(window)) throw new Error(`not a quiet window: ${window}`)
  const b: T = structuredClone(a)
  b.quietHours = window
  delete b.quietHoursOff
  return b
}

type TriggerLike ={ id: string; type: string; action: string; repeating: boolean; enabled: boolean }

/** Recurring cron triggers — the morning brief, the pings. One-shots are reminders, not settings. */
export function triggerToggles(ts: TriggerLike[]): Toggle[] {
  return ts
    .filter(t => t.type === 'cron' && t.repeating)
    .map(t => ({ id: `setting:trigger-${t.id}`, label: short(t.action), on: t.enabled, section: 'recurring' as const }))
}

export function triggerIdOf(toggleId: string): string | null {
  return toggleId.startsWith('setting:trigger-') ? toggleId.slice('setting:trigger-'.length) : null
}

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

/** Never listed: switching Otto's own server off would cut the page off mid-tap. */
const SELF = 'plugin:otto:otto'

export type ConnectorSources = {
  /** Parsed ~/.claude.json. */
  claudeJson: Record<string, any>
  /** `plugin:<plugin>:<server>` names of enabled plugins' MCP servers. */
  pluginServers: string[]
  /** The Claude Code project the session runs in — the key under `projects`. */
  project: string
}

export function connectorToggles(src: ConnectorSources): Toggle[] {
  const proj = src.claudeJson.projects?.[src.project]
  if (!proj) return []
  const disabled: string[] = Array.isArray(proj.disabledMcpServers) ? proj.disabledMcpServers : []
  const names = new Set<string>([
    ...Object.keys(src.claudeJson.mcpServers ?? {}),
    ...Object.keys(proj.mcpServers ?? {}),
    ...(Array.isArray(src.claudeJson.claudeAiMcpEverConnected) ? src.claudeJson.claudeAiMcpEverConnected : []),
    ...src.pluginServers,
    // A server switched off earlier stays listed, so it can be switched back on.
    ...disabled,
  ])
  names.delete(SELF)
  return [...names].sort().map(n => ({ id: `connector:${n}`, label: n, on: !disabled.includes(n), section: 'connectors' as const }))
}

/** Flip one server in the project's opt-out list, on a copy. Only listed names. */
export function flipConnector(src: ConnectorSources, id: string): Record<string, any> {
  const t = connectorToggles(src).find(x => x.id === id)
  if (!t) throw new Error(`no such connector: ${id}`)
  const name = id.slice('connector:'.length)
  const c = structuredClone(src.claudeJson)
  const proj = c.projects[src.project]
  const list: string[] = Array.isArray(proj.disabledMcpServers) ? proj.disabledMcpServers : []
  proj.disabledMcpServers = t.on ? [...list, name] : list.filter(n => n !== name)
  return c
}

/**
 * Read what Claude Code knows about MCP servers. Best effort: a file that is
 * missing or unreadable contributes nothing, and the page shows what is left.
 */
export function readConnectorSources(home: string, project: string): ConnectorSources | null {
  let claudeJson: Record<string, any>
  try { claudeJson = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) } catch { return null }
  const pluginServers: string[] = []
  try {
    const enabled = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).enabledPlugins ?? {}
    const installed = JSON.parse(readFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8')).plugins ?? {}
    for (const [key, on] of Object.entries(enabled)) {
      if (on !== true) continue
      const root = installed[key]?.[0]?.installPath
      if (!root) continue
      try {
        const servers = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')).mcpServers ?? {}
        for (const s of Object.keys(servers)) pluginServers.push(`plugin:${key.split('@')[0]}:${s}`)
      } catch {}
    }
  } catch {}
  return { claudeJson, pluginServers, project }
}

// ---------------------------------------------------------------------------
// Rendering and taps
// ---------------------------------------------------------------------------

/** callback_data for a toggle: `set:` + a hash of its id. Fits the 64-byte cap
 * whatever the server is called, and cannot be minted by the reply tool, whose
 * buttons are always `btn:`. */
export function callbackFor(id: string): string {
  return `set:${createHash('sha256').update(id).digest('hex').slice(0, 16)}`
}

/** The toggle a tap names, looked up against the page as it is NOW — a stale
 * button for something that no longer exists finds nothing. */
export function findToggle(toggles: Toggle[], data: string): Toggle | undefined {
  return toggles.find(t => callbackFor(t.id) === data)
}

const HEAD: Record<Section, string> = {
  otto: 'otto',
  recurring: 'recurring',
  connectors: 'connectors — a change applies from the next session',
}

export function renderSettings(toggles: Toggle[], note?: string): { text: string; buttons: { label: string; data: string }[] } {
  const lines = ['⚙️ settings — tap one to flip it']
  for (const s of ['otto', 'recurring', 'connectors'] as Section[]) {
    const ts = toggles.filter(t => t.section === s)
    if (!ts.length) continue
    lines.push('', HEAD[s], ...ts.map(t => `${t.on ? '🟢' : '⚪'} ${t.label}`))
  }
  if (note) lines.push('', note)
  return {
    text: lines.join('\n'),
    buttons: toggles.map(t => ({ label: `${t.on ? '🟢' : '⚪'} ${short(t.label, 28)}`, data: callbackFor(t.id) })),
  }
}

function short(s: string, n = 48): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1).trimEnd() + '…' : one
}
