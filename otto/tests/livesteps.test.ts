import { describe, expect, test } from 'bun:test'
import { LiveSteps, shrinkScreenshot, findImage, todoItems, readTaskList, subagentOf } from '../livesteps.ts'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

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

describe('todoItems', () => {
  test('reads a TodoWrite list, with the item in progress in its -ing form', () => {
    const items = todoItems('TodoWrite', { todos: [
      { content: 'Write the parser', status: 'completed', activeForm: 'Writing the parser' },
      { content: 'Run the tests', status: 'in_progress', activeForm: 'Running the tests' },
      { content: 'Ship it', status: 'pending', activeForm: 'Shipping it' },
    ] })
    expect(items).toEqual([
      { text: 'Write the parser', status: 'completed' },
      { text: 'Running the tests', status: 'in_progress' },
      { text: 'Ship it', status: 'pending' },
    ])
  })
  test('other tools and broken input are not a list', () => {
    expect(todoItems('Bash', { todos: [] })).toBeNull()
    expect(todoItems('TodoWrite', {})).toBeNull()
    expect(todoItems('TodoWrite', { todos: [null, { content: '  ', status: 'x' }, { content: 'a\n b', status: 'weird' }] }))
      .toEqual([{ text: 'a b', status: 'pending' }])
  })
})

describe('readTaskList', () => {
  test('reads the task folder in id order, present tense for the one in progress', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tasks-'))
    writeFileSync(join(dir, '10.json'), JSON.stringify({ id: '10', subject: 'Push', status: 'pending' }))
    writeFileSync(join(dir, '9.json'), JSON.stringify({ id: '9', subject: 'Run the tests', activeForm: 'Running the tests', status: 'in_progress' }))
    writeFileSync(join(dir, '.highwatermark'), '10')
    writeFileSync(join(dir, '11.json'), '{"id":') // mid-write
    expect(readTaskList(dir)).toEqual([{ text: 'Running the tests', status: 'in_progress' }, { text: 'Push', status: 'pending' }])
    expect(readTaskList(join(dir, 'missing'))).toEqual([])
  })
})

describe('subagent steps', () => {
  // The shape Claude Code 2.1.318 sends: a subagent's tool call carries agent_id and agent_type,
  // and the parent's description sits in <transcript>/subagents/agent-<id>.meta.json.
  function session(metas: Record<string, object>) {
    const dir = mkdtempSync(join(tmpdir(), 'otto-sub-'))
    const transcript = join(dir, 'sess.jsonl')
    mkdirSync(join(dir, 'sess', 'subagents'), { recursive: true })
    for (const [id, m] of Object.entries(metas)) writeFileSync(join(dir, 'sess', 'subagents', `agent-${id}.meta.json`), JSON.stringify(m))
    return transcript
  }

  test('a subagent hook payload yields marked steps; parallel ones stay apart; the parent stays unmarked', () => {
    const transcript_path = session({
      a1: { agentType: 'general-purpose', description: 'Count lines', toolUseId: 'toolu_1' },
      a2: { agentType: 'general-purpose', description: '  Search   the docs for the hook payload shape, every field  ' },
    })
    const parent = { hook_event_name: 'PreToolUse', tool_name: 'Agent', transcript_path }
    const sub1 = { hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_id: 'a1', agent_type: 'general-purpose', transcript_path }
    const sub2 = { ...sub1, agent_id: 'a2' }
    const { live, sent, advance } = rig()
    live.step('Starting a subagent', subagentOf(parent))
    live.step('Running wc', subagentOf(sub1))
    live.step('Running ls', subagentOf(sub2))
    advance(0)
    const steps = sent.at(-1).steps
    expect(steps[0].subagent).toBeUndefined()
    expect('subagent' in steps[0]).toBe(false)
    expect(steps[1].subagent).toEqual({ id: 'a1', label: 'Count lines' })
    expect(steps[2].subagent).toEqual({ id: 'a2', label: 'Search the docs for the hook payload sha' })
  })

  test('no meta file: the agent type stands in, and a bad id is ignored', () => {
    const transcript_path = session({})
    expect(subagentOf({ agent_id: 'b1', agent_type: 'Explore', transcript_path })).toEqual({ id: 'b1', label: 'Explore' })
    expect(subagentOf({ agent_id: '../x', agent_type: 'Explore', transcript_path })).toBeUndefined()
  })
})

test('take hands over the steps since the last take, once, and keeps its place when old steps fall off', () => {
  const sent: string[] = []
  const s = new LiveSteps(f => sent.push(f), () => 1_000, fn => fn(), 0)
  expect(s.take()).toEqual([])
  s.step('Reading mail'); s.step('Checking the calendar', { id: 'a1', label: 'Research' })
  expect(s.take()).toEqual([{ label: 'Reading mail', ts: new Date(1_000).toISOString() }, { label: 'Checking the calendar', ts: new Date(1_000).toISOString(), subagent: { id: 'a1', label: 'Research' } }])
  expect(s.take()).toEqual([])
  s.step('Writing the draft')
  expect(s.take().map(x => x.label)).toEqual(['Writing the draft'])
  // The live frame still has all of them: taking changes nothing a watching app sees.
  expect(JSON.parse(sent.at(-1)!).steps).toHaveLength(3)

  // Past the 100 kept, the oldest fall off; what was already taken is not handed over again.
  for (let i = 0; i < 150; i++) s.step(`step ${i}`)
  const late = s.take()
  expect(late).toHaveLength(100)
  expect(late.at(-1)!.label).toBe('step 149')
  s.step('one more')
  expect(s.take().map(x => x.label)).toEqual(['one more'])

  // A turn that ends without a reply keeps its steps: the next turn's reply doesn't inherit them.
  s.step('left untaken')
  s.finish()
  expect(s.take()).toEqual([])
  s.step('next turn')
  expect(s.take().map(x => x.label)).toEqual(['next turn'])
})

test('shrinkScreenshot converts a real PNG to a bounded JPEG', async () => {
  const png = readFileSync(new URL('./fixtures/screenshot.png', import.meta.url)).toString('base64')
  for (const maxPx of [10, 64]) {
    const shot = await shrinkScreenshot(png, maxPx)
    expect(shot).not.toBeNull()
    const jpeg = Buffer.from(shot!, 'base64')
    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    // Decode the JPEG to PNG, whose header gives the decoded pixel dimensions.
    const decoder = Bun.spawn(['ffmpeg', '-i', 'pipe:0', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], {
      stdin: jpeg, stdout: 'pipe', stderr: 'ignore', timeout: 5000,
    })
    const decoded = Buffer.from(await new Response(decoder.stdout).arrayBuffer())
    expect(await decoder.exited).toBe(0)
    expect(decoded.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(Math.max(decoded.readUInt32BE(16), decoded.readUInt32BE(20))).toBe(process.platform === 'darwin' ? maxPx : Math.min(32, maxPx))
  }
})
