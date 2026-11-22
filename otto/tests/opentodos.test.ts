// open_todos: Otto's open to-dos reach the app while idle, and survive turn end and a restart.
import { test, expect, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { startTwin, phone, type Twin } from './apptwin.ts'

const SID = 'twin-session-1'
let t: Twin
afterAll(async () => { await t?.stop() })

const items = (f: any) => f.items.map((i: any) => `${i.text}:${i.status}`).join(',')
const isOpen = (want: string) => (f: any) => f.type === 'open_todos' && items(f) === want

test('open_todos on connect, on change, past turn end and a restart; empty clears', async () => {
  t = await startTwin()
  const tasks = join(t.state, '..', '..', '.claude', 'tasks', SID)
  mkdirSync(tasks, { recursive: true })
  const task = (n: number, subject: string, status: string) => writeFileSync(join(tasks, `${n}.json`), JSON.stringify({ subject, status }))
  const taskCall = (tool: string) => t.hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {}, session_id: SID })

  let p = await phone(t)
  expect(await p.until(isOpen(''))).toBeDefined()   // empty on connect

  // No app message in flight: the list still tracks.
  task(1, 'book the dentist', 'pending'); task(2, 'pay rent', 'pending')
  await taskCall('TaskCreate')
  expect(await p.until(isOpen('book the dentist:pending,pay rent:pending'))).toBeDefined()

  task(1, 'book the dentist', 'completed')
  await taskCall('TaskUpdate')
  expect(await p.until(isOpen('pay rent:pending'))).toBeDefined()

  // Turn end clears the thinking-bubble list, never the open one.
  await t.hook({ hook_event_name: 'Stop' })
  p.close()
  p = await phone(t)
  expect(await p.until(isOpen('pay rent:pending'))).toBeDefined()
  p.close()

  t = await t.restart()
  p = await phone(t)
  expect(await p.until(isOpen('pay rent:pending'))).toBeDefined()

  task(2, 'pay rent', 'completed')
  await taskCall('TaskUpdate')
  expect(await p.until(isOpen(''))).toBeDefined()   // this phone connected to a non-empty list
  p.close()
}, 60_000)
