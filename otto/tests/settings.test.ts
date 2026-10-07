import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  accessToggles, flipAccess, triggerToggles, triggerIdOf, connectorToggles, flipConnector,
  readConnectorSources, callbackFor, findToggle, renderSettings,
} from '../settings.ts'
import { classify } from '../selfedit.ts'

const access = {
  dmPolicy: 'allowlist', allowFrom: ['1234567890'], pending: {},
  emailScanMinutes: 30, quietHours: '23:00-08:00', voice: { enabled: true, speaker: 'x' },
  webhook: { token: 'secret' },
}

test('every switch round-trips and touches nothing else', () => {
  for (const t of accessToggles(access)) {
    const off = flipAccess(access, t.id)
    expect(accessToggles(off).find(x => x.id === t.id)!.on).toBe(!t.on)
    expect(off.allowFrom).toEqual(['1234567890'])
    expect(off.webhook).toEqual({ token: 'secret' })
    expect(off.dmPolicy).toBe('allowlist')
    const back = flipAccess(off, t.id)
    expect(accessToggles(back).find(x => x.id === t.id)!.on).toBe(t.on)
  }
  expect(access.emailScanMinutes).toBe(30) // the input is never mutated
})

test('quiet hours come back as the window they were', () => {
  const off = flipAccess(access, 'setting:quiet')
  expect(off.quietHours).toBeUndefined()
  expect(flipAccess(off, 'setting:quiet').quietHours).toBe('23:00-08:00')
  // No window to restore → no switch, rather than an invented one.
  expect(accessToggles({}).some(t => t.id === 'setting:quiet')).toBe(false)
})

test('voice back on clears a hard off, keeps the voice settings', () => {
  const v = flipAccess({ voice: { enabled: false, speaker: 'x' } as any }, 'setting:voice')
  expect(v.voice).toEqual({ speaker: 'x' })
})

test('access control, pairing and secrets are not switches', () => {
  for (const id of ['setting:allowFrom', 'setting:dmPolicy', 'setting:webhook', 'allowFrom']) {
    expect(() => flipAccess(access, id)).toThrow()
  }
})

test('only recurring cron triggers are listed', () => {
  const ts = [
    { id: 'a1', type: 'cron', action: 'Morning brief', repeating: true, enabled: true },
    { id: 'b2', type: 'cron', action: 'one-off reminder', repeating: false, enabled: true },
    { id: 'c3', type: 'email', action: 'x', repeating: true, enabled: true },
  ]
  const t = triggerToggles(ts)
  expect(t.map(x => x.id)).toEqual(['setting:trigger-a1'])
  expect(triggerIdOf(t[0].id)).toBe('a1')
  expect(triggerIdOf('setting:scan')).toBeNull()
})

const src = {
  project: '__HOME__/proj',
  pluginServers: ['plugin:otto:otto', 'plugin:chat:chat'],
  claudeJson: {
    mcpServers: { school: {} },
    claudeAiMcpEverConnected: ['claude.ai Gmail'],
    projects: { '__HOME__/proj': { mcpServers: {}, disabledMcpServers: ['plugin:old:old'] } },
    oauthAccount: { emailAddress: 'you@example.com' },
  },
}

test('connectors: every known server, never Otto itself', () => {
  const t = connectorToggles(src)
  expect(t.map(x => x.label)).toEqual(['claude.ai Gmail', 'plugin:chat:chat', 'plugin:old:old', 'school'])
  expect(t.find(x => x.label === 'plugin:old:old')!.on).toBe(false)
  expect(connectorToggles({ ...src, project: 'elsewhere' })).toEqual([])
})

test('connector flip edits only the project opt-out list', () => {
  const c = flipConnector(src, 'connector:school')
  expect(c.projects['__HOME__/proj'].disabledMcpServers).toEqual(['plugin:old:old', 'school'])
  expect(c.oauthAccount).toEqual(src.claudeJson.oauthAccount)
  const back = flipConnector({ ...src, claudeJson: c }, 'connector:plugin:old:old')
  expect(back.projects['__HOME__/proj'].disabledMcpServers).toEqual(['school'])
  // No adding servers: an unlisted name is refused, Otto's own included.
  expect(() => flipConnector(src, 'connector:new-thing')).toThrow()
  expect(() => flipConnector(src, 'connector:plugin:otto:otto')).toThrow()
})

test('reads plugin servers off enabled plugins only', () => {
  const home = mkdtempSync(join(tmpdir(), 'otto-settings-'))
  const plug = join(home, 'cache', 'chat')
  mkdirSync(plug, { recursive: true })
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true })
  writeFileSync(join(plug, '.mcp.json'), JSON.stringify({ mcpServers: { chat: {} } }))
  writeFileSync(join(home, '.claude.json'), JSON.stringify(src.claudeJson))
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'chat@m': true, 'off@m': false } }))
  writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
    plugins: { 'chat@m': [{ installPath: plug }], 'off@m': [{ installPath: plug }] },
  }))
  expect(readConnectorSources(home, 'p')!.pluginServers).toEqual(['plugin:chat:chat'])
  expect(readConnectorSources(join(home, 'nope'), 'p')).toBeNull()
})

test('taps resolve by hash against the current page, within 64 bytes', () => {
  const page = [...accessToggles(access), ...connectorToggles(src)]
  for (const t of page) {
    expect(Buffer.byteLength(callbackFor(t.id))).toBeLessThanOrEqual(64)
    expect(findToggle(page, callbackFor(t.id))).toBe(t)
  }
  expect(findToggle(page, callbackFor('connector:gone'))).toBeUndefined()
  expect(callbackFor('x').startsWith('btn:')).toBe(false)
})

test('a tap clears classify for every toggle id, and nothing else does', () => {
  const page = [...accessToggles(access), ...triggerToggles([{ id: 'a1', type: 'cron', action: 'x', repeating: true, enabled: true }]), ...connectorToggles(src)]
  for (const t of page) {
    expect(classify([t.id], 'user-typed', { kind: 'tapped', buttonData: callbackFor(t.id) }).allowed).toBe(true)
    expect(classify([t.id], 'triggered').allowed).toBe(false)
    expect(classify([t.id], 'external-content', { kind: 'tapped', buttonData: 'x' }).allowed).toBe(false)
  }
  // An id the page does not mint falls through to guarded.
  expect(classify(['setting:allowFrom'], 'user-typed', { kind: 'tapped', buttonData: 'x' }).allowed).toBe(false)
})

test('render: one button per toggle, state in the label', () => {
  const r = renderSettings([...accessToggles(access), ...connectorToggles(src)], '→ done')
  expect(r.buttons.length).toBe(accessToggles(access).length + 4)
  expect(r.text).toContain('next session')
  expect(r.text.endsWith('→ done')).toBe(true)
})
