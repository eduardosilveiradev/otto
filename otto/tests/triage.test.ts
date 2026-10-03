import { test, expect } from 'bun:test'
import {
  routeModel,
  shouldEscalate,
  escalationPlan,
  nextTier,
  formatRoute,
  HAIKU,
  SONNET,
  MAIN,
  type TriageItem,
} from '../triage.ts'

function item(over: Partial<TriageItem> = {}): TriageItem {
  return { kind: 'scan-classification', chars: 900, ...over }
}

test('short mechanical classification goes to haiku', () => {
  expect(routeModel(item()).model).toBe(HAIKU)
  expect(routeModel(item({ kind: 'watch-page', chars: 400 })).model).toBe(HAIKU)
})

test('length alone pushes the same job up a tier', () => {
  expect(routeModel(item({ chars: 20_000 })).model).toBe(SONNET)
  expect(routeModel(item({ chars: 20_000 })).why).toContain('20000 chars')
})

test('attachments push it up — there is no text-only shortcut', () => {
  expect(routeModel(item({ attachments: 1 })).model).toBe(SONNET)
})

// The rule the user asked for: complexity of the item, not a fixed cheap model.
test('evaluating a draft is sonnet work even when it is short', () => {
  expect(routeModel(item({ kind: 'shadow-eval', chars: 200 })).model).toBe(SONNET)
})

test('anything the user reads as written goes to the main session, however short', () => {
  expect(routeModel(item({ chars: 50, userFacing: true })).model).toBe(MAIN)
  expect(routeModel(item({ chars: 50, userFacing: true })).why).toContain('reads the output')
})

test('anything that writes state goes to the main session', () => {
  expect(routeModel(item({ writes: true })).model).toBe(MAIN)
})

test('an unrecognised job is not assumed cheap', () => {
  expect(routeModel(item({ kind: 'other', chars: 10 })).model).toBe(MAIN)
})

test('genuinely large input stops being mechanical', () => {
  expect(routeModel(item({ kind: 'clipping-summary', chars: 500_000 })).model).toBe(MAIN)
})

test('a retry never repeats the tier that just failed', () => {
  expect(routeModel(item({ retryOf: HAIKU })).model).toBe(SONNET)
  expect(routeModel(item({ retryOf: SONNET })).model).toBe(MAIN)
})

test('the cheap tier declining is honoured, not overruled', () => {
  expect(shouldEscalate({ verdict: 'marketing', escalate: true })).toBe(true)
  expect(shouldEscalate({ verdict: null })).toBe(true)
  expect(shouldEscalate({ verdict: 'marketing' })).toBe(false)
})

test('a broken run escalates rather than being read as an answer', () => {
  expect(shouldEscalate({ verdict: null, error: 'timeout' })).toBe(true)
  expect(shouldEscalate({ verdict: 'ok', error: 'bad json' })).toBe(true)
})

test('low stated confidence escalates; saying nothing is not certainty', () => {
  expect(shouldEscalate({ verdict: 'bill', confidence: 0.4 })).toBe(true)
  expect(shouldEscalate({ verdict: 'bill', confidence: 0.9 })).toBe(false)
  expect(shouldEscalate({ verdict: 'bill' })).toBe(false)
})

test('the plan walks up to the main session and stops there', () => {
  expect(escalationPlan(item()).map(r => r.model)).toEqual([HAIKU, SONNET, MAIN])
  expect(escalationPlan(item({ userFacing: true })).map(r => r.model)).toEqual([MAIN])
  expect(nextTier(MAIN)).toBeNull()
})

test('routes format as something readable in a weekly line', () => {
  expect(formatRoute(routeModel(item()))).toStartWith('haiku (')
  expect(formatRoute(routeModel(item({ userFacing: true })))).toStartWith('main session (')
})
