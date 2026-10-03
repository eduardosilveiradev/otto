import { test, expect } from 'bun:test'
import {
  makeDraft,
  pickSample,
  evaluateDryRun,
  formatOffer,
  planInstall,
  installPaths,
  looksLikeForgeRequest,
  type Draft,
  type Observation,
  type Sample,
} from '../forge.ts'
import type { HistoryLine } from '../repetition.ts'
import { TYPED_PHRASE } from '../selfedit.ts'

const NOW = Date.parse('2026-08-12T09:00:00Z')
const at = (h: number) => new Date(NOW - h * 3_600_000).toISOString()

function draft(over: Partial<Parameters<typeof makeDraft>[0]> = {}): Draft {
  return makeDraft({
    kind: 'recipe',
    title: 'a nocturne CI watch',
    claim: 'tells you when the nocturne build goes red',
    files: [{ path: 'otto/skills/recipes/SKILL.md', content: 'new', before: 'old' }],
    matches: ['nocturne', 'ci'],
    at: at(0),
    ...over,
  })
}

const ran: Observation = { ran: true, wouldSend: true, text: 'nocturne CI went red on main' }

function inb(ts: string, text: string): HistoryLine {
  return { ts, dir: 'in', text, kind: 'text' }
}
function outb(ts: string, text: string): HistoryLine {
  return { ts, dir: 'out', text, kind: 'text' }
}

test('the ask is recognised without catching ordinary requests', () => {
  expect(looksLikeForgeRequest('you should be able to watch that repo')).toBe(true)
  expect(looksLikeForgeRequest("it'd be nice if you told me when CI breaks")).toBe(true)
  expect(looksLikeForgeRequest('check the nocturne CI build')).toBe(false)
})

test('a draft without a claim cannot be built, because it could not be graded', () => {
  expect(() => draft({ claim: '  ' })).toThrow(/needs a claim/)
  expect(() => draft({ files: [] })).toThrow(/at least one file/)
})

test('a draft lands on its own branch and knows what it would touch', () => {
  const d = draft()
  expect(d.branch).toBe(`otto/forge-${d.id}`)
  expect(installPaths(d)).toEqual(['otto/skills/recipes/SKILL.md'])
})

// The sample is picked by a rule the draft's author does not control, because
// the dry run exists to check the model's optimism.
test('the sample is the most recent real match, not the most flattering', () => {
  const lines = [
    inb(at(48), 'nocturne CI build red again'),
    inb(at(10), 'nocturne CI build status?'),
    inb(at(9), 'play something'),
  ]
  expect(pickSample(lines, draft())!.line.text).toBe('nocturne CI build status?')
})

test('a transcript with nothing relevant yields no sample', () => {
  expect(pickSample([inb(at(2), 'play something by caetano')], draft())).toBeNull()
})

test('the sample carries what actually happened next', () => {
  const engaged = pickSample(
    [inb(at(5), 'nocturne CI build status?'), outb(at(4.9), 'it went red'), inb(at(4.8), 'which step')],
    draft(),
  )!
  expect(engaged.ottoResponded).toBe(true)
  expect(engaged.heFollowedUp).toBe(true)

  const ignored = pickSample([inb(at(5), 'nocturne CI build status?')], draft())!
  expect(ignored.ottoResponded).toBe(false)
  expect(ignored.heFollowedUp).toBe(false)
})

test('a draft that breaks the session is dropped, not offered', () => {
  const v = evaluateDryRun(draft(), null, {
    ran: false,
    wouldSend: false,
    selfTest: { ok: false, errors: 1, line: 'twin never reported: SyntaxError' },
  })
  expect(v.grade).toBe('drop')
  expect(v.line).toContain("doesn't load")
})

test('a draft that errored on a real event is dropped', () => {
  const v = evaluateDryRun(draft(), null, { ran: false, wouldSend: false, error: 'fetch failed' })
  expect(v.grade).toBe('drop')
  expect(v.line).toContain('fetch failed')
})

// The least informative outcome there is — installing on it means installing
// on the claim alone.
test('nothing to test it against is a tweak, never an install', () => {
  const v = evaluateDryRun(draft(), null, ran)
  expect(v.grade).toBe('tweak')
  expect(v.line).toContain("couldn't try it on anything real")
})

test('firing where the user was already engaged is an install', () => {
  const sample: Sample = { line: inb(at(5), 'nocturne CI status'), at: NOW - 5 * 3.6e6, ottoResponded: true, heFollowedUp: true }
  const v = evaluateDryRun(draft(), sample, ran)
  expect(v.grade).toBe('install')
  expect(v.line).toContain('would have told you')
})

