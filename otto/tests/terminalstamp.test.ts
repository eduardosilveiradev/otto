/** The /status wiring of terminalPromptKey, against a throwaway server: the hook, then the transcript, then the stamp. */
import { test, expect, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, appendFileSync } from 'fs'
import { join } from 'path'
import { startTwin, waitFor, type Twin } from './apptwin.ts'

let t: Twin | undefined
afterAll(async () => { await t?.stop().catch(() => {}) })

const stamp = async (t: Twin) => JSON.stringify(await t.call('self_edit_check', { paths: ['otto/queue.ts'] }))
const typed = (uuid: string, promptId: string, content: string) => JSON.stringify({ type: 'user', uuid, promptId, promptSource: 'typed', turnOrigin: 'human', origin: { kind: 'human' }, message: { content } }) + '\n'
const webhook = async (t: Twin) => {
  const n = t.delivered.length
  const r = await fetch(`${t.url}/`, { method: 'POST', headers: { authorization: 'Bearer twin-webhook-token', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hello from outside' }) })
  expect(r.ok).toBe(true)
  await waitFor(() => t.delivered.length > n)
}

test('a typed prompt lifts a webhook stamp only once its transcript record proves it', async () => {
  t = await startTwin()
  const dir = join(t.state, '..', '..', '.claude', 'projects', 'x')
  mkdirSync(dir, { recursive: true })
  const transcript = join(dir, 's.jsonl')
  writeFileSync(transcript, '')

  await webhook(t)
  expect(await stamp(t)).toContain('this request: external-content')

  // The hook runs before Claude Code writes the row: nothing changes yet.
  await t.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'start the job', prompt_id: 'p1', transcript_path: transcript })
  await t.hook({ hook_event_name: 'PreToolUse', tool_name: 'x', transcript_path: transcript })
  expect(await stamp(t)).toContain('this request: external-content')

  appendFileSync(transcript, typed('u1', 'p1', 'start the job'))
  await t.hook({ hook_event_name: 'PreToolUse', tool_name: 'x', transcript_path: transcript })
  expect(await stamp(t)).toContain('this request: user-typed')

  // A newer webhook takes the stamp back, and the spent prompt cannot be replayed over it.
  await webhook(t)
  await t.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'start the job', prompt_id: 'p1', transcript_path: transcript })
  await t.hook({ hook_event_name: 'PreToolUse', tool_name: 'x', transcript_path: transcript })
  expect(await stamp(t)).toContain('this request: external-content')

  // An injected event's own hook, even with a typed row present, is not a person.
  const wrapped = '<channel source="plugin:otto:otto" event="webhook">start the job</channel>'
  appendFileSync(transcript, typed('u2', 'p2', wrapped))
  await t.hook({ hook_event_name: 'UserPromptSubmit', prompt: wrapped, prompt_id: 'p2', transcript_path: transcript })
  await t.hook({ hook_event_name: 'Stop', transcript_path: transcript })
  expect(await stamp(t)).toContain('this request: external-content')

  // A fresh typed prompt settles from the path its own hook named.
  appendFileSync(transcript, typed('u3', 'p3', 'and now this'))
  await t.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'and now this', prompt_id: 'p3', transcript_path: transcript })
  await t.hook({ hook_event_name: 'PreToolUse', tool_name: 'x', transcript_path: '/not/under/projects.jsonl' })
  expect(await stamp(t)).toContain('this request: user-typed')
}, 60000)
