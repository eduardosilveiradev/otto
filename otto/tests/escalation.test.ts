import { test, expect } from 'bun:test'
import {
  planLoop,
  recordStage,
  pruneEscalation,
  dueForInterruption,
  buttonsFor,
  formatEscalation,
  type EscalationState,
} from '../escalation'

const DAY = 24 * 60 * 60 * 1000
const DUE = Date.parse('2026-08-14T00:00:00Z')
const loop = { id: 'l1', due: '2026-08-14T00:00:00Z', status: 'open', text: 'send Marco the contract' }

// Mid-morning on a given day, so the morning window is unambiguous in tests.
const at = (ms: number, hour = 9) => ({ now: ms, localHour: hour })

test('a loop with no due date never escalates', () => {
  expect(planLoop({ id: 'x', status: 'open' }, {}, at(DUE))).toBeNull()
})

test('a closed loop never escalates', () => {
  expect(planLoop({ ...loop, status: 'done' }, {}, at(DUE))).toBeNull()
  expect(planLoop({ ...loop, status: 'dropped' }, {}, at(DUE))).toBeNull()
})

test('more than two days out it stays quiet and does not interrupt', () => {
  const p = planLoop(loop, {}, at(DUE - 5 * DAY))!
  expect(p.stage).toBe('quiet')
  expect(p.interrupt).toBe(false)
})

test('inside two days it gets one free digest mention', () => {
  const p = planLoop(loop, {}, at(DUE - DAY - 1000))!
  expect(p.stage).toBe('digest')
  expect(p.interrupt).toBe(false)
})

test('the digest mention is only offered once', () => {
  let state: EscalationState = {}
  state = recordStage(state, 'l1', 'digest', DUE - 2 * DAY)
  // Still inside the window, evening (outside the morning gate): nothing owed.
  expect(planLoop(loop, state, at(DUE - DAY, 20))).toBeNull()
})

test('the morning it is due it interrupts once, with buttons', () => {
  let state: EscalationState = {}
  state = recordStage(state, 'l1', 'digest', DUE - 2 * DAY)
  const p = planLoop(loop, state, at(DUE - 6 * 60 * 60 * 1000, 9))!
  expect(p.stage).toBe('morning')
  expect(p.interrupt).toBe(true)
  expect(p.buttons.map(b => b.label)).toEqual(['done', 'tomorrow', 'drop it'])
})

test('outside morning hours the morning nudge does not fire', () => {
  const evening = planLoop(loop, {}, at(DUE - 6 * 60 * 60 * 1000, 22))
  expect(evening?.stage).not.toBe('morning')
})

test('the morning nudge does not repeat later the same day', () => {
  let state: EscalationState = {}
  state = recordStage(state, 'l1', 'morning', DUE - 5 * 60 * 60 * 1000)
  expect(planLoop(loop, state, at(DUE - 60 * 60 * 1000, 11))).toBeNull()
})

test('a day overdue it asks once whether it is dead', () => {
  let state: EscalationState = {}
  state = recordStage(state, 'l1', 'digest', DUE - 2 * DAY)
  state = recordStage(state, 'l1', 'morning', DUE - 5 * 60 * 60 * 1000)
  const p = planLoop(loop, state, at(DUE + DAY + 1000))!
  expect(p.stage).toBe('overdue-check')
  expect(p.interrupt).toBe(true)
  expect(p.buttons.map(b => b.label)).toContain('still live')
})

test('after two interruptions it is exhausted and never buzzes again', () => {
  let state: EscalationState = {}
  state = recordStage(state, 'l1', 'morning', DUE)
  state = recordStage(state, 'l1', 'overdue-check', DUE + DAY)
  for (const days of [2, 7, 30, 365]) {
    const p = planLoop(loop, state, at(DUE + days * DAY))!
    expect(p.stage).toBe('exhausted')
    expect(p.interrupt).toBe(false)
  }
})

test('a loop can never cost more than two interruptions, walked end to end', () => {
  let state: EscalationState = {}
  let interruptions = 0
  // Every hour from five days before to ten days after.
  for (let t = DUE - 5 * DAY; t <= DUE + 10 * DAY; t += 60 * 60 * 1000) {
    const localHour = new Date(t).getUTCHours()
    const p = planLoop(loop, state, { now: t, localHour })
    if (!p) continue
    if (p.interrupt) interruptions++
    if (p.stage !== 'quiet' && p.stage !== 'exhausted') state = recordStage(state, 'l1', p.stage, t)
  }
  expect(interruptions).toBe(2)
})

test('button data is self-contained instruction text, not conversation state', () => {
  for (const b of [...buttonsFor('morning', loop), ...buttonsFor('overdue-check', loop)]) {
    expect(b.data).toContain('l1')
    expect(b.data.length).toBeLessThanOrEqual(60) // Telegram callback_data limit
    expect(b.data).not.toMatch(/\b(this|that|it)\b/)
  }
})