// The counterfactual that matters: it fires, and nothing was there.
test('firing where nothing was happening is noise, and grades as tweak', () => {
  const sample: Sample = { line: inb(at(5), 'nocturne CI status'), at: NOW - 5 * 3.6e6, ottoResponded: false, heFollowedUp: false }
  const v = evaluateDryRun(draft(), sample, ran)
  expect(v.grade).toBe('tweak')
  expect(v.line).toContain("it'd be noise")
})

test('a wall of text is a tweak however right it is', () => {
  const sample: Sample = { line: inb(at(5), 'nocturne CI status'), at: NOW - 5 * 3.6e6, ottoResponded: true, heFollowedUp: true }
  const v = evaluateDryRun(draft(), sample, { ran: true, wouldSend: true, text: 'x'.repeat(4000) })
  expect(v.grade).toBe('tweak')
  expect(v.line).toContain('too long')
})

test('correct silence is a pass', () => {
  const sample: Sample = { line: inb(at(5), 'nocturne CI status'), at: NOW - 5 * 3.6e6, ottoResponded: false, heFollowedUp: false }
  const v = evaluateDryRun(draft(), sample, { ran: true, wouldSend: false })
  expect(v.grade).toBe('install')
  expect(v.line).toContain('correctly said nothing')
})

test('silence where the user wanted an answer is a tweak', () => {
  const sample: Sample = { line: inb(at(5), 'nocturne CI status'), at: NOW - 5 * 3.6e6, ottoResponded: true, heFollowedUp: true }
  const v = evaluateDryRun(draft(), sample, { ran: true, wouldSend: false })
  expect(v.grade).toBe('tweak')
  expect(v.line).toContain('where you wanted something')
})

test('the offer is one line and three buttons that fit in callback data', () => {
  const sample: Sample = { line: inb(at(5), 'nocturne CI status'), at: NOW - 5 * 3.6e6, ottoResponded: true, heFollowedUp: true }
  const d = draft()
  const offer = formatOffer(d, evaluateDryRun(d, sample, ran), 'user-typed')
  expect(offer.text).toStartWith('built a nocturne CI watch.')
  expect(offer.buttons.map(b => b.label)).toEqual(['install', 'tweak', 'drop'])
  for (const b of offer.buttons) {
    expect(Buffer.byteLength(b.data, 'utf8')).toBeLessThanOrEqual(60)
    expect(b.data).toContain(d.id)
  }
})

test('a dropped draft offers only the drop button', () => {
  const d = draft()
  const offer = formatOffer(d, evaluateDryRun(d, null, { ran: false, wouldSend: false }), 'user-typed')
  expect(offer.buttons.map(b => b.label)).toEqual(['drop it'])
})

test('a draft touching the channel says so before the user taps', () => {
  const d = draft({ files: [{ path: 'otto/server.ts', content: 'x', before: 'y' }] })
  const offer = formatOffer(d, evaluateDryRun(d, null, ran), 'user-typed')
  expect(offer.decision.tier).toBe('guarded')
  expect(offer.text).toContain('typed confirm')
})

// A tap confirms a change; it does not launder where the idea came from.
test('an install carries the original provenance, not the tap', () => {
  const d = draft()
  const req = { text: 'you should watch the CI', origin: 'external-content' as const, at: at(1) }
  expect(() =>
    planInstall(d, req, { kind: 'tapped', buttonData: `install forge ${d.id}` }, { verdict: { grade: 'install', line: '', evidence: [] } }),
  ).toThrow(/propose but never install/)
})

test('an ordinary recipe installs on a tap and writes a revertible entry', () => {
  const d = draft()
  const req = { text: 'you should watch the CI', origin: 'user-typed' as const, at: at(1) }
  const { decision, entry } = planInstall(d, req, { kind: 'tapped', buttonData: 'x' }, {
    sha: 'abc1234',
    verdict: { grade: 'install', line: 'on 2026-08-11 it would have told you: red', evidence: [] },
  })
  expect(decision.allowed).toBe(true)
  expect(entry.by).toBe('forge')
  expect(entry.what).toContain('nocturne CI watch')
  expect(entry.revert).toEqual({ kind: 'restore-files', files: [{ path: 'otto/skills/recipes/SKILL.md', before: 'old' }] })
})

test('a draft touching the channel needs the typed phrase, tap or no tap', () => {
  const d = draft({ files: [{ path: 'otto/server.ts', content: 'x', before: 'y' }] })
  const req = { text: 'you should be able to', origin: 'user-typed' as const, at: at(1) }
  const ctx = { verdict: { grade: 'install' as const, line: '', evidence: [] } }
  expect(() => planInstall(d, req, { kind: 'tapped', buttonData: 'x' }, ctx)).toThrow(/self-edit blocked/)
  expect(planInstall(d, req, { kind: 'typed', text: TYPED_PHRASE }, ctx).decision.tier).toBe('guarded')
})
