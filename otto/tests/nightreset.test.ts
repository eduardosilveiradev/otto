import { test, expect } from 'bun:test'
import { atPrompt, skipReason, nightlyReset, QUIET_MS, IDLE_CAP_MS, type Busy, type ResetDeps } from '../nightreset.ts'

const RULE = '─'.repeat(40)
const IDLE = ['  ✻ Brewed for 17s', '', RULE, '❯ ', RULE, '  ~/project │ ctx:44%'].join('\n')
const SPINNING = ['✽ Wibbling… (44s · ↓2.4k tokens)', '', RULE, '❯ ', RULE].join('\n')
const TYPED = [RULE, '❯ /clear', RULE].join('\n')
const MENU = ['Do you want to proceed?', '❯ 1. Yes', '  2. No'].join('\n')
const TODO_SPIN = ['✶ Saving the open drafts as loops… (12s)', RULE, '❯ ', RULE].join('\n')
const THINKING = ['✻ thinking with xhigh effort', RULE, '❯ ', RULE].join('\n')

const NOW = Date.parse('2026-11-13T04:20:00Z')
const quiet: Busy = { lastUserAt: NOW - QUIET_MS - 1, appOwed: 0, turnOpen: false, pacing: 0 }

test('skip rules: each busy signal says why, quiet says nothing', () => {
  expect(skipReason(quiet, NOW)).toBeNull()
  expect(skipReason({ ...quiet, lastUserAt: NOW - 5 * 60_000 }, NOW)).toBe('the user wrote 5 min ago')
  expect(skipReason({ ...quiet, appOwed: 2 }, NOW)).toContain('unread or unanswered')
  expect(skipReason({ ...quiet, turnOpen: true }, NOW)).toBe('a turn is in progress')
  expect(skipReason({ ...quiet, pacing: 1 }, NOW)).toBe('a reply is still pacing out')
  expect(skipReason({ ...quiet, lastUserAt: 0 }, NOW)).toBeNull()
})

test("pane check: only an empty composer between rules, with nothing spinning", () => {
  expect(atPrompt(IDLE)).toBe(true)
  expect(atPrompt(SPINNING)).toBe(false)
  expect(atPrompt(TYPED)).toBe(false)
  expect(atPrompt(MENU)).toBe(false)
  expect(atPrompt(TODO_SPIN)).toBe(false)
  expect(atPrompt(THINKING)).toBe(false)
  expect(atPrompt(['   … +4 completed', RULE, '❯ ', RULE].join('\n'))).toBe(true)
  expect(atPrompt('')).toBe(false)
})

/** A fake session: `script` hands out pane captures in order (the last one repeats). */
function fake(o: { busy?: (calls: number) => Busy; panes?: (string | null)[]; injectOk?: boolean; turnMs?: number } = {}) {
  let t = NOW
  const log: string[] = []
  let busyCalls = 0
  let saveAt = -1
  const panes = [...(o.panes ?? [IDLE, IDLE, TYPED, IDLE])]
  const d: ResetDeps = {
    now: () => t,
    sleep: async ms => { t += ms },
    busy: () => {
      const b = o.busy?.(busyCalls++) ?? quiet
      // The save turn stays open for turnMs after the save event goes in.
      return saveAt >= 0 && t - saveAt < (o.turnMs ?? 20_000) ? { ...b, turnOpen: true } : b
    },
    tmux: async args => {
      log.push(`tmux ${args.join(' ')}`)
      if (args[0] !== 'capture-pane') return { ok: true, out: '' }
      const p = panes.length > 1 ? panes.shift()! : panes[0]
      return p == null ? { ok: false, out: '' } : { ok: true, out: p }
    },
    inject: async kind => {
      log.push(`inject ${kind}`)
      if (kind === 'save') saveAt = t
      return o.injectOk ?? true
    },
  }
  return { d, log }
}

test('quiet night: save, wait for the turn to end, clear, then orient', async () => {
  const { d, log } = fake()
  const r = await nightlyReset(d)
  expect(r).toMatchObject({ reset: true, reason: 'cleared' })
  expect(log).toEqual([
    'tmux capture-pane -p -t otto',
    'inject save',
    'tmux capture-pane -p -t otto',
    'tmux send-keys -t otto -l /clear',
    'tmux capture-pane -p -t otto',
    'tmux send-keys -t otto Enter',
    'tmux capture-pane -p -t otto',
    'inject fresh',
  ])
})

test('busy before anything happens: nothing is injected or typed', async () => {
  const { d, log } = fake({ busy: () => ({ ...quiet, appOwed: 1 }) })
  const r = await nightlyReset(d)
  expect(r.reset).toBe(false)
  expect(r.reason).toContain('unread or unanswered')
  expect(log).toEqual([])
})

test('no tmux session: skipped before the save event', async () => {
  const { d, log } = fake({ panes: [null] })
  expect(await nightlyReset(d)).toMatchObject({ reset: false, reason: 'no tmux session (run without tmux)' })
  expect(log).toEqual(['tmux capture-pane -p -t otto'])
})

test("pane mid-turn (spinner): skipped, nothing injected", async () => {
  const { d, log } = fake({ panes: [SPINNING] })
  expect((await nightlyReset(d)).reason).toBe("the pane isn't at Claude Code's empty prompt")
  expect(log.some(l => l.startsWith('inject'))).toBe(false)
})

test('the save turn outruns the 10-minute cap: no clear', async () => {
  const { d, log } = fake({ turnMs: IDLE_CAP_MS * 2 })
  expect(await nightlyReset(d)).toMatchObject({ reset: false, reason: 'the save turn was still running after 10 min' })
  expect(log.some(l => l.includes('send-keys'))).toBe(false)
})

test('the user writes during the save turn: no clear', async () => {
  const { d, log } = fake({ busy: n => n === 0 ? quiet : { ...quiet, lastUserAt: NOW } })
  const r = await nightlyReset(d)
  expect(r.reset).toBe(false)
  expect(r.reason).toStartWith('after saving: the user wrote')
  expect(log.some(l => l.includes('send-keys'))).toBe(false)
})

test('save event never reached the session: no clear', async () => {
  const { d, log } = fake({ injectOk: false })
  expect((await nightlyReset(d)).reason).toBe('the save event did not reach the session')
  expect(log.some(l => l.includes('send-keys'))).toBe(false)
})

test('/clear left in the composer gets one more Enter', async () => {
  const { d, log } = fake({ panes: [IDLE, IDLE, TYPED, TYPED, IDLE] })
  expect((await nightlyReset(d)).reset).toBe(true)
  expect(log.filter(l => l.endsWith('Enter'))).toHaveLength(2)
  expect(log.at(-1)).toBe('inject fresh')
})

test("/clear never reached the composer: no Enter, recorded as a failure", async () => {
  const { d, log } = fake({ panes: [IDLE, IDLE, IDLE] })
  expect(await nightlyReset(d)).toMatchObject({ reset: false, reason: "/clear didn't reach the composer" })
  expect(log.some(l => l.endsWith('Enter'))).toBe(false)
  expect(log).not.toContain('inject fresh')
})

test('prompt never comes back: recorded as a failure, no orientation event', async () => {
  const { d, log } = fake({ panes: [IDLE, IDLE, TYPED, SPINNING] })
  expect(await nightlyReset(d)).toMatchObject({ reset: false, reason: '/clear sent but the prompt did not come back' })
  expect(log).not.toContain('inject fresh')
})