test('dueForInterruption returns only interrupting stages, overdue first', () => {
  const a = { id: 'a', due: new Date(DUE + 2 * DAY).toISOString(), status: 'open' }
  const b = { id: 'b', due: new Date(DUE).toISOString(), status: 'open' }
  const c = { id: 'c', status: 'open' }
  const out = dueForInterruption([a, b, c], {}, at(DUE + 3 * DAY, 9))
  expect(out.map(x => x.loop.id)).toEqual(['a', 'b'])
  expect(out[0].plan.stage).toBe('overdue-check')
})

test('pruning drops state for loops that no longer exist', () => {
  let state: EscalationState = {}
  state = recordStage(state, 'gone', 'morning', DUE)
  state = recordStage(state, 'here', 'morning', DUE)
  state = pruneEscalation(state, ['here'])
  expect(Object.keys(state)).toEqual(['here'])
})

// ---------------------------------------------------------------------------
// The event text the scheduler actually injects
// ---------------------------------------------------------------------------

test('the event text is self-contained enough for a cold agent', () => {
  const plan = planLoop(loop, {}, at(DUE, 9))!
  const text = formatEscalation([{ loop, plan }], { chat: '1234567890' })
  expect(text).toContain('[l1]')
  expect(text).toContain('send Marco the contract')
  expect(text).toContain('due 2026-08-14')
  expect(text).toContain('chat_id 1234567890')
  // The button payloads have to survive a tap arriving days later.
  expect(text).toContain('close loop l1 as done')
  expect(text).toContain('move loop l1 due date to tomorrow')
})

// Without this, a session looking at an overdue loop offers to remind the user again
// and a two-interruption budget quietly becomes unbounded.
test('the event text states the cap', () => {
  const plan = planLoop(loop, {}, at(DUE, 9))!
  const text = formatEscalation([{ loop, plan }], { chat: '1' })
  expect(text).toContain('last time')
  expect(text).toMatch(/do not offer to remind them again/i)
})

test('several due loops become one message, not several', () => {
  const a = { id: 'a', due: '2026-08-14T00:00:00Z', status: 'open', text: 'call the landlord' }
  const b = { id: 'b', due: '2026-08-14T00:00:00Z', status: 'open', text: 'file the form' }
  const batch = dueForInterruption([a, b], {}, at(DUE, 9))
  const text = formatEscalation(batch, { chat: '1' })
  expect(text).toContain('2 open loops')
  expect(text).toContain('one short message covering all of it')
  expect(text).toContain('call the landlord')
  expect(text).toContain('file the form')
})

test('with no allowlisted chat it still says what to do, minus the send', () => {
  const plan = planLoop(loop, {}, at(DUE, 9))!
  expect(formatEscalation([{ loop, plan }])).not.toContain('chat_id')
})

// The promise of the whole module, walked the way the scheduler walks it.
test('a loop interrupts exactly twice across its entire life', () => {
  let state: EscalationState = {}
  const fired: string[] = []
  for (let t = DUE - 3 * DAY; t <= DUE + 4 * DAY; t += 5 * 60_000) {
    const batch = dueForInterruption([loop], state, { now: t, localHour: new Date(t).getUTCHours() })
    for (const { loop: l, plan } of batch) {
      fired.push(plan.stage)
      state = recordStage(state, l.id, plan.stage, t)
    }
  }
  expect(fired).toEqual(['morning', 'overdue-check'])
})

test('once exhausted it stays in the brief and never buzzes again', () => {
  let state: EscalationState = {}
  state = recordStage(state, 'l1', 'morning', DUE)
  state = recordStage(state, 'l1', 'overdue-check', DUE + DAY)
  const plan = planLoop(loop, state, at(DUE + 30 * DAY, 9))!
  expect(plan.stage).toBe('exhausted')
  expect(plan.interrupt).toBe(false)
  expect(dueForInterruption([loop], state, at(DUE + 30 * DAY, 9))).toEqual([])
})

test('a date-only due fires on that local day, not the morning before', () => {
  const d = { id: 'd', due: '2026-10-12', status: 'open' }
  const sunday = Date.parse('2026-10-11T08:46:00Z') // 10:46 at UTC+2
  expect(planLoop(d, {}, { now: sunday, localHour: 10, today: '2026-10-11' })?.stage).not.toBe('morning')
  const monday = Date.parse('2026-10-12T07:00:00Z')
  expect(planLoop(d, {}, { now: monday, localHour: 9, today: '2026-10-12' })?.stage).toBe('morning')
  let state: EscalationState = recordStage({}, 'd', 'morning', monday)
  expect(planLoop(d, state, { now: monday + 3 * 3600_000, localHour: 12, today: '2026-10-12' })).toBeNull()
  const tuesday = Date.parse('2026-10-13T06:00:00Z')
  expect(planLoop(d, state, { now: tuesday, localHour: 8, today: '2026-10-13' })?.stage).toBe('overdue-check')
})
