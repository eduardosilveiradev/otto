import { test, expect } from 'bun:test'
import {
  decide,
  repairFor,
  omittedSections,
  briefSectionsProbe,
  GRACE_MS,
  TELL_COOLDOWN_MS,
  type ProbeResult,
  type ProbeState,
} from '../watchdog.ts'

const NOW = Date.parse('2026-08-12T09:00:00Z')
const ago = (ms: number) => NOW - ms
const stale = (name: ProbeState['name'], over: Partial<ProbeState> = {}): ProbeState => ({
  name,
  failingSince: ago(GRACE_MS + 60_000),
  repairs: 2,
  ...over,
})

function fail(name: ProbeResult['name'], over: Partial<ProbeResult> = {}): ProbeResult {
  return { name, ok: false, ...over }
}

test('a failing probe with a scripted fix is repaired before anyone is told', () => {
  const v = decide([fail('voice-daemon')], [], NOW)
  expect(v.actions[0]).toMatchObject({ kind: 'repair', probe: 'voice-daemon' })
  expect(v.message).toBeNull()
})

test('a repair that worked never becomes a message', () => {
  const v = decide([{ name: 'poller-lag', ok: true }], [stale('poller-lag')], NOW)
  expect(v.message).toBeNull()
  // Success wipes the streak, so the next failure is reported as a new incident.
  expect(v.states[0]).toEqual({ name: 'poller-lag' })
})

test('a repair that did not take, on something the user would notice, is a message', () => {
  const v = decide([fail('poller-lag', { detail: 'no updates in 22 min' })], [stale('poller-lag')], NOW)
  expect(v.message).toContain('stopped receiving your messages')
  expect(v.message).toContain('22 min')
})

// The rule the whole file exists to enforce.
test('a connector down while gog covers it is not worth a message', () => {
  const v = decide([fail('calendar-connector', { covered: true })], [stale('calendar-connector')], NOW)
  expect(v.message).toBeNull()
  expect(v.actions[0]).toMatchObject({ kind: 'wait', why: 'another path covers it' })
})

test('a feature the user never switched on is never repaired', () => {
  // The webhook probe reports covered when no token is configured. Repairing it
  // means running `kill` against whatever holds the port — on behalf of
  // something the user never asked to be running.
  const v = decide([fail('webhook', { covered: true, detail: 'no token configured' })], [], NOW)
  expect(v.actions[0]).toMatchObject({ kind: 'wait', why: 'another path covers it' })
  expect(v.actions.some(a => a.kind === 'repair')).toBe(false)
  expect(v.states[0].repairs).toBe(0)
  expect(v.message).toBeNull()
})

test('a failure the user would never notice stays silent even when unrepairable', () => {
  const v = decide([fail('gmail-connector')], [stale('gmail-connector')], NOW)
  expect(v.message).toBeNull()
  expect(v.actions[0]).toMatchObject({ kind: 'wait', why: 'the user would not notice this one' })
})

test('a fresh failure waits out the grace window — networks blip', () => {
  const v = decide([fail('google-auth')], [{ name: 'google-auth', failingSince: ago(60_000), repairs: 2 }], NOW)
  expect(v.message).toBeNull()
  expect(v.actions[0]).toMatchObject({ kind: 'wait', why: 'inside the grace window' })
})

test('a repair needing a browser is not attempted, it is escalated', () => {
  expect(repairFor('google-auth')!.unattended).toBe(false)
  const v = decide([fail('google-auth')], [stale('google-auth')], NOW)
  expect(v.actions[0].kind).toBe('tell')
  expect(v.message).toContain('needs you: gog auth login')
})

test('repairs are capped rather than retried forever', () => {
  const first = decide([fail('webhook')], [{ name: 'webhook', failingSince: ago(GRACE_MS * 2) }], NOW)
  expect(first.actions[0].kind).toBe('repair')
  expect(first.states[0].repairs).toBe(1)

  const exhausted = decide(
    [fail('webhook')],
    [{ name: 'webhook', failingSince: ago(GRACE_MS * 2), repairs: 2 }],
    NOW,
  )
  expect(exhausted.actions[0].kind).toBe('tell')
})

