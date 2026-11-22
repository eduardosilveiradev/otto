import { test, expect, afterAll } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { stopTurn, type Tmux } from '../stopturn.ts'
import { startTwin, phone, waitFor, type Twin } from './apptwin.ts'

const IDLE = ['──────────────', '❯', '──────────────'].join('\n')
const BUSY = ['✻ Thinking… (3s · esc to interrupt)', IDLE].join('\n')

function fake(panes: string[], sendOk = true) {
  const calls: string[][] = []
  const tmux: Tmux = async args => {
    calls.push(args)
    return args[0] === 'send-keys' ? { ok: sendOk, out: '' } : { ok: true, out: panes.shift() ?? BUSY }
  }
  return { calls, tmux, sleep: async () => {} }
}

test('with no turn open nothing is sent to the pane', async () => {
  const f = fake([IDLE])
  expect(await stopTurn({ ...f, turnOpen: () => false })).toBe('idle')
  expect(f.calls).toEqual([])
})

test('Escape goes to the session, and it is stopped once the pane is back at the prompt', async () => {
  const f = fake([BUSY, IDLE])
  expect(await stopTurn({ ...f, turnOpen: () => true })).toBe('stopped')
  expect(f.calls[0]).toEqual(['send-keys', '-t', 'otto', 'Escape'])
  expect(f.calls.filter(c => c[0] === 'send-keys')).toHaveLength(1)
})

test('a key that did not go, or a pane that stays busy, is a failure', async () => {
  expect(await stopTurn({ ...fake([], false), turnOpen: () => true })).toBe('failed')
  expect(await stopTurn({ ...fake([]), turnOpen: () => true })).toBe('failed')
})

// End to end: a twin whose "tmux" is a script that logs its arguments and draws an idle pane.
const twins: Twin[] = []
afterAll(async () => { for (const t of twins) await t.stop().catch(() => {}) })

test('a server outside tmux says nothing about stop, and acks a stop frame without doing anything', async () => {
  const t = await startTwin(); twins.push(t)
  const p = await phone(t)
  const hello = await p.until(f => f.type === 'hello')
  expect(hello).toMatchObject({ acks: true, messageAcks: true })
  expect(hello.stop).toBeUndefined()
  p.send({ type: 'stop', op: 'S0' })
  expect(await p.until(f => f.type === 'ack' && f.id === 'S0')).toBeTruthy()
}, 60000)

test('stop interrupts the open turn, acks, and sends the turn-end frames; a repeat is acked and not redone', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'otto-faketmux-'))
  const log = join(bin, 'calls.log')
  writeFileSync(join(bin, 'tmux'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\ncase "$*" in *capture-pane*) printf '%s\\n' '──────────────' '❯' '──────────────';; esac\n`)
  chmodSync(join(bin, 'tmux'), 0o755)
  const first = await startTwin(undefined, { PATH: `${bin}:${process.env.PATH}` })
  writeFileSync(join(first.state, 'tmux.sock'), '')
  const t = await first.restart(); twins.push(t)
  const p = await phone(t)
  expect(await p.until(f => f.type === 'hello')).toMatchObject({ stop: true })

  // No turn yet: acked, and the pane is left alone.
  p.send({ type: 'stop', op: 'S1' })
  expect(await p.until(f => f.type === 'ack' && f.id === 'S1')).toBeTruthy()
  expect(existsSync(log)).toBe(false)

  p.send({ type: 'message', id: 'M1', text: 'do something long' })
  await waitFor(() => t.delivered.length === 1)
  await t.hook({ hook_event_name: 'PreToolUse', tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'a step', status: 'in_progress' }] } })
  await p.until(f => f.type === 'todos' && f.items.length === 1)
  await t.hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'sleep 600', description: 'Waiting a long time' } })
  await p.until(f => f.type === 'steps' && f.done === false)
  const before = p.got.length
  p.send({ type: 'stop', op: 'S2' })
  expect(await p.until(f => f.type === 'ack' && f.id === 'S2')).toBeTruthy()
  const after = () => p.got.slice(before)
  await waitFor(() => after().some(f => f.type === 'typing' && f.on === false))
  expect(after().some(f => f.type === 'todos' && f.items.length === 0)).toBe(true)
  expect(await waitFor(() => after().some(f => f.type === 'steps' && f.done === true))).toBe(true)
  expect(readFileSync(log, 'utf8')).toContain('send-keys -t otto Escape')

  const keys = () => readFileSync(log, 'utf8').split('\n').filter(l => l.includes('send-keys')).length
  expect(keys()).toBe(1)
  p.send({ type: 'stop', op: 'S2' })
  await waitFor(() => p.got.filter(f => f.type === 'ack' && f.id === 'S2').length === 2)
  expect(keys()).toBe(1)
}, 90000)

test('the socket takes no stop without a device token', async () => {
  const t = twins.at(-1)!
  const ws = new WebSocket(`${t.url.replace('http', 'ws')}/app`, { headers: { authorization: 'Bearer nope' } } as any)
  const outcome = await new Promise(r => { ws.onopen = () => r('open'); ws.onerror = () => r('refused'); ws.onclose = () => r('refused') })
  expect(outcome).toBe('refused')
}, 30000)
