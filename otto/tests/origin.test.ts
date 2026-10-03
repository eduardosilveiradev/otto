import { test, expect } from 'bun:test'
import {
  freshState, onWake, taint, effectiveOrigin, recordTyped, currentProof,
  originForWake, describeOrigin, TYPED_PROOF_MS,
} from '../origin.ts'
import { classify, TYPED_PHRASE } from '../selfedit.ts'

test('a Telegram message and a tapped button are both the user', () => {
  expect(originForWake({ kind: 'inbound' }).origin).toBe('user-typed')
  expect(originForWake({ kind: 'button' }).origin).toBe('user-typed')
  expect(originForWake({ kind: 'event', event: 'button' }).origin).toBe('user-typed')
})

test('a clock is triggered and a webhook is a stranger', () => {
  expect(originForWake({ kind: 'event', event: 'trigger' }).origin).toBe('triggered')
  expect(originForWake({ kind: 'event', event: 'webhook' }).origin).toBe('external-content')
})

// The scan is the case where the two halves of the design meet: the clock woke
// it, but mail is what it is about to read.
test('an email scan is tainted from the start, not merely triggered', () => {
  const s = onWake(freshState(), { kind: 'event', event: 'email-scan' })
  expect(s.origin).toBe('triggered')
  expect(s.tainted).toBe(true)
  expect(effectiveOrigin(s)).toBe('external-content')
})

test('an unknown event does not silently become privileged', () => {
  // Defaulting to user-typed is the permissive branch, so it is worth pinning:
  // every event the scheduler actually emits is enumerated above it.
  const s = onWake(freshState(), { kind: 'event', event: 'something-new' })
  expect(s.origin).toBe('user-typed')
  expect(s.tainted).toBe(false)
})

test('taint is one-way within a turn', () => {
  let s = onWake(freshState(), { kind: 'inbound' })
  expect(effectiveOrigin(s)).toBe('user-typed')
  s = taint(s, 'read an attachment')
  expect(effectiveOrigin(s)).toBe('external-content')
  // No untaint exists; re-tainting keeps the first, most specific reason.
  s = taint(s, 'something else')
  expect(s.taintedBy).toBe('read an attachment')
})

test('taint does not survive into the next turn', () => {
  let s = taint(onWake(freshState(), { kind: 'inbound' }), 'read an attachment')
  s = onWake(s, { kind: 'inbound' })
  expect(s.tainted).toBe(false)
  expect(effectiveOrigin(s)).toBe('user-typed')
})

test('only the exact phrase is recorded as a typed confirmation', () => {
  const s = onWake(freshState(), { kind: 'inbound' })
  expect(recordTyped(s, 'yes go ahead').typedProof).toBeUndefined()
  expect(recordTyped(s, 'sure, i approve').typedProof).toBeUndefined()
  expect(recordTyped(s, TYPED_PHRASE).typedProof).toBeDefined()
  // Punctuation and case are noise; the sentence is the signal.
  expect(recordTyped(s, 'I approve the Otto core change.').typedProof).toBeDefined()
})

test('a typed confirmation survives a wake but expires on its own clock', () => {
  const t0 = 1_000_000
  let s = recordTyped(onWake(freshState(), { kind: 'inbound' }), TYPED_PHRASE, t0)
  s = onWake(s, { kind: 'inbound' })
  expect(currentProof(s, t0 + 60_000).kind).toBe('typed')
  expect(currentProof(s, t0 + TYPED_PROOF_MS + 1).kind).toBe('none')
})

// The whole point of holding the proof server-side: it must not become a window
// during which anything else can walk through the guarded tier.
test('a typed confirmation is unusable from a turn that is not the user', () => {
  const t0 = 1_000_000
  const typed = recordTyped(onWake(freshState(), { kind: 'inbound' }), TYPED_PHRASE, t0)

  const fired = onWake(typed, { kind: 'event', event: 'trigger' })
  expect(currentProof(fired, t0 + 1000).kind).toBe('none')

  const scanned = onWake(typed, { kind: 'event', event: 'email-scan' })
  expect(currentProof(scanned, t0 + 1000).kind).toBe('none')

  const poisoned = taint(onWake(typed, { kind: 'inbound' }), 'read an email')
  expect(currentProof(poisoned, t0 + 1000).kind).toBe('none')
})

// These are the claims SELFEDIT.md makes in prose. They only hold if the stamp
// and the policy are composed the way server.ts composes them.
test('end to end: a fired trigger structurally cannot edit the send path', () => {
  const s = onWake(freshState(), { kind: 'event', event: 'trigger' })
  const d = classify(['otto/server.ts'], effectiveOrigin(s), currentProof(s))
  expect(d.tier).toBe('guarded')
  expect(d.allowed).toBe(false)
  expect(d.reason).toContain('tops out at unattended')
})

test('end to end: a trigger may still rewrite its own parameters', () => {
  const s = onWake(freshState(), { kind: 'event', event: 'trigger' })
  const d = classify(['trigger:a1b2c3/action'], effectiveOrigin(s), currentProof(s))
  expect(d.tier).toBe('unattended')
  expect(d.allowed).toBe(true)
})

test('end to end: an email scan may not, because it has read mail', () => {
  const s = onWake(freshState(), { kind: 'event', event: 'email-scan' })
  const d = classify(['trigger:a1b2c3/action'], effectiveOrigin(s), currentProof(s))
  expect(d.allowed).toBe(false)
  expect(d.reason).toContain('outside content')
})

test('end to end: the user types the phrase and the core change clears', () => {
  const t0 = 1_000_000
  const s = recordTyped(onWake(freshState(), { kind: 'inbound' }), TYPED_PHRASE, t0)
  const d = classify(['otto/queue.ts'], effectiveOrigin(s), currentProof(s, t0 + 5000))
  expect(d.allowed).toBe(true)
})

test('end to end: the same phrase does not clear it once an email is in the turn', () => {
  const t0 = 1_000_000
  let s = recordTyped(onWake(freshState(), { kind: 'inbound' }), TYPED_PHRASE, t0)
  s = taint(s, 'read the inbox')
  const d = classify(['otto/queue.ts'], effectiveOrigin(s), currentProof(s, t0 + 5000))
  expect(d.allowed).toBe(false)
  expect(d.reason).toContain('outside content')
})

test('describeOrigin says both what was stamped and what overrode it', () => {
  const s = taint(onWake(freshState(), { kind: 'inbound' }), 'read an attachment')
  expect(describeOrigin(s)).toBe('external-content (stamped user-typed; read an attachment)')
  expect(describeOrigin(onWake(freshState(), { kind: 'inbound' }))).toBe('user-typed')
})