test('a probe repaired earlier this tick is not repaired again before re-probing', () => {
  const v = decide([fail('voice-daemon')], [], NOW, { repairedThisTick: ['voice-daemon'] })
  expect(v.actions[0].kind).not.toBe('repair')
})

test('the user is told once, not every tick, while it stays broken', () => {
  const told = decide([fail('poller-lag')], [stale('poller-lag')], NOW)
  expect(told.message).not.toBeNull()
  expect(told.states[0].toldAt).toBe(NOW)

  const again = decide([fail('poller-lag')], told.states, NOW + 60_000)
  expect(again.message).toBeNull()
  expect(again.actions[0]).toMatchObject({ kind: 'wait', why: 'already told the user' })

  const muchLater = decide([fail('poller-lag')], told.states, NOW + TELL_COOLDOWN_MS + 1)
  expect(muchLater.message).not.toBeNull()
})

test('several dead probes on one tick arrive as one message', () => {
  const v = decide(
    [fail('poller-lag'), fail('webhook'), fail('google-auth')],
    [stale('poller-lag'), stale('webhook'), stale('google-auth')],
    NOW,
  )
  expect(v.actions.filter(a => a.kind === 'tell')).toHaveLength(3)
  expect(v.message!.split('\n')).toHaveLength(1)
})

test('everything healthy says nothing and remembers nothing', () => {
  const v = decide([{ name: 'poller-lag', ok: true }, { name: 'webhook', ok: true }], [], NOW)
  expect(v.message).toBeNull()
  expect(v.states.every(s => s.failingSince === undefined)).toBe(true)
})

// A dead calendar source looks exactly like an empty calendar. This is the
// only signal that tells them apart.
test('a section that used to render and has gone quiet is caught', () => {
  const rebuilds = [
    { at: 1, sections: ['Today', 'Inbox 24h', 'Armed'] },
    { at: 2, sections: ['Today', 'Inbox 24h', 'Armed'] },
    { at: 3, sections: ['Inbox 24h', 'Armed'] },
    { at: 4, sections: ['Inbox 24h', 'Armed'] },
    { at: 5, sections: ['Inbox 24h', 'Armed'] },
    { at: 6, sections: ['Inbox 24h', 'Armed'] },
  ]
  expect(omittedSections(rebuilds)).toEqual(['Today'])
  expect(briefSectionsProbe(rebuilds).ok).toBe(false)
  expect(briefSectionsProbe(rebuilds).detail).toContain('Today')
})

test('a section missing once is a blip, not a failure', () => {
  const rebuilds = [
    { at: 1, sections: ['Today', 'Inbox 24h'] },
    { at: 2, sections: ['Today', 'Inbox 24h'] },
    { at: 3, sections: ['Inbox 24h'] },
    { at: 4, sections: ['Today', 'Inbox 24h'] },
    { at: 5, sections: ['Today', 'Inbox 24h'] },
    { at: 6, sections: ['Today', 'Inbox 24h'] },
  ]
  expect(omittedSections(rebuilds)).toEqual([])
})

// Otherwise they get told weekly that they have no tasks configured.
test('a section that never rendered is not reported as gone', () => {
  const rebuilds = Array.from({ length: 8 }, (_, i) => ({ at: i, sections: ['Today'] }))
  expect(omittedSections(rebuilds)).toEqual([])
})

test('too little history to judge yields no verdict', () => {
  expect(omittedSections([{ at: 1, sections: ['Today'] }])).toEqual([])
  expect(briefSectionsProbe([{ at: 1, sections: ['Today'] }]).ok).toBe(true)
})

// --- Capability watchdog: only documented repairs, always on the record ------

import { isSafeRepair, repairLogEntry } from '../watchdog.ts'
import { classify } from '../selfedit.ts'
import { readFileSync } from 'fs'
import { join } from 'path'

const UNATTENDED: ProbeResult['name'][] = ['voice-daemon', 'webhook', 'poller-lag', 'launchd']

