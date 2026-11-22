import { test, expect, afterAll } from 'bun:test'
import { join } from 'path'
import { startTwin, type Twin } from './apptwin.ts'

// A fresh install has no "selfEdit" in access.json: every door to its own code stays shut.
let t: Twin
afterAll(async () => { await t?.stop() })

test('self-edit ships off: forge, self_test, ask_approval, self_edit_check and the session write hook all refuse', async () => {
  t = await startTwin()
  const text = (r: any) => JSON.stringify(r)
  expect(text(await t.call('forge', { files: [{ path: 'otto/skills/x/SKILL.md', content: 'x' }] }))).toContain('self-editing is off')
  expect(text(await t.call('self_test', {}))).toContain('self-editing is off')
  expect(text(await t.call('ask_approval', { title: 'x', summary: 'y', paths: ['otto/server.ts'] }))).toContain('self-editing is off')
  expect(text(await t.call('self_edit_check', { paths: ['otto/server.ts'] }))).toContain('self-editing is off')
  const res = await fetch(`${t.url}/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-claude-pid': String(process.pid), 'x-otto-hook': 'selfedit' },
    body: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(import.meta.dir, '..', 'server.ts'), content: '' } }),
  })
  expect(res.status).toBe(403)
  expect(await res.text()).toContain('self-editing is off')
}, 60000)
