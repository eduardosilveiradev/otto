import { expect, test } from 'bun:test'
import { LiveSteps, findImage } from '../livesteps.ts'

/** A LiveSteps on a hand-wound clock: `run()` fires whatever is due. */
function rig() {
  const sent: any[] = []
  let t = 1_000_000
  let queue: { fn: () => void; at: number }[] = []
  const live = new LiveSteps(f => sent.push(JSON.parse(f)), () => t, (fn, ms) => { queue.push({ fn, at: t + ms }) })
  const advance = (ms: number) => {
    t += ms
    const due = queue.filter(q => q.at <= t)
    queue = queue.filter(q => q.at > t)
    for (const q of due) q.fn()
  }
  return { live, sent, advance }
}

test('a step starts a task and goes out on the next tick', () => {
  const { live, sent, advance } = rig()
  live.step('Reading a.ts')
  expect(sent).toHaveLength(0)
  advance(0)
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ type: 'steps', done: false, steps: [{ label: 'Reading a.ts' }] })
  expect(sent[0].taskId).toMatch(/^[0-9a-f]{8}$/)
})

test('a burst coalesces to at most two frames a second', () => {
  const { live, sent, advance } = rig()
  live.step('one'); advance(0)
  for (let i = 0; i < 20; i++) { live.step(`s${i}`); advance(50) }   // 1s of steps every 50ms
  advance(500)
  expect(sent.length).toBeLessThanOrEqual(4)
  expect(sent.at(-1).steps).toHaveLength(21)
})

test('empty labels are not steps', () => {
  const { live, sent, advance } = rig()
  live.step(''); advance(1000)
  expect(sent).toHaveLength(0)
})

test('finish marks it done; the next step is a new task', () => {
  const { live, sent, advance } = rig()
  live.step('a'); advance(0)
  live.finish(); advance(500)
  expect(sent.at(-1)).toMatchObject({ done: true })
  live.finish(); advance(500)
  expect(sent).toHaveLength(2)                        // a second finish says nothing
  const first = sent[0].taskId
  live.step('b'); advance(500)
  expect(sent.at(-1).taskId).not.toBe(first)
  expect(sent.at(-1).steps.map((s: any) => s.label)).toEqual(['b'])
})

test('the screenshot rides one frame, and the snapshot', () => {
  const { live, sent, advance } = rig()
  live.screenshot('x'.repeat(200)); advance(500)
  expect(sent).toHaveLength(0)                        // no task, no screenshot
  live.step('a'); advance(0)
  live.screenshot('JPEG'); advance(500)
  expect(sent.at(-1).screenshot).toBe('JPEG')
  live.step('b'); advance(500)
  expect(sent.at(-1).screenshot).toBeUndefined()
  expect(JSON.parse(live.snapshot()!).screenshot).toBe('JPEG')
})

test('snapshot is only for a running task', () => {
  const { live, advance } = rig()
  expect(live.snapshot()).toBeNull()
  live.step('a'); advance(0)
  expect(JSON.parse(live.snapshot()!).steps).toHaveLength(1)
  live.finish()
  expect(live.snapshot()).toBeNull()
})

test('a long task keeps its last 100 steps', () => {
  const { live, sent, advance } = rig()
  for (let i = 0; i < 150; i++) live.step(`s${i}`)
  advance(0)
  expect(sent[0].steps).toHaveLength(100)
  expect(sent[0].steps[0].label).toBe('s50')
})

test('findImage reads both image shapes and ignores the rest', () => {
  const b = 'A'.repeat(200)
  expect(findImage([{ type: 'text', text: 'ok' }, { type: 'image', data: b, mimeType: 'image/png' }])).toBe(b)
  expect(findImage({ content: [{ type: 'image', source: { type: 'base64', data: b } }] })).toBe(b)
  expect(findImage([{ type: 'text', text: 'clicked' }])).toBeNull()
  expect(findImage('nope')).toBeNull()
})