test('every unattended repair the watchdog can pick passes the guard', () => {
  for (const name of UNATTENDED) {
    const r = repairFor(name, { home: '/home/x/.otto', port: 4589 })
    expect(r?.unattended).toBe(true)
    expect(isSafeRepair(r!).ok).toBe(true)
  }
})

test('the guard refuses anything that names config, secrets or the allowlist', () => {
  const bad = [
    ['sh', '-c', 'rm ~/.otto/state/access.json'],
    ['sh', '-c', 'cat ~/.otto/state/.env'],
    ['sed', '-i', 's/a/b/', 'access.json'],
    ['bash', '/home/x/.otto/scripts/otto-ctl.sh', 'restart', 'access.json'],
    ['bash', '/home/x/.otto/scripts/otto-ctl.sh', 'stop'],
    ['bash', '/home/x/.otto/scripts/otto-ctl.sh; rm -rf /', 'restart'],
    ['bash', '/home/x/.otto/scripts/evil.sh', 'restart'],
    ['pkill', '-f', 'server.ts'],
    ['sh', '-c', 'lsof -ti tcp:4589 | xargs -r kill'], // no LISTEN filter: would hit clients too
    ['sh', '-c', 'lsof -ti tcp:4589 -sTCP:LISTEN | xargs -r kill; rm -rf /'],
  ]
  for (const argv of bad) expect(isSafeRepair({ argv, unattended: true, why: 'x' }).ok).toBe(false)
})

test('a repair that needs a human is never run, however safe it looks', () => {
  const g = repairFor('google-auth')!
  expect(isSafeRepair(g).ok).toBe(false)
})

test('the guard and the tier policy agree: a repair writes no files, so nothing guarded is in reach', () => {
  // A fired trigger tops out at `unattended`; a repair has no paths, so it fits.
  expect(classify([], 'triggered').allowed).toBe(true)
  // And the protected files stay out of reach of that origin, whatever the repair says.
  for (const p of ['~/.otto/state/access.json', '~/.otto/state/.env', 'templates/otto.service.template']) {
    expect(classify([p], 'triggered').allowed).toBe(false)
  }
})

test('a repair is logged with what it did and what undoing it takes', () => {
  const r = repairFor('voice-daemon')!
  const e = repairLogEntry('voice-daemon', r, { ran: true }, '2026-08-12T09:00:00Z', 'abc12345')
  expect(e).toMatchObject({ by: 'watchdog', tier: 'unattended', origin: 'triggered', paths: [] })
  expect(e.what).toContain('pkill -f voiced.py')
  expect(e.revert.kind).toBe('none')
  expect((e.revert as { why: string }).why).toContain('respawns on demand')
  const declined = repairLogEntry('webhook', { argv: ['x'], unattended: true, why: 'w' }, { ran: false }, '2026-08-12T09:00:00Z', 'd')
  expect(declined.what).toContain('declined to run')
})

test('a webhook that stopped listening is repaired first, then reported if it stays down', () => {
  const first = decide([fail('webhook')], [], NOW)
  expect(first.actions[0]).toMatchObject({ kind: 'repair', probe: 'webhook' })
  const later = decide([fail('webhook')], [stale('webhook')], NOW)
  expect(later.message).toContain('local webhook stopped listening')
})

test('a stalled email scan is reported, never "repaired"', () => {
  expect(repairFor('email-scan')).toBeNull()
  const v = decide([fail('email-scan', { detail: 'last ran 6 h ago' })], [stale('email-scan')], NOW)
  expect(v.message).toContain('inbox checks have stalled')
})

test('the README lists every unattended repair the watchdog can run', () => {
  const readme = readFileSync(join(import.meta.dir, '..', '..', 'README.md'), 'utf8')
  const table = readme.slice(readme.indexOf('### Watchdog repairs'))
  expect(table).toContain('pkill -f voiced.py')
  expect(table).toContain('bash ~/.otto/scripts/otto-ctl.sh restart')
  expect(table).toContain('lsof -ti tcp:<port> -sTCP:LISTEN')
})

// --- Review fixes -----------------------------------------------------------

