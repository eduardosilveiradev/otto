import { test, expect } from 'bun:test'
import {
  classify,
  assertInstallable,
  requiredTier,
  tierForPath,
  normalizePath,
  matchesTypedPhrase,
  TYPED_PHRASE,
  type Proof,
} from '../selfedit.ts'

const typed: Proof = { kind: 'typed', text: TYPED_PHRASE }
const tapped: Proof = { kind: 'tapped', buttonData: 'install draft abc' }

test('the send path and the rails are guarded', () => {
  for (const p of [
    'otto/server.ts',
    'otto/queue.ts',
    'otto/selfedit.ts',
    'otto/tests/selfedit.test.ts',
    'SELFEDIT.md',
    '~/.otto/state/access.json',
    '~/.otto/state/.env',
    'run.sh',
    'templates/otto.service.template',
    'scripts/install.sh',
    'scripts/otto-ctl.sh',
    'otto/package.json',
    'scripts/hooks/pre-push',
    'scripts/canary-deploy.sh',
  ]) {
    expect(tierForPath(p).tier).toBe('guarded')
  }
})

test('recipes, prose and ordinary modules need one tap', () => {
  for (const p of ['otto/skills/recipes/SKILL.md', 'CLAUDE.md', 'README.md', 'otto/forge.ts', 'scripts/triage.js']) {
    expect(tierForPath(p).tier).toBe('confirmed')
  }
})

test('trigger and recipe parameters change unattended', () => {
  expect(tierForPath('trigger:a1b2c3/action').tier).toBe('unattended')
  expect(tierForPath('trigger:a1b2c3/schedule').tier).toBe('unattended')
  expect(tierForPath('recipe-param:price-watch/last-price').tier).toBe('unattended')
})

// The rename hazard: this table will fall behind the tree at some point, and
// the only safe way to be behind is to over-guard.
test('an unrecognised path outside every known root is guarded, not confirmed', () => {
  expect(tierForPath('/etc/hosts').tier).toBe('guarded')
  expect(tierForPath('~/.zshrc').tier).toBe('guarded')
  expect(tierForPath('~/.claude/settings.json').tier).toBe('guarded')
  // Inside the repo but unrecognised: a tap is proportionate.
  expect(tierForPath('otto/brand-new-thing.ts').tier).toBe('confirmed')
})

test('traversal cannot dodge a rule', () => {
  expect(normalizePath('./otto/../otto/server.ts')).toBe('otto/server.ts')
  expect(tierForPath('otto/skills/../../otto/server.ts').tier).toBe('guarded')
  expect(tierForPath('../../../etc/passwd').tier).toBe('guarded')
})

test('the tier is the maximum over every path touched', () => {
  const r = requiredTier(['otto/skills/recipes/SKILL.md', 'otto/server.ts'])
  expect(r.tier).toBe('guarded')
  expect(r.because.join(' ')).toContain('server.ts')
  // ...and the evidence lists only the paths that set it.
  expect(r.because.join(' ')).not.toContain('SKILL.md')
})

// The single most important test in the file.
test('a fired trigger can never reach the send path, however it asks', () => {
  const d = classify(['otto/server.ts'], 'triggered', typed)
  expect(d.allowed).toBe(false)
  expect(d.ceiling).toBe('unattended')
  expect(d.reason).toContain('tops out at unattended')
})

test('a fired trigger may still update its own parameters', () => {
  expect(classify(['trigger:a1b2c3/action'], 'triggered').allowed).toBe(true)
})

test('email content can never install anything, at any tier', () => {
  for (const p of ['trigger:a1b2c3/action', 'otto/skills/recipes/SKILL.md', 'otto/server.ts']) {
    const d = classify([p], 'external-content', typed)
    expect(d.allowed).toBe(false)
    expect(d.reason).toContain('propose but never install')
  }
})

test('a tap clears confirmed and never clears guarded', () => {
  expect(classify(['CLAUDE.md'], 'user-typed', tapped).allowed).toBe(true)
  const guarded = classify(['otto/server.ts'], 'user-typed', tapped)
  expect(guarded.allowed).toBe(false)
  expect(guarded.reason).toContain(TYPED_PHRASE)
})

test('the typed phrase clears guarded, and only when it is the phrase', () => {
  expect(classify(['otto/server.ts'], 'user-typed', typed).allowed).toBe(true)
  const wrong = classify(['otto/server.ts'], 'user-typed', { kind: 'typed', text: 'yes go ahead' })
  expect(wrong.allowed).toBe(false)
  expect(wrong.reason).toContain('not the phrase')
})

test('the phrase tolerates punctuation and case but not paraphrase', () => {
  expect(matchesTypedPhrase('I approve the Otto core change.')).toBe(true)
  expect(matchesTypedPhrase('  i   approve the otto core change  ')).toBe(true)
  expect(matchesTypedPhrase('i approve the otto change')).toBe(false)
  expect(matchesTypedPhrase('approve the otto core change')).toBe(false)
})

test('Otto acting on its own idea can reach confirmed but never guarded', () => {
  expect(classify(['otto/skills/recipes/SKILL.md'], 'model-authored', tapped).allowed).toBe(false)
  expect(classify(['otto/server.ts'], 'model-authored', typed).allowed).toBe(false)
  // model-authored is capped at confirmed, and confirmed still wants the user’s tap —
  // which by definition arrives as user-typed.
  expect(classify(['otto/skills/recipes/SKILL.md'], 'model-authored').ceiling).toBe('confirmed')
})

test('an empty change list is trivially unattended', () => {
  expect(classify([], 'triggered').allowed).toBe(true)
  expect(classify([], 'triggered').tier).toBe('unattended')
})

test('assertInstallable throws a sentence you could send the user verbatim', () => {
  expect(() => assertInstallable(['otto/server.ts'], 'triggered')).toThrow(/tops out at unattended/)
  expect(assertInstallable(['CLAUDE.md'], 'user-typed', tapped).tier).toBe('confirmed')
})