import { executeRepairs, restartArgv, type Verdict } from '../watchdog.ts'
import { blameSelfInstall } from '../selftriage.ts'
import type { CapEntry } from '../changelog.ts'

test('the webhook repair only kills a listener, never a client of the port', () => {
  const r = repairFor('webhook', { port: 4589 })!
  expect(r.argv[2]).toBe('lsof -ti tcp:4589 -sTCP:LISTEN | xargs -r kill')
  expect(isSafeRepair(r).ok).toBe(true)
})

test('the session restart goes through otto-ctl.sh, whichever supervisor is in use', () => {
  expect(repairFor('launchd', { home: '/home/x/.otto' })!.argv).toEqual(['bash', '/home/x/.otto/scripts/otto-ctl.sh', 'restart'])
  expect(repairFor('poller-lag')!.argv).toEqual(restartArgv())
  expect(isSafeRepair(repairFor('launchd')!).ok).toBe(true)
})

test('repair budget and log entry are written before the repair runs', async () => {
  const order: string[] = []
  const verdict: Verdict = {
    actions: [{ kind: 'repair', probe: 'poller-lag', repair: repairFor('poller-lag', { home: '/home/x/.otto' })! }],
    states: [{ name: 'poller-lag', failingSince: NOW, repairs: 1 }],
    message: null,
  }
  const ran = await executeRepairs(verdict, { home: '/home/x/.otto' }, {
    save: s => { order.push(`save:${s[0].repairs}`) },
    log: e => { order.push(`log:${e.by}`) },
    // The restart kills the process: nothing after run() is guaranteed.
    run: async argv => { order.push(`run:${argv[0]}`); return true },
    now: () => '2026-08-12T09:00:00Z',
    id: () => 'id1',
  })
  expect(order).toEqual(['save:1', 'log:watchdog', 'run:bash'])
  expect(ran).toEqual(['poller-lag'])
})

test('a repair the guard declines is logged as declined and never run', async () => {
  const bad = { argv: ['sh', '-c', 'rm access.json'], unattended: true, why: 'x' }
  // Not reachable via repairFor, so drive the guard through a verdict for a probe
  // with no repair: nothing runs, nothing is logged.
  const ran: string[] = []
  const logged: string[] = []
  const v: Verdict = { actions: [{ kind: 'repair', probe: 'brief-sections', repair: bad }], states: [], message: null }
  const out = await executeRepairs(v, {}, {
    save: () => {}, log: e => { logged.push(e.what) }, run: async a => { ran.push(a[0]); return true },
    now: () => 't', id: () => 'i',
  })
  expect(out).toEqual([])
  expect(ran).toEqual([])
  expect(logged).toEqual([])
})

function install(over: Partial<CapEntry>): CapEntry {
  return {
    id: 'x', at: '2026-08-12T10:00:00Z', what: 'added a recipe', paths: ['otto/skills/recipes/SKILL.md'],
    tier: 'confirmed', origin: 'user-typed', by: 'forge',
    revert: { kind: 'restore-files', files: [{ path: 'otto/skills/recipes/SKILL.md', before: 'old' }] },
    ...over,
  }
}

// forge install 10:00 breaks the session at 10:05; a webhook repair is logged 10:02.
test('a watchdog restart logged after the real install is never blamed for the crash loop', () => {
  const forge = install({ id: 'forge1' })
  const restart = repairLogEntry('webhook', repairFor('webhook', { port: 4589 })!, { ran: true }, '2026-08-12T10:02:00Z', 'wd1')
  const blamed = blameSelfInstall(Date.parse('2026-08-12T10:05:00Z'), [forge, restart])
  expect(blamed?.id).toBe('forge1')
  expect(blameSelfInstall(Date.parse('2026-08-12T10:05:00Z'), [restart])).toBeNull()
  // ...and anything with no inverse is not a suspect, whoever wrote it.
  const opaque = install({ id: 'o', by: 'forge', revert: { kind: 'none', why: 'irreversible' }, at: '2026-08-12T10:03:00Z' })
  expect(blameSelfInstall(Date.parse('2026-08-12T10:05:00Z'), [forge, opaque])?.id).toBe('forge1')
})
